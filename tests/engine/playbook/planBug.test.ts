import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Contract, Flow } from '../../../src/domain/types.js';
import type { PhaseInput, PhaseOutput } from '../../../src/engine/runEngine.js';
import { parsePlan } from '../../../src/engine/playbook/planDoc.js';
import { ensureAttempt } from '../../../src/engine/playbook/runFolder.js';
import type { CommandResult, GitPort, WorkerPort, WorkerTask } from '../../../src/engine/playbook/ports.js';
import type { FilesPort } from '../../../src/runs/runService.js';
import type { SqliteRunStore } from '../../../src/store/runStore.js';
import { runPlanPhase } from '../../../src/engine/playbook/phases/planPhase.js';

const PLAYBOOK_PATH = fileURLToPath(new URL('../../../src/engine/playbooks/plan-bug.md', import.meta.url));
const PLAYBOOK = [
  '# Plan a bug',
  'Add a failing test only, run it twice, and write `repro.md` with `status`, `test`, and `command`. It must not edit production files.',
  'write a unit or integration test with the repo\'s framework. Use Playwright only when `package.json` already contains `@playwright/test`.',
].join('\n');

const NOT_REPRODUCED = `---
status: not-reproduced
---
# Repro
What was tried: called the handler with an empty name.
`;

const REPRODUCED = `---
status: reproduced
test: tests/bug.test.ts::fails
command: pnpm exec vitest run tests/bug.test.ts
allowed: src/handler.ts
---
# Repro
What was tried: called the handler with an empty name.
`;

const ALLOWED_IS_TEST = `---
status: reproduced
test: tests/bug.test.ts::fails
command: pnpm exec vitest run tests/bug.test.ts
allowed: tests/bug.test.ts
---
# Repro
What was tried: called the handler with an empty name.
`;

const FAILURE: CommandResult = { ok: false, output: 'expected 1 received 0' };
const COMMAND = 'pnpm exec vitest run tests/bug.test.ts';

const BRIEF = `# Empty name
## Requirements / acceptance criteria
- An empty name is rejected
`;

function fakeGit(over: Partial<GitPort> = {}): GitPort {
  return {
    isRepo: async () => true,
    statusPorcelain: async () => '',
    originHead: async () => 'main',
    fetch: async () => { throw new Error('fetch was called'); },
    branchExists: async () => false,
    createBranch: async () => {},
    headBranch: async () => 'feat/gh-7',
    headSha: async () => 'abc',
    commitAll: async () => {},
    diffNames: async () => [],
    changedLines: async () => 0,
    push: async () => { throw new Error('push was called'); },
    remoteHead: async () => null,
    revert: async () => {},
    deleteUntracked: async () => {},
    ...over,
  };
}

function contract(): Contract {
  return {
    id: 'fix-handler',
    title: 'Empty name',
    intent: 'Reject an empty name',
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
  git?: Partial<GitPort>;
  repro?: string;
  results?: CommandResult[];
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cf-plan-bug-'));
  const subject = contract();
  const saved: Contract[] = [];
  const updates: { id: string; patch: { contractRevision?: string } }[] = [];
  const workerRuns: WorkerTask[] = [];
  const commandRuns: { root: string; command: string }[] = [];
  const results = options.results ?? [FAILURE, FAILURE];
  const dir = ensureAttempt(root, 'run-1', 1);
  writeFileSync(join(dir, 'status.md'), '- branch: feat/gh-7\n- base: main@abc\n');
  writeFileSync(join(dir, 'brief.md'), BRIEF);
  const git = fakeGit(options.git);
  const workers: WorkerPort = {
    async run(task) {
      workerRuns.push(task);
      if (task.unitId !== 'repro') throw new Error(`unexpected unit ${task.unitId}`);
      writeFileSync(join(task.runDir, 'repro.md'), options.repro ?? REPRODUCED);
      return { status: 'done', filesChanged: ['repro.md'], notes: '', route: task.role };
    },
  };
  const files: FilesPort = {
    load: () => { throw new Error('unused'); },
    readContractFile: () => '',
    saveContract: (next) => {
      saved.push(next);
      return 'rev-saved';
    },
  };
  const store = {
    updateRunState(id: string, patch: { contractRevision?: string }) { updates.push({ id, patch }); },
  } as unknown as SqliteRunStore;
  const input: PhaseInput = { phase: 'plan', attempt: 1, contract: subject, runId: 'run-1' };
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
        const next = results[commandRuns.length - 1] ?? results[results.length - 1];
        return next;
      },
    },
    ci: { waitMs: 0, extraIntervalMs: 0 },
    readPlaybook: (name: string) => {
      if (name !== 'plan-bug.md') throw new Error(`unexpected playbook ${name}`);
      return PLAYBOOK;
    },
    flow: 'bug' as Flow,
  };
  return { root, dir, input, ctx, saved, updates, workerRuns, commandRuns, subject };
}

