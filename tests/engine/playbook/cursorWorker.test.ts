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