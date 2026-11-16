import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Contract, Flow } from '../../../src/domain/types.js';
import type { PhaseInput } from '../../../src/engine/runEngine.js';
import { ensureAttempt } from '../../../src/engine/playbook/runFolder.js';
import type { GitPort, WorkerPort, WorkerReport, WorkerTask } from '../../../src/engine/playbook/ports.js';
import type { FilesPort } from '../../../src/runs/runService.js';
import type { SqliteRunStore } from '../../../src/store/runStore.js';
import { runVerifyPhase } from '../../../src/engine/playbook/phases/verifyPhase.js';

const MUST = 'MUST src/a.ts:10 Title | failure scenario | suggested fix';
const PLAYBOOK = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../src/engine/playbooks/verify.md'),
  'utf8',
);

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
    diffNames: async () => ['src/a.ts'],
    changedLines: async () => 10,
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
      { id: 'ac-1', statement: 'The change meets the contract', gates: ['verify', 'commit'], evidence: 'verification-check' },
      { id: 'ac-spec', statement: 'kept', gates: ['spec'], evidence: 'brief' },
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
  changedLines?: number;
  diffNames?: string[];
  reviewerNotes?: string[];
  verifierNotes?: string;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cf-verify-phase-'));
  const workerRuns: WorkerTask[] = [];
  const diffCalls: { root: string; base: string; path?: string }[] = [];
  const lineCalls: { root: string; base: string }[] = [];
  const dir = ensureAttempt(root, 'run-1', 1);
  writeFileSync(join(dir, 'status.md'), '- base: main@abc\n- branch: feat/gh-7\n');
  const reviewerNotes = [...(options.reviewerNotes ?? [''])];
  let reviewerCall = 0;
  const git = fakeGit({
    diffNames: async (repoRoot, base, path) => {
      diffCalls.push({ root: repoRoot, base, path });
      return options.diffNames ?? ['src/a.ts'];
    },
    changedLines: async (repoRoot, base) => {
      lineCalls.push({ root: repoRoot, base });
      return options.changedLines ?? 10;
    },
    ...options.git,
  });
  const workers: WorkerPort = {
    async run(task) {
      workerRuns.push(task);
      let notes = '';
      if (task.role !== 'implement') {
        if (task.unitId.startsWith('review-')) {
          notes = reviewerNotes[reviewerCall] ?? reviewerNotes.at(-1) ?? '';
          reviewerCall += 1;
        } else {
          notes = options.verifierNotes ?? '';
        }
      }
      const report: WorkerReport = { status: 'done', filesChanged: [], notes, route: task.role };
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
  const input: PhaseInput = { phase: 'verify', attempt: 1, contract: contract(), runId: 'run-1' };
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
      async run() { throw new Error('command was called'); },
    },
    ci: { waitMs: 0, extraIntervalMs: 0 },
    readPlaybook: (name: string) => {
      if (name !== 'verify.md') throw new Error(`playbook ${name} was read`);
      return PLAYBOOK;
    },
    flow: options.flow ?? 'feature',
  };
  return { root, dir, input, ctx, workerRuns, diffCalls, lineCalls };
}

function reviewers(tasks: WorkerTask[]): WorkerTask[] {
  return tasks.filter((task) => task.unitId.startsWith('review-'));
}

function verifiers(tasks: WorkerTask[]): WorkerTask[] {
  return tasks.filter((task) => task.role === 'default' && !task.unitId.startsWith('review-'));
}

function fixes(tasks: WorkerTask[]): WorkerTask[] {
  return tasks.filter((task) => task.role === 'implement');
}

