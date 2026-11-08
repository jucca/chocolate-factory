// tests/gates/gateEvaluator.test.ts
import { describe, it, expect } from 'vitest';
import { evaluateGate } from '../../src/gates/gateEvaluator.js';
import { DEFAULT_CONFIG, type Contract, type EvidenceRecord } from '../../src/domain/types.js';

const contract: Contract = { id: 'a', title: 'A', intent: 'x', constraints: [], out_of_scope: [], linked_issue: null, milestone: 'm1', dependencies: [],
  acceptance_criteria: [
    { id: 'ac-1', statement: 's1', gates: ['spec', 'verify'], evidence: 'verification-check' },
    { id: 'ac-2', statement: 's2', gates: ['verify', 'commit'], evidence: 'verification-check' },
  ] };
const ev = (over: Partial<EvidenceRecord>): EvidenceRecord => ({ id: 'e1', runId: 'r1', attempt: 1, phase: 'verify', producerPhase: 'verify', criterionIds: ['ac-1'], kind: 'verification-check', summary: 'ok', createdAt: '2026-11-08T00:00:00.000Z', ...over });
const base = { attempt: 1, contract, evidence: [] as EvidenceRecord[], dependencyStatuses: [] as never[], config: DEFAULT_CONFIG };

describe('evaluateGate', () => {
  it('fails closed when evidence is missing', () => {
    const r = evaluateGate({ ...base, gate: 'verify' });
    expect(r.outcome).toBe('fail'); expect(r.missingCriterionIds).toEqual(['ac-1', 'ac-2']);
  });
  it('verify requires independent verify-produced evidence, not implement self-report', () => {
    const r = evaluateGate({ ...base, gate: 'verify', evidence: [ev({ producerPhase: 'implement', phase: 'implement', criterionIds: ['ac-1', 'ac-2'] })] });
    expect(r.outcome).toBe('fail');
  });
  it('passes verify when every mapped criterion has verification-check evidence', () => {
    const r = evaluateGate({ ...base, gate: 'verify', evidence: [ev({ criterionIds: ['ac-1', 'ac-2'] })] });
    expect(r).toMatchObject({ outcome: 'pass', missingCriterionIds: [] });
  });
  it('commit fails when a dependency is unsatisfied', () => {
    const r = evaluateGate({ ...base, gate: 'commit', evidence: [ev({ criterionIds: ['ac-2'] })], dependencyStatuses: ['in-progress'] });
    expect(r.outcome).toBe('fail'); expect(r.reasons.join(' ')).toMatch(/dependency/);
  });
  it('soft spec gate passes when its mapped criteria have any evidence', () => {
    const r = evaluateGate({ ...base, gate: 'spec', evidence: [ev({ phase: 'spec', producerPhase: 'spec', kind: 'spec-summary', criterionIds: ['ac-1'] })] });
    expect(r.outcome).toBe('pass');
  });
});
