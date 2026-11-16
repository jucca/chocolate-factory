import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Flow } from '../../../domain/types.js';
import type { PhaseInput, PhaseOutput } from '../../runEngine.js';
import { dispatchWorker } from '../dispatchWorker.js';
import { buildWaves, parsePlan, type WorkUnit } from '../planDoc.js';
import type { CommandResult, WorkerReport } from '../ports.js';
import { porcelainEntries, revertOutside } from '../porcelain.js';
import { appendStatus, ensureAttempt, readStatusValue } from '../runFolder.js';
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
  const planPath = join(dir, 'plan.md');
  const playbook = ctx.readPlaybook('implement.md');
  const waves = buildWaves(parsePlan(readFileSync(planPath, 'utf8')));
  const rows: UnitRow[] = [];

  for (const wave of waves) {
    const waveAllowed = new Set(wave.flatMap((unit) => unit.files.map(stripNew)));
    const waveRows = await Promise.all(wave.map((unit) => runUnit(
      ctx, dir, planPath, playbook, unit, waveAllowed, reproPath, base,
    )));
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
): Promise<UnitRow> {
  let report = await dispatchUnit(ctx, dir, planPath, playbook, unit);
  await guardScope(ctx, waveAllowed, reproPath, base);
  let command = await ctx.commands.run(ctx.repoRoot, unit.verify);
  if (needsAnotherPass(report, command)) {
    report = await dispatchUnit(ctx, dir, planPath, playbook, unit);
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
): Promise<WorkerReport> {
  const allowed = unit.files.map(stripNew);
  const runDir = join(dir, 'units', unit.id);
  mkdirSync(runDir, { recursive: true });
  return dispatchWorker(ctx.workers, {
    role: 'implement',
    runDir,
    repoRoot: ctx.repoRoot,
    prompt: [playbook, `Plan: ${planPath}`, `Unit: ${unit.id}`, `Allowed files: ${allowed.join(', ')}`, `Verify: ${unit.verify}`].join('\n'),
    allowedFiles: allowed,
    unitId: unit.id,
  });
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
