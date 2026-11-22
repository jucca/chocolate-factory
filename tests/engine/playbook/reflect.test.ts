import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { judgePlaybooks, makeReflector } from '../../../src/engine/playbook/reflect.js';
import { GitCli } from '../../../src/engine/playbook/gitCli.js';
import { attemptDir } from '../../../src/engine/playbook/runFolder.js';
import type { RunRecord } from '../../../src/domain/types.js';
import type { GitPort, WorkerTask } from '../../../src/engine/playbook/ports.js';

const before = 'a\n';
const replaced = 'b\n';

const quietGit: Pick<GitPort, 'statusPorcelain' | 'revert' | 'deleteUntracked'> = {
  statusPorcelain: async () => '',
  revert: async () => {},
  deleteUntracked: async () => {},
};

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1', contractId: 'c', contractRevision: 'r', issue: null,
    phase: 'commit', state: 'commit-ready', currentAttempt: 1,
    execPlanRef: 'p', createdAt: 't', flow: 'feature', engine: 'playbook',
    ...over,
  };
}

describe('judgePlaybooks', () => {
  it('discards an empty, growing, oversized, or outside diff', () => {
    expect(judgePlaybooks({ 'spec.md': before }, { 'spec.md': before })).toEqual({ ok: false, reason: 'empty' });
    expect(judgePlaybooks({ 'spec.md': before }, { 'spec.md': 'a\nb\n' })).toEqual({ ok: false, reason: 'grows' });
    expect(judgePlaybooks({ 'spec.md': before }, { 'spec.md': replaced })).toEqual({ ok: true, files: { 'spec.md': replaced } });
    const many = (prefix: string) => Array.from({ length: 21 }, (_, i) => `${prefix}${i}`).join('\n') + '\n';
    expect(judgePlaybooks({ 'spec.md': many('a') }, { 'spec.md': many('b') })).toEqual({ ok: false, reason: 'over-cap' });
    expect(judgePlaybooks({ 'spec.md': before }, { 'evil.md': 'x\n' })).toEqual({ ok: false, reason: 'outside' });
  });
});

