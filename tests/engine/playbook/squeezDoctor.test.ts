import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SqueezDoctor, SqueezDoctorReport } from '../../../src/engine/playbook/ports.js';
import { ProcessSqueezDoctor } from '../../../src/engine/playbook/processSqueezDoctor.js';
import { recordSqueezDoctor } from '../../../src/engine/playbook/recordSqueezDoctor.js';
import { attemptDir, ensureAttempt } from '../../../src/engine/playbook/runFolder.js';
import { DEFAULT_CONFIG, type Contract } from '../../../src/domain/types.js';
import { DispatchRunEngine } from '../../../src/engine/playbook/dispatchEngine.js';
import { PlaybookRunEngine } from '../../../src/engine/playbook/playbookEngine.js';
import { SimulatorRunEngine } from '../../../src/engine/simulator.js';
import type { ChocolateData } from '../../../src/files/chocolateFiles.js';
import { RunService } from '../../../src/runs/runService.js';
import { SqliteRunStore } from '../../../src/store/runStore.js';

function attempt(): string {
  const root = mkdtempSync(join(tmpdir(), 'cf-squeez-'));
  return ensureAttempt(root, 'run-1', 1);
}

function probe(report: SqueezDoctorReport, calls: { n: number }): SqueezDoctor {
  return {
    async doctor() {
      calls.n += 1;
      return report;
    },
  };
}

describe('recordSqueezDoctor', () => {
  it('writes the status line and the report on the first call', async () => {
    const dir = attempt();
    const calls = { n: 0 };
    await recordSqueezDoctor(dir, probe({ status: 'ok', output: 'hooks ok' }, calls));
    expect(calls.n).toBe(1);
    expect(readFileSync(join(dir, 'status.md'), 'utf8')).toContain('- squeez-doctor: ok\n');
    expect(readFileSync(join(dir, 'squeez-doctor.txt'), 'utf8')).toBe('hooks ok');
  });

  it('does not call the probe again when the status line exists', async () => {
    const dir = attempt();
    const calls = { n: 0 };
    const doctor = probe({ status: 'failed', output: 'FAIL hooks' }, calls);
    await recordSqueezDoctor(dir, doctor);
    rmSync(join(dir, 'squeez-doctor.txt'));
    await recordSqueezDoctor(dir, doctor);
    expect(calls.n).toBe(1);
    expect(readFileSync(join(dir, 'status.md'), 'utf8')).toContain('- squeez-doctor: failed\n');
  });

  it('writes unavailable when the probe throws', async () => {
    const dir = attempt();
    const doctor: SqueezDoctor = {
      async doctor() {
        throw new Error('probe exploded');
      },
    };
    await recordSqueezDoctor(dir, doctor);
    expect(readFileSync(join(dir, 'status.md'), 'utf8')).toContain('- squeez-doctor: unavailable\n');
    expect(readFileSync(join(dir, 'squeez-doctor.txt'), 'utf8')).toBe('probe exploded');
  });

  it('records each status value on its own line', async () => {
    for (const status of ['ok', 'failed', 'unavailable'] as const) {
      const dir = attempt();
      await recordSqueezDoctor(dir, probe({ status, output: status }, { n: 0 }));
      expect(readFileSync(join(dir, 'status.md'), 'utf8')).toContain(`- squeez-doctor: ${status}\n`);
    }
  });
});

