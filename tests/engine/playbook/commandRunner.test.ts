import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ShellCommandRunner } from '../../../src/engine/playbook/commandRunner.js';

describe('ShellCommandRunner', () => {
  it('runs one shell command and keeps stdout and stderr', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-sh-'));
    const runner = new ShellCommandRunner();
    const ok = await runner.run(root, 'printf out; printf err >&2');
    expect(ok).toEqual({ ok: true, output: 'outerr' });
    const bad = await runner.run(root, 'printf fail >&2; exit 3');
    expect(bad.ok).toBe(false);
    expect(bad.output).toContain('fail');
  });
});
