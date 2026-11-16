import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Contract, Flow } from '../../../src/domain/types.js';
import type { PhaseInput } from '../../../src/engine/runEngine.js';
import { attemptDir, readStatusValue } from '../../../src/engine/playbook/runFolder.js';
import type { ForgePort, GitPort, WorkerPort, WorkerTask } from '../../../src/engine/playbook/ports.js';
import type { FilesPort } from '../../../src/runs/runService.js';
import type { SqliteRunStore } from '../../../src/store/runStore.js';
import { runSpecPhase } from '../../../src/engine/playbook/phases/specPhase.js';

const PLAYBOOK = '# Spec\nWrite brief.md from intake.json. Do not invent requirements.\n';
const BRIEF = `# Issue 7
- type: feature
- source: https://github.com/o/r/issues/7

## Requirements / acceptance criteria
- The inbox lists the issue
`;
const ISSUE = { tracker: 'github' as const, repo: 'o/r', number: 7, url: 'https://github.com/o/r/issues/7' };

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

function fakeForge(over: Partial<ForgePort> = {}): ForgePort {
  return {
    defaultBranch: async () => 'main',
    readIssue: async () => ({ title: 'Issue 7', body: 'UNTRUSTED-TICKET-BODY', comments: ['UNTRUSTED-COMMENT'] }),
    viewPr: async () => null,
    upsertPr: async () => ({ url: 'https://github.com/o/r/pull/1', number: 1, isDraft: true, headSha: 'abc', headBranch: 'feat/gh-7' }),
    checks: async () => [],
    rerunFailed: async () => {},
    failedLog: async () => '',
    ...over,
  };
}

function contract(over: Partial<Contract> = {}): Contract {
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
    ...over,
  };
}

