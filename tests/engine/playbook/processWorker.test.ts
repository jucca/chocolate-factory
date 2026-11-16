import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dispatchWorker } from '../../../src/engine/playbook/dispatchWorker.js';
import { ProcessWorker } from '../../../src/engine/playbook/processWorker.js';
import { ensureAttempt } from '../../../src/engine/playbook/runFolder.js';

describe('ProcessWorker', () => {
  it('appends the prompt path, sets env, and reads STATUS', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-'));
    const dir = ensureAttempt(root, 'run-1', 1);
    const script = join(root, 'worker.mjs');
    writeFileSync(script, `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.CHOCOLATE_RUN_DIR + '/seen.txt', process.argv.at(-1) + '\\n' + process.env.CHOCOLATE_ROLE);
writeFileSync(process.env.CHOCOLATE_RUN_DIR + '/worker-report.md', 'STATUS: done\\nnotes here\\n');
`);
    const prompt = join(dir, 'prompt.md');
    writeFileSync(prompt, 'do the thing');
    const port = new ProcessWorker({ default: [process.execPath, script], implement: [process.execPath, script] });
    const report = await port.run({ role: 'default', runDir: dir, repoRoot: root, prompt: 'do the thing', allowedFiles: [], unitId: 'U1' });
    expect(report).toMatchObject({ status: 'done', route: 'default', filesChanged: [] });
    expect(report.notes).toContain('notes here');
    expect(readFileSync(join(dir, 'seen.txt'), 'utf8')).toContain(prompt);
    expect(readFileSync(join(dir, 'seen.txt'), 'utf8')).toContain('default');
    expect(readFileSync(prompt, 'utf8')).toBe('do the thing');
  });
  it('sets CHOCOLATE_REPO and the repo root as cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-'));
    const dir = ensureAttempt(root, 'run-1', 1);
    const script = join(root, 'env.mjs');
    writeFileSync(script, `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.CHOCOLATE_RUN_DIR + '/seen.txt', process.env.CHOCOLATE_REPO + '\\n' + process.cwd());
writeFileSync(process.env.CHOCOLATE_RUN_DIR + '/worker-report.md', 'STATUS: partial\\n');
`);
    const port = new ProcessWorker({ default: [process.execPath, script], implement: [process.execPath, script] });
    const report = await port.run({ role: 'default', runDir: dir, repoRoot: root, prompt: 'x', allowedFiles: [], unitId: 'U1' });
    expect(report.status).toBe('partial');
    expect(readFileSync(join(dir, 'seen.txt'), 'utf8')).toBe(`${root}\n${root}`);
  });
  it('returns blocked when the command cannot be spawned', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-'));
    const dir = ensureAttempt(root, 'run-1', 1);
    const port = new ProcessWorker({ default: ['chocolate-missing-binary'], implement: ['chocolate-missing-binary'] });
    const report = await port.run({ role: 'implement', runDir: dir, repoRoot: root, prompt: 'x', allowedFiles: [], unitId: 'U1' });
    expect(report.status).toBe('blocked');
    expect(report.notes.startsWith('spawn failed')).toBe(true);
    expect(report.filesChanged).toEqual([]);
    expect(report.route).toBe('implement');
  });
  it('does not report a non-ENOENT error code as spawn failed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-'));
    const dir = ensureAttempt(root, 'run-1', 1);
    const notBinary = join(root, 'not-a-binary');
    mkdirSync(notBinary);
    const port = new ProcessWorker({ default: [notBinary], implement: [notBinary] });
    const report = await port.run({ role: 'implement', runDir: dir, repoRoot: root, prompt: 'x', allowedFiles: [], unitId: 'U1' });
    expect(report.notes.startsWith('spawn failed')).toBe(false);
  });
  it('reads STATUS when the process started and then exited non-zero', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-'));
    const dir = ensureAttempt(root, 'run-1', 1);
    const script = join(root, 'exit.mjs');
    writeFileSync(script, `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.CHOCOLATE_RUN_DIR + '/worker-report.md', 'STATUS: done\\nstill ran\\n');
process.exit(1);
`);
    const port = new ProcessWorker({ default: [process.execPath, script], implement: [process.execPath, script] });
    const report = await port.run({ role: 'implement', runDir: dir, repoRoot: root, prompt: 'x', allowedFiles: [], unitId: 'U1' });
    expect(report.status).toBe('done');
    expect(report.notes).toContain('still ran');
    expect(report.notes.startsWith('spawn failed')).toBe(false);
  });
  it('returns blocked when the worker report is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-'));
    const dir = ensureAttempt(root, 'run-1', 1);
    const script = join(root, 'quiet.mjs');
    writeFileSync(script, 'process.stdout.write("ran\\n");\n');
    const port = new ProcessWorker({ default: [process.execPath, script], implement: [process.execPath, script] });
    const report = await port.run({ role: 'default', runDir: dir, repoRoot: root, prompt: 'x', allowedFiles: [], unitId: 'U1' });
    expect(report).toMatchObject({ status: 'blocked', filesChanged: [], notes: 'missing worker report', route: 'default' });
  });
  it('falls back once when the implement command cannot spawn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-'));
    const dir = ensureAttempt(root, 'run-1', 1);
    const script = join(root, 'ok.mjs');
    writeFileSync(script, `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.CHOCOLATE_RUN_DIR + '/worker-report.md', 'STATUS: done\\n');
`);
    const port = new ProcessWorker({ default: [process.execPath, script], implement: ['chocolate-missing-binary'] });
    const report = await dispatchWorker(port, { role: 'implement', runDir: dir, repoRoot: root, prompt: 'x', allowedFiles: ['src/a.ts'], unitId: 'U1' });
    expect(report.route).toBe('default');
    expect(report.fallback).toMatch(/U1 implement→default/);
    expect(report.fallback).toMatch(/spawn failed/);
    expect(report.status).toBe('done');
  });
});
