import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Contract, Flow } from '../../../src/domain/types.js';
import type { PhaseInput } from '../../../src/engine/runEngine.js';
import { ensureAttempt } from '../../../src/engine/playbook/runFolder.js';
import type { CommandResult, GitPort, WorkerPort, WorkerReport, WorkerTask } from '../../../src/engine/playbook/ports.js';
import type { FilesPort } from '../../../src/runs/runService.js';
import type { SqliteRunStore } from '../../../src/store/runStore.js';
import { runTestPhase } from '../../../src/engine/playbook/phases/testPhase.js';

const PLAN = [
  '## Test plan',
  '- cmd: pnpm test',
  '- cmd: pnpm exec tsc --noEmit',
  '',
].join('\n');

const REPRO = [
  'test: tests/bug.test.ts::name',
  'command: pnpm exec vitest run tests/bug.test.ts',
  '',
].join('\n');

function fakeGit(over: Partial<GitPort> = {}): GitPort {
  const unused = async () => {
    throw new Error('git was called');
  };
  return {
    isRepo: unused,
    statusPorcelain: async () => '',
    originHead: unused,
    fetch: unused,
    branchExists: unused,
    createBranch: unused,
    headBranch: async () => 'feat/gh-7',
    headSha: unused,
    commitAll: unused,
    diffNames: async () => [],
    changedLines: unused,
    push: unused,
    remoteHead: unused,
    revert: unused,
    deleteUntracked: unused,
    ...over,
  };
}

function contract(): Contract {
  return {
    id: 'feat-inbox',
    title: 'Inbox',
    intent: 'List issues',
    acceptance_criteria: [
      { id: 'ac-spec', statement: 'kept', gates: ['spec', 'verify', 'commit'], evidence: 'brief' },
    ],
    constraints: [],
    out_of_scope: [],
    linked_issue: null,
    milestone: 'm1',
    dependencies: [],
  };
}

