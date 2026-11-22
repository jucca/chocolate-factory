import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Contract, Flow, GateId } from '../../../domain/types.js';
import type { PhaseInput, PhaseOutput } from '../../runEngine.js';
import { dispatchWorker } from '../dispatchWorker.js';
import { buildWaves, parseAcceptanceIds, parsePlan, topLevelDirs, type WorkUnit } from '../planDoc.js';
import type { CommandResult } from '../ports.js';
import type { PhaseContext } from './specPhase.js';
import { porcelainEntries, revertOutside } from '../porcelain.js';
import { appendStatus, ensureAttempt, readStatusValue } from '../runFolder.js';
import { readToolboxText, toolboxPrompt } from '../toolbox.js';

const WHERE = 'Where does the behavior live?';
const HOW_TESTED = 'How is it tested?';
const PATTERNS = 'What patterns should be reused?';
const INTEGRATIONS = 'What integrations or public APIs are affected?';

export async function runPlanPhase(input: PhaseInput, ctx: PhaseContext & { flow: Flow }): Promise<PhaseOutput> {
  const repoRoot = ctx.repoRoot;
  const dir = ensureAttempt(repoRoot, input.runId, input.attempt);
  const porcelain = await ctx.git.statusPorcelain(repoRoot);
  if (porcelain !== '') throw new Error('working tree is dirty');
  const expected = readStatusValue(dir, 'branch');
  const actual = await ctx.git.headBranch(repoRoot);
  if (actual !== expected) throw new Error(`HEAD is ${actual}, expected ${expected}`);
  if (ctx.flow === 'bug') return planBug(input, ctx, dir);

  await explore(ctx, dir, 'explore-where', WHERE);
  await explore(ctx, dir, 'explore-tests', HOW_TESTED);
  const notes = readFileSync(join(dir, 'explore.md'), 'utf8');
  if (topLevelDirs(notes).length > 1) {
    await explore(ctx, dir, 'explore-patterns', PATTERNS);
    await explore(ctx, dir, 'explore-integrations', INTEGRATIONS);
  }

  await dispatchPlan(ctx, dir, 'plan');
  let problem = checkPlan(repoRoot, dir);
  if (problem) {
    await dispatchPlan(ctx, dir, 'plan-fix', problem);
    problem = checkPlan(repoRoot, dir);
    if (problem) throw new Error(`plan check failed: ${problem}`);
  }

  return finishPlan(input, ctx, dir);
}

async function planBug(input: PhaseInput, ctx: PhaseContext, dir: string): Promise<PhaseOutput> {
  const reproPath = join(dir, 'repro.md');
  const toolbox = toolboxPrompt(await readToolboxText(ctx.toolboxGit, ctx.repoRoot, baseSha(readStatusValue(dir, 'base'))));
  await dispatchWorker(ctx.workers, {
    role: 'default',
    runDir: dir,
    repoRoot: ctx.repoRoot,
    prompt: [ctx.readPlaybook('plan-bug.md'), `Brief: ${join(dir, 'brief.md')}`, `Write ${reproPath}`, toolbox].filter((part) => part !== '').join('\n'),
    allowedFiles: [relative(ctx.repoRoot, reproPath)],
    unitId: 'repro',
  });
  const repro = readFileSync(reproPath, 'utf8');
  if (reproValue(repro, 'status') !== 'reproduced') throw new Error('not-reproduced');
  const command = reproValue(repro, 'command');
  const first = await ctx.commands.run(ctx.repoRoot, command);
  const second = await ctx.commands.run(ctx.repoRoot, command);
  if (!sameFailure(first, second)) throw new Error('failure is not deterministic');
  const allowed = reproValue(repro, 'allowed');
  const testPath = reproTestPath(reproValue(repro, 'test'));
  if (allowed === testPath) throw new Error('repro test is not an allowed file');
  await commitReproTest(ctx, testPath);
  writeFileSync(join(dir, 'plan.md'), oneUnitPlan(allowed, command));
  return finishPlan(input, ctx, dir);
}

async function commitReproTest(ctx: PhaseContext, testPath: string): Promise<void> {
  if (!testPath) return;
  const porcelain = await ctx.git.statusPorcelain(ctx.repoRoot);
  const entries = porcelainEntries(porcelain);
  await revertOutside(ctx.git, ctx.repoRoot, porcelain, new Set([testPath]));
  if (!entries.some((entry) => entry.path === testPath)) return;
  await ctx.git.commitAll(ctx.repoRoot, 'test: reproduce the bug');
}

function finishPlan(input: PhaseInput, ctx: PhaseContext, dir: string): PhaseOutput {
  const plan = readFileSync(join(dir, 'plan.md'), 'utf8');
  const next = withPlanCriteria(input.contract, plan);
  const revision = ctx.files.saveContract(next);
  ctx.store.updateRunState(input.runId, { contractRevision: revision });
  appendStatus(dir, '- phase: plan');

  const criterionIds = next.acceptance_criteria
    .filter((criterion) => criterion.gates.includes('plan'))
    .map((criterion) => criterion.id);
  return {
    events: [{ type: 'phase_completed', message: `plan phase completed (attempt ${input.attempt})` }],
    evidence: [{
      attempt: input.attempt,
      phase: 'plan',
      producerPhase: 'plan',
      criterionIds,
      kind: 'plan-summary',
      summary: `plan for ${criterionIds.join(', ')}`,
    }],
  };
}

