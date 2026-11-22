import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Flow } from '../../../domain/types.js';
import type { PhaseInput, PhaseOutput } from '../../runEngine.js';
import { dispatchWorker } from '../dispatchWorker.js';
import { buildWaves, parsePlan, type WorkUnit } from '../planDoc.js';
import type { CommandResult, WorkerReport } from '../ports.js';
import { porcelainEntries, revertOutside } from '../porcelain.js';
import { appendStatus, ensureAttempt, readStatusValue } from '../runFolder.js';
import {
  decideHold,
  diffDirectories,
  implementToolboxPrompt,
  latestDrop,
  parseManifest,
  TOOLBOX_DIR,
  toolboxHoldPaths,
} from '../toolbox.js';
import type { PhaseContext } from './specPhase.js';

interface UnitRow {
  id: string;
  status: string;
  route: string;
  fallback: string;
}

export async function runImplementPhase(input: PhaseInput, ctx: PhaseContext & { flow: Flow }): Promise<PhaseOutput> {
  const repoRoot = ctx.repoRoot;
  const dir = ensureAttempt(repoRoot, input.runId, input.attempt);
  const porcelain = await ctx.git.statusPorcelain(repoRoot);
  if (porcelain !== '') throw new Error('working tree is dirty');
  const expected = readStatusValue(dir, 'branch');
  const actual = await ctx.git.headBranch(repoRoot);
  if (actual !== expected) throw new Error(`HEAD is ${actual}, expected ${expected}`);

  const reproPath = ctx.flow === 'bug' ? readReproPath(dir) : null;
  const base = reproPath ? baseSha(readStatusValue(dir, 'base')) : '';
  const toolboxSha = ctx.toolboxGit ? baseSha(readStatusValue(dir, 'base')) : '';
  const baseManifest = ctx.toolboxGit ? (await ctx.toolboxGit.show(repoRoot, toolboxSha, `${TOOLBOX_DIR}/manifest.md`)) ?? '' : '';
  const present = parseManifest(baseManifest).map((entry) => entry.name);
  const drop = ctx.toolboxGit ? latestDrop(repoRoot, present) : null;
  const toolboxRule = ctx.toolboxGit ? implementToolboxPrompt(drop) : '';
  const planPath = join(dir, 'plan.md');
  const playbook = ctx.readPlaybook('implement.md');
  const waves = buildWaves(parsePlan(readFileSync(planPath, 'utf8')));
  const rows: UnitRow[] = [];

  for (const wave of waves) {
    const waveAllowed = new Set(wave.flatMap((unit) => unit.files.map(stripNew)));
    const waveRows = await Promise.all(wave.map((unit) => runUnit(
      ctx, dir, planPath, playbook, unit, waveAllowed, reproPath, base, toolboxRule,
    )));
    if (ctx.toolboxGit) await revertIllegalToolbox(ctx, dir);
    for (const row of waveRows) {
      if (row.fallback !== '-') appendStatus(dir, `- fallback: ${row.fallback}`);
    }
    rows.push(...waveRows);
    const blocked = waveRows.filter((row) => row.status === 'blocked');
    if (blocked.length > 0) {
      writeImplement(dir, rows);
      throw new Error(`blocked units: ${blocked.map((row) => row.id).join(', ')}`);
    }
    const verb = ctx.flow === 'bug' ? 'fix' : 'feat';
    await ctx.git.commitAll(repoRoot, `${verb}: ${wave.map((unit) => unit.id).join(', ')}`);
  }

  writeImplement(dir, rows);
  appendStatus(dir, '- phase: implement');
  const ids = rows.map((row) => row.id).join(', ');
  return {
    events: [{ type: 'phase_completed', message: `implement phase completed (attempt ${input.attempt})` }],
    evidence: [{
      attempt: input.attempt,
      phase: 'implement',
      producerPhase: 'implement',
      criterionIds: [],
      kind: 'implement-summary',
      summary: ids ? `implement ${ids}` : 'implement',
    }],
  };
}

async function runUnit(
  ctx: PhaseContext,
  dir: string,
  planPath: string,
  playbook: string,
  unit: WorkUnit,
  waveAllowed: ReadonlySet<string>,
  reproPath: string | null,
  base: string,
  toolboxRule: string,
): Promise<UnitRow> {
  let report = await dispatchUnit(ctx, dir, planPath, playbook, unit, toolboxRule);
  await guardScope(ctx, waveAllowed, reproPath, base);
  let command = await ctx.commands.run(ctx.repoRoot, unit.verify);
  if (needsAnotherPass(report, command)) {
    report = await dispatchUnit(ctx, dir, planPath, playbook, unit, toolboxRule);
    await guardScope(ctx, waveAllowed, reproPath, base);
    command = await ctx.commands.run(ctx.repoRoot, unit.verify);
    if (needsAnotherPass(report, command)) return toRow(unit.id, 'blocked', report);
  }
  return toRow(unit.id, report.status, report);
}

async function dispatchUnit(
  ctx: PhaseContext,
  dir: string,
  planPath: string,
  playbook: string,
  unit: WorkUnit,
  toolboxRule: string,
): Promise<WorkerReport> {
  const allowed = unit.files.map(stripNew);
  const runDir = join(dir, 'units', unit.id);
  mkdirSync(runDir, { recursive: true });
  const parts = [playbook, `Plan: ${planPath}`, `Unit: ${unit.id}`, `Allowed files: ${allowed.join(', ')}`, `Verify: ${unit.verify}`];
  if (toolboxRule !== '') parts.push(toolboxRule);
  return dispatchWorker(ctx.workers, {
    role: 'implement',
    runDir,
    repoRoot: ctx.repoRoot,
    prompt: parts.join('\n'),
    allowedFiles: allowed,
    unitId: unit.id,
  });
}