function expectSavedPlan(h: ReturnType<typeof setup>, output: PhaseOutput): void {
  expect(parsePlan(readFileSync(join(h.dir, 'plan.md'), 'utf8'))).toEqual([
    {
      id: 'U1',
      goal: 'fix the reproduced failure',
      files: ['new:src/handler.ts'],
      dependsOn: [],
      verify: COMMAND,
    },
  ]);
  expect(h.saved).toHaveLength(1);
  expect(h.saved[0].acceptance_criteria).toEqual([
    { id: 'ac-spec', statement: 'kept', gates: ['spec', 'verify', 'commit', 'plan'], evidence: 'brief' },
  ]);
  expect(h.subject.acceptance_criteria).toEqual([
    { id: 'ac-spec', statement: 'kept', gates: ['spec', 'verify', 'commit'], evidence: 'brief' },
  ]);
  expect(h.updates).toEqual([{ id: 'run-1', patch: { contractRevision: 'rev-saved' } }]);
  expect(output.events).toEqual([{ type: 'phase_completed', message: 'plan phase completed (attempt 1)' }]);
  expect(output.evidence).toEqual([{
    attempt: 1,
    phase: 'plan',
    producerPhase: 'plan',
    criterionIds: ['ac-spec'],
    kind: 'plan-summary',
    summary: 'plan for ac-spec',
  }]);
  expect(readFileSync(join(h.dir, 'status.md'), 'utf8')).toContain('- phase: plan');
  expect(readFileSync(join(h.dir, 'status.md'), 'utf8')).toContain('- base: main@abc');
}

