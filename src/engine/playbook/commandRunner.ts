import { execFile } from 'node:child_process';
import type { CommandResult, CommandRunner } from './ports.js';

export class ShellCommandRunner implements CommandRunner {
  run(repoRoot: string, command: string): Promise<CommandResult> {
    return new Promise((resolve) => {
      execFile('sh', ['-c', command], { cwd: repoRoot, encoding: 'utf8' }, (err, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : '';
        const errText = typeof stderr === 'string' ? stderr : '';
        resolve({ ok: !err, output: out + errText });
      });
    });
  }
}
