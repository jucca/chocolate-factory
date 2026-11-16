// tests/stamp/stamp.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { stampRepo, AlreadyStampedError } from '../../src/stamp/stamp.js';
import { loadChocolate } from '../../src/files/chocolateFiles.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cf-')); writeFileSync(join(root, '.gitignore'), 'node_modules\n'); });
describe('stampRepo', () => {
  it('creates the full .chocolate layout loadable by loadChocolate', () => {
    const { created } = stampRepo(root);
    for (const p of ['.chocolate/config.yaml', '.chocolate/roadmap.yaml', '.chocolate/AGENTS.md', '.chocolate/contracts', '.chocolate/templates', '.chocolate/docs', '.chocolate/exec-plans', '.chocolate/runtime']) expect(created).toContain(p);
    expect(loadChocolate(root).config.issue_label).toBe('chocolate:ready');
  });
  it('gitignores the runtime dir without clobbering existing entries', () => {
    stampRepo(root);
    const gi = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(gi).toContain('node_modules'); expect(gi).toContain('/.chocolate/runtime/');
  });
  it('refuses to re-stamp', () => { stampRepo(root); expect(() => stampRepo(root)).toThrowError(AlreadyStampedError); });
  it('never overwrites an existing root AGENTS.md', () => {
    writeFileSync(join(root, 'AGENTS.md'), 'mine\n'); stampRepo(root);
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe('mine\n');
  });
  it('adds a root AGENTS.md pointer only when absent', () => {
    stampRepo(root);
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('.chocolate/AGENTS.md');
  });
  it('AGENTS map is short and points into docs', () => {
    stampRepo(root);
    const map = readFileSync(join(root, '.chocolate/AGENTS.md'), 'utf8');
    expect(map.split('\n').length).toBeLessThanOrEqual(40); expect(map).toContain('.chocolate/docs/');
    expect(existsSync(join(root, '.chocolate/docs/index.md'))).toBe(true);
  });
});
