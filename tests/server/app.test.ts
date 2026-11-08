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
