// tests/server/app.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stampRepo } from '../../src/stamp/stamp.js';
import { buildApp } from '../../src/server/app.js';
import { SqliteRunStore } from '../../src/store/runStore.js';
import { RunService } from '../../src/runs/runService.js';
import { SimulatorRunEngine } from '../../src/engine/simulator.js';
import { FakeIssueSource } from '../../src/issues/issueSource.js';
import { loadChocolate, saveContract } from '../../src/files/chocolateFiles.js';
import { contractRevision } from '../../src/files/writeBack.js';
import { DEFAULT_CONFIG, type Contract } from '../../src/domain/types.js';
import { ensureAttempt } from '../../src/engine/playbook/runFolder.js';

let app: ReturnType<typeof buildApp>;
let root: string;
let store: SqliteRunStore;
let deps: Parameters<typeof buildApp>[0];
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
  deps = {
    repoRoot: root,
    store,
    runService,
    issueSource: new FakeIssueSource([issue]),
    config: DEFAULT_CONFIG,
    walker: { kick() {} },
  };
  app = buildApp(deps);
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
    const brokenApp = buildApp({ repoRoot: root, store: brokenStore, runService, issueSource: new FakeIssueSource([issue]), config: DEFAULT_CONFIG, walker: { kick() {} } });
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
  it('defaults a claim to feature and simulator and does not kick', async () => {
    const kicks: string[] = [];
    const app = buildApp({ ...deps, walker: { kick(id: string) { kicks.push(id); } } });
    try {
      const claim = await app.inject({ method: 'POST', url: '/api/runs/claim', payload: { issue } });
      expect(claim.statusCode).toBe(200);
      expect(claim.json()).toMatchObject({ flow: 'feature', engine: 'simulator' });
      expect(kicks).toEqual([]);
    } finally {
      await app.close();
    }
  });
  it('rejects a playbook claim when worker commands are empty', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/runs/claim', payload: { issue, engine: 'playbook', flow: 'bug' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/worker command/);
  });
  it('returns attempt file names and the pull request url', async () => {
    const claim = await app.inject({ method: 'POST', url: '/api/runs/claim', payload: { issue } });
    const id = claim.json().id as string;
    const dir = ensureAttempt(deps.repoRoot, id, 1);
    writeFileSync(join(dir, 'status.md'), '- pr: https://github.com/o/r/pull/4\n');
    writeFileSync(join(dir, 'brief.md'), '# T\n');
    const detail = await app.inject({ method: 'GET', url: `/api/runs/${id}` });
    expect(detail.json().artifacts).toEqual(expect.arrayContaining(['brief.md', 'status.md']));
    expect(detail.json().pullRequestUrl).toBe('https://github.com/o/r/pull/4');
  });
  it('rejects spec approval when the brief has an open question', async () => {
    saveContract(root, {
      id: `issue-${issue.number}`,
      title: `Issue #${issue.number}`,
      intent: 'Ship the feature.',
      acceptance_criteria: [{ id: 'ac-1', statement: 'The feature works.', gates: ['spec'], evidence: 'spec-summary' }],
      constraints: [],
      out_of_scope: [],
      linked_issue: issue,
      milestone: 'v1',
      dependencies: [],
    });
    const claim = await app.inject({ method: 'POST', url: '/api/runs/claim', payload: { issue } });
    const id = claim.json().id as string;
    await app.inject({ method: 'POST', url: `/api/runs/${id}/advance` });
    const dir = ensureAttempt(root, id, 1);
    writeFileSync(join(dir, 'brief.md'), '## Open questions\n- Which shade of brown?\n');
    const gate = await app.inject({ method: 'POST', url: `/api/runs/${id}/gate`, payload: { gate: 'spec', action: 'approve' } });
    expect(gate.statusCode).toBe(400);
    expect(gate.json().error).toMatch(/open questions/);
  });
});
