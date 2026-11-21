import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { latestDrop, readToolboxText } from '../../../src/engine/playbook/toolbox.js';
import type { ToolboxGit } from '../../../src/engine/playbook/ports.js';

function git(files: Record<string, string | null>): ToolboxGit {
  return {
    show: async (_root, _rev, path) => files[path] ?? null,
    restoreTree: async () => {},
  };
}

describe('toolbox read', () => {
  it('renders the manifest and notes at the base sha', async () => {
    const text = await readToolboxText(git({
      'chocolate-tools/manifest.md': '## widget\nuse: u\ntest: t\n',
      'chocolate-tools/NOTES.md': 'remember\n',
    }), '/repo', 'abc');
    expect(text).toContain('## widget');
    expect(text).toContain('remember');
  });

  it('treats a missing file as empty', async () => {
    expect(await readToolboxText(git({}), '/repo', 'abc')).toBe('');
    expect(await readToolboxText(undefined, '/repo', 'abc')).toBe('');
  });

  it('returns the newest drop whose tool is still present', () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-drop-'));
    const older = join(root, '.chocolate', 'runtime', 'runs', 'run-a', 'attempt-1');
    const newer = join(root, '.chocolate', 'runtime', 'runs', 'run-b', 'attempt-1');
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });
    writeFileSync(join(older, 'reflect.md'), 'REASON: old\nDROP: old\n');
    writeFileSync(join(newer, 'reflect.md'), 'REASON: new\nDROP: widget\n');
    expect(latestDrop(root, ['widget'])).toBe('widget');
    expect(latestDrop(root, ['other'])).toBeNull();
  });
});
