import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Contract, Flow } from '../../../src/domain/types.js';
import type { PhaseInput } from '../../../src/engine/runEngine.js';
import { parsePlan } from '../../../src/engine/playbook/planDoc.js';
import { attemptDir, ensureAttempt, readStatusValue } from '../../../src/engine/playbook/runFolder.js';
import type { GitPort, WorkerPort, WorkerTask } from '../../../src/engine/playbook/ports.js';
import type { FilesPort } from '../../../src/runs/runService.js';
import type { SqliteRunStore } from '../../../src/store/runStore.js';
import { runPlanPhase } from '../../../src/engine/playbook/phases/planPhase.js';

const PLAYBOOK_PATH = fileURLToPath(new URL('../../../src/engine/playbooks/plan-feature.md', import.meta.url));
const PLAYBOOK = [
  '# Plan a feature',
  'Write plan.md.',
  '## Acceptance criteria',
  '- AC1: <testable statement>',
  '## Test plan',
  'Mention every acceptance criterion id.',
  '| ID | Goal | Files (create/modify) | Depends on | Verify with |',
  'Two units must not share a file unless one depends on the other.',
  'Prefix files that do not exist with `new:`.',
].join('\n');

const WHERE = 'Where does the behavior live?';
const HOW_TESTED = 'How is it tested?';
const PATTERNS = 'What patterns should be reused?';
const INTEGRATIONS = 'What integrations or public APIs are affected?';

const VALID_PLAN = `# Plan
## Acceptance criteria
- AC1: The inbox lists the issue

## Test plan
- AC1 is covered by the unit check

| ID | Goal | Files (create/modify) | Depends on | Verify with |
| --- | --- | --- | --- | --- |
| U1 | add the inbox | new:src/a.ts | - | pnpm test src/a.test.ts |
`;

const SHARED_PLAN = `# Plan
## Acceptance criteria
- AC1: The inbox lists the issue

## Test plan
- AC1 is covered by the unit check

| ID | Goal | Files (create/modify) | Depends on | Verify with |
| --- | --- | --- | --- | --- |
| U1 | one | src/a.ts | - | pnpm test src/a.test.ts |
| U2 | two | src/a.ts | - | pnpm test src/a.test.ts |
`;

const ORDERED_SHARE_PLAN = `# Plan
## Acceptance criteria
- AC1: The inbox lists the issue

## Test plan
- AC1 is covered by the unit check

| ID | Goal | Files (create/modify) | Depends on | Verify with |
| --- | --- | --- | --- | --- |
| U1 | one | src/a.ts | - | pnpm test src/a.test.ts |
| U2 | two | src/a.ts | U1 | pnpm test src/a.test.ts |
`;

const MISSING_AC_PLAN = `# Plan
## Acceptance criteria
- AC1: one
- AC10: ten

## Test plan
- AC10 is covered

| ID | Goal | Files (create/modify) | Depends on | Verify with |
| --- | --- | --- | --- | --- |
| U1 | add | new:src/a.ts | - | pnpm test src/a.test.ts |
`;

const MISSING_FILE_PLAN = `# Plan
## Acceptance criteria
- AC1: one

## Test plan
- AC1 is covered

| ID | Goal | Files (create/modify) | Depends on | Verify with |
| --- | --- | --- | --- | --- |
| U1 | add | src/missing.ts | - | pnpm test src/a.test.ts |
`;

const CYCLE_PLAN = `# Plan
## Acceptance criteria
- AC1: one

## Test plan
- AC1 is covered

| ID | Goal | Files (create/modify) | Depends on | Verify with |
| --- | --- | --- | --- | --- |
| U1 | a | new:src/a.ts | U2 | pnpm test a |
| U2 | b | new:src/b.ts | U1 | pnpm test b |
`;

const BRIEF = `# Inbox
## Requirements / acceptance criteria
- The inbox lists the issue
`;

