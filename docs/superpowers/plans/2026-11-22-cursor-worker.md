# Cursor Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Cursor CLI wrapper a playbook operator pastes into both worker commands, so a feature or bug run can launch `agent` and still leave `worker-report.md` for the engine.

**Architecture:** `runCursorWorker` resolves the target repo from `CHOCOLATE_REPO`, spawns `agent` with no shell, and guarantees a `STATUS` line. `bin/chocolate-cursor-worker.ts` is the thin entry. The README shows the argv to paste. Config files stay empty.

**Tech Stack:** Node.js 22, TypeScript, Vitest, `node:child_process` `spawn`, existing `tsx` bin style.

## Global Constraints

- The worker stays an argv list. `ProcessWorker`, the phases, and the gates stay as they are.
- `.chocolate/config.yaml` and the stamp template gain no `workers` block.
- The program runs `agent` with no shell. Headless flags are `-p`, `--force`, `--trust`, `--sandbox disabled`, and `--output-format text`. They are placed after any flags from the command list, so a pasted `--model` cannot drop them.
- No model is pinned. No timeout is set. A running agent holds the walk until it exits.
- `partial` is written only by the agent. The program synthesizes `done` or `blocked`.
- A missing `agent` binary is `blocked` for that role. The implement-to-default fallback still happens only when the implement command’s own first binary cannot be spawned.
- Tests substitute `CHOCOLATE_AGENT_BIN` or an injected spawn. `pnpm test` does not start Cursor and does not use the network.
- `argv` is everything after the script name. The last entry is the prompt path. Earlier entries are forwarded unchanged, and those entries are flags only.
- `runCursorWorker` returns `0` when `worker-report.md` has a valid status line, and `1` when the prompt path is missing. A failure to delete the stale report, to read a prompt that then cannot be recorded, or to write `worker-report.md` rejects. The bin prints that error to stderr and exits `1`.
- Resolve `CHOCOLATE_REPO` against `cwd` when it is set and non-empty. Otherwise the repo is `cwd`. A relative value resolves against `cwd`. An absolute value is used as given.
- Resolve a relative prompt path against `cwd`, not against the repo. An absolute prompt path is used as given.
- The report path is `worker-report.md` in `CHOCOLATE_RUN_DIR` when that variable is set and non-empty. A relative run directory resolves against `cwd`. Otherwise the report directory is the prompt file’s directory.
- When the prompt read fails, replace `worker-report.md` with `STATUS: blocked` and the note `prompt unreadable: <message>`, spawn nothing, and return `0`.
- Delete `worker-report.md` when it already exists, so an earlier dispatch in the same attempt directory cannot satisfy this one. Delete only after the prompt has been read.
- Spawn `CHOCOLATE_AGENT_BIN` when that variable is set and non-empty, otherwise `agent`. The child cwd is the resolved repo. The child inherits `env`. Stdout and stderr are ignored.
- The argument list is `[forwarded flags] -p --force --trust --sandbox disabled --output-format text --workspace <resolved repo> <prompt text>`.
- After the child exits, if `worker-report.md` contains a line `STATUS: done`, `STATUS: partial`, or `STATUS: blocked`, leave the file unchanged and return `0`.
- Otherwise replace the file and return `0`. Child exit code `0` writes `STATUS: done` and no note. Any other code, a null code, or a spawn error writes `STATUS: blocked` and one note line.
- The note for a numeric exit is `agent exited <code>`. The note for a spawn error is `agent spawn failed: <message>`. The note for a null code with no spawn error is `agent exited null`.
- A missing last entry prints `usage: chocolate-cursor-worker <prompt-file>` to stderr and returns `1` without spawning.
- A failure to delete the stale report, to read a prompt that then cannot be recorded, or to write `worker-report.md` rejects from `runCursorWorker`. The bin prints that error to stderr and exits `1`.
- A valid status line the agent wrote is kept, including `partial` and including `blocked` after a non-zero exit. The program does not merge its own note into that file.

---

### Task 1: Cursor worker rules

