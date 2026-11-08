// tests/domain/derivedStatus.test.ts
import { describe, it, expect } from 'vitest';
import { deriveContractStatus, buildRoadmapView } from '../../src/domain/derivedStatus.js';
import type { Contract, RunRecord } from '../../src/domain/types.js';

const c = (id: string, deps: string[] = []): Contract => ({ id, title: id, intent: 'x', acceptance_criteria: [], constraints: [], out_of_scope: [], linked_issue: null, milestone: 'm1', dependencies: deps });
const run = (state: RunRecord['state']): RunRecord => ({ id: 'r1', contractId: 'a', contractRevision: 'rev', issue: null, phase: 'spec', state, currentAttempt: 1, execPlanRef: '.chocolate/exec-plans/r1.md', createdAt: '2026-11-08T00:00:00.000Z' });
const base = { valid: true, contract: c('a'), dependencyStatuses: [], latestRun: null, pendingGate: false, latestAttemptFailed: false };

describe('deriveContractStatus (spec 5.4 order)', () => {
  it('invalid beats everything', () => { expect(deriveContractStatus({ ...base, valid: false, latestRun: run('commit-ready') })).toBe('invalid'); });
  it('blocked when a dependency is not commit-ready/done (V1 reading, see plan Spec Gaps)', () => {
    expect(deriveContractStatus({ ...base, contract: c('a', ['b']), dependencyStatuses: ['in-progress'] })).toBe('blocked');
    expect(deriveContractStatus({ ...base, contract: c('a', ['b']), dependencyStatuses: ['commit-ready'] })).toBe('not-started');
  });
  it('not-started, in-progress, in-review, commit-ready, failed', () => {
    expect(deriveContractStatus(base)).toBe('not-started');
    expect(deriveContractStatus({ ...base, latestRun: run('running') })).toBe('in-progress');
    expect(deriveContractStatus({ ...base, latestRun: run('awaiting-decision'), pendingGate: true })).toBe('in-review');
    expect(deriveContractStatus({ ...base, latestRun: run('commit-ready') })).toBe('commit-ready');
    expect(deriveContractStatus({ ...base, latestRun: run('failed'), latestAttemptFailed: true })).toBe('failed');
  });
  it('never derives done in V1', () => { expect(deriveContractStatus({ ...base, latestRun: run('commit-ready') })).not.toBe('done'); });
});
describe('buildRoadmapView', () => {
  it('renders milestones in order with plain-language fields and statuses', () => {
    const v = buildRoadmapView({ contracts: [c('a')], invalidFiles: [], roadmap: { milestones: [{ id: 'm1', title: 'M1', intent: 'why', contracts: ['a'] }] }, runsByContract: new Map(), pendingGateByContract: new Set(), failedByContract: new Set() });
    expect(v.milestones[0].contracts[0]).toMatchObject({ id: 'a', status: 'not-started', intent: 'x' });
  });
});
