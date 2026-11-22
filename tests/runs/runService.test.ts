// tests/runs/runService.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunService, HardGateOverrideError, OverrideReasonRequiredError } from '../../src/runs/runService.js';
import { SqliteRunStore } from '../../src/store/runStore.js';
import { SimulatorRunEngine } from '../../src/engine/simulator.js';
import { ensureAttempt } from '../../src/engine/playbook/runFolder.js';
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
  it('advance appends phase completion lines to the exec-plan log', async () => {
    const run = svc.claim({ issue: null, contract, contractRevision: 'rev1' });
    await svc.advance(run.id);
    const plan = readFileSync(join(root, run.execPlanRef), 'utf8');
    expect(plan).toContain('Completed spec phase');
    await svc.actOnGate(run.id, { gate: 'spec', action: 'approve' });
    const afterGate = readFileSync(join(root, run.execPlanRef), 'utf8');
    expect(afterGate).toContain('Gate spec: approve');
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

  it('rejects a playbook claim when a worker command is empty and stores nothing', () => {
    expect(() => svc.claim({ issue: null, contract, contractRevision: 'rev1', engine: 'playbook' })).toThrow(/worker command/);
    expect(store.listRuns()).toEqual([]);
  });

  it('records flow and engine on the claim', () => {
    const run = svc.claim({ issue: null, contract, contractRevision: 'rev1', flow: 'bug', engine: 'simulator' });
    expect(store.getRun(run.id)).toMatchObject({ flow: 'bug', engine: 'simulator' });
  });

  it('reloads the contract after the phase before evaluating the gate', async () => {
    const empty = structuredClone(contract);
    empty.acceptance_criteria = [];
    const reloaded = structuredClone(empty);
    reloaded.acceptance_criteria = [{ id: 'ac-new', statement: 'from brief', gates: ['spec', 'verify', 'commit'], evidence: 'brief' }];
    let loads = 0;
    const files = {
      load: () => {
        loads += 1;
        const current = loads === 1 ? empty : reloaded;
        return { contracts: [current], invalidContracts: [], roadmap: null, roadmapError: null, config: DEFAULT_CONFIG, crossRefErrors: [] };
      },
      readContractFile: () => 'rev',
      saveContract: () => 'rev-new',
    };
    const engine = {
      async runPhase() {
        return { events: [{ type: 'phase_completed', message: 'spec wrote criteria' }], evidence: [{ attempt: 1, phase: 'spec' as const, producerPhase: 'spec' as const, criterionIds: ['ac-new'], kind: 'brief', summary: 'brief' }] };
      },
    };
    const local = new RunService({ store, engine, files, config: DEFAULT_CONFIG, repoRoot: root });
    const run = local.claim({ issue: null, contract: empty, contractRevision: 'rev1' });
    const stopped = await local.advance(run.id);
    expect(empty.acceptance_criteria).toEqual([]);
    expect(stopped.state).toBe('awaiting-decision');
    expect(store.events(run.id).some((e) => e.message.includes('gate spec: pass'))).toBe(true);
  });

  it('rejects spec approval while open questions have no answers', async () => {
    const run = svc.claim({ issue: null, contract, contractRevision: 'rev1' });
    const dir = ensureAttempt(root, run.id, 1);
    writeFileSync(join(dir, 'brief.md'), '# T\n## Open questions\n- Which limit?\n');
    writeFileSync(join(dir, 'status.md'), '# T\n');
    await svc.advance(run.id);
    await expect(svc.actOnGate(run.id, { gate: 'spec', action: 'approve' })).rejects.toThrow(/open questions/);
    expect(store.getRun(run.id)?.state).toBe('awaiting-decision');
    await svc.actOnGate(run.id, { gate: 'spec', action: 'approve', answers: 'Limit is 3' });
    expect(store.getRun(run.id)?.phase).toBe('plan');
  });

  it('returns the same promise when advance is already in flight', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const engine = {
      async runPhase() {
        calls += 1;
        await gate;
        return { events: [{ type: 'phase_completed', message: 'spec done' }], evidence: [] };
      },
    };
    const files = {
      load: () => ({
        contracts: [contract],
        invalidContracts: [],
        roadmap: { milestones: [{ id: 'm1', title: 'M1', intent: 'x', contracts: ['feat-a'] }] },
        roadmapError: null,
        config: DEFAULT_CONFIG,
        crossRefErrors: [],
      }),
      readContractFile: () => 'rev-content',
      saveContract: () => 'rev2',
    };
    const local = new RunService({ store, engine, files, config: DEFAULT_CONFIG, repoRoot: root });
    const run = local.claim({ issue: null, contract, contractRevision: 'rev1' });
    const first = local.advance(run.id);
    const second = local.advance(run.id);
    expect(second).toBe(first);
    expect(calls).toBe(1);
    release();
    const settled = await first;
    expect(await second).toBe(settled);
    const third = local.advance(run.id);
    expect(third).not.toBe(first);
    await third;
    expect(calls).toBe(1);
  });

  it('spec override with a reason proceeds while open questions are unanswered', async () => {
    const run = svc.claim({ issue: null, contract, contractRevision: 'rev1' });
    const dir = ensureAttempt(root, run.id, 1);
    writeFileSync(join(dir, 'brief.md'), '# T\n## Open questions\n- Which limit?\n');
    writeFileSync(join(dir, 'status.md'), '# T\n');
    await svc.advance(run.id);
    await svc.actOnGate(run.id, { gate: 'spec', action: 'override', reason: 'ship the brief' });
    expect(store.getRun(run.id)?.phase).toBe('plan');
  });

  it('calls onTerminal once when a playbook run fails and not for the simulator', async () => {
    const seen: string[] = [];
    const files = {
      load: () => ({
        contracts: [contract],
        invalidContracts: [],
        roadmap: { milestones: [{ id: 'm1', title: 'M1', intent: 'x', contracts: ['feat-a'] }] },
        roadmapError: null,
        config: { ...DEFAULT_CONFIG, workers: { default: { command: ['node'] }, implement: { command: ['node'] } } },
        crossRefErrors: [],
      }),
      readContractFile: () => 'rev',
      saveContract: () => 'rev2',
    };
    const engine = { runPhase: async () => { throw new Error('boom'); } };
    const playbook = new RunService({
      store,
      engine,
      files,
      config: files.load().config,
      repoRoot: root,
      onTerminal: async (run) => { seen.push(run.state); },
    });
    const run = playbook.claim({ issue: null, contract, contractRevision: 'rev1', engine: 'playbook' });
    const failed = await playbook.advance(run.id);
    expect(failed.state).toBe('failed');
    expect(seen).toEqual(['failed']);
    await playbook.advance(run.id);
    expect(seen).toEqual(['failed']);

    const simStore = new SqliteRunStore(join(root, 'sim.db'));
    const simulator = new RunService({
      store: simStore,
      engine,
      files,
      config: files.load().config,
      repoRoot: root,
      onTerminal: async (run) => { seen.push(run.state); },
    });
    const sim = simulator.claim({ issue: null, contract, contractRevision: 'rev1', engine: 'simulator' });
    const simFailed = await simulator.advance(sim.id);
    expect(simFailed.state).toBe('failed');
    expect(seen).toEqual(['failed']);
  });

  it('calls onTerminal once when the commit gate is approved and keeps commit-ready if it throws', async () => {
    const seen: string[] = [];
    const config = { ...DEFAULT_CONFIG, workers: { default: { command: ['node'] }, implement: { command: ['node'] } } };
    const files = {
      load: () => ({
        contracts: [contract],
        invalidContracts: [],
        roadmap: { milestones: [{ id: 'm1', title: 'M1', intent: 'x', contracts: ['feat-a'] }] },
        roadmapError: null,
        config,
        crossRefErrors: [],
      }),
      readContractFile: () => 'rev',
      saveContract: () => 'rev2',
    };
    const engine = { runPhase: async () => { throw new Error('unused'); } };
    const playbook = new RunService({
      store,
      engine,
      files,
      config,
      repoRoot: root,
      onTerminal: async (run) => { seen.push(run.state); },
    });
    const run = playbook.claim({ issue: null, contract, contractRevision: 'rev1', engine: 'playbook' });
    store.updateRunState(run.id, { phase: 'commit', state: 'awaiting-decision' });
    store.appendEvidence({
      runId: run.id,
      attempt: 1,
      phase: 'verify',
      producerPhase: 'verify',
      criterionIds: ['ac-1'],
      kind: 'verification-check',
      summary: 'ok',
      createdAt: new Date().toISOString(),
    });
    const ready = await playbook.actOnGate(run.id, { gate: 'commit', action: 'approve' });
    expect(ready.state).toBe('commit-ready');
    expect(seen).toEqual(['commit-ready']);

    const throwing = new RunService({
      store,
      engine,
      files,
      config,
      repoRoot: root,
      onTerminal: async () => { throw new Error('reflect down'); },
    });
    const run2 = throwing.claim({ issue: null, contract, contractRevision: 'rev1', engine: 'playbook' });
    store.updateRunState(run2.id, { phase: 'commit', state: 'awaiting-decision' });
    store.appendEvidence({
      runId: run2.id,
      attempt: 1,
      phase: 'verify',
      producerPhase: 'verify',
      criterionIds: ['ac-1'],
      kind: 'verification-check',
      summary: 'ok',
      createdAt: new Date().toISOString(),
    });
    const still = await throwing.actOnGate(run2.id, { gate: 'commit', action: 'approve' });
    expect(still.state).toBe('commit-ready');
    expect(seen).toEqual(['commit-ready']);
  });
});