**Files:**
- Create: `src/engine/playbook/cursorWorker.ts`
- Test: `tests/engine/playbook/cursorWorker.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:

```typescript
export interface CursorWorkerSpawn {
  (input: { bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }): Promise<{
    code: number | null;
    error: NodeJS.ErrnoException | null;
  }>;
}

export function runCursorWorker(input: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  spawnAgent: CursorWorkerSpawn;
}): Promise<number>;
```

- [ ] **Step 1: Write the failing test**

Create `tests/engine/playbook/cursorWorker.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCursorWorker, type CursorWorkerSpawn } from '../../../src/engine/playbook/cursorWorker.js';

function layout() {
  const cwd = mkdtempSync(join(tmpdir(), 'cf-cursor-'));
  const repo = join(cwd, 'repo');
  const runDir = join(repo, 'attempt');
  mkdirSync(runDir, { recursive: true });
  const promptPath = join(runDir, 'prompt.md');
  writeFileSync(promptPath, 'write the brief');
  return { cwd, repo, runDir, promptPath };
}

function env(repo: string, runDir: string, agentBin = 'agent'): NodeJS.ProcessEnv {
  return { CHOCOLATE_REPO: repo, CHOCOLATE_RUN_DIR: runDir, CHOCOLATE_AGENT_BIN: agentBin };
}

