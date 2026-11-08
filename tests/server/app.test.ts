// tests/server/app.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stampRepo } from '../../src/stamp/stamp.js';
import { buildApp } from '../../src/server/app.js';
import { SqliteRunStore } from '../../src/store/runStore.js';
import { RunService } from '../../src/runs/runService.js';
import { SimulatorRunEngine } from '../../src/engine/simulator.js';
import { FakeIssueSource } from '../../src/issues/issueSource.js';
import { loadChocolate, saveContract } from '../../src/files/chocolateFiles.js';
import { readFileSync } from 'node:fs';
import { contractRevision } from '../../src/files/writeBack.js';
import { DEFAULT_CONFIG, type Contract } from '../../src/domain/types.js';

let app: ReturnType<typeof buildApp>;
let root: string;
let store: SqliteRunStore;
const issue = { tracker: 'github' as const, repo: 'o/r', number: 7, url: 'https://github.com/o/r/issues/7' };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cf-'));
  stampRepo(root);
  store = new SqliteRunStore(join(root, '.chocolate/runtime/cf.db'));
  const files = {
    load: () => loadChocolate(root),
    readContractFile: (id: string) => readFileSync(join(root, `.chocolate/contracts/${id}.yaml`), 'utf8'),
    saveContract: (c: Contract) => saveContract(root, c),
  };
  const runService = new RunService({ store, engine: new SimulatorRunEngine(), files, config: DEFAULT_CONFIG, repoRoot: root });
  app = buildApp({ repoRoot: root, store, runService, issueSource: new FakeIssueSource([issue]), config: DEFAULT_CONFIG });
});
afterEach(async () => {
  await app.close();
  store.close();
});

describe('cockpit API', () => {
  it('GET /api/roadmap renders milestones from files', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/roadmap' });
    expect(res.statusCode).toBe(200);
    expect(res.json().milestones[0].id).toBe('v1');
  });
  it('GET /api/inbox returns labelled issues fresh from FakeIssueSource', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/inbox' });
    expect(res.json()).toMatchObject({ kind: 'fresh', issues: [{ number: 7 }] });
  });
  it('claim registers draft contract on roadmap and still returns 200', async () => {
    const claim = await app.inject({ method: 'POST', url: '/api/runs/claim', payload: { issue } });
    expect(claim.statusCode).toBe(200);
    const roadmap = await app.inject({ method: 'GET', url: '/api/roadmap' });
    const ids = roadmap.json().milestones[0].contracts.map((c: { id: string }) => c.id);
    expect(ids).toContain(`issue-${issue.number}`);
  });
  it('GET /api/contracts/:id returns a contract by id', async () => {
    await app.inject({ method: 'POST', url: '/api/runs/claim', payload: { issue } });
    const res = await app.inject({ method: 'GET', url: `/api/contracts/issue-${issue.number}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(`issue-${issue.number}`);
  });
  it('PUT /api/contracts/:id rejects when URL id !== body.id', async () => {
    await app.inject({ method: 'POST', url: '/api/runs/claim', payload: { issue } });
    const contract = loadChocolate(root).contracts.find((c) => c.id === `issue-${issue.number}`)!;
    const res = await app.inject({
      method: 'PUT',
      url: '/api/contracts/wrong-id',
      payload: { ...contract, id: contract.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/does not match/i);
  });
  it('GET /api/roadmap sets runtimeAvailable false when store fails', async () => {
    const brokenStore = Object.create(store) as SqliteRunStore;
    brokenStore.listRuns = () => {
      throw new Error('database unavailable');
    };
    const files = {
      load: () => loadChocolate(root),
      readContractFile: (id: string) => readFileSync(join(root, `.chocolate/contracts/${id}.yaml`), 'utf8'),
      saveContract: (c: Contract) => saveContract(root, c),
    };
    const runService = new RunService({ store: brokenStore, engine: new SimulatorRunEngine(), files, config: DEFAULT_CONFIG, repoRoot: root });
    const brokenApp = buildApp({ repoRoot: root, store: brokenStore, runService, issueSource: new FakeIssueSource([issue]), config: DEFAULT_CONFIG });
    const res = await brokenApp.inject({ method: 'GET', url: '/api/roadmap' });
    expect(res.statusCode).toBe(200);
    expect(res.json().runtimeAvailable).toBe(false);
    expect(res.json().milestones[0].contracts.every((c: { status: string }) => c.status === 'not-started')).toBe(true);
    await brokenApp.close();
  });
  it('POST /api/runs/:id/new-attempt starts a new attempt from a phase', async () => {
    const claim = await app.inject({ method: 'POST', url: '/api/runs/claim', payload: { issue } });
    const runId = claim.json().id as string;
    store.updateRunState(runId, { state: 'failed', phase: 'test' });
    const res = await app.inject({ method: 'POST', url: `/api/runs/${runId}/new-attempt`, payload: { fromPhase: 'spec' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().currentAttempt).toBe(2);
    expect(res.json().state).toBe('running');
    expect(res.json().phase).toBe('spec');
  });
  it('claim → advance → spec gate approve flows over HTTP', async () => {
    const claim = await app.inject({ method: 'POST', url: '/api/runs/claim', payload: { issue } });
    expect(claim.statusCode).toBe(200);
    const runId = claim.json().id as string;
    await app.inject({ method: 'POST', url: `/api/runs/${runId}/advance` });
    const detail = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(detail.json().run.state).toBe('awaiting-decision');
    const gate = await app.inject({ method: 'POST', url: `/api/runs/${runId}/gate`, payload: { gate: 'spec', action: 'override', reason: 'ok' } });
    expect(gate.statusCode).toBe(200);
    const bad = await app.inject({ method: 'POST', url: `/api/runs/${runId}/gate`, payload: { gate: 'verify', action: 'override', reason: 'x' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/hard gate/);
  });
});
