import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Contract, Flow } from '../../../src/domain/types.js';
import type { PhaseInput } from '../../../src/engine/runEngine.js';
import { ensureAttempt } from '../../../src/engine/playbook/runFolder.js';
import type { CommandResult, GitPort, ToolboxGit, WorkerPort, WorkerReport, WorkerTask } from '../../../src/engine/playbook/ports.js';
import type { FilesPort } from '../../../src/runs/runService.js';
import type { SqliteRunStore } from '../../../src/store/runStore.js';
import { runImplementPhase } from '../../../src/engine/playbook/phases/implementPhase.js';

const PLAYBOOK_PATH = fileURLToPath(new URL('../../../src/engine/playbooks/implement.md', import.meta.url));

const DEFAULT_PLAN = [
  '| ID | Goal | Files (create/modify) | Depends on | Verify with |',
  '| --- | --- | --- | --- | --- |',
  '| U1 | goal | src/a.ts | - | pnpm test a |',
  '| U2 | goal | src/b.ts | - | pnpm test b |',
].join('\n');

const REPRO = 'test: tests/bug.test.ts::name\n';
const PORCELAIN = ' M src/a.ts\n M src/other.ts\n?? stray.ts';

function plan(rows: { id: string; files: string; depends?: string; verify: string }[]): string {
  const lines = [
    '| ID | Goal | Files (create/modify) | Depends on | Verify with |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    lines.push(`| ${row.id} | goal | ${row.files} | ${row.depends ?? '-'} | ${row.verify} |`);
  }
  return lines.join('\n');
}

function implementDoc(rows: [string, string, string, string][]): string {
  return [
    '| ID | Status | Route | Fallback |',
    '| --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.join(' | ')} |`),
    '',
  ].join('\n');
}

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
    push: async () => { throw new Error('push was called'); },
    remoteHead: async () => null,
    revert: async () => {},
    deleteUntracked: async () => {},
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
  plan?: string;
  flow?: Flow;
  git?: Partial<GitPort>;
  results?: Record<string, CommandResult[]>;
  reports?: Record<string, Partial<WorkerReport>[]>;
  repro?: string;
  overlap?: boolean;
  diffResult?: string[];
  toolboxGit?: ToolboxGit;
  manifest?: string;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cf-implement-'));
  const workerRuns: WorkerTask[] = [];
  const commandRuns: { root: string; command: string }[] = [];
  const commits: { root: string; message: string }[] = [];
  const reverts: string[][] = [];
  const deletes: string[][] = [];
  const diffCalls: { root: string; base: string; path?: string }[] = [];
  const saved: Contract[] = [];
  const dir = ensureAttempt(root, 'run-1', 1);
  writeFileSync(join(dir, 'status.md'), '- branch: feat/gh-7\n- base: main@abc\n');
  writeFileSync(join(dir, 'plan.md'), options.plan ?? DEFAULT_PLAN);
  if (options.repro !== undefined) writeFileSync(join(dir, 'repro.md'), options.repro);
  if (options.manifest !== undefined) {
    mkdirSync(join(root, 'chocolate-tools'), { recursive: true });
    writeFileSync(join(root, 'chocolate-tools/manifest.md'), options.manifest);
  }
  const flow = options.flow ?? 'feature';
  let started = 0;
  let release: () => void = () => {};
  const overlapped = new Promise<void>((resolve) => { release = resolve; });
  const queues = new Map<string, CommandResult[]>();
  for (const [command, results] of Object.entries(options.results ?? {})) queues.set(command, [...results]);
  const reports = new Map<string, Partial<WorkerReport>[]>();
  for (const [id, list] of Object.entries(options.reports ?? {})) reports.set(id, [...list]);
  const git = fakeGit({
    commitAll: async (repoRoot, message) => { commits.push({ root: repoRoot, message }); },
    revert: async (_repoRoot, paths) => { reverts.push(paths); },
    deleteUntracked: async (_repoRoot, paths) => { deletes.push(paths); },
    diffNames: async (repoRoot, base, path) => {
      diffCalls.push({ root: repoRoot, base, path });
      if (flow !== 'bug') throw new Error('diffNames was called');
      return options.diffResult ?? [];
    },
    push: async () => { throw new Error('push was called'); },
    ...options.git,
  });
  const workers: WorkerPort = {
    async run(task) {
      workerRuns.push(task);
      if (options.overlap) {
        started += 1;
        if (started >= 2) release();
        const timeout = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('workers did not overlap')), 500);
        });
        await Promise.race([overlapped, timeout]);
      }
      const scripted = reports.get(task.unitId)?.shift();
      const report: WorkerReport = {
        status: scripted?.status ?? 'done',
        filesChanged: [],
        notes: scripted?.notes ?? '',
        route: scripted?.route ?? task.role,
      };
      if (scripted?.fallback !== undefined) report.fallback = scripted.fallback;
      return report;
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
    updateRunState() { throw new Error('updateRunState was called'); },
  } as unknown as SqliteRunStore;
  const input: PhaseInput = { phase: 'implement', attempt: 1, contract: contract(), runId: 'run-1' };
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
        const queue = queues.get(command);
        if (!queue || queue.length === 0) return { ok: true, output: '' };
        return queue.length === 1 ? queue[0] : queue.shift()!;
      },
    },
    ci: { waitMs: 0, extraIntervalMs: 0 },
    readPlaybook: (name: string) => {
      if (name !== 'implement.md') throw new Error(`unexpected playbook ${name}`);
      return readFileSync(PLAYBOOK_PATH, 'utf8');
    },
    flow,
    ...(options.toolboxGit ? { toolboxGit: options.toolboxGit } : {}),
  };
  return { root, dir, input, ctx, workerRuns, commandRuns, commits, reverts, deletes, diffCalls, saved };
}

