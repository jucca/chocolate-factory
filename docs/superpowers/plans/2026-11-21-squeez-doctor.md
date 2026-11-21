# Squeez doctor check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record one `squeez doctor` result per playbook attempt without stopping the walk or changing gate evidence.

**Architecture:** `PlaybookRunEngine.runPhase` calls `recordSqueezDoctor` once per attempt before the phase. The probe is a `SqueezDoctor` port. `ProcessSqueezDoctor` runs `squeez doctor` with no shell. The attempt log gets one status line and `squeez-doctor.txt`.

**Tech Stack:** TypeScript, Node 22, Vitest, `node:child_process` `execFile`, existing playbook ports and `status.md` helpers.

## Global Constraints

- The check runs once per playbook attempt, on the first phase of that attempt.
- The factory runs `squeez doctor` with no host flag and no extra arguments. Squeez decides which installed CLIs it inspects.
- A missing binary, a non-zero exit, or a timeout is a line in the attempt log. The phase still runs.
- The status line is `ok`, `failed`, or `unavailable`. `ok` means exit 0. WARN lines can still be in the report file.
- `squeez-doctor.txt` receives the adapter's output string. That string is the captured doctor text, or the timeout or size line when those rules apply. `status.md` gains one single-line entry.
- The probe result is not evidence, not a gate input, and not part of a worker prompt.
- `ShellCommandRunner`, worker commands, and the simulator stay as they are.
- The operator installs Squeez. The factory does not run `squeez setup` and does not install the binary.
- The cockpit lists `squeez-doctor.txt` by name through the existing artifact list. This slice adds no viewer for the file body.
- Production `ProcessSqueezDoctor` uses command `['squeez', 'doctor']`, `timeoutMs` `15000`, and `maxBuffer` `1024 * 1024`.
- Stdout and stderr are concatenated with no added separator.
- Adapter classification outcomes: `ENOENT` or `EACCES` → `unavailable` with the spawn error message; timeout → `failed` with `squeez doctor timed out after <timeoutMs>ms`; output over `maxBuffer` → `failed` with `squeez doctor report exceeded <maxBuffer> bytes`; exit 0 → `ok` with the capture (empty capture stays empty); numeric non-zero exit → `failed` with the capture, or `squeez doctor exited <code>` when the capture is empty; any other error → `unavailable` with the error message.
- Node sets `killed` on a maxBuffer kill as well as a timeout. Recognize `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` before `killed`, so the size line is not replaced by the timeout line. Timeout remains the `killed` result for every other kill.
- `ProcessSqueezDoctor.doctor()` always returns a report and does not throw.
- If `recordSqueezDoctor` receives a throw from the probe, it writes `unavailable` with that error message and returns.
- A failure to write `squeez-doctor.txt` or `status.md` propagates. The report file is written first, then the status line.
- When `- squeez-doctor:` is already in `status.md`, `recordSqueezDoctor` returns without calling the probe, including when `squeez-doctor.txt` is absent.
- The child runs in the server process environment. Its working directory is the server process working directory. The call uses `execFile` and does not invoke a shell.
- CI does not run a real `squeez` binary.
- `tests/engine/playbook/feature.test.ts` and `tests/engine/playbook/bug.test.ts` pass a fake whose `doctor()` returns `{ status: 'ok', output: '' }`.
- Phase tests call the phase functions directly and do not gain a probe.

---

### Task 1: Record the doctor result once per attempt

**Files:**
- Create: `src/engine/playbook/recordSqueezDoctor.ts`
- Modify: `src/engine/playbook/ports.ts`
- Test: `tests/engine/playbook/squeezDoctor.test.ts`

**Interfaces:**
- Consumes: `appendStatus` and `readStatusValue` from `src/engine/playbook/runFolder.ts`. `readStatusValue(dir, 'squeez-doctor')` matches a line `- squeez-doctor: <value>`.
- Produces:
  - `SqueezDoctorStatus = 'ok' | 'failed' | 'unavailable'`
  - `SqueezDoctorReport = { status: SqueezDoctorStatus; output: string }`
  - `SqueezDoctor = { doctor(): Promise<SqueezDoctorReport> }`
  - `recordSqueezDoctor(dir: string, probe: SqueezDoctor): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/engine/playbook/squeezDoctor.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SqueezDoctor, SqueezDoctorReport } from '../../../src/engine/playbook/ports.js';
import { recordSqueezDoctor } from '../../../src/engine/playbook/recordSqueezDoctor.js';
import { ensureAttempt } from '../../../src/engine/playbook/runFolder.js';

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/engine/playbook/squeezDoctor.test.ts`

Expected: FAIL because `recordSqueezDoctor.js` cannot be resolved, or `SqueezDoctor` is not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/engine/playbook/ports.ts`:

```ts
export type SqueezDoctorStatus = 'ok' | 'failed' | 'unavailable';

export interface SqueezDoctorReport {
  status: SqueezDoctorStatus;
  output: string;
}

