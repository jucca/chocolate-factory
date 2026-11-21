import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Contract, Flow } from '../../../src/domain/types.js';
import type { PhaseInput } from '../../../src/engine/runEngine.js';
import { ensureAttempt, readStatusValue } from '../../../src/engine/playbook/runFolder.js';
import type { CheckView, ForgePort, GitPort, WorkerPort, WorkerReport, WorkerTask } from '../../../src/engine/playbook/ports.js';
import type { FilesPort } from '../../../src/runs/runService.js';
import type { SqliteRunStore } from '../../../src/store/runStore.js';
import { runCommitPhase } from '../../../src/engine/playbook/phases/commitPhase.js';

const PLAYBOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../../src/engine/playbooks/commit.md');
const PR_URL = 'https://github.com/o/r/pull/4';
const FAIL_LINK = 'https://github.com/o/r/actions/runs/15';
const CANCEL_LINK = 'https://github.com/o/r/actions/runs/9';

function check(bucket: string, link = ''): CheckView {
  return { name: 'test', state: bucket === 'pass' ? 'success' : bucket, bucket, link };
}

function contract(): Contract {
  return {
    id: 'feat-inbox',
    title: 'Inbox',
    intent: 'List issues',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'The change meets the contract', gates: ['verify', 'commit'], evidence: 'verification-check' },
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
  baseline?: string;
  porcelain?: string;
  headBranch?: string;
  headSha?: string;
  remoteHead?: string | null;
  checks?: CheckView[][];
  repeatChecks?: boolean;
  logFor?: (runId: string) => string;
  viewDraft?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cf-commit-phase-'));
  const dir = ensureAttempt(root, 'run-1', 1);
  writeFileSync(join(dir, 'status.md'), `- base: main@abc\n- branch: feat/gh-7\n${options.baseline ?? ''}`);
  writeFileSync(join(dir, 'review-1.md'), '## Must\n\n## Nice\n\n## Could\n');
  const workerRuns: WorkerTask[] = [];
  const pushes: { root: string; branch: string }[] = [];
  const remoteCalls: { root: string; branch: string }[] = [];
  const prs: { repoRoot: string; base: string; title: string; bodyPath: string; draft: boolean }[] = [];
  const checkCalls: { root: string; number: number }[] = [];
  const reruns: string[] = [];
  const logIds: string[] = [];
  const commits: { root: string; message: string }[] = [];
  const trace: string[] = [];
  let pendingFix = false;
  let tree = options.porcelain ?? '';
  const queue = (options.checks ?? [[check('pass')]]).map((row) => [...row]);
  const git: GitPort = {
    isRepo: async () => { throw new Error('git was called'); },
    statusPorcelain: async () => tree,
    originHead: async () => { throw new Error('git was called'); },
    fetch: async () => { throw new Error('git was called'); },
    branchExists: async () => { throw new Error('git was called'); },
    createBranch: async () => { throw new Error('git was called'); },
    headBranch: async () => options.headBranch ?? 'feat/gh-7',
    headSha: async () => options.headSha ?? 'abc',
    commitAll: async (repoRoot, message) => {
      commits.push({ root: repoRoot, message });
      trace.push('commit');
      pendingFix = false;
      tree = '';
    },
    diffNames: async () => ['src/a.ts'],
    changedLines: async () => { throw new Error('git was called'); },
    push: async (repoRoot, branch) => {
      if (pendingFix) throw new Error('fix push without commitAll');
      trace.push('push');
      pushes.push({ root: repoRoot, branch });
    },
    remoteHead: async (repoRoot, branch) => {
      trace.push('remote');
      remoteCalls.push({ root: repoRoot, branch });
      return options.remoteHead === undefined ? 'abc' : options.remoteHead;
    },
    revert: async () => { throw new Error('git was called'); },
    deleteUntracked: async () => { throw new Error('git was called'); },
  };
  const workers: WorkerPort = {
    async run(task) {
      workerRuns.push(task);
      if (task.role === 'default') {
        writeFileSync(join(dir, 'pr.md'), '# Ship the inbox\n\n## Summary\nShipped\n');
      }
      if (task.role === 'implement') {
        tree = ' M src/a.ts';
        pendingFix = true;
      }
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
  const forge: ForgePort = {
    defaultBranch: async () => { throw new Error('gh was called'); },
    readIssue: async () => { throw new Error('gh was called'); },
    viewPr: async () => { throw new Error('gh was called'); },
    upsertPr: async (input) => {
      prs.push(input);
      return { url: PR_URL, number: 4, isDraft: options.viewDraft ?? input.draft, headSha: 'abc', headBranch: 'feat/gh-7' };
    },
    checks: async (repoRoot, number) => {
      checkCalls.push({ root: repoRoot, number });
      if (queue.length === 0) throw new Error(`unexpected checks call ${checkCalls.length}`);
      if (options.repeatChecks && queue.length === 1) return queue[0];
      return queue.shift() ?? [];
    },
    rerunFailed: async (_repoRoot, runId) => { reruns.push(runId); },
    failedLog: async (_repoRoot, runId) => {
      logIds.push(runId);
      return options.logFor ? options.logFor(runId) : 'Error: boom';
    },
  };
  const input: PhaseInput = { phase: 'commit', attempt: 1, contract: contract(), runId: 'run-1' };
  const ctx = {
    repoRoot: root,
    files,
    store,
    git,
    forge,
    workers,
    commands: {
      async run() { throw new Error('command was called'); },
    },
    ci: { waitMs: 0, extraIntervalMs: 0 },
    readPlaybook: (name: string) => {
      if (name !== 'commit.md') throw new Error(`playbook ${name} was read`);
      return readFileSync(PLAYBOOK_PATH, 'utf8');
    },
    squeez: { async doctor() { throw new Error('phase test must not probe'); } },
    flow: options.flow ?? 'feature' as Flow,
  };
  return { root, dir, input, ctx, workerRuns, pushes, remoteCalls, prs, checkCalls, reruns, logIds, commits, trace };
}

function writers(tasks: WorkerTask[]): WorkerTask[] {
  return tasks.filter((task) => task.role === 'default');
}

function fixes(tasks: WorkerTask[]): WorkerTask[] {
  return tasks.filter((task) => task.role === 'implement');
}

function expectOwnRunDir(task: WorkerTask, dir: string): void {
  const nested = relative(dir, task.runDir);
  expect(nested).not.toBe('');
  expect(nested.startsWith('..')).toBe(false);
  expect(relative(task.runDir, join(dir, 'pr.md')).startsWith('..')).toBe(true);
  expect(relative(task.runDir, join(dir, 'babysit.md')).startsWith('..')).toBe(true);
}

describe('runCommitPhase', () => {
  it('opens a draft when baseline M1 is open and does not watch CI', async () => {
    const h = setup({ baseline: '- M1 | open | Title\n' });
    const output = await runCommitPhase(h.input, h.ctx);
    expect(writers(h.workerRuns)).toHaveLength(1);
    expectOwnRunDir(writers(h.workerRuns)[0], h.dir);
    expect(writers(h.workerRuns)[0].prompt).toContain(join(h.dir, 'pr.md'));
    expect(writers(h.workerRuns)[0].prompt).toContain('Summary');
    expect(h.prs).toEqual([{
      repoRoot: h.root,
      base: 'main',
      title: 'Ship the inbox',
      bodyPath: join(h.dir, 'pr.md'),
      draft: true,
    }]);
    expect(h.pushes).toEqual([{ root: h.root, branch: 'feat/gh-7' }]);
    expect(h.remoteCalls).toEqual([{ root: h.root, branch: 'feat/gh-7' }]);
    expect(h.checkCalls).toEqual([]);
    expect(h.logIds).toEqual([]);
    expect(h.reruns).toEqual([]);
    expect(fixes(h.workerRuns)).toHaveLength(0);
    expect(existsSync(join(h.dir, 'pr.md'))).toBe(true);
    expect(existsSync(join(writers(h.workerRuns)[0].runDir, 'pr.md'))).toBe(false);
    expect(readStatusValue(h.dir, 'pr')).toBe(PR_URL);
    expect(output.events).toEqual([
      { type: 'phase_completed', message: 'commit phase completed (attempt 1)' },
    ]);
    expect(output.evidence).toEqual([{
      attempt: 1,
      phase: 'commit',
      producerPhase: 'commit',
      criterionIds: [],
      kind: 'pull-request',
      summary: 'draft',
    }]);
  });

  it('treats a partial baseline row as unresolved and a later resolved row as open', async () => {
    const partial = setup({ baseline: '- M1 | partial | Title\n' });
    await runCommitPhase(partial.input, partial.ctx);
    expect(partial.prs[0].draft).toBe(true);
    expect(partial.checkCalls).toEqual([]);

    const resolved = setup({ baseline: '- M1 | open | Title\n- M1 | resolved | Title\n' });
    const output = await runCommitPhase(resolved.input, resolved.ctx);
    expect(resolved.prs[0].draft).toBe(false);
    expect(output.evidence.map((item) => item.kind)).toEqual(['pull-request', 'ci-green']);
    expect(output.evidence[0].summary).toBe('open');
  });

  it('records an open pull request and ci-green when every check passes', async () => {
    const h = setup({
      checks: [[{ name: 'test', state: 'success', bucket: 'pass', link: '' }]],
    });
    const output = await runCommitPhase(h.input, h.ctx);
    expect(h.prs[0].draft).toBe(false);
    expect(h.pushes).toHaveLength(1);
    expect(h.checkCalls).toEqual([{ root: h.root, number: 4 }]);
    expect(output.evidence).toEqual([
      {
        attempt: 1,
        phase: 'commit',
        producerPhase: 'commit',
        criterionIds: [],
        kind: 'pull-request',
        summary: 'open',
      },
      {
        attempt: 1,
        phase: 'commit',
        producerPhase: 'commit',
        criterionIds: [],
        kind: 'ci-green',
        summary: 'abc',
      },
    ]);
  });

  it('dispatches one implement worker for a failing check and does not rerun it', async () => {
    const h = setup({
      checks: [
        [check('fail', FAIL_LINK)],
        [check('pass')],
      ],
      logFor: () => 'Error: boom',
    });
    const output = await runCommitPhase(h.input, h.ctx);
    const fix = fixes(h.workerRuns);
    expect(fix).toHaveLength(1);
    expect(fix[0].unitId).toBe('ci-1');
    expect(fix[0].role).toBe('implement');
    expectOwnRunDir(fix[0], h.dir);
    expect(fix[0].runDir).not.toBe(writers(h.workerRuns)[0].runDir);
    expect(fix[0].prompt).toContain('Error: boom');
    expect(fix[0].prompt).toContain(fix[0].runDir);
    expect(h.logIds).toEqual(['15']);
    expect(h.reruns).toEqual([]);
    expect(h.pushes).toEqual([
      { root: h.root, branch: 'feat/gh-7' },
      { root: h.root, branch: 'feat/gh-7' },
    ]);
    expect(h.commits).toEqual([{ root: h.root, message: 'fix: CI' }]);
    expect(h.trace).toEqual(['remote', 'push', 'commit', 'remote', 'push']);
    expect(h.checkCalls).toHaveLength(2);
    expect(output.evidence.map((item) => `${item.kind}:${item.summary}`)).toEqual([
      'pull-request:open',
      'ci-green:abc',
    ]);
  });

  it('stops after three CI fix attempts and still returns an open pull request', async () => {
    const h = setup({
      checks: [[check('fail', FAIL_LINK)]],
      repeatChecks: true,
      logFor: () => 'Error: boom',
    });
    const output = await runCommitPhase(h.input, h.ctx);
    const fix = fixes(h.workerRuns);
    expect(fix.map((task) => task.unitId)).toEqual(['ci-1', 'ci-2', 'ci-3']);
    expect(new Set(fix.map((task) => task.runDir)).size).toBe(3);
    for (const task of fix) {
      expectOwnRunDir(task, h.dir);
      expect(task.prompt).toContain('Error: boom');
    }
    expect(h.reruns).toEqual([]);
    expect(h.commits).toEqual([
      { root: h.root, message: 'fix: CI' },
      { root: h.root, message: 'fix: CI' },
      { root: h.root, message: 'fix: CI' },
    ]);
    const babysit = readFileSync(join(h.dir, 'babysit.md'), 'utf8');
    expect(babysit).toContain('attempt 3');
    expect(existsSync(join(fix[0].runDir, 'babysit.md'))).toBe(false);
    expect(output.evidence).toEqual([{
      attempt: 1,
      phase: 'commit',
      producerPhase: 'commit',
      criterionIds: [],
      kind: 'pull-request',
      summary: 'open',
    }]);
  });

  it('reads empty checks once more and omits ci-green', async () => {
    const h = setup({ checks: [[], []] });
    const output = await runCommitPhase(h.input, h.ctx);
    expect(h.checkCalls).toHaveLength(2);
    expect(h.reruns).toEqual([]);
    expect(fixes(h.workerRuns)).toHaveLength(0);
    expect(output.evidence.map((item) => item.kind)).toEqual(['pull-request']);
    expect(output.evidence[0].summary).toBe('open');
  });

  it('stops immediately when a check is pending and waitMs is 0', async () => {
    const h = setup({ checks: [[check('pending')]] });
    const output = await runCommitPhase(h.input, h.ctx);
    expect(h.checkCalls).toHaveLength(1);
    expect(fixes(h.workerRuns)).toHaveLength(0);
    expect(output.evidence.map((item) => item.kind)).toEqual(['pull-request']);
  });

  it('reruns a cancelled check once and records ci-green when the next checks pass', async () => {
    const h = setup({
      checks: [
        [check('cancel', CANCEL_LINK)],
        [check('pass')],
      ],
    });
    const output = await runCommitPhase(h.input, h.ctx);
    expect(h.reruns).toEqual(['9']);
    expect(fixes(h.workerRuns)).toHaveLength(0);
    expect(h.logIds).toEqual([]);
    expect(output.evidence.map((item) => `${item.kind}:${item.summary}`)).toEqual([
      'pull-request:open',
      'ci-green:abc',
    ]);
  });

  it('does not rerun or code-fix a second cancel', async () => {
    const h = setup({
      checks: [
        [check('cancel', CANCEL_LINK)],
        [check('cancel', CANCEL_LINK)],
      ],
    });
    const output = await runCommitPhase(h.input, h.ctx);
    expect(h.reruns).toEqual(['9']);
    expect(fixes(h.workerRuns)).toHaveLength(0);
    expect(output.evidence.map((item) => item.kind)).toEqual(['pull-request']);
    expect(output.evidence[0].summary).toBe('open');
  });

  it('reruns one infrastructure failure and does not count it as a code fix', async () => {
    const h = setup({
      checks: [
        [check('fail', 'https://github.com/o/r/actions/runs/21')],
        [check('pass')],
      ],
      logFor: () => 'network timeout while fetching',
    });
    const output = await runCommitPhase(h.input, h.ctx);
    expect(h.logIds).toEqual(['21']);
    expect(h.reruns).toEqual(['21']);
    expect(fixes(h.workerRuns)).toHaveLength(0);
    expect(output.evidence.some((item) => item.kind === 'ci-green' && item.summary === 'abc')).toBe(true);
  });

  it('records a draft when the re-read says the pull request is still a draft', async () => {
    const h = setup({ viewDraft: true });
    const output = await runCommitPhase(h.input, h.ctx);
    expect(h.prs[0].draft).toBe(false);
    expect(output.evidence).toEqual([{
      attempt: 1,
      phase: 'commit',
      producerPhase: 'commit',
      criterionIds: [],
      kind: 'pull-request',
      summary: 'draft',
    }]);
    expect(h.checkCalls).toEqual([]);
  });

  it('throws when the remote head moved and does not push', async () => {
    const h = setup({ remoteHead: 'def', headSha: 'abc' });
    await expect(runCommitPhase(h.input, h.ctx)).rejects.toThrow(/remote head moved/);
    expect(h.pushes).toEqual([]);
    expect(h.prs).toEqual([]);
    expect(h.checkCalls).toEqual([]);
  });

  it('pushes when the remote head is missing', async () => {
    const h = setup({ remoteHead: null });
    await runCommitPhase(h.input, h.ctx);
    expect(h.pushes).toEqual([{ root: h.root, branch: 'feat/gh-7' }]);
    expect(h.prs[0].draft).toBe(false);
  });

  it('refuses a dirty worktree before a worker or a push', async () => {
    const h = setup({ porcelain: ' M src/a.ts' });
    await expect(runCommitPhase(h.input, h.ctx)).rejects.toThrow('working tree is dirty');
    expect(h.workerRuns).toEqual([]);
    expect(h.pushes).toEqual([]);
    expect(h.prs).toEqual([]);
  });

  it('refuses a HEAD that is not the run branch', async () => {
    const h = setup({ headBranch: 'feat/other' });
    await expect(runCommitPhase(h.input, h.ctx)).rejects.toThrow('HEAD is feat/other, expected feat/gh-7');
    expect(h.workerRuns).toEqual([]);
    expect(h.pushes).toEqual([]);
  });
});

describe('commit.md', () => {
  it('tells the writer to fill pr.md from attempt files without inventing results', () => {
    const text = readFileSync(PLAYBOOK_PATH, 'utf8');
    expect(text).toContain('pr.md');
    expect(text).toMatch(/title/i);
    expect(text).toContain('Summary');
    expect(text).toContain('Context');
    expect(text).toContain('Changes');
    expect(text).toContain('Testing');
    expect(text).toContain('Review');
    expect(text.toLowerCase()).toContain('do not invent');
    expect(text.toLowerCase()).toContain('attempt');
  });
});
