import { execFile } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { GitPort } from './ports.js';

function git(repoRoot: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: repoRoot, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export class GitCli implements GitPort {
  async isRepo(repoRoot: string): Promise<boolean> {
    try {
      const out = await git(repoRoot, ['rev-parse', '--is-inside-work-tree']);
      return out.trim() === 'true';
    } catch {
      return false;
    }
  }

  async statusPorcelain(repoRoot: string): Promise<string> {
    return git(repoRoot, ['status', '--porcelain']);
  }

  async originHead(repoRoot: string): Promise<string | null> {
    try {
      const name = (await git(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
      return name.startsWith('origin/') ? name.slice('origin/'.length) : name;
    } catch {
      return null;
    }
  }

  async fetch(repoRoot: string): Promise<void> {
    await git(repoRoot, ['fetch', 'origin']);
  }

  async branchExists(repoRoot: string, name: string): Promise<boolean> {
    try {
      await git(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
      return true;
    } catch {
      return false;
    }
  }

  async createBranch(repoRoot: string, name: string, from: string): Promise<void> {
    await git(repoRoot, ['switch', '-c', name, from]);
  }

  async headBranch(repoRoot: string): Promise<string> {
    return (await git(repoRoot, ['branch', '--show-current'])).trim();
  }

  async headSha(repoRoot: string): Promise<string> {
    return (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();
  }

  async commitAll(repoRoot: string, message: string): Promise<void> {
    await git(repoRoot, ['add', '-A']);
    await git(repoRoot, ['commit', '-m', message]);
  }

  async diffNames(repoRoot: string, baseSha: string, pathspec?: string): Promise<string[]> {
    const args = ['diff', '--name-only', baseSha];
    if (pathspec) args.push('--', pathspec);
    const out = await git(repoRoot, args);
    return out.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  }

  async changedLines(repoRoot: string, baseSha: string): Promise<number> {
    const out = await git(repoRoot, ['diff', '--numstat', baseSha]);
    let total = 0;
    for (const line of out.split('\n')) {
      if (!line) continue;
      const [added, deleted] = line.split('\t');
      if (added && /^\d+$/.test(added)) total += Number(added);
      if (deleted && /^\d+$/.test(deleted)) total += Number(deleted);
    }
    return total;
  }

  async push(repoRoot: string, branch: string): Promise<void> {
    await git(repoRoot, ['push', '-u', 'origin', branch]);
  }

  async remoteHead(repoRoot: string, branch: string): Promise<string | null> {
    try {
      return (await git(repoRoot, ['rev-parse', `origin/${branch}`])).trim();
    } catch {
      return null;
    }
  }

  async revert(repoRoot: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await git(repoRoot, ['checkout', '--', ...paths]);
  }

  async deleteUntracked(repoRoot: string, paths: string[]): Promise<void> {
    for (const path of paths) {
      const abs = isAbsolute(path) ? path : join(repoRoot, path);
      if (existsSync(abs)) unlinkSync(abs);
    }
  }
}