export interface SqueezDoctor {
  doctor(): Promise<SqueezDoctorReport>;
}
```

Create `src/engine/playbook/recordSqueezDoctor.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqueezDoctor, SqueezDoctorStatus } from './ports.js';
import { appendStatus, readStatusValue } from './runFolder.js';

export async function recordSqueezDoctor(dir: string, probe: SqueezDoctor): Promise<void> {
  if (readStatusValue(dir, 'squeez-doctor') !== null) return;
  let status: SqueezDoctorStatus = 'unavailable';
  let output = '';
  try {
    const report = await probe.doctor();
    status = report.status;
    output = report.output;
  } catch (err) {
    status = 'unavailable';
    output = err instanceof Error ? err.message : String(err);
  }
  writeFileSync(join(dir, 'squeez-doctor.txt'), output);
  appendStatus(dir, `- squeez-doctor: ${status}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/engine/playbook/squeezDoctor.test.ts`

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/playbook/ports.ts src/engine/playbook/recordSqueezDoctor.ts tests/engine/playbook/squeezDoctor.test.ts
git commit -m "$(cat <<'EOF'
feat: record one squeez doctor result per attempt

EOF
)"
```

---

### Task 2: Run squeez doctor as a process

**Files:**
- Create: `src/engine/playbook/processSqueezDoctor.ts`
- Modify: `tests/engine/playbook/squeezDoctor.test.ts`
- Test: `tests/engine/playbook/squeezDoctor.test.ts`

**Interfaces:**
- Consumes: `SqueezDoctor` and `SqueezDoctorReport` from Task 1.
- Produces: `ProcessSqueezDoctor` implementing `SqueezDoctor`.
  - `constructor(options?: { command?: string[]; timeoutMs?: number; maxBuffer?: number })`
  - Defaults: `command` `['squeez', 'doctor']`, `timeoutMs` `15000`, `maxBuffer` `1024 * 1024`.
  - `doctor(): Promise<SqueezDoctorReport>` never throws.

- [ ] **Step 1: Write the failing test**

Add `writeFileSync` to the existing `node:fs` import. Add this import, then the describe block:

```ts
import { ProcessSqueezDoctor } from '../../../src/engine/playbook/processSqueezDoctor.js';

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/engine/playbook/squeezDoctor.test.ts`

Expected: FAIL because `processSqueezDoctor.js` cannot be resolved. The Task 1 tests still pass.

- [ ] **Step 3: Write the minimal implementation**

Create `src/engine/playbook/processSqueezDoctor.ts`:

```ts
import { execFile } from 'node:child_process';
import type { SqueezDoctor, SqueezDoctorReport } from './ports.js';

const DEFAULT_COMMAND = ['squeez', 'doctor'];
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

export class ProcessSqueezDoctor implements SqueezDoctor {
  private readonly command: string[];
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;

  constructor(options: { command?: string[]; timeoutMs?: number; maxBuffer?: number } = {}) {
    this.command = options.command ?? DEFAULT_COMMAND;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  }

  doctor(): Promise<SqueezDoctorReport> {
    const [bin, ...args] = this.command;
    return new Promise((resolve) => {
      if (!bin) {
        resolve({ status: 'unavailable', output: 'missing command' });
        return;
      }
      execFile(bin, args, { timeout: this.timeoutMs, maxBuffer: this.maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : '';
        const errText = typeof stderr === 'string' ? stderr : '';
        const text = out + errText;
        if (!err) {
          resolve({ status: 'ok', output: text });
          return;
        }
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES') {
          resolve({ status: 'unavailable', output: err.message });
          return;
        }
        if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          resolve({ status: 'failed', output: `squeez doctor report exceeded ${this.maxBuffer} bytes` });
          return;
        }
        const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
        if (killed) {
          resolve({ status: 'failed', output: `squeez doctor timed out after ${this.timeoutMs}ms` });
          return;
        }
        if (typeof code === 'number') {
          resolve({ status: 'failed', output: text === '' ? `squeez doctor exited ${code}` : text });
          return;
        }
        resolve({ status: 'unavailable', output: err.message });
      });
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/engine/playbook/squeezDoctor.test.ts`

Expected: PASS, 9 tests. The timeout test finishes in well under the default Vitest timeout.

- [ ] **Step 5: Commit**

```bash
git add src/engine/playbook/processSqueezDoctor.ts tests/engine/playbook/squeezDoctor.test.ts
git commit -m "$(cat <<'EOF'
feat: run squeez doctor without failing the caller

EOF
)"
```

---

### Task 3: Check doctor before each playbook phase

**Files:**
- Modify: `src/engine/playbook/phases/specPhase.ts` (`PhaseContext`)
- Modify: `src/engine/playbook/playbookEngine.ts`
- Modify: `src/server/server.ts`
- Modify: `tests/engine/playbook/feature.test.ts`
- Modify: `tests/engine/playbook/bug.test.ts`
- Modify: `tests/engine/playbook/squeezDoctor.test.ts`
- Test: `tests/engine/playbook/squeezDoctor.test.ts`

**Interfaces:**
- Consumes: `recordSqueezDoctor(dir, probe)` from Task 1. `ProcessSqueezDoctor` from Task 2. `ensureAttempt` from `runFolder.ts`. `PlaybookRunEngine` already requires `PhaseContext`.
- Produces: `PhaseContext.squeez: SqueezDoctor`, required. `PlaybookRunEngine.runPhase` calls `recordSqueezDoctor` after the run is known and before the phase function. `startServer` passes `new ProcessSqueezDoctor()` with defaults.

- [ ] **Step 1: Write the failing test**

Append to `tests/engine/playbook/squeezDoctor.test.ts`. Merge new names into the existing imports instead of adding a second import from the same module: `existsSync` into `node:fs`, `afterEach` into `vitest`, and `attemptDir` into the `runFolder.js` import. Add the remaining imports once:

```ts
import { DEFAULT_CONFIG, type Contract } from '../../../src/domain/types.js';
import { DispatchRunEngine } from '../../../src/engine/playbook/dispatchEngine.js';
import { PlaybookRunEngine } from '../../../src/engine/playbook/playbookEngine.js';
import { SimulatorRunEngine } from '../../../src/engine/simulator.js';
import type { ChocolateData } from '../../../src/files/chocolateFiles.js';
import { RunService } from '../../../src/runs/runService.js';
import { SqliteRunStore } from '../../../src/store/runStore.js';

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/engine/playbook/squeezDoctor.test.ts`

Expected: FAIL to typecheck or fail at runtime because `PlaybookRunEngine` does not accept `squeez`, or the probe is never called (`calls` is 0).

- [ ] **Step 3: Write the minimal implementation**

In `src/engine/playbook/phases/specPhase.ts`, add `SqueezDoctor` to the ports import and add `squeez: SqueezDoctor;` to `PhaseContext`:

```ts
import type { CommandRunner, ForgePort, GitPort, SqueezDoctor, WorkerPort } from '../ports.js';
```

```ts
export interface PhaseContext {
  repoRoot: string;
  files: FilesPort;
  store: SqliteRunStore;
  git: GitPort;
  forge: ForgePort;
  workers: WorkerPort;
  commands: CommandRunner;
  ci: { waitMs: number; extraIntervalMs: number };
  readPlaybook: (name: string) => string;
  squeez: SqueezDoctor;
}
```

Replace `runPhase` in `src/engine/playbook/playbookEngine.ts` with this body, and add the two imports:

```ts
import { ensureAttempt } from './runFolder.js';
import { recordSqueezDoctor } from './recordSqueezDoctor.js';
```

```ts
  async runPhase(input: PhaseInput): Promise<PhaseOutput> {
    const run = this.ctx.store.getRun(input.runId);
    if (!run) throw new Error(`unknown run ${input.runId}`);
    const dir = ensureAttempt(this.ctx.repoRoot, input.runId, input.attempt);
    await recordSqueezDoctor(dir, this.ctx.squeez);
    const flow: Flow = run.flow;
    const ctx = { ...this.ctx, flow, readPlaybook };
    switch (input.phase) {
      case 'spec':
        return runSpecPhase(input, ctx);
      case 'plan':
        return runPlanPhase(input, ctx);
      case 'implement':
        return runImplementPhase(input, ctx);
      case 'test':
        return runTestPhase(input, ctx);
      case 'verify':
        return runVerifyPhase(input, ctx);
      case 'commit':
        return runCommitPhase(input, ctx);
      default: {
        const unexpected: never = input.phase;
        throw new Error(`unknown phase ${unexpected}`);
      }
    }
  }
```

In `src/server/server.ts`, import `ProcessSqueezDoctor` and pass it on the playbook context:

```ts
import { ProcessSqueezDoctor } from '../engine/playbook/processSqueezDoctor.js';
```

```ts
    readPlaybook,
    squeez: new ProcessSqueezDoctor(),
```

In `tests/engine/playbook/feature.test.ts` and `tests/engine/playbook/bug.test.ts`, add this field to the `new PlaybookRunEngine({ ... })` object, after `readPlaybook`:

```ts
    squeez: { async doctor() { return { status: 'ok' as const, output: '' }; } },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/engine/playbook/squeezDoctor.test.ts tests/engine/playbook/feature.test.ts tests/engine/playbook/bug.test.ts`

Expected: PASS.

Run: `pnpm test`

Expected: PASS, the full suite, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/engine/playbook/phases/specPhase.ts src/engine/playbook/playbookEngine.ts src/server/server.ts tests/engine/playbook/feature.test.ts tests/engine/playbook/bug.test.ts tests/engine/playbook/squeezDoctor.test.ts
git commit -m "$(cat <<'EOF'
feat: record squeez doctor before a playbook phase

EOF
)"
```
