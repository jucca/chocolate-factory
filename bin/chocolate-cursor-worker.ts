import { spawn } from 'node:child_process';
import { runCursorWorker, type CursorWorkerSpawn } from '../src/engine/playbook/cursorWorker.js';

const spawnAgent: CursorWorkerSpawn = (input) => new Promise((resolvePromise) => {
  let settled = false;
  const finish = (value: { code: number | null; error: NodeJS.ErrnoException | null }) => {
    if (settled) return;
    settled = true;
    resolvePromise(value);
  };
  try {
    const child = spawn(input.bin, input.args, {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      stdio: 'ignore',
    });
    child.on('error', (error: NodeJS.ErrnoException) => finish({ code: null, error }));
    child.on('close', (code) => finish({ code, error: null }));
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    finish({ code: null, error });
  }
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