function setup(options: { git?: Partial<GitPort>; forge?: Partial<ForgePort>; flow?: Flow; contract?: Contract } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cf-spec-'));
  const subject = options.contract ?? contract();
  const saved: Contract[] = [];
  const updates: { id: string; patch: { contractRevision?: string } }[] = [];
  const workerRuns: WorkerTask[] = [];
  const created: { name: string; from: string }[] = [];
  const branchChecks: string[] = [];
  const defaultBranchRepos: string[] = [];
  const issueReads: { repo: string; number: number }[] = [];
  const seen = { intake: '', prompt: '' };
  const innerGit = fakeGit(options.git);
  const git: GitPort = {
    ...innerGit,
    branchExists: async (repoRoot, name) => {
      branchChecks.push(name);
      return innerGit.branchExists(repoRoot, name);
    },
    createBranch: async (repoRoot, name, from) => {
      created.push({ name, from });
      await innerGit.createBranch(repoRoot, name, from);
    },
  };
  const innerForge = fakeForge(options.forge);
  const forge: ForgePort = {
    ...innerForge,
    defaultBranch: async (repo) => {
      defaultBranchRepos.push(repo);
      return innerForge.defaultBranch(repo);
    },
    readIssue: async (repo, number) => {
      issueReads.push({ repo, number });
      return innerForge.readIssue(repo, number);
    },
  };
  const workers: WorkerPort = {
    async run(task) {
      workerRuns.push(task);
      const promptPath = join(task.runDir, 'prompt.md');
      const intakePath = join(task.runDir, 'intake.json');
      if (!existsSync(promptPath)) throw new Error('prompt.md was not written before the worker ran');
      if (!existsSync(intakePath)) throw new Error('intake.json was not written before the worker ran');
      seen.prompt = readFileSync(promptPath, 'utf8');
      seen.intake = readFileSync(intakePath, 'utf8');
      writeFileSync(join(task.runDir, 'brief.md'), BRIEF);
      return { status: 'done', filesChanged: [], notes: '', route: task.role };
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
  const store = { updateRunState(id: string, patch: { contractRevision?: string }) { updates.push({ id, patch }); } } as unknown as SqliteRunStore;
  const input: PhaseInput = { phase: 'spec', attempt: 1, contract: subject, runId: 'run-1' };
  const ctx = {
    repoRoot: root,
    files,
    store,
    git,
    forge,
    workers,
    commands: { run: async () => ({ ok: true, output: '' }) },
    ci: { waitMs: 0, extraIntervalMs: 0 },
    readPlaybook: (name: string) => {
      if (name !== 'spec.md') throw new Error(`unexpected playbook ${name}`);
      return PLAYBOOK;
    },
    flow: options.flow ?? 'feature' as Flow,
  };
  return { root, input, ctx, saved, updates, workerRuns, created, branchChecks, defaultBranchRepos, issueReads, seen };
}

describe('runSpecPhase', () => {
  it('throws when the checkout is not a git repo and does not call the worker', async () => {
    const h = setup({ git: { isRepo: async () => false } });
    await expect(runSpecPhase(h.input, h.ctx)).rejects.toThrow(/not a git checkout/);
    expect(h.workerRuns).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
  });

  it('throws when the working tree is dirty and does not call the worker', async () => {
    const h = setup({ git: { statusPorcelain: async () => ' M src/a.ts' } });
    await expect(runSpecPhase(h.input, h.ctx)).rejects.toThrow(/working tree is dirty/);
    expect(h.workerRuns).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
  });

  it('throws when feat/gh-7 already exists', async () => {
    const h = setup({ git: { branchExists: async () => true } });
    await expect(runSpecPhase(h.input, h.ctx)).rejects.toThrow(/already exists/);
    expect(h.branchChecks).toEqual(['feat/gh-7']);
    expect(h.workerRuns).toHaveLength(0);
  });

  it('throws when the default branch cannot be resolved', async () => {
    const h = setup({
      git: { originHead: async () => null },
      forge: { defaultBranch: async () => null },
    });
    await expect(runSpecPhase(h.input, h.ctx)).rejects.toThrow(/default branch/);
    expect(h.workerRuns).toHaveLength(0);
    expect(h.created).toHaveLength(0);
  });

  it('writes a brief and maps new requirements onto the spec gate', async () => {
    const h = setup({ git: { originHead: async () => 'not-the-base' } });
    const output = await runSpecPhase(h.input, h.ctx);
    const dir = attemptDir(h.root, 'run-1', 1);
    expect(h.created).toEqual([{ name: 'feat/gh-7', from: 'main' }]);
    expect(h.defaultBranchRepos).toEqual(['o/r']);
    expect(h.issueReads).toEqual([{ repo: 'o/r', number: 7 }]);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].acceptance_criteria).toEqual([
      { id: 'ac-1', statement: 'The inbox lists the issue', gates: ['spec', 'verify', 'commit'], evidence: 'brief' },
    ]);
    expect(h.input.contract.acceptance_criteria).toEqual([]);
    expect(h.updates).toEqual([{ id: 'run-1', patch: { contractRevision: 'rev-saved' } }]);
    expect(output.events).toEqual([{ type: 'phase_completed', message: expect.any(String) }]);
    expect(output.evidence).toMatchObject([{ kind: 'brief', criterionIds: ['ac-1'], phase: 'spec', producerPhase: 'spec' }]);
    const status = readFileSync(join(dir, 'status.md'), 'utf8');
    expect(status).toContain('branch: feat/gh-7');
    expect(status).toContain('base: main@abc');
    expect(status).toContain('- flow: feature');
    expect(status).toContain('- source: https://github.com/o/r/issues/7');
    expect(status).toContain('- phase: spec');
    expect(readStatusValue(dir, 'branch')).toBe('feat/gh-7');
    expect(h.workerRuns).toHaveLength(1);
    expect(h.workerRuns[0]).toMatchObject({
      role: 'default',
      unitId: 'spec',
      repoRoot: h.root,
      runDir: dir,
      allowedFiles: [relative(h.root, join(dir, 'brief.md'))],
    });
    expect(h.seen.prompt).toContain(PLAYBOOK);
    expect(h.seen.prompt).toContain(join(dir, 'intake.json'));
    expect(h.seen.prompt).toContain('type: feature');
    expect(h.seen.prompt).not.toContain('UNTRUSTED-TICKET-BODY');
    expect(h.seen.prompt).not.toContain('UNTRUSTED-COMMENT');
    expect(JSON.parse(h.seen.intake)).toEqual({
      title: 'Issue 7',
      body: 'UNTRUSTED-TICKET-BODY',
      comments: ['UNTRUSTED-COMMENT'],
    });
  });

  it('uses fix/gh-7 for a bug flow', async () => {
    const h = setup({ flow: 'bug', git: { originHead: async () => 'not-the-base' } });
    await runSpecPhase(h.input, h.ctx);
    expect(h.created).toEqual([{ name: 'fix/gh-7', from: 'main' }]);
    expect(readStatusValue(attemptDir(h.root, 'run-1', 1), 'branch')).toBe('fix/gh-7');
    expect(h.seen.prompt).toContain('type: bug');
  });

  it('uses the contract id and writes intake from the contract when there is no issue', async () => {
    const subject = contract({ id: 'manual-contract', linked_issue: null, title: 'Inbox', intent: 'List issues' });
    const h = setup({
      contract: subject,
      forge: { defaultBranch: async () => 'wrong-base' },
    });
    await runSpecPhase(h.input, h.ctx);
    const dir = attemptDir(h.root, 'run-1', 1);
    expect(h.created).toEqual([{ name: 'feat/manual-contract', from: 'main' }]);
    expect(h.defaultBranchRepos).toEqual([]);
    expect(h.issueReads).toEqual([]);
    expect(JSON.parse(h.seen.intake)).toEqual({ title: 'Inbox', body: 'List issues', comments: [] });
    expect(existsSync(join(dir, 'prompt.md'))).toBe(true);
    expect(h.seen.prompt).toContain(join(dir, 'intake.json'));
    expect(readFileSync(join(dir, 'status.md'), 'utf8')).toContain('- source: text');
  });

  it('adds spec, commit, and verify to an existing criterion without changing its statement', async () => {
    const subject = contract({
      acceptance_criteria: [{ id: 'ac-9', statement: 'kept', gates: ['verify'], evidence: 'x' }],
    });
    const h = setup({ contract: subject });
    const output = await runSpecPhase(h.input, h.ctx);
    expect(h.saved[0].acceptance_criteria).toEqual([
      { id: 'ac-9', statement: 'kept', gates: ['verify', 'spec', 'commit'], evidence: 'x' },
    ]);
    expect(subject.acceptance_criteria[0]).toEqual({ id: 'ac-9', statement: 'kept', gates: ['verify'], evidence: 'x' });
    expect(output.evidence).toMatchObject([{ kind: 'brief', criterionIds: ['ac-9'], phase: 'spec', producerPhase: 'spec' }]);
  });
});