function unit(runs: WorkerTask[], id: string): WorkerTask {
  const task = runs.find((item) => item.unitId === id);
  if (!task) throw new Error(`missing worker ${id}`);
  return task;
}

describe('runImplementPhase', () => {
  it('commits one wave once and records implement evidence', async () => {
    const h = setup({ overlap: true });
    const output = await runImplementPhase(h.input, h.ctx);
    const planPath = join(h.dir, 'plan.md');
    expect(h.workerRuns).toHaveLength(2);
    const u1 = unit(h.workerRuns, 'U1');
    const u2 = unit(h.workerRuns, 'U2');
    expect(u1.role).toBe('implement');
    expect(u2.role).toBe('implement');
    expect(u1.runDir).toBe(join(h.dir, 'units', 'U1'));
    expect(u1.repoRoot).toBe(h.root);
    expect(u1.allowedFiles).toEqual(['src/a.ts']);
    expect(u2.allowedFiles).toEqual(['src/b.ts']);
    expect(u1.prompt).toContain(readFileSync(PLAYBOOK_PATH, 'utf8'));
    expect(u1.prompt).toContain(planPath);
    expect(u1.prompt).toContain('Unit: U1');
    expect(u1.prompt).toContain('Allowed files: src/a.ts');
    expect(u1.prompt).toContain('Verify: pnpm test a');
    expect(u1.prompt).not.toContain('src/b.ts');
    expect(u1.prompt).not.toContain('pnpm test b');
    expect(u2.prompt).toContain('Unit: U2');
    expect(u2.prompt).toContain('Verify: pnpm test b');
    expect(h.commandRuns.map((run) => run.command).sort()).toEqual(['pnpm test a', 'pnpm test b']);
    expect(h.commandRuns.every((run) => run.root === h.root)).toBe(true);
    expect(h.commits).toEqual([{ root: h.root, message: 'feat: U1, U2' }]);
    expect(readFileSync(join(h.dir, 'implement.md'), 'utf8')).toBe(implementDoc([
      ['U1', 'done', 'implement', '-'],
      ['U2', 'done', 'implement', '-'],
    ]));
    expect(readFileSync(join(h.dir, 'status.md'), 'utf8')).toContain('- phase: implement');
    expect(output.events).toEqual([{ type: 'phase_completed', message: 'implement phase completed (attempt 1)' }]);
    expect(output.evidence).toEqual([{
      attempt: 1,
      phase: 'implement',
      producerPhase: 'implement',
      criterionIds: [],
      kind: 'implement-summary',
      summary: 'implement U1, U2',
    }]);
    expect(h.saved).toHaveLength(0);
    expect(h.diffCalls).toHaveLength(0);
  });

  it('gives two units in one wave different run directories under the attempt', async () => {
    const h = setup();
    const ready: { id: string; runDir: string }[] = [];
    const workers = h.ctx.workers;
    h.ctx.workers = {
      async run(task) {
        expect(existsSync(task.runDir)).toBe(true);
        ready.push({ id: task.unitId, runDir: task.runDir });
        return workers.run(task);
      },
    };
    await runImplementPhase(h.input, h.ctx);
    const u1 = ready.find((item) => item.id === 'U1');
    const u2 = ready.find((item) => item.id === 'U2');
    expect(u1?.runDir).toBe(join(h.dir, 'units', 'U1'));
    expect(u2?.runDir).toBe(join(h.dir, 'units', 'U2'));
    expect(u1?.runDir).not.toBe(u2?.runDir);
    expect(u1?.runDir.startsWith(h.dir)).toBe(true);
    expect(u2?.runDir.startsWith(h.dir)).toBe(true);
    expect(existsSync(join(h.dir, 'plan.md'))).toBe(true);
    expect(existsSync(join(h.dir, 'status.md'))).toBe(true);
    expect(existsSync(join(h.dir, 'implement.md'))).toBe(true);
  });

  it('commits once per wave when U2 depends on U1', async () => {
    let u2Started = false;
    let committedBeforeU2 = false;
    const h = setup({
      plan: plan([
        { id: 'U1', files: 'src/a.ts', verify: 'pnpm test a' },
        { id: 'U2', files: 'src/b.ts', depends: 'U1', verify: 'pnpm test b' },
      ]),
    });
    const git = h.ctx.git;
    h.ctx.git = {
      ...git,
      commitAll: async (repoRoot, message) => {
        if (!u2Started) committedBeforeU2 = true;
        h.commits.push({ root: repoRoot, message });
      },
    };
    const workers = h.ctx.workers;
    h.ctx.workers = {
      async run(task) {
        if (task.unitId === 'U2') u2Started = true;
        return workers.run(task);
      },
    };
    await runImplementPhase(h.input, h.ctx);
    expect(committedBeforeU2).toBe(true);
    expect(h.commits.map((commit) => commit.message)).toEqual(['feat: U1', 'feat: U2']);
    expect(h.workerRuns.map((task) => task.unitId)).toEqual(['U1', 'U2']);
  });

  it('dispatches U1 a second time when its first command fails', async () => {
    const h = setup({
      results: { 'pnpm test a': [{ ok: false, output: 'boom' }, { ok: true, output: '' }] },
    });
    const output = await runImplementPhase(h.input, h.ctx);
    expect(h.workerRuns.filter((task) => task.unitId === 'U1')).toHaveLength(2);
    expect(h.workerRuns.filter((task) => task.unitId === 'U2')).toHaveLength(1);
    expect(h.commandRuns.filter((run) => run.command === 'pnpm test a').map((run) => run.command)).toEqual([
      'pnpm test a',
      'pnpm test a',
    ]);
    expect(h.commits).toEqual([{ root: h.root, message: 'feat: U1, U2' }]);
    expect(output.evidence[0].kind).toBe('implement-summary');
    expect(readFileSync(join(h.dir, 'implement.md'), 'utf8')).toContain('| U1 | done | implement | - |');
  });

  it('dispatches a partial unit once more', async () => {
    const h = setup({
      reports: { U1: [{ status: 'partial', notes: 'halfway' }, { status: 'done' }] },
    });
    await runImplementPhase(h.input, h.ctx);
    expect(h.workerRuns.filter((task) => task.unitId === 'U1')).toHaveLength(2);
    expect(h.commandRuns.filter((run) => run.command === 'pnpm test a')).toHaveLength(2);
    expect(h.commits).toHaveLength(1);
    expect(readFileSync(join(h.dir, 'implement.md'), 'utf8')).toContain('| U1 | done | implement | - |');
  });

  it('dispatches a blocked unit once more', async () => {
    const h = setup({
      reports: { U1: [{ status: 'blocked', notes: 'needs another pass' }, { status: 'done' }] },
    });
    await runImplementPhase(h.input, h.ctx);
    expect(h.workerRuns.filter((task) => task.unitId === 'U1')).toHaveLength(2);
    expect(h.workerRuns.filter((task) => task.unitId === 'U1').every((task) => task.role === 'implement')).toBe(true);
    expect(h.commits).toHaveLength(1);
  });

  it('throws when U1 fails twice and still runs an independent U2', async () => {
    const h = setup({
      results: {
        'pnpm test a': [{ ok: false, output: 'boom' }, { ok: false, output: 'boom' }],
      },
    });
    await expect(runImplementPhase(h.input, h.ctx)).rejects.toThrow('blocked units: U1');
    expect(h.workerRuns.filter((task) => task.unitId === 'U1')).toHaveLength(2);
    expect(h.workerRuns.filter((task) => task.unitId === 'U2')).toHaveLength(1);
    expect(h.commits).toHaveLength(0);
    expect(readFileSync(join(h.dir, 'implement.md'), 'utf8')).toBe(implementDoc([
      ['U1', 'blocked', 'implement', '-'],
      ['U2', 'done', 'implement', '-'],
    ]));
    expect(readFileSync(join(h.dir, 'status.md'), 'utf8')).not.toContain('- phase: implement');
  });

  it('skips a later wave that depends on a blocked unit', async () => {
    const h = setup({
      plan: plan([
        { id: 'U1', files: 'src/a.ts', verify: 'pnpm test a' },
        { id: 'U2', files: 'src/b.ts', depends: 'U1', verify: 'pnpm test b' },
      ]),
      results: {
        'pnpm test a': [{ ok: false, output: 'boom' }, { ok: false, output: 'boom' }],
      },
    });
    await expect(runImplementPhase(h.input, h.ctx)).rejects.toThrow('blocked units: U1');
    expect(h.workerRuns.filter((task) => task.unitId === 'U1')).toHaveLength(2);
    expect(h.workerRuns.filter((task) => task.unitId === 'U2')).toHaveLength(0);
    expect(h.commits).toHaveLength(0);
    expect(readFileSync(join(h.dir, 'implement.md'), 'utf8')).toBe(implementDoc([
      ['U1', 'blocked', 'implement', '-'],
    ]));
  });

  it('reverts tracked paths and deletes untracked paths outside the allow list', async () => {
    let reads = 0;
    const h = setup({
      git: {
        statusPorcelain: async () => {
          reads += 1;
          return reads === 1 ? '' : PORCELAIN;
        },
      },
    });
    await runImplementPhase(h.input, h.ctx);
    expect(h.reverts.length).toBeGreaterThan(0);
    expect(h.reverts.every((paths) => paths.length === 1 && paths[0] === 'src/other.ts')).toBe(true);
    expect(h.deletes.length).toBeGreaterThan(0);
    expect(h.deletes.every((paths) => paths.length === 1 && paths[0] === 'stray.ts')).toBe(true);
    expect(h.commits).toHaveLength(1);
  });

  it('strips the new: prefix and keeps an allowed untracked file', async () => {
    let reads = 0;
    const h = setup({
      plan: plan([
        { id: 'U1', files: 'new:src/a.ts', verify: 'pnpm test a' },
        { id: 'U2', files: 'new:src/b.ts', verify: 'pnpm test b' },
      ]),
      git: {
        statusPorcelain: async () => {
          reads += 1;
          return reads === 1 ? '' : '?? src/a.ts\n?? stray.ts\n M src/other.ts';
        },
      },
    });
    await runImplementPhase(h.input, h.ctx);
    expect(unit(h.workerRuns, 'U1').allowedFiles).toEqual(['src/a.ts']);
    expect(unit(h.workerRuns, 'U2').allowedFiles).toEqual(['src/b.ts']);
    expect(unit(h.workerRuns, 'U1').prompt).toContain('Allowed files: src/a.ts');
    expect(unit(h.workerRuns, 'U1').prompt).not.toContain('new:');
    expect(h.reverts.length).toBeGreaterThan(0);
    expect(h.deletes.length).toBeGreaterThan(0);
    expect(h.reverts.every((paths) => paths.length === 1 && paths[0] === 'src/other.ts')).toBe(true);
    expect(h.deletes.every((paths) => paths.length === 1 && paths[0] === 'stray.ts')).toBe(true);
    expect(h.reverts.some((paths) => paths.includes('src/a.ts'))).toBe(false);
    expect(h.deletes.some((paths) => paths.includes('src/a.ts'))).toBe(false);
  });

  it('reverts both sides of a rename that fall outside the allow list', async () => {
    let reads = 0;
    const h = setup({
      git: {
        statusPorcelain: async () => {
          reads += 1;
          return reads === 1 ? '' : 'R  src/old.ts -> src/a.ts\nR src/b.ts -> src/new.ts\n?? stray.ts';
        },
      },
    });
    await runImplementPhase(h.input, h.ctx);
    const reverted = h.reverts.flat();
    const deleted = h.deletes.flat();
    expect(reverted).toContain('src/old.ts');
    expect(reverted).toContain('src/new.ts');
    expect(reverted).not.toContain('src/a.ts');
    expect(reverted).not.toContain('src/b.ts');
    expect(deleted).toContain('stray.ts');
    expect(deleted).not.toContain('src/old.ts');
    expect(deleted).not.toContain('src/new.ts');
  });

  it('reverts a tracked repro test and does not delete it', async () => {
    let reads = 0;
    const h = setup({
      flow: 'bug',
      repro: REPRO,
      diffResult: [],
      git: {
        statusPorcelain: async () => {
          reads += 1;
          return reads === 1 ? '' : 'R  tests/bug.test.ts -> tests/moved.test.ts';
        },
      },
    });
    await expect(runImplementPhase(h.input, h.ctx)).rejects.toThrow('repro test was modified');
    expect(h.reverts.flat()).toContain('tests/bug.test.ts');
    expect(h.deletes.flat()).not.toContain('tests/bug.test.ts');
    expect(h.deletes.flat()).not.toContain('tests/moved.test.ts');
    expect(h.commits).toHaveLength(0);
  });

  it('reverts a modified repro test and throws', async () => {
    let reads = 0;
    const h = setup({
      flow: 'bug',
      repro: REPRO,
      diffResult: [],
      git: {
        statusPorcelain: async () => {
          reads += 1;
          return reads === 1 ? '' : ' M tests/bug.test.ts';
        },
      },
    });
    await expect(runImplementPhase(h.input, h.ctx)).rejects.toThrow('repro test was modified');
    expect(h.workerRuns.length).toBeGreaterThan(0);
    expect(h.reverts.some((paths) => paths.includes('tests/bug.test.ts'))).toBe(true);
    expect(h.commits).toHaveLength(0);
  });

  it('throws when the repro test differs from the base sha', async () => {
    const h = setup({
      flow: 'bug',
      repro: REPRO,
      diffResult: ['tests/bug.test.ts'],
    });
    await expect(runImplementPhase(h.input, h.ctx)).rejects.toThrow('repro test was modified');
    expect(h.diffCalls.some((call) => call.root === h.root && call.base === 'abc' && call.path === 'tests/bug.test.ts')).toBe(true);
    expect(h.reverts).toContainEqual(['tests/bug.test.ts']);
    expect(h.commits).toHaveLength(0);
  });

  it('commits a bug wave with a fix message when the repro test is untouched', async () => {
    const h = setup({ flow: 'bug', repro: REPRO, diffResult: [] });
    const output = await runImplementPhase(h.input, h.ctx);
    expect(h.commits).toEqual([{ root: h.root, message: 'fix: U1, U2' }]);
    expect(h.diffCalls.every((call) => call.base === 'abc' && call.path === 'tests/bug.test.ts')).toBe(true);
    expect(h.diffCalls.length).toBeGreaterThan(0);
    expect(h.reverts).toHaveLength(0);
    expect(output.evidence[0]).toMatchObject({ kind: 'implement-summary', criterionIds: [] });
  });

  it('records a fallback route on the unit row and in status', async () => {
    const fallback = 'U1 implement→default (spawn failed: ENOENT)';
    const h = setup({
      reports: { U1: [{ status: 'done', route: 'default', fallback }] },
    });
    await runImplementPhase(h.input, h.ctx);
    expect(readFileSync(join(h.dir, 'implement.md'), 'utf8')).toBe(implementDoc([
      ['U1', 'done', 'default', fallback],
      ['U2', 'done', 'implement', '-'],
    ]));
    expect(readFileSync(join(h.dir, 'status.md'), 'utf8')).toContain(`- fallback: ${fallback}`);
  });

  it('throws when the working tree is dirty and does not call a worker', async () => {
    const h = setup({ git: { statusPorcelain: async () => ' M src/a.ts' } });
    await expect(runImplementPhase(h.input, h.ctx)).rejects.toThrow('working tree is dirty');
    expect(h.workerRuns).toHaveLength(0);
    expect(h.commits).toHaveLength(0);
  });

  it('throws when HEAD is not the branch recorded in status', async () => {
    const h = setup({ git: { headBranch: async () => 'main' } });
    await expect(runImplementPhase(h.input, h.ctx)).rejects.toThrow('HEAD is main, expected feat/gh-7');
    expect(h.workerRuns).toHaveLength(0);
    expect(h.commits).toHaveLength(0);
  });

  it('holds one new tool and reverts a playbook edit', async () => {
    const rootFiles: Record<string, string | null> = { 'chocolate-tools/manifest.md': '' };
    let reads = 0;
    const h = setup({
      toolboxGit: {
        show: async (_root, _rev, path) => rootFiles[path] ?? null,
        restoreTree: async () => {},
      },
      manifest: '## widget\nuse: u\ntest: node t.js\n',
      git: {
        statusPorcelain: async () => {
          reads += 1;
          return reads === 1
            ? ''
            : '?? chocolate-tools/widget/a.js\n?? chocolate-tools/manifest.md\n M src/engine/playbooks/spec.md\n';
        },
      },
    });
    await runImplementPhase(h.input, h.ctx);
    const reverted = h.reverts.flat();
    expect(reverted).toContain('src/engine/playbooks/spec.md');
    expect(reverted).not.toContain('chocolate-tools/widget/a.js');
    expect(h.deletes.flat()).not.toContain('chocolate-tools/widget/a.js');
    expect(h.deletes.flat()).not.toContain('chocolate-tools/manifest.md');
    expect(h.workerRuns[0].prompt).toContain('Toolbox rule:');
  });

  it('reverts an in-place toolbox edit when no directory was added', async () => {
    let reads = 0;
    const h = setup({
      toolboxGit: {
        show: async () => '## old\nuse: u\ntest: node old.js\n',
        restoreTree: async () => {},
      },
      manifest: '## old\nuse: u\ntest: node old.js\n',
      git: {
        statusPorcelain: async () => {
          reads += 1;
          return reads === 1 ? '' : ' M chocolate-tools/old/a.js\n';
        },
      },
    });
    await runImplementPhase(h.input, h.ctx);
    expect(h.reverts.flat()).toContain('chocolate-tools/old/a.js');
  });
});

describe('implement.md', () => {
  it('tells the worker to stay inside the allowed files', () => {
    const text = readFileSync(PLAYBOOK_PATH, 'utf8');
    expect(text).toContain('fix only the allowed files');
    expect(text).toContain('do not commit');
    expect(text).toContain('do not push');
    expect(text).toContain('do not weaken tests');
    expect(text).toContain('worker-report.md');
    expect(text).toContain('STATUS: done|partial|blocked');
  });
});
