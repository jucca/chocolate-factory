import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Flow } from '../../../domain/types.js';
import type { PhaseInput, PhaseOutput } from '../../runEngine.js';
import { dispatchWorker } from '../dispatchWorker.js';
import type { CommandResult } from '../ports.js';
import { revertOutside } from '../porcelain.js';
import { appendStatus, ensureAttempt, readStatusValue } from '../runFolder.js';
import type { PhaseContext } from './specPhase.js';

const INTEGRATION_UNITS = ['integrate-1', 'integrate-2'] as const;

interface FailedCommand {
  command: string;
  output: string;
}

export async function runTestPhase(input: PhaseInput, ctx: PhaseContext & { flow: Flow }): Promise<PhaseOutput> {
  const repoRoot = ctx.repoRoot;
  const dir = ensureAttempt(repoRoot, input.runId, input.attempt);
  const porcelain = await ctx.git.statusPorcelain(repoRoot);
  if (porcelain !== '') throw new Error('working tree is dirty');
  const expected = readStatusValue(dir, 'branch');
  const actual = await ctx.git.headBranch(repoRoot);
  if (actual !== expected) throw new Error(`HEAD is ${actual}, expected ${expected}`);

  const commands = testCommands(readFileSync(join(dir, 'plan.md'), 'utf8'));
  await runUntilGreen(ctx, dir, commands);
  if (ctx.flow === 'bug') await checkRepro(ctx, dir);

  appendStatus(dir, '- phase: test');
  return {
    events: [{ type: 'phase_completed', message: `test phase completed (attempt ${input.attempt})` }],
    evidence: [{
      attempt: input.attempt,
      phase: 'test',
      producerPhase: 'test',
      criterionIds: [],
      kind: 'test-summary',
      summary: commands.map((command) => `${command} ok`).join('\n'),
    }],
  };
}

async function runUntilGreen(ctx: PhaseContext, dir: string, commands: string[]): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const failed = await runCommands(ctx, dir, commands);
    if (!failed) return;
    const unitId = INTEGRATION_UNITS[attempt];
    if (!unitId) throw new Error('integration checks failed');
    await dispatchIntegration(ctx, dir, commands, failed, unitId);
  }
}

async function runCommands(ctx: PhaseContext, dir: string, commands: string[]): Promise<FailedCommand | null> {
  for (const command of commands) {
    const result = await ctx.commands.run(ctx.repoRoot, command);
    appendOutput(dir, command, result);
    if (!result.ok) return { command, output: result.output };
  }
  return null;
}

async function dispatchIntegration(
  ctx: PhaseContext,
  dir: string,
  commands: string[],
  failed: FailedCommand,
  unitId: string,
): Promise<void> {
  const repoRoot = ctx.repoRoot;
  const allowed = await ctx.git.diffNames(repoRoot, baseSha(readStatusValue(dir, 'base')));
  const runDir = join(dir, 'units', unitId);
  mkdirSync(runDir, { recursive: true });
  await dispatchWorker(ctx.workers, {
    role: 'implement',
    runDir,
    repoRoot,
    prompt: [
      `Plan: ${join(dir, 'plan.md')}`,
      `Failed command: ${failed.command}`,
      failed.output,
      `Allowed files: ${allowed.join(', ')}`,
      ...commands.map((command) => `- cmd: ${command}`),
    ].join('\n'),
    allowedFiles: allowed,
    unitId,
  });
  await commitIntegration(ctx, allowed);
}

async function commitIntegration(ctx: PhaseContext, allowed: readonly string[]): Promise<void> {
  const repoRoot = ctx.repoRoot;
  const porcelain = await ctx.git.statusPorcelain(repoRoot);
  if (porcelain === '') return;
  await revertOutside(ctx.git, repoRoot, porcelain, new Set(allowed));
  if ((await ctx.git.statusPorcelain(repoRoot)) === '') return;
  await ctx.git.commitAll(repoRoot, 'fix: integration checks');
}

async function checkRepro(ctx: PhaseContext, dir: string): Promise<void> {
  const markdown = readRepro(dir);
  const reproPath = reproTestPath(reproValue(markdown, 'test'));
  if (!reproPath) throw new Error('repro test is missing');
  const command = reproValue(markdown, 'command');
  if (!command) throw new Error('repro command is missing');
  const result = await ctx.commands.run(ctx.repoRoot, command);
  appendOutput(dir, command, result);
  if (!result.ok) throw new Error('repro command failed');
  const names = await ctx.git.diffNames(ctx.repoRoot, baseSha(readStatusValue(dir, 'base')), reproPath);
  if (names.length > 0) throw new Error('repro test diff');
}

function appendOutput(dir: string, command: string, result: CommandResult): void {
  const body = result.output.endsWith('\n') || result.output === '' ? result.output : `${result.output}\n`;
  appendFileSync(join(dir, 'implement.md'), `$ ${command}\n${result.ok ? 'ok' : 'failed'}\n${body}`);
}

function testCommands(markdown: string): string[] {
  const commands: string[] = [];
  let collecting = false;
  for (const line of markdown.split('\n')) {
    if (!collecting) {
      if (line.trim() === '## Test plan') collecting = true;
      continue;
    }
    if (line.startsWith('## ')) break;
    const trimmed = line.trim();
    const prefix = '- cmd: ';
    if (!trimmed.startsWith(prefix)) continue;
    const command = trimmed.slice(prefix.length).trim();
    if (command) commands.push(command);
  }
  return commands;
}

function readRepro(dir: string): string {
  const path = join(dir, 'repro.md');
  if (!existsSync(path)) throw new Error('repro.md is missing');
  return readFileSync(path, 'utf8');
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