describe('runPlanPhase bug', () => {
  it('throws not-reproduced and does not save a contract', async () => {
    const h = setup({ repro: NOT_REPRODUCED });
    await expect(runPlanPhase(h.input, h.ctx)).rejects.toThrow(/not-reproduced/);
    expect(h.workerRuns.map((task) => task.unitId)).toEqual(['repro']);
    expect(h.commandRuns).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
    expect(h.updates).toHaveLength(0);
    expect(existsSync(join(h.dir, 'plan.md'))).toBe(false);
  });

  it('writes a one-unit plan from a deterministic repro and adds a plan gate', async () => {
    const h = setup();
    const output = await runPlanPhase(h.input, h.ctx);
    const reproPath = join(h.dir, 'repro.md');
    expect(h.workerRuns).toHaveLength(1);
    expect(h.workerRuns[0].role).toBe('default');
    expect(h.workerRuns[0].unitId).toBe('repro');
    expect(h.workerRuns[0].prompt).toContain(PLAYBOOK);
    expect(h.workerRuns[0].prompt).toContain(join(h.dir, 'brief.md'));
    expect(h.workerRuns[0].allowedFiles).toEqual([relative(h.root, reproPath)]);
    expect(h.commandRuns).toEqual([
      { root: h.root, command: COMMAND },
      { root: h.root, command: COMMAND },
    ]);
    const units = parsePlan(readFileSync(join(h.dir, 'plan.md'), 'utf8'));
    expect(units).toHaveLength(1);
    expect(units[0].files).toEqual(['new:src/handler.ts']);
    expect(units[0].files.includes('tests/bug.test.ts')).toBe(false);
    expect(units[0].files.includes('new:tests/bug.test.ts')).toBe(false);
    expect(units[0].verify).toBe(COMMAND);
    expectSavedPlan(h, output);
  });

  it('accepts two failures that share a last non-empty line', async () => {
    const h = setup({
      results: [
        { ok: false, output: 'setup\nexpected 1 received 0\n' },
        { ok: false, output: 'other\nexpected 1 received 0' },
      ],
    });
    const output = await runPlanPhase(h.input, h.ctx);
    expect(h.commandRuns).toHaveLength(2);
    expectSavedPlan(h, output);
  });

  it('throws when the second repro run does not fail', async () => {
    const h = setup({ results: [FAILURE, { ok: true, output: '' }] });
    await expect(runPlanPhase(h.input, h.ctx)).rejects.toThrow(/not deterministic/);
    expect(h.commandRuns).toHaveLength(2);
    expect(h.saved).toHaveLength(0);
    expect(h.updates).toHaveLength(0);
    expect(existsSync(join(h.dir, 'plan.md'))).toBe(false);
  });

  it('throws when both failures end on different lines', async () => {
    const h = setup({
      results: [
        { ok: false, output: 'expected 1 received 0' },
        { ok: false, output: 'expected 2 received 0' },
      ],
    });
    await expect(runPlanPhase(h.input, h.ctx)).rejects.toThrow(/not deterministic/);
    expect(h.saved).toHaveLength(0);
    expect(existsSync(join(h.dir, 'plan.md'))).toBe(false);
  });

  it('throws when the allowed path is the repro test', async () => {
    const h = setup({ repro: ALLOWED_IS_TEST });
    await expect(runPlanPhase(h.input, h.ctx)).rejects.toThrow(/repro test is not an allowed file/);
    expect(h.saved).toHaveLength(0);
    expect(h.updates).toHaveLength(0);
    expect(existsSync(join(h.dir, 'plan.md'))).toBe(false);
  });

  it('commits only the repro test after a deterministic failure', async () => {
    let reads = 0;
    const commits: { root: string; message: string }[] = [];
    const order: string[] = [];
    const h = setup({
      git: {
        statusPorcelain: async () => {
          reads += 1;
          return reads === 1 ? '' : ' M src/handler.ts\n?? src/other.ts\n?? tests/bug.test.ts';
        },
        commitAll: async (repoRoot, message) => {
          order.push(`commit:${message}`);
          commits.push({ root: repoRoot, message });
        },
        revert: async (_repo, paths) => { order.push(`revert:${paths.join(',')}`); },
        deleteUntracked: async (_repo, paths) => { order.push(`delete:${paths.join(',')}`); },
      },
    });
    await runPlanPhase(h.input, h.ctx);
    expect(order).toEqual([
      'revert:src/handler.ts',
      'delete:src/other.ts',
      'commit:test: reproduce the bug',
    ]);
    expect(commits).toEqual([{ root: h.root, message: 'test: reproduce the bug' }]);
    expect(order.join(' ')).not.toContain('tests/bug.test.ts');
  });

  it('throws when the working tree is dirty and does not call a worker', async () => {
    const h = setup({ git: { statusPorcelain: async () => ' M src/handler.ts' } });
    await expect(runPlanPhase(h.input, h.ctx)).rejects.toThrow(/working tree is dirty/);
    expect(h.workerRuns).toHaveLength(0);
    expect(h.commandRuns).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
  });
});

describe('plan-bug.md', () => {
  it('tells the worker to reproduce with a failing test and not to edit production files', () => {
    const text = readFileSync(PLAYBOOK_PATH, 'utf8');
    expect(text).toContain('Add a failing test only, run it twice, and write `repro.md` with `status`, `test`, and `command`.');
    expect(text).toContain('must not edit production files');
    expect(text).toContain('write a unit or integration test with the repo\'s framework. Use Playwright only when `package.json` already contains `@playwright/test`.');
    expect(text).toContain('allowed:');
  });
});
