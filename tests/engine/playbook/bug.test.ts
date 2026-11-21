import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Contract, FactoryConfig, Flow, RunRecord } from '../../../src/domain/types.js';
import { DEFAULT_CONFIG } from '../../../src/domain/types.js';
import { PlaybookRunEngine } from '../../../src/engine/playbook/playbookEngine.js';
import type { CommandResult, ForgePort, GitPort, WorkerTask } from '../../../src/engine/playbook/ports.js';
import { RunWalker } from '../../../src/engine/playbook/walker.js';
import type { ChocolateData } from '../../../src/files/chocolateFiles.js';
import { RunService } from '../../../src/runs/runService.js';
import { SqliteRunStore } from '../../../src/store/runStore.js';

const ISSUE = { tracker: 'github' as const, repo: 'o/r', number: 7, url: 'https://github.com/o/r/issues/7' };
const BUG_COMMAND = 'pnpm exec vitest run tests/bug.test.ts';
const REPRO_PATH = 'tests/bug.test.ts';
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
  flow?: Flow;
  reviewNotes?: string;
  reproStatus?: 'reproduced' | 'not-reproduced';
  reproFailures?: number;
  modifyRepro?: boolean;
}

interface Harness {
  run: RunRecord;
  runs: RunService;
  walker: RunWalker;
  store: SqliteRunStore;
  reverts: string[][];
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

function reproFile(status: 'reproduced' | 'not-reproduced'): string {
  return [
    `status: ${status}`,
    `test: ${REPRO_PATH}::fails`,
    `command: ${BUG_COMMAND}`,
    'allowed: src/handler.ts',
    '',
  ].join('\n');
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
  const flow = options.flow ?? 'bug';
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
  const reverts: string[][] = [];
  let head = 'main';
  let porcelain = '';
  let reproFailures = options.reproFailures ?? 0;
  const git: GitPort = {
    isRepo: async () => true,
    statusPorcelain: async () => porcelain,
    originHead: async () => 'main',
    fetch: async () => {},
    branchExists: async () => false,
    createBranch: async (_repo, name) => { head = name; },
    headBranch: async () => head,
    headSha: async () => 'abc',
    commitAll: async () => {},
    diffNames: async () => [],
    changedLines: async () => 10,
    push: async () => {},
    remoteHead: async () => null,
    revert: async (_repo, paths) => { reverts.push(paths); },
    deleteUntracked: async () => {},
  };
  const forge: ForgePort = {
    defaultBranch: async () => 'main',
    readIssue: async () => ({ title: 'Issue 7', body: 'List the issue', comments: [] }),
    viewPr: async () => null,
    upsertPr: async (input) => ({
      url: 'https://github.com/o/r/pull/1',
      number: 1,
      isDraft: input.draft,
      headSha: 'abc',
      headBranch: head,
    }),
    checks: async () => [{ name: 'ci', state: 'success', bucket: 'pass', link: 'https://github.com/o/r/actions/runs/1' }],
    rerunFailed: async () => {},
    failedLog: async () => '',
  };
  const workers = {
    async run(task: WorkerTask) {
      const dir = attemptOf(task);
      if (task.unitId === 'spec') writeFileSync(join(dir, 'brief.md'), BRIEF);
      if (task.unitId === 'plan' || task.unitId === 'plan-fix') writeFileSync(join(dir, 'plan.md'), PLAN);
      if (task.unitId === 'repro') writeFileSync(join(dir, 'repro.md'), reproFile(options.reproStatus ?? 'reproduced'));
      if (task.unitId === 'pr') writeFileSync(join(dir, 'pr.md'), '# Inbox\n');
      if (options.modifyRepro && task.unitId === 'U1') porcelain = ` M ${REPRO_PATH}`;
      const notes = task.unitId.startsWith('review-') ? (options.reviewNotes ?? '') : '';
      return { status: 'done' as const, filesChanged: [], notes, route: task.role };
    },
  };
  const commands = {
    async run(_repo: string, command: string): Promise<CommandResult> {
      if (command === BUG_COMMAND && reproFailures > 0) {
        reproFailures -= 1;
        return { ok: false, output: 'expected 1 received 0' };
      }
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
    squeez: { async doctor() { return { status: 'ok' as const, output: '' }; } },
  });
  const runs = new RunService({ store, engine, files, config: factory, repoRoot: root });
  const walker = new RunWalker(runs);
  const run = runs.claim({
    issue: ISSUE,
    contract: initial,
    contractRevision: 'rev-0',
    flow,
    engine: 'playbook',
  });
  return { run, runs, walker, store, reverts };
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

describe('bug playbook walk', () => {
  it('reaches commit-ready after a reproduced failure', async () => {
    const h = startWalk({ flow: 'bug', reproFailures: 2 });
    await settle(h.walker, h.store, h.run.id);
    await h.runs.actOnGate(h.run.id, { gate: 'spec', action: 'approve' });
    await settle(h.walker, h.store, h.run.id);
    await h.runs.actOnGate(h.run.id, { gate: 'plan', action: 'approve' });
    await settle(h.walker, h.store, h.run.id);
    await h.runs.actOnGate(h.run.id, { gate: 'verify', action: 'approve' });
    await settle(h.walker, h.store, h.run.id);
    await h.runs.actOnGate(h.run.id, { gate: 'commit', action: 'approve' });
    expect(h.store.getRun(h.run.id)?.state).toBe('commit-ready');
  });

  it('fails and reverts when implement touches the repro test', async () => {
    const h = startWalk({ flow: 'bug', reproFailures: 2, modifyRepro: true });
    await settle(h.walker, h.store, h.run.id);
    await h.runs.actOnGate(h.run.id, { gate: 'spec', action: 'approve' });
    await settle(h.walker, h.store, h.run.id);
    await h.runs.actOnGate(h.run.id, { gate: 'plan', action: 'approve' });
    await settle(h.walker, h.store, h.run.id);
    expect(h.store.getRun(h.run.id)?.state).toBe('failed');
    expect(h.reverts.some((paths) => paths.includes(REPRO_PATH))).toBe(true);
  });

  it('fails when the bug is not reproduced and records no plan decision', async () => {
    const h = startWalk({ flow: 'bug', reproStatus: 'not-reproduced' });
    await settle(h.walker, h.store, h.run.id);
    await h.runs.actOnGate(h.run.id, { gate: 'spec', action: 'approve' });
    await settle(h.walker, h.store, h.run.id);
    expect(h.store.getRun(h.run.id)?.state).toBe('failed');
    expect(h.store.gateDecisions(h.run.id).filter((decision) => decision.gate === 'plan')).toEqual([]);
  });
});
