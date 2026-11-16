import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Contract, FactoryConfig, GateId, RunRecord } from '../../../src/domain/types.js';
import { DEFAULT_CONFIG } from '../../../src/domain/types.js';
import { PlaybookRunEngine } from '../../../src/engine/playbook/playbookEngine.js';
import type { CommandResult, ForgePort, GitPort, WorkerTask } from '../../../src/engine/playbook/ports.js';
import { attemptDir } from '../../../src/engine/playbook/runFolder.js';
import { RunWalker } from '../../../src/engine/playbook/walker.js';
import type { ChocolateData } from '../../../src/files/chocolateFiles.js';
import { RunService } from '../../../src/runs/runService.js';
import { SqliteRunStore } from '../../../src/store/runStore.js';

const ISSUE = { tracker: 'github' as const, repo: 'o/r', number: 7, url: 'https://github.com/o/r/issues/7' };
const MUST = 'MUST src/a.ts:1 Gap | missing test | add a test';
const BRIEF = `# Issue 7

## Requirements / acceptance criteria
- The inbox lists the issue
`;
const PLAN = `# Plan
## Acceptance criteria
- AC1: The inbox lists the issue

## Test plan
- AC1 is covered by the unit check
- cmd: pnpm test

| ID | Goal | Files (create/modify) | Depends on | Verify with |
| --- | --- | --- | --- | --- |
| U1 | add the inbox | new:src/a.ts | - | pnpm test |
`;

const openStores: SqliteRunStore[] = [];
afterEach(() => {
  for (const store of openStores) store.close();
  openStores.length = 0;
});

interface WalkOptions {
  reviewNotes?: string;
}

interface Harness {
  root: string;
  run: RunRecord;
  runs: RunService;
  walker: RunWalker;
  store: SqliteRunStore;
  drafts: boolean[];
  pushes: string[];
}

function baseContract(): Contract {
  return {
    id: 'feat-inbox',
    title: 'Inbox',
    intent: 'List issues',
    acceptance_criteria: [],
    constraints: [],
    out_of_scope: [],
    linked_issue: ISSUE,
    milestone: 'm1',
    dependencies: [],
  };
}

function attemptOf(task: WorkerTask): string {
  const parent = dirname(task.runDir);
  return basename(parent) === 'units' ? dirname(parent) : task.runDir;
}

function config(): FactoryConfig {
  return {
    ...DEFAULT_CONFIG,
    workers: {
      default: { command: ['node'] },
      implement: { command: ['node'] },
    },
  };
}

function startWalk(options: WalkOptions = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'cf-walk-'));
  const store = new SqliteRunStore(join(root, 'test.db'));
  openStores.push(store);
  const initial = baseContract();
  let current: Contract = initial;
  let rev = 0;
  const factory = config();
  const files = {
    load(): ChocolateData {
      return {
        contracts: [structuredClone(current)],
        invalidContracts: [],
        roadmap: { milestones: [{ id: 'm1', title: 'M', intent: 'x', contracts: [initial.id] }] },
        roadmapError: null,
        config: factory,
        crossRefErrors: [],
      };
    },
    readContractFile: () => '',
    saveContract: (next: Contract) => {
      current = structuredClone(next);
      rev += 1;
      return `rev-${rev}`;
    },
  };
  const drafts: boolean[] = [];
  const pushes: string[] = [];
  let head = 'main';
  const git: GitPort = {
    isRepo: async () => true,
    statusPorcelain: async () => '',
    originHead: async () => 'main',
    fetch: async () => {},
    branchExists: async () => false,
    createBranch: async (_repo, name) => { head = name; },
    headBranch: async () => head,
    headSha: async () => 'abc',
    commitAll: async () => {},
    diffNames: async () => [],
    changedLines: async () => 10,
    push: async (_repo, branch) => { pushes.push(branch); },
    remoteHead: async () => null,
    revert: async () => {},
    deleteUntracked: async () => {},
  };
  const forge: ForgePort = {
    defaultBranch: async () => 'main',
    readIssue: async () => ({ title: 'Issue 7', body: 'List the issue', comments: [] }),
    viewPr: async () => null,
    upsertPr: async (input) => {
      drafts.push(input.draft);
      return { url: 'https://github.com/o/r/pull/1', number: 1, isDraft: input.draft, headSha: 'abc', headBranch: head };
    },
    checks: async () => [{ name: 'ci', state: 'success', bucket: 'pass', link: 'https://github.com/o/r/actions/runs/1' }],
    rerunFailed: async () => {},
    failedLog: async () => '',
  };
  const workers = {
    async run(task: WorkerTask) {
      const dir = attemptOf(task);
      if (task.unitId === 'spec') writeFileSync(join(dir, 'brief.md'), BRIEF);
      if (task.unitId === 'plan' || task.unitId === 'plan-fix') writeFileSync(join(dir, 'plan.md'), PLAN);
      if (task.unitId === 'pr') writeFileSync(join(dir, 'pr.md'), '# Inbox\n');
      const notes = task.unitId.startsWith('review-') ? (options.reviewNotes ?? '') : '';
      return { status: 'done' as const, filesChanged: [], notes, route: task.role };
    },
  };
  const commands = {
    async run(): Promise<CommandResult> {
      return { ok: true, output: '' };
    },
  };
  const engine = new PlaybookRunEngine({
    repoRoot: root,
    files,
    store,
    git,
    forge,
    workers,
    commands,
    ci: { waitMs: 0, extraIntervalMs: 0 },
    readPlaybook: () => '',
  });
  const runs = new RunService({ store, engine, files, config: factory, repoRoot: root });
  const walker = new RunWalker(runs);
  const run = runs.claim({
    issue: ISSUE,
    contract: initial,
    contractRevision: 'rev-0',
    flow: 'feature',
    engine: 'playbook',
  });
  return { root, run, runs, walker, store, drafts, pushes };
}

