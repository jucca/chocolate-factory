import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Flow } from '../../../domain/types.js';
import type { PhaseInput, PhaseOutput } from '../../runEngine.js';
import { dispatchWorker } from '../dispatchWorker.js';
import { revertOutside } from '../porcelain.js';
import { appendStatus, ensureAttempt, readStatusValue } from '../runFolder.js';
import type { PhaseContext } from './specPhase.js';

const SPLIT_AT = 300;
const MAX_PASS = 3;
const REVIEWERS = ['review-correctness', 'review-tests', 'review-security'] as const;
const ANGLES: Record<string, string> = {
  'review-all': 'correctness, tests and intent, and security, data, and performance',
  'review-correctness': 'correctness',
  'review-tests': 'tests and intent',
  'review-security': 'security, data, and performance',
};

interface Finding {
  file: string;
  line: string;
  title: string;
  rest: string;
}

interface Rated extends Finding {
  id: string;
  status: 'open' | 'resolved';
}

interface ParsedNotes {
  must: Finding[];
  nice: Finding[];
  could: Finding[];
  base: { id: string; status: 'open' | 'resolved' }[];
}

export async function runVerifyPhase(input: PhaseInput, ctx: PhaseContext & { flow: Flow }): Promise<PhaseOutput> {
  const repoRoot = ctx.repoRoot;
  const dir = ensureAttempt(repoRoot, input.runId, input.attempt);
  const porcelain = await ctx.git.statusPorcelain(repoRoot);
  if (porcelain !== '') throw new Error('working tree is dirty');
  const expected = readStatusValue(dir, 'branch');
  const actual = await ctx.git.headBranch(repoRoot);
  if (actual !== expected) throw new Error(`HEAD is ${actual}, expected ${expected}`);

  const base = baseSha(readStatusValue(dir, 'base'));
  const playbook = ctx.readPlaybook('verify.md');
  const baseline = new Map<string, Rated>();
  const deferredItems: Rated[] = [];

  for (let pass = 1; pass <= MAX_PASS; pass += 1) {
    const notes = await reviewPass(ctx, dir, playbook, base, pass);
    const parsed = parseNotes(notes);
    if (pass === 1) {
      const kept = await confirmMusts(ctx, dir, playbook, rate(parsed.must, (index) => `M${index + 1}`));
      for (const item of kept) {
        baseline.set(item.id, item);
        appendStatus(dir, `- ${item.id} | open | ${item.title}`);
      }
      writeReview(dir, pass, kept, parsed.nice, parsed.could);
    } else {
      for (const update of parsed.base) {
        const item = baseline.get(update.id);
        if (!item) continue;
        item.status = update.status;
        appendStatus(dir, `- ${item.id} | ${item.status} | ${item.title}`);
      }
      const kept = await confirmMusts(ctx, dir, playbook, rate(parsed.must, (index) => `P${pass}-M${index + 1}`));
      deferredItems.push(...kept);
      writeReview(dir, pass, kept, parsed.nice, parsed.could);
    }

    const open = [...baseline.values()].filter((item) => item.status === 'open');
    if (pass >= MAX_PASS || open.length === 0) break;
    await fixOpen(ctx, dir, playbook, open, join(dir, `review-${pass}.md`));
    await commitFixRound(ctx, pass, new Set(open.map((item) => item.file)));
  }

  if (deferredItems.length > 0) {
    appendStatus(dir, '## Deferred must-fix');
    for (const item of deferredItems) appendStatus(dir, `- ${item.id} | ${item.title}`);
  }
  appendStatus(dir, '- phase: verify');
  const resolved = [...baseline.values()].filter((item) => item.status === 'resolved').length;
  const open = [...baseline.values()].filter((item) => item.status === 'open').length;
  const deferred = deferredItems.length;
  const criterionIds = input.contract.acceptance_criteria
    .filter((criterion) => criterion.gates.includes('verify'))
    .map((criterion) => criterion.id);
  return {
    events: [{ type: 'phase_completed', message: `verify phase completed (attempt ${input.attempt})` }],
    evidence: [{
      attempt: input.attempt,
      phase: 'verify',
      producerPhase: 'verify',
      criterionIds,
      kind: 'verification-check',
      summary: `baseline resolved ${resolved} baseline open ${open} deferred ${deferred}`,
    }],
  };
}

async function reviewPass(
  ctx: PhaseContext,
  dir: string,
  playbook: string,
  base: string,
  pass: number,
): Promise<string> {
  const repoRoot = ctx.repoRoot;
  const changed = await ctx.git.changedLines(repoRoot, base);
  const names = await ctx.git.diffNames(repoRoot, base);
  const diffPath = join(dir, `review-${pass}.diff`);
  writeFileSync(diffPath, names.length === 0 ? '' : `${names.join('\n')}\n`);
  const unitIds = changed < SPLIT_AT ? ['review-all'] : [...REVIEWERS];
  const parallel = unitIds.length > 1;
  const reports = await Promise.all(unitIds.map((unitId) => {
    const runDir = parallel ? join(dir, 'units', unitId) : dir;
    if (parallel) mkdirSync(runDir, { recursive: true });
    return dispatchWorker(ctx.workers, {
      role: 'default',
      runDir,
      repoRoot,
      prompt: [playbook, `Diff: ${diffPath}`, `Angle: ${ANGLES[unitId]}`].join('\n'),
      allowedFiles: [],
      unitId,
    });
  }));
  if (reports.some((report) => report.status === 'blocked')) throw new Error('review blocked');
  return reports.map((report) => report.notes).join('\n');
}