async function explore(ctx: PhaseContext, dir: string, unitId: string, question: string): Promise<void> {
  const report = await dispatchWorker(ctx.workers, {
    role: 'default',
    runDir: dir,
    repoRoot: ctx.repoRoot,
    prompt: explorePrompt(dir, question),
    allowedFiles: [],
    unitId,
  });
  appendFileSync(join(dir, 'explore.md'), `## ${unitId}\n${report.notes.trim()}\n`);
}

function explorePrompt(dir: string, question: string): string {
  return [`Brief: ${join(dir, 'brief.md')}`, question, 'Keep the report to at most 40 lines.'].join('\n');
}

async function dispatchPlan(ctx: PhaseContext, dir: string, unitId: string, problem?: string): Promise<void> {
  const planPath = join(dir, 'plan.md');
  const toolbox = toolboxPrompt(await readToolboxText(ctx.toolboxGit, ctx.repoRoot, baseSha(readStatusValue(dir, 'base'))));
  const lines = [
    ctx.readPlaybook('plan-feature.md'),
    `Brief: ${join(dir, 'brief.md')}`,
    `Explore: ${join(dir, 'explore.md')}`,
    `Write ${planPath}`,
  ];
  if (problem) lines.push(`plan check failed: ${problem}`);
  if (toolbox) lines.push(toolbox);
  await dispatchWorker(ctx.workers, {
    role: 'default',
    runDir: dir,
    repoRoot: ctx.repoRoot,
    prompt: lines.join('\n'),
    allowedFiles: [relative(ctx.repoRoot, planPath)],
    unitId,
  });
}

function baseSha(value: string | null): string {
  const at = value?.lastIndexOf('@') ?? -1;
  if (!value || at < 0 || at === value.length - 1) return '';
  return value.slice(at + 1);
}

function checkPlan(repoRoot: string, dir: string): string | null {
  const path = join(dir, 'plan.md');
  if (!existsSync(path)) return 'plan.md was not written';
  const markdown = readFileSync(path, 'utf8');
  const units = parsePlan(markdown);
  for (const unit of units) {
    for (const file of unit.files) {
      if (file.startsWith('new:')) continue;
      if (!existsSync(join(repoRoot, file))) return `${file} does not exist`;
    }
  }
  const share = unorderedShare(units);
  if (share) return share;
  try {
    buildWaves(units);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const testPlan = section(markdown, '## Test plan');
  for (const id of parseAcceptanceIds(markdown)) {
    if (!new RegExp(`(?:^|[^A-Z0-9])${id}(?![0-9])`).test(testPlan)) return `${id} is missing from the test plan`;
  }
  return null;
}

function unorderedShare(units: WorkUnit[]): string | null {
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const left = units[i];
      const right = units[j];
      if (left.dependsOn.includes(right.id) || right.dependsOn.includes(left.id)) continue;
      const leftFiles = new Set(left.files.map(stripNew));
      for (const file of right.files.map(stripNew)) {
        if (leftFiles.has(file)) return `${left.id} and ${right.id} share ${file}`;
      }
    }
  }
  return null;
}

function stripNew(file: string): string {
  return file.startsWith('new:') ? file.slice(4) : file;
}

function oneUnitPlan(allowed: string, command: string): string {
  return [
    '| ID | Goal | Files (create/modify) | Depends on | Verify with |',
    '| --- | --- | --- | --- | --- |',
    `| U1 | fix the reproduced failure | new:${allowed} | - | ${command} |`,
    '',
  ].join('\n');
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

function lastNonEmptyLine(output: string): string {
  let last = '';
  for (const line of output.split('\n')) {
    if (line.trim() !== '') last = line.trim();
  }
  return last;
}

function sameFailure(first: CommandResult, second: CommandResult): boolean {
  return first.ok === false
    && second.ok === false
    && lastNonEmptyLine(first.output) === lastNonEmptyLine(second.output);
}

function section(markdown: string, heading: string): string {
  const lines: string[] = [];
  let collecting = false;
  for (const line of markdown.split('\n')) {
    if (!collecting) {
      if (line.trim() === heading) collecting = true;
      continue;
    }
    if (line.startsWith('## ')) break;
    lines.push(line);
  }
  return lines.join('\n');
}

function acceptanceStatements(markdown: string): Map<string, string> {
  const statements = new Map<string, string>();
  for (const line of markdown.split('\n')) {
    const match = line.match(/^- (AC\d+):\s*(.*)$/);
    if (!match || statements.has(match[1])) continue;
    statements.set(match[1], match[2].trim());
  }
  return statements;
}

function withPlanCriteria(contract: Contract, markdown: string): Contract {
  const next: Contract = {
    ...contract,
    acceptance_criteria: contract.acceptance_criteria.map((criterion) => ({
      ...criterion,
      gates: [...criterion.gates],
    })),
  };
  const statements = acceptanceStatements(markdown);
  const known = new Set(next.acceptance_criteria.map((criterion) => criterion.id));
  for (const id of parseAcceptanceIds(markdown)) {
    if (known.has(id)) continue;
    next.acceptance_criteria.push({
      id,
      statement: statements.get(id) ?? id,
      gates: ['plan', 'verify', 'commit'] as GateId[],
      evidence: 'plan-summary',
    });
    known.add(id);
  }
  if (!next.acceptance_criteria.some((criterion) => criterion.gates.includes('plan'))) {
    next.acceptance_criteria[0]?.gates.push('plan');
  }
  return next;
}
