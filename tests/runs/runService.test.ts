// tests/runs/runService.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunService, HardGateOverrideError, OverrideReasonRequiredError } from '../../src/runs/runService.js';
import { SqliteRunStore } from '../../src/store/runStore.js';
import { SimulatorRunEngine } from '../../src/engine/simulator.js';
import { DEFAULT_CONFIG, type Contract } from '../../src/domain/types.js';
import type { ChocolateData } from '../../src/files/chocolateFiles.js';

const contract: Contract = {
  id: 'feat-a',
  title: 'A',
  intent: 'x',
  constraints: [],
  out_of_scope: [],
  linked_issue: null,
  milestone: 'm1',
  dependencies: [],
  acceptance_criteria: [{ id: 'ac-1', statement: 's', gates: ['spec', 'plan', 'verify', 'commit'], evidence: 'verification-check' }],
};
let store: SqliteRunStore;
let svc: RunService;
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cf-'));
  store = new SqliteRunStore(join(root, 'test.db'));
  const data: ChocolateData = {
    contracts: [contract],
    invalidContracts: [],
    roadmap: { milestones: [{ id: 'm1', title: 'M1', intent: 'x', contracts: ['feat-a'] }] },
    roadmapError: null,
    config: DEFAULT_CONFIG,
    crossRefErrors: [],
  };
  const files = { load: () => data, readContractFile: () => 'rev-content', saveContract: () => 'rev2' };
  svc = new RunService({ store, engine: new SimulatorRunEngine(), files, config: DEFAULT_CONFIG, repoRoot: root });
});

describe('RunService', () => {
  it('claim creates attempt 1 in spec phase with an exec-plan file', async () => {
    const run = svc.claim({
      issue: { tracker: 'github', repo: 'o/r', number: 7, url: 'https://github.com/o/r/issues/7' },
      contract,
      contractRevision: 'rev1',
    });
    expect(run).toMatchObject({ contractId: 'feat-a', phase: 'spec', currentAttempt: 1, state: 'running' });
    expect(existsSync(join(root, run.execPlanRef))).toBe(true);
  });
  it('advance stops at the spec gate awaiting decision; approve advances', async () => {
    const run = svc.claim({ issue: null, contract, contractRevision: 'rev1' });
    const stopped = await svc.advance(run.id);
    expect(stopped.state).toBe('awaiting-decision');
    const next = await svc.actOnGate(run.id, { gate: 'spec', action: 'approve' });
    expect(next.state).toBe('running');
  });
  it('soft override requires a reason and records it verbatim', async () => {
    const run = svc.claim({ issue: null, contract, contractRevision: 'rev1' });
    await svc.advance(run.id);
    await expect(svc.actOnGate(run.id, { gate: 'spec', action: 'override' })).rejects.toBeInstanceOf(OverrideReasonRequiredError);
    await svc.actOnGate(run.id, { gate: 'spec', action: 'override', reason: 'spec good enough' });
    expect(store.gateDecisions(run.id).at(-1)).toMatchObject({ action: 'override', reason: 'spec good enough' });
  });
  it('hard gate override is impossible', async () => {
    const run = svc.claim({ issue: null, contract, contractRevision: 'rev1' });
    await expect(svc.actOnGate(run.id, { gate: 'verify', action: 'override', reason: 'x' })).rejects.toBeInstanceOf(HardGateOverrideError);
  });
  it('contract revision invalidation supersedes approvals and regresses the run', async () => {
    const run = svc.claim({ issue: null, contract, contractRevision: 'rev1' });
    await svc.advance(run.id);
    await svc.actOnGate(run.id, { gate: 'spec', action: 'approve' });
    svc.invalidateForContract('feat-a', 'rev2');
    const events = store.events(run.id);
    expect(events.at(-1)?.type).toBe('approvals_invalidated');
    expect(store.getRun(run.id)?.phase).toBe('spec');
    expect(store.getRun(run.id)?.contractRevision).toBe('rev2');
  });
  it('actOnGate rejects when not awaiting decision or wrong gate', async () => {
    const run = svc.claim({ issue: null, contract, contractRevision: 'rev1' });
    await expect(svc.actOnGate(run.id, { gate: 'spec', action: 'approve' })).rejects.toThrow(/awaiting-decision/);
    await svc.advance(run.id);
    await expect(svc.actOnGate(run.id, { gate: 'plan', action: 'approve' })).rejects.toThrow(/gate .* does not match/);
  });
  it('actOnGate does not proceed on failed or commit-ready runs', async () => {
    const run = svc.claim({ issue: null, contract, contractRevision: 'rev1' });
    for (const gate of ['spec', 'plan', 'verify', 'commit'] as const) {
      await svc.advance(run.id);
      await svc.actOnGate(run.id, { gate, action: 'approve' });
    }
    await svc.advance(run.id);
    expect(store.getRun(run.id)?.state).toBe('commit-ready');
    await expect(svc.actOnGate(run.id, { gate: 'commit', action: 'approve' })).rejects.toThrow(/awaiting-decision/);
  });
  it('full lifecycle reaches commit-ready only after hard-gate approvals', async () => {
    const run = svc.claim({ issue: null, contract, contractRevision: 'rev1' });
    for (const gate of ['spec', 'plan', 'verify', 'commit'] as const) {
      await svc.advance(run.id);
      await svc.actOnGate(run.id, { gate, action: 'approve' });
    }
    await svc.advance(run.id);
    expect(store.getRun(run.id)?.state).toBe('commit-ready');
  });
});
