// tests/files/writeBack.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { saveContract, contractRevision, UnparseableFileError } from '../../src/files/writeBack.js';
import { parseContract } from '../../src/domain/schemas.js';

let root: string; const file = () => join(root, '.chocolate/contracts/feat-a.yaml');
const contract = { id: 'feat-a', title: 'A', intent: 'x', acceptance_criteria: [{ id: 'ac-1', statement: 's', gates: ['verify'], evidence: 'e' }], constraints: [], out_of_scope: [], linked_issue: null, milestone: 'm1', dependencies: [] };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cf-')); mkdirSync(join(root, '.chocolate/contracts'), { recursive: true }); writeFileSync(file(), stringify(contract)); });

describe('writeBack', () => {
  it('round-trips: save with no semantic edit keeps parsed value identical', () => {
    saveContract(root, parseContract(contract));
    expect(parse(readFileSync(file(), 'utf8'))).toEqual(contract);
  });
  it('writes exactly the edit and changes the revision', () => {
    const before = contractRevision(readFileSync(file(), 'utf8'));
    const rev = saveContract(root, { ...parseContract(contract), title: 'A2' });
    expect(parse(readFileSync(file(), 'utf8')).title).toBe('A2'); expect(rev).not.toBe(before);
  });
  it('never overwrites an unparseable file', () => {
    writeFileSync(file(), 'id: [unclosed\n');
    expect(() => saveContract(root, parseContract(contract))).toThrowError(UnparseableFileError);
    expect(readFileSync(file(), 'utf8')).toBe('id: [unclosed\n');
  });
});