async function legalToolboxHold(ctx: PhaseContext, dir: string, porcelain: string): Promise<string[]> {
  if (!ctx.toolboxGit) return [];
  const base = readStatusValue(dir, 'base');
  const at = base?.lastIndexOf('@') ?? -1;
  if (!base || at < 0 || at === base.length - 1) return [];
  const sha = base.slice(at + 1);
  const baseManifest = (await ctx.toolboxGit.show(ctx.repoRoot, sha, `${TOOLBOX_DIR}/manifest.md`)) ?? '';
  const baseNotes = (await ctx.toolboxGit.show(ctx.repoRoot, sha, `${TOOLBOX_DIR}/NOTES.md`)) ?? '';
  const manifestPath = join(ctx.repoRoot, TOOLBOX_DIR, 'manifest.md');
  const notesPath = join(ctx.repoRoot, TOOLBOX_DIR, 'NOTES.md');
  const headManifest = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
  const headNotes = existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : '';
  const baseEntries = parseManifest(baseManifest);
  const headEntries = parseManifest(headManifest);
  const { added, removed } = diffDirectories(
    baseEntries.map((entry) => entry.name),
    headEntries.map((entry) => entry.name),
  );
  const tests: Record<string, string> = {};
  for (const entry of headEntries) tests[entry.name] = entry.test;
  const notesLines = headNotes === '' ? 0 : headNotes.split('\n').filter((line, index, all) => !(index === all.length - 1 && line === '')).length;
  const accept = decideHold({
    baseTools: baseEntries.map((entry) => entry.name),
    added,
    removed,
    notesLines,
    notesChanged: headNotes !== baseNotes,
    tests,
  }) && added.length === 1;
  return toolboxHoldPaths(porcelain, accept);
}

async function revertIllegalToolbox(ctx: PhaseContext, dir: string): Promise<void> {
  const porcelain = await ctx.git.statusPorcelain(ctx.repoRoot);
  const hold = new Set(await legalToolboxHold(ctx, dir, porcelain));
  const tracked: string[] = [];
  const untracked: string[] = [];
  const seenTracked = new Set<string>();
  const seenUntracked = new Set<string>();
  for (const entry of porcelainEntries(porcelain)) {
    if (!isToolboxPath(entry.path) || hold.has(entry.path)) continue;
    if (entry.untracked) {
      if (seenUntracked.has(entry.path)) continue;
      seenUntracked.add(entry.path);
      untracked.push(entry.path);
    } else if (!seenTracked.has(entry.path)) {
      seenTracked.add(entry.path);
      tracked.push(entry.path);
    }
  }
  if (tracked.length > 0) await ctx.git.revert(ctx.repoRoot, tracked);
  if (untracked.length > 0) await ctx.git.deleteUntracked(ctx.repoRoot, untracked);
}

function isToolboxPath(path: string): boolean {
  return path === TOOLBOX_DIR || path.startsWith(`${TOOLBOX_DIR}/`);
}

async function guardScope(
  ctx: PhaseContext,
  allowed: ReadonlySet<string>,
  reproPath: string | null,
  base: string,
): Promise<void> {
  const repoRoot = ctx.repoRoot;
  const porcelain = await ctx.git.statusPorcelain(repoRoot);
  const entries = porcelainEntries(porcelain);
  const hold = new Set<string>();
  if (reproPath) hold.add(reproPath);
  if (ctx.toolboxGit) {
    for (const entry of entries) {
      if (isToolboxPath(entry.path)) hold.add(entry.path);
    }
  }
  await revertOutside(ctx.git, repoRoot, porcelain, allowed, hold);
  if (!reproPath) return;
  const names = await ctx.git.diffNames(repoRoot, base, reproPath);
  if (!entries.some((entry) => entry.path === reproPath) && !names.includes(reproPath)) return;
  await ctx.git.revert(repoRoot, [reproPath]);
  throw new Error('repro test was modified');
}

function needsAnotherPass(report: WorkerReport, command: CommandResult): boolean {
  return report.status !== 'done' || command.ok === false;
}

function toRow(id: string, status: string, report: WorkerReport): UnitRow {
  return { id, status, route: report.route, fallback: report.fallback ?? '-' };
}

function writeImplement(dir: string, rows: UnitRow[]): void {
  const lines = [
    '| ID | Status | Route | Fallback |',
    '| --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.id} | ${row.status} | ${row.route} | ${row.fallback} |`),
    '',
  ];
  writeFileSync(join(dir, 'implement.md'), lines.join('\n'));
}

function stripNew(file: string): string {
  return file.startsWith('new:') ? file.slice(4) : file;
}

function readReproPath(dir: string): string {
  const path = join(dir, 'repro.md');
  if (!existsSync(path)) throw new Error('repro.md is missing');
  const testPath = reproTestPath(reproValue(readFileSync(path, 'utf8'), 'test'));
  if (!testPath) throw new Error('repro test is missing');
  return testPath;
}

function baseSha(value: string | null): string {
  const at = value?.lastIndexOf('@') ?? -1;
  if (!value || at < 0 || at === value.length - 1) throw new Error('base is missing');
  return value.slice(at + 1);
}

function reproValue(markdown: string, key: string): string {
  const prefix = `${key}:`;
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(prefix)) continue;
    return trimmed.slice(prefix.length).trim();
  }
  return '';
}

function reproTestPath(testField: string): string {
  const marker = testField.indexOf('::');
  return (marker === -1 ? testField : testField.slice(0, marker)).trim();
}