describe('runCursorWorker', () => {
  it('writes STATUS done when the agent exits 0 and leaves no report', async () => {
    const { cwd, repo, runDir, promptPath } = layout();
    const spawnAgent: CursorWorkerSpawn = async () => ({ code: 0, error: null });
    const code = await runCursorWorker({ argv: [promptPath], env: env(repo, runDir), cwd, spawnAgent });
    expect(code).toBe(0);
    expect(readFileSync(join(runDir, 'worker-report.md'), 'utf8')).toBe('STATUS: done\n');
  });

  it('keeps a STATUS partial line the agent wrote', async () => {
    const { cwd, repo, runDir, promptPath } = layout();
    const report = 'STATUS: partial\nleft a question\n';
    const spawnAgent: CursorWorkerSpawn = async () => {
      writeFileSync(join(runDir, 'worker-report.md'), report);
      return { code: 0, error: null };
    };
    const code = await runCursorWorker({ argv: [promptPath], env: env(repo, runDir), cwd, spawnAgent });
    expect(code).toBe(0);
    expect(readFileSync(join(runDir, 'worker-report.md'), 'utf8')).toBe(report);
  });

  it('writes blocked with the exit code when the agent exits 1', async () => {
    const { cwd, repo, runDir, promptPath } = layout();
    const spawnAgent: CursorWorkerSpawn = async () => ({ code: 1, error: null });
    const code = await runCursorWorker({ argv: [promptPath], env: env(repo, runDir), cwd, spawnAgent });
    expect(code).toBe(0);
    expect(readFileSync(join(runDir, 'worker-report.md'), 'utf8')).toBe('STATUS: blocked\nagent exited 1\n');
  });

  it('writes blocked and returns 0 when the agent cannot be spawned', async () => {
    const { cwd, repo, runDir, promptPath } = layout();
    const error = Object.assign(new Error('spawn agent ENOENT'), { code: 'ENOENT' });
    const spawnAgent: CursorWorkerSpawn = async () => ({ code: null, error });
    const code = await runCursorWorker({ argv: [promptPath], env: env(repo, runDir), cwd, spawnAgent });
    expect(code).toBe(0);
    expect(readFileSync(join(runDir, 'worker-report.md'), 'utf8')).toBe('STATUS: blocked\nagent spawn failed: spawn agent ENOENT\n');
  });

  it('places forwarded flags before the headless flags and passes the prompt text last', async () => {
    const { cwd, repo, runDir, promptPath } = layout();
    let seen: { bin: string; args: string[]; childCwd: string; env: NodeJS.ProcessEnv } | undefined;
    const childEnv = env(repo, runDir, '/opt/fake-agent');
    const spawnAgent: CursorWorkerSpawn = async (input) => {
      seen = { bin: input.bin, args: input.args, childCwd: input.cwd, env: input.env };
      return { code: 0, error: null };
    };
    await runCursorWorker({
      argv: ['--model', 'composer-2.5', promptPath],
      env: childEnv,
      cwd,
      spawnAgent,
    });
    expect(seen).toEqual({
      bin: '/opt/fake-agent',
      childCwd: repo,
      env: childEnv,
      args: [
        '--model', 'composer-2.5',
        '-p', '--force', '--trust', '--sandbox', 'disabled', '--output-format', 'text',
        '--workspace', repo,
        'write the brief',
      ],
    });
  });

  it('resolves a relative CHOCOLATE_REPO against cwd', async () => {
    const { cwd, runDir, promptPath } = layout();
    let childCwd = '';
    const spawnAgent: CursorWorkerSpawn = async (input) => {
      childCwd = input.cwd;
      return { code: 0, error: null };
    };
    await runCursorWorker({
      argv: [promptPath],
      env: env('repo', runDir),
      cwd,
      spawnAgent,
    });
    expect(childCwd).toBe(resolve(cwd, 'repo'));
  });

  it('returns 1 and does not spawn when the prompt path is missing', async () => {
    const { cwd } = layout();
    let calls = 0;
    const spawnAgent: CursorWorkerSpawn = async () => {
      calls += 1;
      return { code: 0, error: null };
    };
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await runCursorWorker({ argv: [], env: {}, cwd, spawnAgent });
      expect(code).toBe(1);
      expect(calls).toBe(0);
      expect(lines.join('')).toBe('usage: chocolate-cursor-worker <prompt-file>\n');
    } finally {
      process.stderr.write = original;
    }
  });

  it('writes blocked and does not spawn when the prompt cannot be read', async () => {
    const { cwd, repo, runDir } = layout();
    const missing = join(runDir, 'missing-prompt.md');
    let calls = 0;
    const spawnAgent: CursorWorkerSpawn = async () => {
      calls += 1;
      return { code: 0, error: null };
    };
    const code = await runCursorWorker({ argv: [missing], env: env(repo, runDir), cwd, spawnAgent });
    expect(code).toBe(0);
    expect(calls).toBe(0);
    const text = readFileSync(join(runDir, 'worker-report.md'), 'utf8');
    expect(text.startsWith('STATUS: blocked\nprompt unreadable: ')).toBe(true);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('deletes a stale report before spawn and keeps only the new status', async () => {
    const { cwd, repo, runDir, promptPath } = layout();
    const reportPath = join(runDir, 'worker-report.md');
    writeFileSync(reportPath, 'STATUS: blocked\nstale\n');
    let presentDuringSpawn = true;
    const spawnAgent: CursorWorkerSpawn = async () => {
      presentDuringSpawn = false;
      try {
        readFileSync(reportPath, 'utf8');
        presentDuringSpawn = true;
      } catch {
        presentDuringSpawn = false;
      }
      return { code: 0, error: null };
    };
    await runCursorWorker({ argv: [promptPath], env: env(repo, runDir), cwd, spawnAgent });
    expect(presentDuringSpawn).toBe(false);
    expect(readFileSync(reportPath, 'utf8')).toBe('STATUS: done\n');
  });

  it('uses cwd as the repo when CHOCOLATE_REPO is empty and the prompt directory when CHOCOLATE_RUN_DIR is empty', async () => {
    const { cwd, promptPath } = layout();
    let childCwd = '';
    let bin = '';
    const spawnAgent: CursorWorkerSpawn = async (input) => {
      childCwd = input.cwd;
      bin = input.bin;
      return { code: 0, error: null };
    };
    const code = await runCursorWorker({
      argv: [promptPath],
      env: { CHOCOLATE_REPO: '', CHOCOLATE_RUN_DIR: '', CHOCOLATE_AGENT_BIN: '' },
      cwd,
      spawnAgent,
    });
    expect(code).toBe(0);
    expect(childCwd).toBe(cwd);
    expect(bin).toBe('agent');
    expect(readFileSync(join(cwd, 'repo', 'attempt', 'worker-report.md'), 'utf8')).toBe('STATUS: done\n');
  });

  it('writes agent exited null when the child closes without a code or an error', async () => {
    const { cwd, repo, runDir, promptPath } = layout();
    const spawnAgent: CursorWorkerSpawn = async () => ({ code: null, error: null });
    await runCursorWorker({ argv: [promptPath], env: env(repo, runDir), cwd, spawnAgent });
    expect(readFileSync(join(runDir, 'worker-report.md'), 'utf8')).toBe('STATUS: blocked\nagent exited null\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/engine/playbook/cursorWorker.test.ts`

Expected: FAIL. `runCursorWorker` is not defined.

- [ ] **Step 3: Write minimal implementation**

Create `src/engine/playbook/cursorWorker.ts`:

```typescript
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, dirname, join, resolve } from 'node:path';

export interface CursorWorkerSpawn {
  (input: { bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }): Promise<{
    code: number | null;
    error: NodeJS.ErrnoException | null;
  }>;
}

const STATUS_LINE = /^STATUS: (done|partial|blocked)$/m;

function resolveAgainst(cwd: string, value: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

export async function runCursorWorker(input: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  spawnAgent: CursorWorkerSpawn;
}): Promise<number> {
  const repoValue = input.env.CHOCOLATE_REPO;
  const repo = repoValue ? resolveAgainst(input.cwd, repoValue) : input.cwd;
  const promptArg = input.argv.length === 0 ? undefined : input.argv[input.argv.length - 1];
  if (!promptArg) {
    process.stderr.write('usage: chocolate-cursor-worker <prompt-file>\n');
    return 1;
  }
  const promptPath = resolveAgainst(input.cwd, promptArg);
  const runValue = input.env.CHOCOLATE_RUN_DIR;
  const reportDir = runValue ? resolveAgainst(input.cwd, runValue) : dirname(promptPath);
  const reportPath = join(reportDir, 'worker-report.md');

  let promptText: string;
  try {
    promptText = readFileSync(promptPath, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeFileSync(reportPath, `STATUS: blocked\nprompt unreadable: ${message}\n`);
    return 0;
  }

  try {
    unlinkSync(reportPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }

  const agentBin = input.env.CHOCOLATE_AGENT_BIN || 'agent';
  const forwarded = input.argv.slice(0, -1);
  const result = await input.spawnAgent({
    bin: agentBin,
    cwd: repo,
    env: input.env,
    args: [
      ...forwarded,
      '-p', '--force', '--trust', '--sandbox', 'disabled', '--output-format', 'text',
      '--workspace', repo,
      promptText,
    ],
  });

  if (existsReport(reportPath)) return 0;

  if (result.error) {
    writeFileSync(reportPath, `STATUS: blocked\nagent spawn failed: ${result.error.message}\n`);
    return 0;
  }
  if (result.code === 0) {
    writeFileSync(reportPath, 'STATUS: done\n');
    return 0;
  }
  const codeText = result.code === null ? 'null' : String(result.code);
  writeFileSync(reportPath, `STATUS: blocked\nagent exited ${codeText}\n`);
  return 0;
}

function existsReport(path: string): boolean {
  try {
    return STATUS_LINE.test(readFileSync(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/engine/playbook/cursorWorker.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/playbook/cursorWorker.ts tests/engine/playbook/cursorWorker.test.ts
git commit -m "$(cat <<'EOF'
feat: launch Cursor agent as a playbook worker

EOF
)"
```

---

### Task 2: Bin entry and README

**Files:**
- Create: `bin/chocolate-cursor-worker.ts`
- Modify: `README.md` (Playbook engine section)
- Test: `tests/engine/playbook/cursorWorker.test.ts`

**Interfaces:**
- Consumes: `runCursorWorker` and `CursorWorkerSpawn` from `src/engine/playbook/cursorWorker.ts`
- Produces: `pnpm exec tsx bin/chocolate-cursor-worker.ts <prompt-file>` as the documented command

- [ ] **Step 1: Write the failing bin test**

Add `chmodSync` to the existing `node:fs` import at the top of `tests/engine/playbook/cursorWorker.test.ts`, and add this import beside the other imports:

```typescript
import { execFile } from 'node:child_process';

function execFileAsync(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(bin, args, { env }, (err, _stdout, stderr) => {
      if (err && typeof (err as NodeJS.ErrnoException & { code?: string | number }).code === 'number') {
        const exit = err as NodeJS.ErrnoException & { code: number };
        resolvePromise({ code: exit.code, stderr: String(stderr) });
        return;
      }
      if (err && (err as NodeJS.ErrnoException).code && typeof (err as NodeJS.ErrnoException).code !== 'number') {
        reject(err);
        return;
      }
      resolvePromise({ code: 0, stderr: String(stderr) });
    });
  });
}

it('the bin writes STATUS done when the fake agent exits 0', async () => {
  const { cwd, repo, runDir, promptPath } = layout();
  const fake = join(cwd, 'fake-agent.mjs');
  writeFileSync(fake, `#!${process.execPath}\nprocess.exit(0)\n`);
  chmodSync(fake, 0o755);
  const root = process.cwd();
  const result = await execFileAsync(process.execPath, [
    join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(root, 'bin', 'chocolate-cursor-worker.ts'),
    promptPath,
  ], {
    ...process.env,
    CHOCOLATE_REPO: repo,
    CHOCOLATE_RUN_DIR: runDir,
    CHOCOLATE_AGENT_BIN: fake,
  });
  expect(result.code).toBe(0);
  expect(readFileSync(join(runDir, 'worker-report.md'), 'utf8')).toBe('STATUS: done\n');
}, 20000);
```

Place the `it(...)` inside the existing `describe('runCursorWorker')` block. `execFile` from `node:child_process` sets `err.code` to the numeric exit status. A spawn failure such as `ENOENT` has a string `code` and must reject. Do not use a shell.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/engine/playbook/cursorWorker.test.ts`

Expected: FAIL. The bin file cannot be loaded.

- [ ] **Step 3: Write the bin and the README section**

Create `bin/chocolate-cursor-worker.ts`:

```typescript
import { spawn } from 'node:child_process';
import { runCursorWorker, type CursorWorkerSpawn } from '../src/engine/playbook/cursorWorker.js';

const spawnAgent: CursorWorkerSpawn = (input) => new Promise((resolvePromise) => {
  let settled = false;
  const finish = (value: { code: number | null; error: NodeJS.ErrnoException | null }) => {
    if (settled) return;
    settled = true;
    resolvePromise(value);
  };
  const child = spawn(input.bin, input.args, {
    cwd: input.cwd,
    env: input.env,
    shell: false,
    stdio: 'ignore',
  });
  child.on('error', (error: NodeJS.ErrnoException) => finish({ code: null, error }));
  child.on('close', (code) => finish({ code, error: null }));
});

try {
  const code = await runCursorWorker({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    spawnAgent,
  });
  process.exit(code);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(message + '\n');
  process.exit(1);
}
```

In `README.md`, replace the Playbook engine closing sentence:

```markdown
Worker commands live under `workers.default.command` and `workers.implement.command` in `.chocolate/config.yaml`. Empty commands reject a playbook claim.
```

with:

```markdown
Worker commands live under `workers.default.command` and `workers.implement.command` in `.chocolate/config.yaml`. Empty commands reject a playbook claim.

A playbook run launches the Cursor CLI through `bin/chocolate-cursor-worker.ts`. Run `agent login` once on the machine. Paste both command lists yourself. The factory appends the prompt path and does not merge. Paths point at this factory checkout, because the command’s working directory is the target repo:

```yaml
workers:
  default:
    command:
      - pnpm
      - --dir
      - /absolute/path/to/chocolate-factory
      - exec
      - tsx
      - bin/chocolate-cursor-worker.ts
  implement:
    command:
      - pnpm
      - --dir
      - /absolute/path/to/chocolate-factory
      - exec
      - tsx
      - bin/chocolate-cursor-worker.ts
```

An optional `--model` flag is an extra entry after `bin/chocolate-cursor-worker.ts`. The sample does not include one.
```

Do not add a `workers` block to `.chocolate/config.yaml` or to the stamp template.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/engine/playbook/cursorWorker.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bin/chocolate-cursor-worker.ts tests/engine/playbook/cursorWorker.test.ts README.md
git commit -m "$(cat <<'EOF'
feat: document the Cursor worker command for playbook claims

EOF
)"
```
