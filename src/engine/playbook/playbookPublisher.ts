import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PlaybookPublisher } from './reflect.js';

function run(bin: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function git(cwd: string, args: string[]): Promise<string> {
  return run('git', args, cwd);
}

function defaultRunGh(args: string[], cwd: string): Promise<string> {
  return run('gh', args, cwd);
}

function withTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function wrapPublishError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message.startsWith('publish-') ? message : `publish-${message}`);
}

async function resolveBase(factoryRoot: string): Promise<string> {
  let name = 'main';
  try {
    const symbolic = (await git(factoryRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
    if (symbolic !== '') name = symbolic.startsWith('origin/') ? symbolic.slice('origin/'.length) : symbolic;
  } catch {
    name = 'main';
  }
  const remote = `origin/${name}`;
  try {
    await git(factoryRoot, ['rev-parse', '--verify', '--quiet', remote]);
    return remote;
  } catch {
    return 'main';
  }
}

export function createPlaybookPublisher(options?: {
  runGh?: (args: string[], cwd: string) => Promise<string>;
}): PlaybookPublisher {
  const runGh = options?.runGh ?? defaultRunGh;
  return {
    async publish(input) {
      const branch = `playbook/${input.runId}`;
      const worktree = join(input.factoryRoot, '.chocolate', 'runtime', 'worktrees', `playbook-${input.runId}`);
      let added = false;
      try {
        const exists = await git(input.factoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(
          () => true,
          () => false,
        );
        if (exists) throw new Error('publish-branch-exists');
        const base = await resolveBase(input.factoryRoot);
        mkdirSync(dirname(worktree), { recursive: true });
        await git(input.factoryRoot, ['worktree', 'add', '-b', branch, worktree, base]);
        added = true;
        const playbooks = join(worktree, 'src', 'engine', 'playbooks');
        mkdirSync(playbooks, { recursive: true });
        for (const [name, text] of Object.entries(input.files)) {
          writeFileSync(join(playbooks, name), withTrailingNewline(text));
        }
        writeFileSync(join(worktree, 'pr-body.md'), withTrailingNewline(input.body));
        await git(worktree, ['add', 'src/engine/playbooks']);
        await git(worktree, ['commit', '-m', `playbook: reflect ${input.runId}`]);
        await git(worktree, ['push', '-u', 'origin', 'HEAD']);
        return (await runGh(['pr', 'create', '--title', `playbook: ${input.runId}`, '--body-file', join(worktree, 'pr-body.md')], worktree)).trim();
      } catch (error) {
        throw wrapPublishError(error);
      } finally {
        if (added) {
          try {
            await git(input.factoryRoot, ['worktree', 'remove', '--force', worktree]);
          } catch {
            // The worktree may already be gone.
          }
        }
      }
    },
  };
}