describe('runVerifyPhase', () => {
  it('records verification-check with no fix when the reviewer finds nothing', async () => {
    const h = setup({ diffNames: ['src/a.ts', 'src/b.ts'] });
    const output = await runVerifyPhase(h.input, h.ctx);
    expect(reviewers(h.workerRuns)).toHaveLength(1);
    expect(h.workerRuns).toHaveLength(1);
    expect(h.workerRuns[0]).toMatchObject({ role: 'default', unitId: 'review-all' });
    expect(h.workerRuns[0].prompt).toContain('review-1.diff');
    expect(fixes(h.workerRuns)).toHaveLength(0);
    expect(h.lineCalls).toEqual([{ root: h.root, base: 'abc' }]);
    expect(h.diffCalls).toEqual([{ root: h.root, base: 'abc', path: undefined }]);
    expect(readFileSync(join(h.dir, 'review-1.diff'), 'utf8')).toContain('src/a.ts');
    expect(readFileSync(join(h.dir, 'review-1.diff'), 'utf8')).toContain('src/b.ts');
    const review = readFileSync(join(h.dir, 'review-1.md'), 'utf8');
    expect(review).toContain('## Must');
    expect(review).toContain('## Nice');
    expect(review).toContain('## Could');
    expect(output.events).toEqual([
      { type: 'phase_completed', message: 'verify phase completed (attempt 1)' },
    ]);
    expect(output.evidence).toEqual([{
      attempt: 1,
      phase: 'verify',
      producerPhase: 'verify',
      criterionIds: ['ac-1'],
      kind: 'verification-check',
      summary: 'baseline resolved 0 baseline open 0 deferred 0',
    }]);
    expect(readFileSync(join(h.dir, 'status.md'), 'utf8')).toContain('- phase: verify');
  });

  it('uses one reviewer below 300 changed lines and three at 300', async () => {
    const small = setup({ changedLines: 299 });
    await runVerifyPhase(small.input, small.ctx);
    expect(reviewers(small.workerRuns).map((task) => task.unitId)).toEqual(['review-all']);
    expect(small.workerRuns.every((task) => task.role === 'default')).toBe(true);
    expect(fixes(small.workerRuns)).toHaveLength(0);

    const large = setup({ changedLines: 300 });
    await runVerifyPhase(large.input, large.ctx);
    const ids = reviewers(large.workerRuns).map((task) => task.unitId);
    expect(ids).toEqual(['review-correctness', 'review-tests', 'review-security']);
    expect(large.workerRuns).toHaveLength(3);
    for (const task of reviewers(large.workerRuns)) {
      expect(task.role).toBe('default');
      expect(task.runDir).toBe(join(large.dir, 'units', task.unitId));
      expect(task.prompt).toContain('review-1.diff');
    }
    expect(fixes(large.workerRuns)).toHaveLength(0);
  });

  it('fixes a pass-1 must-fix once and records it resolved on the next pass', async () => {
    const h = setup({
      reviewerNotes: [MUST, 'BASE M1 resolved'],
      verifierNotes: '',
    });
    const output = await runVerifyPhase(h.input, h.ctx);
    const fix = fixes(h.workerRuns);
    expect(verifiers(h.workerRuns)).toHaveLength(1);
    expect(fix).toHaveLength(1);
    expect(fix[0].role).toBe('implement');
    expect(fix[0].allowedFiles).toEqual(['src/a.ts']);
    expect(fix[0].unitId).toContain('M1');
    expect(fix[0].prompt).toContain('M1');
    expect(fix[0].prompt).toContain('Do not edit other files.');
    expect(h.workerRuns.indexOf(verifiers(h.workerRuns)[0])).toBeLessThan(h.workerRuns.indexOf(fix[0]));
    expect(existsSync(join(h.dir, 'review-1.md'))).toBe(true);
    expect(existsSync(join(h.dir, 'review-2.md'))).toBe(true);
    expect(existsSync(join(h.dir, 'review-3.md'))).toBe(false);
    const review = readFileSync(join(h.dir, 'review-1.md'), 'utf8');
    expect(review).toContain('## Must');
    expect(review).toContain('Title');
    expect(review).toContain('## Nice');
    expect(review).toContain('## Could');
    const status = readFileSync(join(h.dir, 'status.md'), 'utf8');
    const rows = status.split('\n').filter((line) => line.startsWith('- M1 |'));
    expect(rows[0]).toBe('- M1 | open | Title');
    expect(rows.at(-1)).toBe('- M1 | resolved | Title');
    expect(output.evidence[0]).toMatchObject({
      kind: 'verification-check',
      producerPhase: 'verify',
      criterionIds: ['ac-1'],
      summary: 'baseline resolved 1 baseline open 0 deferred 0',
    });
    expect(output.evidence[0].summary).toContain('baseline open 0');
  });

  it('returns evidence when the baseline stays open after two fix rounds', async () => {
    const h = setup({
      reviewerNotes: [MUST, 'BASE M1 open', 'BASE M1 open'],
      verifierNotes: '',
    });
    const output = await runVerifyPhase(h.input, h.ctx);
    expect(reviewers(h.workerRuns)).toHaveLength(3);
    expect(fixes(h.workerRuns)).toHaveLength(2);
    expect(fixes(h.workerRuns).every((task) => task.unitId.includes('M1'))).toBe(true);
    expect(fixes(h.workerRuns).every((task) => task.allowedFiles.includes('src/a.ts'))).toBe(true);
    expect(existsSync(join(h.dir, 'review-1.md'))).toBe(true);
    expect(existsSync(join(h.dir, 'review-2.md'))).toBe(true);
    expect(existsSync(join(h.dir, 'review-3.md'))).toBe(true);
    expect(output.evidence[0]).toMatchObject({
      kind: 'verification-check',
      producerPhase: 'verify',
      summary: 'baseline resolved 0 baseline open 1 deferred 0',
    });
    expect(output.evidence[0].summary).toContain('baseline open 1');
    const rows = readFileSync(join(h.dir, 'status.md'), 'utf8').split('\n').filter((line) => line.startsWith('- M1 |'));
    expect(rows.at(-1)).toBe('- M1 | open | Title');
  });

  it('records a new pass-2 must-fix as P2-M1 and leaves it out of every fix prompt', async () => {
    const h = setup({
      reviewerNotes: [
        MUST,
        'BASE M1 open\nMUST src/b.ts:4 Second | it leaks | close it',
        'BASE M1 resolved',
      ],
      verifierNotes: '',
    });
    const output = await runVerifyPhase(h.input, h.ctx);
    const status = readFileSync(join(h.dir, 'status.md'), 'utf8');
    expect(status).toContain('## Deferred must-fix');
    expect(status).toContain('P2-M1');
    const fix = fixes(h.workerRuns);
    expect(fix.length).toBeGreaterThan(0);
    for (const task of fix) {
      expect(task.prompt).toContain('M1');
      expect(task.prompt).not.toContain('P2-M1');
      expect(task.prompt).not.toContain('src/b.ts');
      expect(task.allowedFiles).toEqual(['src/a.ts']);
    }
    expect(output.evidence[0].summary).toContain('deferred 1');
    expect(output.evidence[0].summary).toBe('baseline resolved 1 baseline open 0 deferred 1');
  });

  it('drops a must-fix the verifier disproves and does not call a fix worker', async () => {
    const h = setup({
      reviewerNotes: [MUST],
      verifierNotes: 'DISPROVE M1 covered by test',
    });
    const output = await runVerifyPhase(h.input, h.ctx);
    expect(reviewers(h.workerRuns)).toHaveLength(1);
    expect(verifiers(h.workerRuns)).toHaveLength(1);
    expect(verifiers(h.workerRuns)[0].prompt).toContain('M1');
    expect(verifiers(h.workerRuns)[0].prompt).toContain('Title');
    expect(fixes(h.workerRuns)).toHaveLength(0);
    expect(existsSync(join(h.dir, 'review-2.md'))).toBe(false);
    const review = readFileSync(join(h.dir, 'review-1.md'), 'utf8');
    expect(review).not.toContain('Title');
    const status = readFileSync(join(h.dir, 'status.md'), 'utf8');
    expect(status).not.toContain('- M1 | open |');
    expect(output.evidence[0]).toMatchObject({
      kind: 'verification-check',
      criterionIds: ['ac-1'],
      summary: 'baseline resolved 0 baseline open 0 deferred 0',
    });
  });

  it('throws when the working tree is dirty and does not dispatch a worker', async () => {
    const h = setup({ git: { statusPorcelain: async () => ' M src/a.ts' } });
    await expect(runVerifyPhase(h.input, h.ctx)).rejects.toThrow(/working tree is dirty/);
    expect(h.workerRuns).toHaveLength(0);
    expect(h.lineCalls).toHaveLength(0);
    expect(h.diffCalls).toHaveLength(0);
  });

  it('throws when HEAD is not the branch recorded in status', async () => {
    const h = setup({ git: { headBranch: async () => 'main' } });
    await expect(runVerifyPhase(h.input, h.ctx)).rejects.toThrow('HEAD is main, expected feat/gh-7');
    expect(h.workerRuns).toHaveLength(0);
  });
});

describe('verify.md', () => {
  it('states the line format, the three reviewer angles, and that reviewers do not edit files', () => {
    expect(PLAYBOOK).toContain('MUST src/a.ts:10 Title | failure scenario | suggested fix');
    expect(PLAYBOOK).toContain('NICE src/a.ts:3 Title | why | suggestion');
    expect(PLAYBOOK).toContain('COULD src/a.ts:1 Title');
    expect(PLAYBOOK).toContain('correctness');
    expect(PLAYBOOK).toContain('tests and intent');
    expect(PLAYBOOK).toContain('security, data, and performance');
    expect(PLAYBOOK).toMatch(/reviewers do not edit files/i);
  });
});