describe('ProcessSqueezDoctor', () => {
  it('returns ok and concatenates stdout and stderr', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-squeez-bin-'));
    const script = join(root, 'doctor.mjs');
    writeFileSync(script, "process.stdout.write('OUT'); process.stderr.write('ERR');\n");
    const report = await new ProcessSqueezDoctor({ command: [process.execPath, script] }).doctor();
    expect(report).toEqual({ status: 'ok', output: 'OUTERR' });
  });

  it('returns failed with the exit line when the capture is empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-squeez-bin-'));
    const script = join(root, 'doctor.mjs');
    writeFileSync(script, 'process.exit(3);\n');
    const report = await new ProcessSqueezDoctor({ command: [process.execPath, script] }).doctor();
    expect(report).toEqual({ status: 'failed', output: 'squeez doctor exited 3' });
  });

  it('returns unavailable when the executable is missing', async () => {
    const report = await new ProcessSqueezDoctor({ command: ['/this/squeez/does/not/exist'] }).doctor();
    expect(report.status).toBe('unavailable');
    expect(report.output).toContain('ENOENT');
  });

  it('returns failed with the timeout line when the process exceeds the limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-squeez-bin-'));
    const script = join(root, 'doctor.mjs');
    writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    const report = await new ProcessSqueezDoctor({
      command: [process.execPath, script],
      timeoutMs: 200,
    }).doctor();
    expect(report).toEqual({ status: 'failed', output: 'squeez doctor timed out after 200ms' });
  });

  it('returns failed with the size line when output exceeds maxBuffer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-squeez-bin-'));
    const script = join(root, 'doctor.mjs');
    writeFileSync(script, "process.stdout.write('x'.repeat(50));\n");
    const report = await new ProcessSqueezDoctor({
      command: [process.execPath, script],
      maxBuffer: 20,
    }).doctor();
    expect(report).toEqual({ status: 'failed', output: 'squeez doctor report exceeded 20 bytes' });
  });
});

const openStores: SqliteRunStore[] = [];
afterEach(() => {
  for (const store of openStores) store.close();
  openStores.length = 0;
});

const textContract: Contract = {
  id: 'feat-a',
  title: 'Inbox',
  intent: 'List issues',
  acceptance_criteria: [],
  constraints: [],
  out_of_scope: [],
  linked_issue: null,
  milestone: 'm1',
  dependencies: [],
};

