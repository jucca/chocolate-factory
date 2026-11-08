// tests/files/chocolateFiles.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { stringify } from 'yaml';
import { loadChocolate } from '../../src/files/chocolateFiles.js';

let root: string;
const contract = { id: 'feat-a', title: 'A', intent: 'x', acceptance_criteria: [{ id: 'ac-1', statement: 's', gates: ['verify'], evidence: 'e' }], constraints: [], out_of_scope: [], linked_issue: null, milestone: 'm1', dependencies: [] };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cf-'));
  mkdirSync(join(root, '.chocolate/contracts'), { recursive: true });
  writeFileSync(join(root, '.chocolate/config.yaml'), stringify({ issue_label: 'chocolate:ready', issue_source: { repo: 'o/r' }, gates: { spec: 'soft', plan: 'soft', verify: 'hard', commit: 'hard' }, runtime: '.chocolate/runtime' }));
  writeFileSync(join(root, '.chocolate/roadmap.yaml'), stringify({ milestones: [{ id: 'm1', title: 'M1', intent: 'x', contracts: ['feat-a'] }] }));
});
describe('loadChocolate', () => {
  it('loads valid contracts', () => {
    writeFileSync(join(root, '.chocolate/contracts/feat-a.yaml'), stringify(contract));
    const d = loadChocolate(root);
    expect(d.contracts.map((c) => c.id)).toEqual(['feat-a']); expect(d.invalidContracts).toEqual([]);
  });
  it('flags an unparseable contract with the parse error and keeps others', () => {
    writeFileSync(join(root, '.chocolate/contracts/feat-a.yaml'), stringify(contract));
    writeFileSync(join(root, '.chocolate/contracts/broken.yaml'), 'id: [unclosed\n');
    const d = loadChocolate(root);
    expect(d.contracts.map((c) => c.id)).toEqual(['feat-a']);
    expect(d.invalidContracts[0].file).toContain('broken.yaml'); expect(d.invalidContracts[0].error.length).toBeGreaterThan(0);
  });
});