describe('makeReflector', () => {
  it('opens one pull request and does not repeat it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-reflect-'));
    const dir = attemptDir(root, 'run-1', 1);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'status.md'), '- phase: commit\n');
    writeFileSync(join(dir, 'brief.md'), 'brief\n');
    const prompts: string[] = [];
    const published: Record<string, string>[] = [];
    const reflect = makeReflector({
      repoRoot: root,
      factoryRoot: root,
      snapshot: { 'spec.md': before },
      isRepo: async () => true,
      git: quietGit,
      workers: { async run(task: WorkerTask) {
        prompts.push(task.prompt);
        mkdirSync(join(task.runDir, 'reflect-playbooks'), { recursive: true });
        writeFileSync(join(task.runDir, 'reflect.md'), 'REASON: tighten\nDROP: none\n');
        writeFileSync(join(task.runDir, 'reflect-playbooks/spec.md'), replaced);
        return { status: 'done', filesChanged: [], notes: '', route: 'default' };
      } },
      publisher: { async publish(input) { published.push(input.files); return 'https://example.test/pr/1'; } },
    });
    await reflect(run());
    expect(prompts[0]).toContain(join(dir, 'brief.md'));
    expect(prompts[0]).toContain(join(dir, 'reflect.md'));
    expect(prompts[0]).toContain(join(dir, 'reflect-playbooks'));
    expect(prompts[0]).toContain('Write the whole file');
    expect(prompts[0]).toContain(before);
    expect(prompts[0]).not.toContain('evaluateGate');
    expect(published).toEqual([{ 'spec.md': replaced }]);
    expect(readFileSync(join(dir, 'status.md'), 'utf8')).toContain('reflect: pr https://example.test/pr/1');
    await reflect(run());
    expect(published).toHaveLength(1);
  });

  it('discards a blocked worker, a missing repo, a simulator run, and a publish error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-reflect-'));
    const dir = attemptDir(root, 'run-1', 1);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'status.md'), '- phase: commit\n');
    let calls = 0;
    const reflect = makeReflector({
      repoRoot: root,
      factoryRoot: root,
      snapshot: { 'spec.md': before },
      isRepo: async () => true,
      git: quietGit,
      workers: { async run() { calls += 1; return { status: 'blocked', filesChanged: [], notes: '', route: 'default' }; } },
      publisher: { async publish() { throw new Error('publish-branch-exists'); } },
    });
    await expect(reflect(run())).resolves.toBeUndefined();
    expect(readFileSync(join(dir, 'status.md'), 'utf8')).toContain('reflect: discarded worker-blocked');
    writeFileSync(join(dir, 'status.md'), '- phase: commit\n');
    const skipped = makeReflector({
      repoRoot: root,
      factoryRoot: root,
      snapshot: {},
      isRepo: async () => false,
      git: quietGit,
      workers: { async run() { calls += 1; return { status: 'done', filesChanged: [], notes: '', route: 'default' }; } },
      publisher: { async publish() { return 'nope'; } },
    });
    await skipped(run());
    expect(readFileSync(join(dir, 'status.md'), 'utf8')).toContain('reflect: skipped');
    const beforeCalls = calls;
    await skipped(run({ engine: 'simulator' }));
    expect(calls).toBe(beforeCalls);
  });

  it('discards a publish error after a valid one-line replacement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-reflect-'));
    const dir = attemptDir(root, 'run-1', 1);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'status.md'), '- phase: commit\n');
    const reflect = makeReflector({
      repoRoot: root,
      factoryRoot: root,
      snapshot: { 'spec.md': before },
      isRepo: async () => true,
      git: quietGit,
      workers: { async run(task: WorkerTask) {
        mkdirSync(join(task.runDir, 'reflect-playbooks'), { recursive: true });
        writeFileSync(join(task.runDir, 'reflect.md'), 'REASON: tighten\nDROP: none\n');
        writeFileSync(join(task.runDir, 'reflect-playbooks/spec.md'), replaced);
        return { status: 'done', filesChanged: [], notes: '', route: 'default' };
      } },
      publisher: { async publish() { throw new Error('publish-branch-exists'); } },
    });
    await expect(reflect(run())).resolves.toBeUndefined();
    expect(readFileSync(join(dir, 'status.md'), 'utf8')).toContain('reflect: discarded publish-branch-exists');
  });

  it('reverts product files outside the attempt directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-reflect-git-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    writeFileSync(join(root, '.gitignore'), '.chocolate/runtime/\n');
    writeFileSync(join(root, 'README'), 'hello\n');
    execFileSync('git', ['add', '.gitignore', 'README'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
    const dir = attemptDir(root, 'run-1', 1);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'status.md'), '- phase: commit\n');
    writeFileSync(join(dir, 'brief.md'), 'brief\n');
    const reflect = makeReflector({
      repoRoot: root,
      factoryRoot: root,
      snapshot: { 'spec.md': before },
      isRepo: async () => true,
      git: new GitCli(),
      workers: { async run(task: WorkerTask) {
        writeFileSync(join(root, 'README'), 'dirty\n');
        writeFileSync(join(root, 'stray.txt'), 'x\n');
        mkdirSync(join(task.runDir, 'reflect-playbooks'), { recursive: true });
        writeFileSync(join(task.runDir, 'reflect.md'), 'REASON: tighten\nDROP: none\n');
        writeFileSync(join(task.runDir, 'reflect-playbooks/spec.md'), replaced);
        return { status: 'done', filesChanged: [], notes: '', route: 'default' };
      } },
      publisher: { async publish() { return 'https://example.test/pr/2'; } },
    });
    await reflect(run());
    expect(readFileSync(join(root, 'README'), 'utf8')).toBe('hello\n');
    expect(existsSync(join(root, 'stray.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'reflect.md'), 'utf8')).toContain('REASON: tighten');
    expect(await new GitCli().statusPorcelain(root)).toBe('');
  });
});
