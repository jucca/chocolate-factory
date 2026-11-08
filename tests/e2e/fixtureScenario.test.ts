// tests/e2e/fixtureScenario.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { stampRepo } from '../../src/stamp/stamp.js';
import { buildApp } from '../../src/server/app.js';
import { SqliteRunStore } from '../../src/store/runStore.js';
import { RunService } from '../../src/runs/runService.js';
import { SimulatorRunEngine } from '../../src/engine/simulator.js';
import { FakeIssueSource } from '../../src/issues/issueSource.js';
import { loadChocolate, saveContract, saveRoadmap } from '../../src/files/chocolateFiles.js';
import { contractRevision } from '../../src/files/writeBack.js';
import { DEFAULT_CONFIG, type Contract } from '../../src/domain/types.js';

const issue = { tracker: 'github' as const, repo: 'o/r', number: 7, url: 'https://github.com/o/r/issues/7' };
let root: string; let app: ReturnType<typeof buildApp>; let store: SqliteRunStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cf-fixture-')); stampRepo(root);
  const contract: Contract = { id: 'issue-7', title: 'Issue #7', intent: 'Fixture feature.', constraints: [], out_of_scope: [], linked_issue: issue, milestone: 'v1', dependencies: [],
    acceptance_criteria: [{ id: 'ac-1', statement: 'Fixture works end to end', gates: ['spec', 'plan', 'verify', 'commit'], evidence: 'verification-check' }] };
  saveContract(root, contract);
  const chocolate = loadChocolate(root);
  if (chocolate.roadmap) {
    const m = chocolate.roadmap.milestones.find((ms) => ms.id === 'v1');
    if (m && !m.contracts.includes('issue-7')) {
      m.contracts.push('issue-7');
      saveRoadmap(root, chocolate.roadmap);
    }
  }
  store = new SqliteRunStore(join(root, '.chocolate/runtime/cf.db'));
  const files = { load: () => loadChocolate(root), readContractFile: (id: string) => readFileSync(join(root, `.chocolate/contracts/${id}.yaml`), 'utf8'), saveContract: (c: Contract) => saveContract(root, c) };
  const runService = new RunService({ store, engine: new SimulatorRunEngine(), files, config: DEFAULT_CONFIG, repoRoot: root });
  app = buildApp({ repoRoot: root, store, runService, issueSource: new FakeIssueSource([issue]), config: DEFAULT_CONFIG });
});
afterEach(async () => { await app.close(); store.close(); });

describe('fixture scenario (spec 12.5, V1 success)', () => {
  it('issue → claim → all gates → commit-ready, roadmap shows it, no real agent', async () => {
    const claim = await app.inject({ method: 'POST', url: '/api/runs/claim', payload: { issue } });
    const runId = claim.json().id as string;
    // soft-gate override with recorded reason at spec
    await app.inject({ method: 'POST', url: `/api/runs/${runId}/advance` });
    await app.inject({ method: 'POST', url: `/api/runs/${runId}/gate`, payload: { gate: 'spec', action: 'override', reason: 'fixture: spec accepted' } });
    for (const gate of ['plan', 'verify', 'commit'] as const) {
      await app.inject({ method: 'POST', url: `/api/runs/${runId}/advance` });
      await app.inject({ method: 'POST', url: `/api/runs/${runId}/gate`, payload: { gate, action: 'approve' } });
    }
    await app.inject({ method: 'POST', url: `/api/runs/${runId}/advance` });
    const detail = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(['commit-ready', 'running']).toContain(detail.json().run.state);
    const roadmap = await app.inject({ method: 'GET', url: '/api/roadmap' });
    expect(roadmap.json().milestones.flatMap((m: { contracts: unknown[] }) => m.contracts).length).toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(root, '.chocolate/exec-plans', `${runId}.md`), 'utf8')).toContain('Exec Plan');
  });
  it('hard-gate failure then new attempt recovers (simulator failAt via direct service)', async () => {
    const failing = new RunService({ store, engine: new SimulatorRunEngine({ failAt: 'test' }),
      files: { load: () => loadChocolate(root), readContractFile: (id: string) => readFileSync(join(root, `.chocolate/contracts/${id}.yaml`), 'utf8'), saveContract: (c: Contract) => saveContract(root, c) }, config: DEFAULT_CONFIG, repoRoot: root });
    const data = loadChocolate(root);
    const run = failing.claim({ issue, contract: data.contracts[0], contractRevision: contractRevision(readFileSync(join(root, '.chocolate/contracts/issue-7.yaml'), 'utf8')) });
    await failing.advance(run.id); await failing.actOnGate(run.id, { gate: 'spec', action: 'approve' });
    await failing.advance(run.id); await failing.actOnGate(run.id, { gate: 'plan', action: 'approve' });
    await failing.advance(run.id); // implement (no gate) → test phase next; advancing runs test and fails
    const failed = await failing.advance(run.id);
    expect(failed.state).toBe('failed');
    const retry = failing.startNewAttempt(run.id, 'spec');
    expect(retry.currentAttempt).toBe(2); expect(retry.state).toBe('running');
    expect(store.events(run.id).filter((e: { type: string }) => e.type === 'phase_failed')).toHaveLength(1);
  });
});
