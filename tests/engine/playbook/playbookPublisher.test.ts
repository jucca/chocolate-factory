import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPlaybookPublisher } from '../../../src/engine/playbook/playbookPublisher.js';
import { PLAYBOOK_FILES } from '../../../src/engine/playbook/playbookSnapshot.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initFactory(): { root: string; bare: string } {
  const root = mkdtempSync(join(tmpdir(), 'cf-pub-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'a@b.c']);
  git(root, ['config', 'user.name', 't']);
  const playbooks = join(root, 'src', 'engine', 'playbooks');
  mkdirSync(playbooks, { recursive: true });
  writeFileSync(join(playbooks, 'spec.md'), 'a\n');
  for (const name of PLAYBOOK_FILES) {
    if (name === 'spec.md') continue;
    writeFileSync(join(playbooks, name), `${name}\n`);
  }
  git(root, ['add', 'src/engine/playbooks']);
  git(root, ['commit', '-m', 'init']);
  const bare = mkdtempSync(join(tmpdir(), 'cf-pub-bare-'));
  git(bare, ['init', '--bare', '-b', 'main']);
  git(root, ['remote', 'add', 'origin', bare]);
  git(root, ['push', '-u', 'origin', 'main']);
  expect(git(root, ['branch', '--show-current']).trim()).toBe('main');
  return { root, bare };
}

describe('createPlaybookPublisher', () => {
  it('opens a playbook pull request from a worktree and refuses a second branch', async () => {
    const { root, bare } = initFactory();
    const calls: { args: string[]; cwd: string }[] = [];
    const publisher = createPlaybookPublisher({
      runGh: async (args, cwd) => {
        calls.push({ args, cwd });
        return 'https://example.test/pr/9\n';
      },
    });
    const input = { files: { 'spec.md': 'b\n' }, body: 'tighten', runId: 'run-1', factoryRoot: root };
    const url = await publisher.publish(input);
    expect(url).toBe('https://example.test/pr/9');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(expect.arrayContaining(['pr', 'create', '--title', 'playbook: run-1']));
    expect(calls[0].args).not.toContain('--force');
    expect(git(root, ['branch', '--show-current']).trim()).toBe('main');
    expect(existsSync(join(root, '.chocolate', 'runtime', 'worktrees', 'playbook-run-1'))).toBe(false);
    expect(git(bare, ['show', 'playbook/run-1:src/engine/playbooks/spec.md'])).toBe('b\n');
    await expect(publisher.publish(input)).rejects.toThrow(/^publish-branch-exists/);
  });
});