function setup(options: {
  flow?: Flow;
  git?: Partial<GitPort>;
  results?: Record<string, CommandResult[]>;
  changed?: string[];
  diffForPath?: string[];
  repro?: string;
  plan?: string;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cf-test-phase-'));
  const workerRuns: WorkerTask[] = [];
  const commandRuns: { root: string; command: string }[] = [];
  const diffCalls: { root: string; base: string; path?: string }[] = [];
  const order: string[] = [];
  const dir = ensureAttempt(root, 'run-1', 1);
  writeFileSync(join(dir, 'status.md'), '- base: main@abc\n- branch: feat/gh-7\n');
  writeFileSync(join(dir, 'plan.md'), options.plan ?? PLAN);
  writeFileSync(join(dir, 'implement.md'), 'existing row\n');
  if (options.repro !== undefined) writeFileSync(join(dir, 'repro.md'), options.repro);
  const queues = new Map<string, CommandResult[]>();
  for (const [command, results] of Object.entries(options.results ?? {})) queues.set(command, [...results]);
  const git = fakeGit({
    diffNames: async (repoRoot, base, path) => {
      diffCalls.push({ root: repoRoot, base, path });
      if (path) return options.diffForPath ?? [];
      return options.changed ?? [];
    },
    ...options.git,
  });
  const workers: WorkerPort = {
    async run(task) {
      workerRuns.push(task);
      order.push(`worker:${task.unitId}`);
      const report: WorkerReport = { status: 'done', filesChanged: [], notes: '', route: task.role };
      return report;
    },
  };
  const files: FilesPort = {
    load: () => { throw new Error('unused'); },
    readContractFile: () => '',
    saveContract: () => { throw new Error('saveContract was called'); },
  };
  const store = {
    updateRunState() { throw new Error('updateRunState was called'); },
  } as unknown as SqliteRunStore;
  const input: PhaseInput = { phase: 'test', attempt: 1, contract: contract(), runId: 'run-1' };
  const ctx = {
    repoRoot: root,
    files,
    store,
    git,
    forge: {
      defaultBranch: async () => { throw new Error('gh was called'); },
      readIssue: async () => { throw new Error('gh was called'); },
      viewPr: async () => { throw new Error('gh was called'); },
      upsertPr: async () => { throw new Error('gh was called'); },
      checks: async () => { throw new Error('gh was called'); },
      rerunFailed: async () => { throw new Error('gh was called'); },
      failedLog: async () => { throw new Error('gh was called'); },
    },
    workers,
    commands: {
      async run(repoRoot: string, command: string) {
        commandRuns.push({ root: repoRoot, command });
        order.push(`cmd:${command}`);
        const queue = queues.get(command);
        if (!queue || queue.length === 0) return { ok: true, output: `${command} passed` };
        return queue.length === 1 ? queue[0] : queue.shift()!;
      },
    },
    ci: { waitMs: 0, extraIntervalMs: 0 },
    readPlaybook: () => { throw new Error('playbook was read'); },
    flow: options.flow ?? 'feature',
  };
  return { root, dir, input, ctx, workerRuns, commandRuns, diffCalls, order };
}

describe('runTestPhase', () => {
  it('records test-summary when every plan command passes and does not call a worker', async () => {
    const h = setup();
    const output = await runTestPhase(h.input, h.ctx);
    expect(h.order).toEqual(['cmd:pnpm test', 'cmd:pnpm exec tsc --noEmit']);
    expect(h.workerRuns).toHaveLength(0);
    expect(h.diffCalls).toHaveLength(0);
    expect(h.commandRuns.every((run) => run.root === h.root)).toBe(true);
    expect(output.events).toEqual([
      { type: 'phase_completed', message: 'test phase completed (attempt 1)' },
    ]);
    expect(output.evidence).toEqual([{
      attempt: 1,
      phase: 'test',
      producerPhase: 'test',
      criterionIds: [],
      kind: 'test-summary',
      summary: 'pnpm test ok\npnpm exec tsc --noEmit ok',
    }]);
    const implement = readFileSync(join(h.dir, 'implement.md'), 'utf8');
    expect(implement.startsWith('existing row\n')).toBe(true);
    expect(implement).toContain('pnpm test');
    expect(implement).toContain('pnpm test passed');
    expect(implement).toContain('pnpm exec tsc --noEmit');
    expect(implement).toContain('pnpm exec tsc --noEmit passed');
    expect(readFileSync(join(h.dir, 'status.md'), 'utf8')).toContain('- phase: test');
  });

  it('dispatches one implement worker after the first failure, then both commands pass', async () => {
    const changed = ['src/a.ts', 'src/b.ts'];
    const h = setup({
      changed,
      results: {
        'pnpm test': [
          { ok: false, output: 'unit failed' },
          { ok: true, output: 'unit passed' },
        ],
      },
    });
    const output = await runTestPhase(h.input, h.ctx);
    expect(h.order).toEqual([
      'cmd:pnpm test',
      'worker:integrate-1',
      'cmd:pnpm test',
      'cmd:pnpm exec tsc --noEmit',
    ]);
    expect(h.workerRuns).toHaveLength(1);
    expect(h.workerRuns[0]).toMatchObject({
      role: 'implement',
      runDir: join(h.dir, 'units', 'integrate-1'),
      repoRoot: h.root,
      unitId: 'integrate-1',
      allowedFiles: changed,
    });
    expect(h.workerRuns[0].runDir).not.toBe(h.dir);
    expect(h.diffCalls).toEqual([{ root: h.root, base: 'abc', path: undefined }]);
    expect(output.evidence[0]).toMatchObject({
      kind: 'test-summary',
      criterionIds: [],
      summary: 'pnpm test ok\npnpm exec tsc --noEmit ok',
    });
    expect(readFileSync(join(h.dir, 'implement.md'), 'utf8')).toContain('unit failed');
  });

  it('throws after two integration workers and does not call a third', async () => {
    const h = setup({
      changed: ['src/a.ts'],
      results: {
        'pnpm test': [{ ok: false, output: 'still red' }],
      },
    });
    await expect(runTestPhase(h.input, h.ctx)).rejects.toThrow(/integration checks failed/);
    expect(h.order).toEqual([
      'cmd:pnpm test',
      'worker:integrate-1',
      'cmd:pnpm test',
      'worker:integrate-2',
      'cmd:pnpm test',
    ]);
    expect(h.workerRuns.map((task) => task.unitId)).toEqual(['integrate-1', 'integrate-2']);
    expect(h.workerRuns.every((task) => task.role === 'implement')).toBe(true);
    expect(h.workerRuns[0].runDir).toBe(join(h.dir, 'units', 'integrate-1'));
    expect(h.workerRuns[1].runDir).toBe(join(h.dir, 'units', 'integrate-2'));
    expect(h.workerRuns[0].allowedFiles).toEqual(['src/a.ts']);
    expect(h.workerRuns[1].allowedFiles).toEqual(['src/a.ts']);
    expect(readFileSync(join(h.dir, 'status.md'), 'utf8')).not.toContain('- phase: test');
  });

  it('returns evidence for a bug when the repro command passes and its diff is empty', async () => {
    const h = setup({ flow: 'bug', repro: REPRO });
    const output = await runTestPhase(h.input, h.ctx);
    expect(h.order).toEqual([
      'cmd:pnpm test',
      'cmd:pnpm exec tsc --noEmit',
      'cmd:pnpm exec vitest run tests/bug.test.ts',
    ]);
    expect(h.workerRuns).toHaveLength(0);
    expect(h.diffCalls).toEqual([{ root: h.root, base: 'abc', path: 'tests/bug.test.ts' }]);
    expect(output.evidence[0]).toMatchObject({ kind: 'test-summary', criterionIds: [] });
    expect(output.evidence[0].summary).toContain('pnpm test');
    expect(output.evidence[0].summary).toContain('pnpm exec tsc --noEmit');
    expect(output.evidence[0].summary).toContain('ok');
  });

  it('throws when the repro test differs from base', async () => {
    const h = setup({
      flow: 'bug',
      repro: REPRO,
      diffForPath: ['tests/bug.test.ts'],
    });
    await expect(runTestPhase(h.input, h.ctx)).rejects.toThrow(/repro test diff/);
    expect(h.workerRuns).toHaveLength(0);
    expect(h.diffCalls).toEqual([{ root: h.root, base: 'abc', path: 'tests/bug.test.ts' }]);
    expect(h.order).toContain('cmd:pnpm exec vitest run tests/bug.test.ts');
  });

  it('throws when the working tree is dirty and does not run commands', async () => {
    const h = setup({ git: { statusPorcelain: async () => ' M src/a.ts' } });
    await expect(runTestPhase(h.input, h.ctx)).rejects.toThrow(/working tree is dirty/);
    expect(h.workerRuns).toHaveLength(0);
    expect(h.commandRuns).toHaveLength(0);
    expect(h.diffCalls).toHaveLength(0);
  });

  it('throws when HEAD is not the branch recorded in status', async () => {
    const h = setup({ git: { headBranch: async () => 'main' } });
    await expect(runTestPhase(h.input, h.ctx)).rejects.toThrow('HEAD is main, expected feat/gh-7');
    expect(h.workerRuns).toHaveLength(0);
    expect(h.commandRuns).toHaveLength(0);
  });
});