describe('PlaybookRunEngine squeez doctor', () => {
  it('calls the probe once per attempt even when the phase throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-squeez-engine-'));
    const store = new SqliteRunStore(join(root, 'test.db'));
    openStores.push(store);
    store.createRun({
      id: 'run-1',
      contractId: 'feat-a',
      contractRevision: 'rev1',
      issue: null,
      phase: 'spec',
      state: 'running',
      currentAttempt: 1,
      execPlanRef: '.chocolate/exec-plans/run-1.md',
      flow: 'feature',
      engine: 'playbook',
    });
    let calls = 0;
    const engine = new PlaybookRunEngine({
      repoRoot: root,
      files: { load: () => { throw new Error('unused'); }, readContractFile: () => '', saveContract: () => 'rev' },
      store,
      git: {
        isRepo: async () => false,
        statusPorcelain: async () => '',
        originHead: async () => null,
        fetch: async () => {},
        branchExists: async () => false,
        createBranch: async () => {},
        headBranch: async () => 'main',
        headSha: async () => 'abc',
        commitAll: async () => {},
        diffNames: async () => [],
        changedLines: async () => 0,
        push: async () => {},
        remoteHead: async () => null,
        revert: async () => {},
        deleteUntracked: async () => {},
      },
      forge: {
        defaultBranch: async () => null,
        readIssue: async () => ({ title: '', body: '', comments: [] }),
        viewPr: async () => null,
        upsertPr: async () => { throw new Error('unused'); },
        checks: async () => [],
        rerunFailed: async () => {},
        failedLog: async () => '',
      },
      workers: { run: async () => { throw new Error('unused'); } },
      commands: { run: async () => ({ ok: true, output: '' }) },
      ci: { waitMs: 0, extraIntervalMs: 0 },
      readPlaybook: () => '',
      squeez: {
        async doctor() {
          calls += 1;
          return { status: 'ok', output: 'report' };
        },
      },
    });
    const input = { phase: 'spec' as const, attempt: 1, contract: textContract, runId: 'run-1' };
    await expect(engine.runPhase(input)).rejects.toThrow('not a git checkout');
    await expect(engine.runPhase(input)).rejects.toThrow('not a git checkout');
    expect(calls).toBe(1);
    const dir = attemptDir(root, 'run-1', 1);
    expect(readFileSync(join(dir, 'status.md'), 'utf8')).toContain('- squeez-doctor: ok\n');
    expect(readFileSync(join(dir, 'squeez-doctor.txt'), 'utf8')).toBe('report');
  });

  it('finishes the phase when doctor returns failed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-squeez-engine-'));
    const store = new SqliteRunStore(join(root, 'test.db'));
    openStores.push(store);
    store.createRun({
      id: 'run-1',
      contractId: 'feat-a',
      contractRevision: 'rev1',
      issue: null,
      phase: 'spec',
      state: 'running',
      currentAttempt: 1,
      execPlanRef: '.chocolate/exec-plans/run-1.md',
      flow: 'feature',
      engine: 'playbook',
    });
    const engine = new PlaybookRunEngine({
      repoRoot: root,
      files: {
        load: () => { throw new Error('unused'); },
        readContractFile: () => '',
        saveContract: () => 'rev-2',
      },
      store,
      git: {
        isRepo: async () => true,
        statusPorcelain: async () => '',
        originHead: async () => 'main',
        fetch: async () => {},
        branchExists: async () => false,
        createBranch: async () => {},
        headBranch: async () => 'feat/feat-a',
        headSha: async () => 'abc',
        commitAll: async () => {},
        diffNames: async () => [],
        changedLines: async () => 0,
        push: async () => {},
        remoteHead: async () => null,
        revert: async () => {},
        deleteUntracked: async () => {},
      },
      forge: {
        defaultBranch: async () => null,
        readIssue: async () => ({ title: '', body: '', comments: [] }),
        viewPr: async () => null,
        upsertPr: async () => { throw new Error('unused'); },
        checks: async () => [],
        rerunFailed: async () => {},
        failedLog: async () => '',
      },
      workers: {
        async run(task) {
          writeFileSync(task.runDir + '/brief.md', '# Brief\n\n## Requirements / acceptance criteria\n- The inbox lists the issue\n');
          return { status: 'done' as const, filesChanged: [], notes: '', route: task.role };
        },
      },
      commands: { run: async () => ({ ok: true, output: '' }) },
      ci: { waitMs: 0, extraIntervalMs: 0 },
      readPlaybook: () => 'spec playbook',
      squeez: { async doctor() { return { status: 'failed', output: 'FAIL hooks' }; } },
    });
    const out = await engine.runPhase({ phase: 'spec', attempt: 1, contract: textContract, runId: 'run-1' });
    expect(out.events[0]?.type).toBe('phase_completed');
    const dir = attemptDir(root, 'run-1', 1);
    expect(readFileSync(join(dir, 'status.md'), 'utf8')).toContain('- squeez-doctor: failed\n');
    expect(readFileSync(join(dir, 'squeez-doctor.txt'), 'utf8')).toBe('FAIL hooks');
  });

  it('a simulator advance creates no squeez-doctor.txt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-squeez-sim-'));
    const store = new SqliteRunStore(join(root, 'test.db'));
    openStores.push(store);
    const data: ChocolateData = {
      contracts: [textContract],
      invalidContracts: [],
      roadmap: { milestones: [{ id: 'm1', title: 'M', intent: 'x', contracts: ['feat-a'] }] },
      roadmapError: null,
      config: DEFAULT_CONFIG,
      crossRefErrors: [],
    };
    let playbookCalls = 0;
    const engine = new DispatchRunEngine({
      store,
      simulator: new SimulatorRunEngine(),
      playbook: { async runPhase() { playbookCalls += 1; return { events: [], evidence: [] }; } },
    });
    const runs = new RunService({
      store,
      engine,
      files: { load: () => data, readContractFile: () => '', saveContract: () => 'rev-2' },
      config: DEFAULT_CONFIG,
      repoRoot: root,
    });
    const run = runs.claim({ issue: null, contract: textContract, contractRevision: 'rev1', engine: 'simulator' });
    await runs.advance(run.id);
    expect(playbookCalls).toBe(0);
    expect(existsSync(join(root, '.chocolate', 'runtime', 'runs', run.id, 'attempt-1', 'squeez-doctor.txt'))).toBe(false);
  });
});
