import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendStatus, attemptDir, ensureAttempt, listAttemptFiles, openQuestionBullets, readStatusValue, recordAnswers } from '../../../src/engine/playbook/runFolder.js';

describe('runFolder', () => {
  it('creates attempt-N under the gitignored runtime tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-'));
    const dir = ensureAttempt(root, 'run-1', 2);
    expect(dir).toBe(attemptDir(root, 'run-1', 2));
    expect(dir).toContain('.chocolate/runtime/runs/run-1/attempt-2');
  });
  it('reads open-question bullets and records answers', () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-'));
    const dir = ensureAttempt(root, 'run-1', 1);
    writeFileSync(join(dir, 'brief.md'), '# T\n## Open questions\n- What is the limit?\n- Which page?\n## Other\n- ignore\n');
    writeFileSync(join(dir, 'status.md'), '# T\n');
    expect(openQuestionBullets(readFileSync(join(dir, 'brief.md'), 'utf8'))).toEqual(['What is the limit?', 'Which page?']);
    recordAnswers(dir, 'Limit is 3');
    expect(readFileSync(join(dir, 'brief.md'), 'utf8')).toContain('## Answers\nLimit is 3');
    expect(readFileSync(join(dir, 'status.md'), 'utf8')).toContain('## Decisions\n- Limit is 3');
    expect(listAttemptFiles(root, 'run-1', 1).sort()).toEqual(['brief.md', 'status.md']);
  });
  it('appends status lines, reads a keyed value, and lists nothing when the attempt is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-'));
    const dir = ensureAttempt(root, 'run-1', 1);
    appendStatus(dir, '- pr: https://github.com/o/r/pull/4');
    appendStatus(dir, '- branch: feat/gh-1');
    expect(readFileSync(join(dir, 'status.md'), 'utf8')).toBe('- pr: https://github.com/o/r/pull/4\n- branch: feat/gh-1\n');
    expect(readStatusValue(dir, 'pr')).toBe('https://github.com/o/r/pull/4');
    expect(readStatusValue(dir, 'branch')).toBe('feat/gh-1');
    expect(readStatusValue(dir, 'missing')).toBeNull();
    expect(listAttemptFiles(root, 'run-missing', 1)).toEqual([]);
  });
});