function fakeGit(over: Partial<GitPort> = {}): GitPort {
  return {
    isRepo: async () => true,
    statusPorcelain: async () => '',
    originHead: async () => 'main',
    fetch: async () => {},
    branchExists: async () => false,
    createBranch: async () => {},
    headBranch: async () => 'feat/gh-7',
    headSha: async () => 'abc',
    commitAll: async () => {},
    diffNames: async () => [],
    changedLines: async () => 0,
    push: async () => {},
    remoteHead: async () => null,
    revert: async () => {},
    deleteUntracked: async () => {},
    ...over,
  };
}

function contract(over: Partial<Contract> = {}): Contract {
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
    ...over,
  };
}

function setup(options: {
  git?: Partial<GitPort>;
  flow?: Flow;
  contract?: Contract;
  where?: string;
  tests?: string;
  plans?: string[];
  files?: Record<string, string>;
  patterns?: string;
  integrations?: string;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cf-plan-'));
  const subject = options.contract ?? contract();
  const saved: Contract[] = [];
  const updates: { id: string; patch: { contractRevision?: string } }[] = [];
  const workerRuns: WorkerTask[] = [];
  const plans = options.plans ? [...options.plans] : null;
  const dir = ensureAttempt(root, 'run-1', 1);
  writeFileSync(join(dir, 'status.md'), '- branch: feat/gh-7\n- base: main@abc\n');
  writeFileSync(join(dir, 'brief.md'), BRIEF);
  for (const [rel, body] of Object.entries(options.files ?? {})) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  const git = fakeGit(options.git);
  const workers: WorkerPort = {
    async run(task) {
      workerRuns.push(task);
      if (task.unitId === 'explore-where') {
        return { status: 'done', filesChanged: [], notes: options.where ?? 'src/a.ts', route: task.role };
      }
      if (task.unitId === 'explore-tests') {
        return { status: 'done', filesChanged: [], notes: options.tests ?? 'src/a.test.ts', route: task.role };
      }
      if (task.unitId === 'explore-patterns') {
        return { status: 'done', filesChanged: [], notes: options.patterns ?? 'reuse web/lib/theme.ts', route: task.role };
      }
      if (task.unitId === 'explore-integrations') {
        return { status: 'done', filesChanged: [], notes: options.integrations ?? 'call web/api/client.ts', route: task.role };
      }
      if (task.unitId === 'plan' || task.unitId === 'plan-fix') {
        const body = plans ? plans.shift() : VALID_PLAN;
        if (body === undefined) throw new Error(`no plan scripted for ${task.unitId}`);
        writeFileSync(join(task.runDir, 'plan.md'), body);
        return { status: 'done', filesChanged: [], notes: '', route: task.role };
      }
      throw new Error(`unexpected unit ${task.unitId}`);
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
      defaultBranch: async () => 'main',
      readIssue: async () => ({ title: '', body: '', comments: [] }),
      viewPr: async () => null,
      upsertPr: async () => ({ url: '', number: 1, isDraft: true, headSha: 'abc', headBranch: 'feat/gh-7' }),
      checks: async () => [],
      rerunFailed: async () => {},
      failedLog: async () => '',
    },
    workers,
    commands: { run: async () => ({ ok: true, output: '' }) },
    ci: { waitMs: 0, extraIntervalMs: 0 },
    readPlaybook: (name: string) => {
      if (name !== 'plan-feature.md') throw new Error(`unexpected playbook ${name}`);
      return PLAYBOOK;
    },
    squeez: { async doctor() { throw new Error('phase test must not probe'); } },
    flow: options.flow ?? 'feature' as Flow,
  };
  return { root, dir, input, ctx, saved, updates, workerRuns, subject };
}

describe('runPlanPhase feature', () => {
  it('explores one directory, plans U1, and adds AC1 beside the spec criterion', async () => {
    const h = setup();
    const output = await runPlanPhase(h.input, h.ctx);
    const planPath = join(h.dir, 'plan.md');
    expect(h.workerRuns.map((task) => task.unitId)).toEqual(['explore-where', 'explore-tests', 'plan']);
    expect(h.workerRuns.slice(0, 2).every((task) => task.role === 'default' && task.allowedFiles.length === 0)).toBe(true);
    expect(h.workerRuns[0].prompt).toContain(join(h.dir, 'brief.md'));
    expect(h.workerRuns[0].prompt).toContain(WHERE);
    expect(h.workerRuns[0].prompt).toContain('at most 40 lines');
    expect(h.workerRuns[1].prompt).toContain(join(h.dir, 'brief.md'));
    expect(h.workerRuns[1].prompt).toContain(HOW_TESTED);
    expect(h.workerRuns[2].prompt).toContain(PLAYBOOK);
    expect(h.workerRuns[2].prompt).toContain(planPath);
    expect(h.workerRuns[2].allowedFiles).toEqual([relative(h.root, planPath)]);
    const explore = readFileSync(join(h.dir, 'explore.md'), 'utf8');
    expect(explore).toContain('src/a.ts');
    expect(explore).toContain('src/a.test.ts');
    expect(explore).not.toContain('explore-patterns');
    expect(parsePlan(readFileSync(planPath, 'utf8'))).toEqual([
      { id: 'U1', goal: 'add the inbox', files: ['new:src/a.ts'], dependsOn: [], verify: 'pnpm test src/a.test.ts' },
    ]);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].acceptance_criteria).toEqual([
      { id: 'ac-spec', statement: 'kept', gates: ['spec', 'verify', 'commit'], evidence: 'brief' },
      { id: 'AC1', statement: 'The inbox lists the issue', gates: ['plan', 'verify', 'commit'], evidence: 'plan-summary' },
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
      criterionIds: ['AC1'],
      kind: 'plan-summary',
      summary: 'plan for AC1',
    }]);
    expect(readStatusValue(h.dir, 'branch')).toBe('feat/gh-7');
    expect(readFileSync(join(h.dir, 'status.md'), 'utf8')).toContain('- phase: plan');
    expect(readFileSync(join(h.dir, 'status.md'), 'utf8')).toContain('- base: main@abc');
  });

  it('explores patterns and integrations when notes name two top-level directories', async () => {
    const h = setup({ where: 'src/a.ts', tests: 'web/b.tsx' });
    await runPlanPhase(h.input, h.ctx);
    expect(h.workerRuns.map((task) => task.unitId)).toEqual([
      'explore-where',
      'explore-tests',
      'explore-patterns',
      'explore-integrations',
      'plan',
    ]);
    expect(h.workerRuns[2].prompt).toContain(PATTERNS);
    expect(h.workerRuns[2].allowedFiles).toEqual([]);
    expect(h.workerRuns[3].prompt).toContain(INTEGRATIONS);
    expect(h.workerRuns[3].prompt).toContain(join(h.dir, 'brief.md'));
    const explore = readFileSync(join(h.dir, 'explore.md'), 'utf8');
    expect(explore.indexOf('src/a.ts')).toBeLessThan(explore.indexOf('web/b.tsx'));
    expect(explore).toContain('web/lib/theme.ts');
    expect(explore).toContain('web/api/client.ts');
  });

  it('calls the planner once more when two units share a file and do not depend on each other', async () => {
    const h = setup({ plans: [SHARED_PLAN, VALID_PLAN], files: { 'src/a.ts': 'export {}\n' } });
    const output = await runPlanPhase(h.input, h.ctx);
    expect(h.workerRuns.map((task) => task.unitId)).toEqual(['explore-where', 'explore-tests', 'plan', 'plan-fix']);
    expect(h.workerRuns[3].prompt).toContain('plan check failed: U1 and U2 share src/a.ts');
    expect(h.workerRuns[3].allowedFiles).toEqual([relative(h.root, join(h.dir, 'plan.md'))]);
    expect(parsePlan(readFileSync(join(h.dir, 'plan.md'), 'utf8')).map((unit) => unit.id)).toEqual(['U1']);
    expect(output.evidence[0].kind).toBe('plan-summary');
    expect(h.saved).toHaveLength(1);
  });

  it('throws plan check failed when the invalid plan is written twice', async () => {
    const h = setup({ plans: [SHARED_PLAN, SHARED_PLAN], files: { 'src/a.ts': 'export {}\n' } });
    await expect(runPlanPhase(h.input, h.ctx)).rejects.toThrow(/plan check failed/);
    expect(h.workerRuns.map((task) => task.unitId)).toEqual(['explore-where', 'explore-tests', 'plan', 'plan-fix']);
    expect(h.saved).toHaveLength(0);
    expect(h.updates).toHaveLength(0);
  });

  it('rejects a test plan that does not mention an acceptance id', async () => {
    const h = setup({ plans: [MISSING_AC_PLAN, VALID_PLAN] });
    await runPlanPhase(h.input, h.ctx);
    expect(h.workerRuns[3].unitId).toBe('plan-fix');
    expect(h.workerRuns[3].prompt).toContain('plan check failed: AC1 is missing from the test plan');
  });

  it('rejects a file that does not exist and is not marked new', async () => {
    const h = setup({ plans: [MISSING_FILE_PLAN, VALID_PLAN] });
    await runPlanPhase(h.input, h.ctx);
    expect(existsSync(join(h.root, 'src/missing.ts'))).toBe(false);
    expect(h.workerRuns[3].prompt).toContain('plan check failed: src/missing.ts does not exist');
  });

  it('rejects a dependency cycle', async () => {
    const h = setup({ plans: [CYCLE_PLAN, VALID_PLAN] });
    await runPlanPhase(h.input, h.ctx);
    expect(h.workerRuns[3].prompt).toContain('plan check failed: cycle in work units');
  });

  it('accepts a shared file when one unit depends on the other', async () => {
    const h = setup({ plans: [ORDERED_SHARE_PLAN], files: { 'src/a.ts': 'export {}\n' } });
    await runPlanPhase(h.input, h.ctx);
    expect(h.workerRuns.map((task) => task.unitId)).toEqual(['explore-where', 'explore-tests', 'plan']);
    expect(h.saved).toHaveLength(1);
  });

  it('adds plan to the first criterion when every acceptance id is already a criterion', async () => {
    const subject = contract({
      acceptance_criteria: [
        { id: 'ac-spec', statement: 'kept', gates: ['spec', 'verify', 'commit'], evidence: 'brief' },
        { id: 'AC1', statement: 'already', gates: ['verify'], evidence: 'brief' },
      ],
    });
    const h = setup({ contract: subject });
    const output = await runPlanPhase(h.input, h.ctx);
    expect(h.saved[0].acceptance_criteria).toEqual([
      { id: 'ac-spec', statement: 'kept', gates: ['spec', 'verify', 'commit', 'plan'], evidence: 'brief' },
      { id: 'AC1', statement: 'already', gates: ['verify'], evidence: 'brief' },
    ]);
    expect(subject.acceptance_criteria[0].gates).toEqual(['spec', 'verify', 'commit']);
    expect(output.evidence[0]).toMatchObject({ kind: 'plan-summary', criterionIds: ['ac-spec'], summary: 'plan for ac-spec' });
  });

  it('throws when the working tree is dirty and does not call a worker', async () => {
    const h = setup({ git: { statusPorcelain: async () => ' M src/a.ts' } });
    await expect(runPlanPhase(h.input, h.ctx)).rejects.toThrow(/working tree is dirty/);
    expect(h.workerRuns).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
  });

  it('throws when HEAD is not the branch recorded in status', async () => {
    const h = setup({ git: { headBranch: async () => 'main' } });
    await expect(runPlanPhase(h.input, h.ctx)).rejects.toThrow('HEAD is main, expected feat/gh-7');
    expect(h.workerRuns).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
  });
});

describe('plan-feature.md', () => {
  it('tells the planner how to write plan.md', () => {
    const text = readFileSync(PLAYBOOK_PATH, 'utf8');
    expect(text).toContain('## Acceptance criteria');
    expect(text).toContain('- AC1:');
    expect(text).toContain('## Test plan');
    expect(text).toContain('| ID | Goal | Files (create/modify) | Depends on | Verify with |');
    expect(text).toContain('Two units must not share a file unless one depends on the other.');
    expect(text).toContain('Prefix files that do not exist with `new:`.');
    expect(text).toContain('plan.md');
  });
});