async function settle(walker: RunWalker, store: SqliteRunStore, id: string): Promise<void> {
  walker.kick(id);
  for (let i = 0; i < 20; i += 1) {
    const run = store.getRun(id);
    if (run && run.state !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('walk did not settle');
}

async function approve(h: Harness, gate: GateId): Promise<void> {
  await h.runs.actOnGate(h.run.id, { gate, action: 'approve' });
}

describe('feature playbook walk', () => {
  it('reaches commit-ready with an open pull request and green CI', async () => {
    const h = startWalk();
    await settle(h.walker, h.store, h.run.id);
    expect(h.store.getRun(h.run.id)?.state).toBe('awaiting-decision');
    await approve(h, 'spec');
    await settle(h.walker, h.store, h.run.id);
    await approve(h, 'plan');
    await settle(h.walker, h.store, h.run.id);
    await approve(h, 'verify');
    await settle(h.walker, h.store, h.run.id);
    await approve(h, 'commit');
    expect(h.store.getRun(h.run.id)?.state).toBe('commit-ready');
    const evidence = h.store.evidence(h.run.id).filter((item) => item.attempt === 1);
    expect(evidence.map((item) => item.kind)).toEqual(expect.arrayContaining([
      'brief',
      'plan-summary',
      'verification-check',
      'pull-request',
      'ci-green',
    ]));
    expect(evidence.find((item) => item.kind === 'pull-request')?.summary).toBe('open');
    expect(h.pushes.length).toBeGreaterThan(0);
    expect(h.drafts).toEqual([false]);
  });

  it('keeps the attempt-1 brief and writes attempt 2 after spec rework', async () => {
    const h = startWalk();
    await settle(h.walker, h.store, h.run.id);
    const first = attemptDir(h.root, h.run.id, 1);
    expect(existsSync(join(first, 'brief.md'))).toBe(true);
    await h.runs.actOnGate(h.run.id, { gate: 'spec', action: 'rework' });
    await settle(h.walker, h.store, h.run.id);
    expect(existsSync(join(first, 'brief.md'))).toBe(true);
    expect(existsSync(join(attemptDir(h.root, h.run.id, 2), 'brief.md'))).toBe(true);
    expect(h.store.getRun(h.run.id)?.currentAttempt).toBe(2);
  });

  it('fails commit when every review pass reports an open must-fix', async () => {
    const h = startWalk({ reviewNotes: MUST });
    await settle(h.walker, h.store, h.run.id);
    await approve(h, 'spec');
    await settle(h.walker, h.store, h.run.id);
    await approve(h, 'plan');
    await settle(h.walker, h.store, h.run.id);
    expect(h.store.getRun(h.run.id)).toMatchObject({ phase: 'verify', state: 'awaiting-decision' });
    expect(h.store.evidence(h.run.id).some((item) => item.kind === 'verification-check')).toBe(true);
    await approve(h, 'verify');
    await settle(h.walker, h.store, h.run.id);
    expect(h.store.getRun(h.run.id)?.state).toBe('failed');
    const evidence = h.store.evidence(h.run.id);
    expect(evidence.find((item) => item.kind === 'pull-request')?.summary).toBe('draft');
    expect(evidence.some((item) => item.kind === 'ci-green')).toBe(false);
  });
});
