import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Flow } from '../../../domain/types.js';
import type { PhaseInput, PhaseOutput } from '../../runEngine.js';
import { dispatchWorker } from '../dispatchWorker.js';
import { appendStatus, ensureAttempt, readStatusValue } from '../runFolder.js';
import type { PhaseContext } from './specPhase.js';

const FLAKY = /runner error|network timeout|cancelled unrelated/;
const MAX_FIXES = 3;

export async function runCommitPhase(input: PhaseInput, ctx: PhaseContext & { flow: Flow }): Promise<PhaseOutput> {
  const repoRoot = ctx.repoRoot;
  const dir = ensureAttempt(repoRoot, input.runId, input.attempt);
  const porcelain = await ctx.git.statusPorcelain(repoRoot);
  if (porcelain !== '') throw new Error('working tree is dirty');
  const branch = readStatusValue(dir, 'branch');
  const actual = await ctx.git.headBranch(repoRoot);
  if (actual !== branch) throw new Error(`HEAD is ${actual}, expected ${branch}`);

  const base = baseName(readStatusValue(dir, 'base'));
  const unresolved = unresolvedBaseline(dir);
  const prPath = join(dir, 'pr.md');
  const title = await writePullRequest(ctx, dir, prPath);
  await pushBranch(ctx, branch);
  const pr = await ctx.forge.upsertPr({
    repoRoot,
    base,
    title,
    bodyPath: prPath,
    draft: unresolved,
  });
  appendStatus(dir, `- pr: ${pr.url}`);

  const green = pr.isDraft ? false : await watch(ctx, dir, branch, pr.number);
  appendStatus(dir, '- phase: commit');
  const evidence: PhaseOutput['evidence'] = [{
    attempt: input.attempt,
    phase: 'commit',
    producerPhase: 'commit',
    criterionIds: [],
    kind: 'pull-request',
    summary: pr.isDraft ? 'draft' : 'open',
  }];
  if (green) {
    evidence.push({
      attempt: input.attempt,
      phase: 'commit',
      producerPhase: 'commit',
      criterionIds: [],
      kind: 'ci-green',
      summary: await ctx.git.headSha(repoRoot),
    });
  }
  return {
    events: [{ type: 'phase_completed', message: `commit phase completed (attempt ${input.attempt})` }],
    evidence,
  };
}

async function writePullRequest(ctx: PhaseContext, dir: string, prPath: string): Promise<string> {
  const runDir = join(dir, 'units', 'pr');
  mkdirSync(runDir, { recursive: true });
  await dispatchWorker(ctx.workers, {
    role: 'default',
    runDir,
    repoRoot: ctx.repoRoot,
    prompt: [ctx.readPlaybook('commit.md'), `Write ${prPath}`, `Attempt: ${dir}`].join('\n'),
    allowedFiles: [relative(ctx.repoRoot, prPath)],
    unitId: 'pr',
  });
  return prTitle(prPath);
}

async function watch(ctx: PhaseContext, dir: string, branch: string, prNumber: number): Promise<boolean> {
  const started = Date.now();
  let reranFlaky = false;
  let emptyRetried = false;
  let fixes = 0;

  for (;;) {
    let checks = await ctx.forge.checks(ctx.repoRoot, prNumber);
    if (checks.length === 0) {
      if (emptyRetried) return false;
      emptyRetried = true;
      await new Promise((resolve) => setTimeout(resolve, ctx.ci.extraIntervalMs));
      checks = await ctx.forge.checks(ctx.repoRoot, prNumber);
      if (checks.length === 0) return false;
    }
    if (checks.every((item) => item.bucket === 'pass')) return true;
    if (checks.some((item) => item.bucket === 'pending')) {
      if (Date.now() >= started + ctx.ci.waitMs) return false;
      await new Promise((resolve) => setTimeout(resolve, ctx.ci.extraIntervalMs));
      continue;
    }

    const blocker = checks.find((item) => item.bucket !== 'pass');
    if (!blocker) return true;
    const runId = digitsAfterRuns(blocker.link);
    const log = blocker.bucket === 'cancel' ? '' : await ctx.forge.failedLog(ctx.repoRoot, runId);
    if (blocker.bucket === 'cancel' || FLAKY.test(log)) {
      if (reranFlaky) return false;
      reranFlaky = true;
      await ctx.forge.rerunFailed(ctx.repoRoot, runId);
      appendFileSync(join(dir, 'babysit.md'), `rerun ${runId}\n`);
      continue;
    }
    if (fixes >= MAX_FIXES) return false;
    fixes += 1;
    await fixFailure(ctx, dir, branch, fixes, log);
  }
}

async function fixFailure(ctx: PhaseContext, dir: string, branch: string, attempt: number, log: string): Promise<void> {
  const unitId = `ci-${attempt}`;
  const runDir = join(dir, 'units', unitId);
  mkdirSync(runDir, { recursive: true });
  const logPath = join(runDir, 'failed.log');
  writeFileSync(logPath, log);
  appendFileSync(join(dir, 'babysit.md'), `attempt ${attempt}\n${log}\n`);
  const allowed = await ctx.git.diffNames(ctx.repoRoot, baseSha(readStatusValue(dir, 'base')));
  await dispatchWorker(ctx.workers, {
    role: 'implement',
    runDir,
    repoRoot: ctx.repoRoot,
    prompt: [`Log: ${logPath}`, log, `Allowed files: ${allowed.join(', ')}`].join('\n'),
    allowedFiles: allowed,
    unitId,
  });
  if ((await ctx.git.statusPorcelain(ctx.repoRoot)) !== '') {
    await ctx.git.commitAll(ctx.repoRoot, 'fix: CI');
  }
  await pushBranch(ctx, branch);
}

async function pushBranch(ctx: PhaseContext, branch: string): Promise<void> {
  const head = await ctx.git.headSha(ctx.repoRoot);
  const remote = await ctx.git.remoteHead(ctx.repoRoot, branch);
  if (remote !== null && remote !== head) throw new Error('remote head moved');
  await ctx.git.push(ctx.repoRoot, branch);
}

function unresolvedBaseline(dir: string): boolean {
  const path = join(dir, 'status.md');
  if (!existsSync(path)) return false;
  const latest = new Map<string, string>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^- (M\d+) \| ([^|]+) \|/);
    if (!match) continue;
    latest.set(match[1], match[2].trim());
  }
  for (const status of latest.values()) {
    if (status === 'open' || status === 'partial') return true;
  }
  return false;
}

function prTitle(path: string): string {
  if (!existsSync(path)) return '';
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const heading = trimmed.match(/^#\s+(.*)$/);
    return (heading ? heading[1] : trimmed).trim();
  }
  return '';
}

function digitsAfterRuns(link: string): string {
  const match = link.match(/\/runs\/(\d+)/);
  return match ? match[1] : '';
}

function baseName(value: string | null): string {
  const at = value?.lastIndexOf('@') ?? -1;
  if (!value || at <= 0) throw new Error('base is missing');
  return value.slice(0, at);
}

function baseSha(value: string | null): string {
  const at = value?.lastIndexOf('@') ?? -1;
  if (!value || at < 0 || at === value.length - 1) throw new Error('base is missing');
  return value.slice(at + 1);
}
