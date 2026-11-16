import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkerPort, WorkerReport, WorkerRole, WorkerStatus, WorkerTask } from './ports.js';

const MAX_BUFFER = 32 * 1024 * 1024;

function isSpawnFailure(err: Error): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function runCommand(command: string[], task: WorkerTask): Promise<void> {
  const [bin, ...args] = command;
  return new Promise((resolve, reject) => {
    if (!bin) {
      reject(new Error('missing command'));
      return;
    }
    execFile(bin, args, {
      cwd: task.repoRoot,
      maxBuffer: MAX_BUFFER,
      env: {
        ...process.env,
        CHOCOLATE_REPO: task.repoRoot,
        CHOCOLATE_RUN_DIR: task.runDir,
        CHOCOLATE_ROLE: task.role,
      },
      shell: false,
    }, (err) => {
      if (err && isSpawnFailure(err)) reject(err);
      else resolve();
    });
  });
}

function readReport(runDir: string, role: WorkerRole): WorkerReport {
  const path = join(runDir, 'worker-report.md');
  if (!existsSync(path)) {
    return { status: 'blocked', filesChanged: [], notes: 'missing worker report', route: role };
  }
  const text = readFileSync(path, 'utf8');
  const match = text.match(/^STATUS: (done|partial|blocked)$/m);
  if (!match) {
    return { status: 'blocked', filesChanged: [], notes: 'missing worker report', route: role };
  }
  const status = match[1] as WorkerStatus;
  return { status, filesChanged: [], notes: text.replace(match[0], '').trim(), route: role };
}

export class ProcessWorker implements WorkerPort {
  constructor(private commands: { default: string[]; implement: string[] }) {}

  async run(task: WorkerTask): Promise<WorkerReport> {
    const promptPath = join(task.runDir, 'prompt.md');
    writeFileSync(promptPath, task.prompt);
    try {
      await runCommand([...this.commands[task.role], promptPath], task);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: 'blocked', filesChanged: [], notes: 'spawn failed: ' + message, route: task.role };
    }
    return readReport(task.runDir, task.role);
  }
}
