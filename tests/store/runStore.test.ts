// tests/store/runStore.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { SqliteRunStore } from '../../src/store/runStore.js';

let store: SqliteRunStore;
beforeEach(() => { store = new SqliteRunStore(join(mkdtempSync(join(tmpdir(), 'cf-')), 'test.db')); });
afterEach(() => store.close());

function seedRun() {
  return store.createRun({ id: 'run-1', contractId: 'feat-a', contractRevision: 'rev1', issue: null, phase: 'spec', state: 'running', currentAttempt: 1, execPlanRef: '.chocolate/exec-plans/run-1.md' });
}
describe('SqliteRunStore', () => {
  it('creates and reads a run', () => { expect(seedRun().id).toBe('run-1'); expect(store.getRun('run-1')?.contractId).toBe('feat-a'); });
  it('appends events/evidence/decisions in order and never mutates them', () => {
    seedRun();
    store.appendEvent({ runId: 'run-1', attempt: 1, type: 'phase_started', phase: 'spec', message: 'spec started', createdAt: '2026-11-08T00:00:00.000Z', data: {} });
    store.appendEvidence({ runId: 'run-1', attempt: 1, phase: 'verify', producerPhase: 'verify', criterionIds: ['ac-1'], kind: 'verification-check', summary: 'checked ac-1', createdAt: '2026-11-08T00:01:00.000Z' });
    store.appendGateDecision({ runId: 'run-1', attempt: 1, gate: 'spec', evaluationOutcome: 'fail', action: 'override', reason: 'acceptable risk', contractRevision: 'rev1', createdAt: '2026-11-08T00:02:00.000Z' });
    expect(store.events('run-1')).toHaveLength(1);
    expect(store.evidence('run-1')[0].kind).toBe('verification-check');
    expect(store.gateDecisions('run-1')[0].reason).toBe('acceptable risk');
    expect((store as unknown as Record<string, unknown>).deleteEvent).toBeUndefined();
  });
  it('lists runs by contract newest first', () => {
    seedRun();
    store.createRun({ id: 'run-2', contractId: 'feat-a', contractRevision: 'rev1', issue: null, phase: 'spec', state: 'running', currentAttempt: 1, execPlanRef: '.chocolate/exec-plans/run-2.md' });
    expect(store.listRunsByContract('feat-a').map((r) => r.id)).toEqual(['run-2', 'run-1']);
  });
  it('updateRunState can patch contractRevision', () => {
    seedRun();
    store.updateRunState('run-1', { contractRevision: 'rev2' });
    expect(store.getRun('run-1')?.contractRevision).toBe('rev2');
    store.updateRunState('run-1', { phase: 'plan' });
    expect(store.getRun('run-1')?.contractRevision).toBe('rev2');
  });
});
