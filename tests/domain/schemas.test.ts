// tests/domain/schemas.test.ts
import { describe, it, expect } from 'vitest';
import { parseContract, parseRoadmap, parseConfig, validateCrossRefs, SchemaError } from '../../src/domain/schemas.js';

const good = {
  id: 'feat-a', title: 'Feature A', intent: 'Help operators see work.',
  acceptance_criteria: [{ id: 'ac-1', statement: 'Roadmap shows A', gates: ['verify'], evidence: 'verification-check summary' }],
  constraints: [], out_of_scope: [], linked_issue: null, milestone: 'm1', dependencies: [],
};

describe('schemas', () => {
  it('parses a valid contract', () => { expect(parseContract(good).id).toBe('feat-a'); });
  it('rejects a criterion with no gate mapping', () => {
    const bad = { ...good, acceptance_criteria: [{ id: 'ac-1', statement: 'x', gates: [], evidence: 'y' }] };
    expect(() => parseContract(bad)).toThrowError(/ac-1.*gate/);
  });
  it('rejects config that weakens a hard gate', () => {
    expect(() => parseConfig({ issue_label: 'chocolate:ready', issue_source: { repo: 'o/r' }, gates: { spec: 'soft', plan: 'soft', verify: 'soft', commit: 'hard' }, runtime: '.chocolate/runtime' }))
      .toThrowError(/verify.*hard/);
  });
  it('flags dangling roadmap and dependency refs', () => {
    const roadmap = parseRoadmap({ milestones: [{ id: 'm1', title: 'M1', intent: 'x', contracts: ['ghost'] }] });
    const errs = validateCrossRefs([parseContract(good)], roadmap);
    expect(errs.join('\n')).toMatch(/ghost/);
    expect(errs.join('\n')).toMatch(/feat-a.*m1|milestone/);
  });
  it('throws SchemaError carrying issues', () => {
    try { parseContract({ id: 1 }); expect.unreachable(); }
    catch (e) { expect(e).toBeInstanceOf(SchemaError); }
  });
});
