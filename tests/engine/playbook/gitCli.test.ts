import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitCli } from '../../../src/engine/playbook/gitCli.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'cf-git-'));
  git(root, ['init', '-b', 'main']);
  writeFileSync(join(root, 'README'), 'hello\n');
  git(root, ['add', 'README']);
  git(root, ['config', 'user.email', 'a@b.c']);
  git(root, ['config', 'user.name', 't']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

describe('GitCli', () => {
  it('creates a branch in a temp repo and counts a one-line edit', async () => {
    const root = initRepo();
    const cli = new GitCli();
    expect(await cli.isRepo(root)).toBe(true);
    expect(await cli.isRepo(mkdtempSync(join(tmpdir(), 'cf-not-repo-')))).toBe(false);
    expect(await cli.statusPorcelain(root)).toBe('');
    expect(await cli.branchExists(root, 'feat/gh-1')).toBe(false);
    await cli.createBranch(root, 'feat/gh-1', 'main');
    expect(await cli.headBranch(root)).toBe('feat/gh-1');
    expect(await cli.branchExists(root, 'feat/gh-1')).toBe(true);
    const base = await cli.headSha(root);
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    expect(await cli.originHead(root)).toBe('main');
    expect(await cli.remoteHead(root, 'feat/gh-1')).toBeNull();
    writeFileSync(join(root, 'README'), 'hello\nworld\n');
    git(root, ['add', 'README']);
    expect(await cli.changedLines(root, base)).toBeGreaterThanOrEqual(1);
    expect(await cli.diffNames(root, base)).toContain('README');
    expect(await cli.diffNames(root, base, 'README')).toEqual(['README']);
    expect(await cli.diffNames(root, base, 'other')).toEqual([]);
    await cli.commitAll(root, 'feat: line');
    expect(git(root, ['log', '-1', '--format=%s']).trim()).toBe('feat: line');
    expect(await cli.statusPorcelain(root)).toBe('');
    expect(await cli.headSha(root)).not.toBe(base);
    writeFileSync(join(root, 'README'), 'mutated\n');
    await cli.revert(root, ['README']);
    expect(readFileSync(join(root, 'README'), 'utf8')).toBe('hello\nworld\n');
    expect(await cli.statusPorcelain(root)).toBe('');
    writeFileSync(join(root, 'extra.txt'), 'x\n');
    await cli.deleteUntracked(root, ['extra.txt']);
    expect(await cli.statusPorcelain(root)).toBe('');
    await cli.revert(root, []);
    await cli.deleteUntracked(root, ['missing.txt']);
  });

  it('shows a file at a revision and restores that tree', async () => {
    const root = initRepo();
    const cli = new GitCli();
    const base = await cli.headSha(root);
    expect(await cli.show(root, base, 'missing')).toBeNull();
    expect(await cli.show(root, base, 'README')).toBe('hello\n');
    writeFileSync(join(root, 'README'), 'dirty\n');
    writeFileSync(join(root, 'extra.txt'), 'x\n');
    await cli.restoreTree(root, base, 'README');
    expect(readFileSync(join(root, 'README'), 'utf8')).toBe('hello\n');
    expect(await cli.statusPorcelain(root)).not.toContain('README');
  });
});