async function confirmMusts(ctx: PhaseContext, dir: string, playbook: string, musts: Rated[]): Promise<Rated[]> {
  if (musts.length === 0) return [];
  const report = await dispatchWorker(ctx.workers, {
    role: 'default',
    runDir: dir,
    repoRoot: ctx.repoRoot,
    prompt: [
      playbook,
      'Disprove each must-fix candidate with a line `DISPROVE <id> <reason>`.',
      ...musts.map(candidateLine),
    ].join('\n'),
    allowedFiles: [],
    unitId: 'verifier',
  });
  if (report.status === 'blocked') throw new Error('verifier blocked');
  const dropped = disprovedIds(report.notes);
  return musts.filter((item) => !dropped.has(item.id));
}

async function commitFixRound(ctx: PhaseContext, pass: number, allowed: ReadonlySet<string>): Promise<void> {
  const repoRoot = ctx.repoRoot;
  const porcelain = await ctx.git.statusPorcelain(repoRoot);
  if (porcelain === '') return;
  await revertOutside(ctx.git, repoRoot, porcelain, allowed);
  if ((await ctx.git.statusPorcelain(repoRoot)) === '') return;
  await ctx.git.commitAll(repoRoot, `fix: pass-${pass} must-fix`);
}

async function fixOpen(ctx: PhaseContext, dir: string, playbook: string, open: Rated[], reviewPath: string): Promise<void> {
  const groups = groupByFile(open);
  const parallel = groups.length > 1;
  await Promise.all(groups.map((group) => {
    const ids = group.map((item) => item.id);
    const files = [...new Set(group.map((item) => item.file))];
    const unitId = `fix-${ids.join('-')}`;
    const runDir = parallel ? join(dir, 'units', unitId) : dir;
    if (parallel) mkdirSync(runDir, { recursive: true });
    return dispatchWorker(ctx.workers, {
      role: 'implement',
      runDir,
      repoRoot: ctx.repoRoot,
      prompt: [
        playbook,
        `Review: ${reviewPath}`,
        ...group.map(candidateLine),
        `Ids: ${ids.join(', ')}`,
        `Allowed files: ${files.join(', ')}`,
        'Do not edit other files.',
      ].join('\n'),
      allowedFiles: files,
      unitId,
    });
  }));
}

function candidateLine(item: Rated): string {
  const rest = item.rest === '' ? '' : ` | ${item.rest}`;
  return `${item.id} ${item.file}:${item.line} ${item.title}${rest}`;
}

function groupByFile(open: Rated[]): Rated[][] {
  const groups: Rated[][] = [];
  for (const item of open) {
    const group = groups.find((existing) => existing.some((other) => other.file === item.file));
    if (group) group.push(item);
    else groups.push([item]);
  }
  return groups;
}

function rate(findings: Finding[], idFor: (index: number) => string): Rated[] {
  return findings.map((finding, index) => ({ ...finding, id: idFor(index), status: 'open' }));
}

function disprovedIds(notes: string): Set<string> {
  const dropped = new Set<string>();
  for (const line of notes.split('\n')) {
    const match = line.trim().match(/^DISPROVE\s+(\S+)/);
    if (match) dropped.add(match[1]);
  }
  return dropped;
}

function parseNotes(notes: string): ParsedNotes {
  const parsed: ParsedNotes = { must: [], nice: [], could: [], base: [] };
  for (const raw of notes.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const base = line.match(/^BASE\s+(M\d+)\s+(resolved|open)\b/);
    if (base) {
      parsed.base.push({ id: base[1], status: base[2] as 'open' | 'resolved' });
      continue;
    }
    const finding = line.match(/^(MUST|NICE|COULD)\s+(\S+):(\d+)\s+(.*)$/);
    if (!finding) continue;
    const body = finding[4];
    const pipe = body.indexOf(' | ');
    const item: Finding = {
      file: finding[2],
      line: finding[3],
      title: (pipe === -1 ? body : body.slice(0, pipe)).trim(),
      rest: pipe === -1 ? '' : body.slice(pipe + 3).trim(),
    };
    if (finding[1] === 'MUST') parsed.must.push(item);
    else if (finding[1] === 'NICE') parsed.nice.push(item);
    else parsed.could.push(item);
  }
  return parsed;
}

function writeReview(dir: string, pass: number, must: Rated[], nice: Finding[], could: Finding[]): void {
  const lines = [
    '## Must',
    ...must.map(formatFinding),
    '',
    '## Nice',
    ...nice.map(formatFinding),
    '',
    '## Could',
    ...could.map(formatFinding),
    '',
  ];
  writeFileSync(join(dir, `review-${pass}.md`), lines.join('\n'));
}

function formatFinding(item: Finding & { id?: string }): string {
  const id = item.id ? `${item.id} ` : '';
  const rest = item.rest ? ` | ${item.rest}` : '';
  return `- ${id}${item.file}:${item.line} ${item.title}${rest}`;
}

function baseSha(value: string | null): string {
  const at = value?.lastIndexOf('@') ?? -1;
  if (!value || at < 0 || at === value.length - 1) throw new Error('base is missing');
  return value.slice(at + 1);
}
