import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Contract, FactoryConfig, GateId, IssueRef } from '../domain/types.js';
import { loadChocolate, saveContract } from '../files/chocolateFiles.js';
import { contractRevision } from '../files/writeBack.js';
import type { SqliteRunStore } from '../store/runStore.js';
import { buildRoadmapView } from '../domain/derivedStatus.js';
import { RunService, HardGateOverrideError, OverrideReasonRequiredError } from '../runs/runService.js';
import type { IssueSource } from '../issues/issueSource.js';

export function buildApp(deps: {
  repoRoot: string;
  store: SqliteRunStore;
  runService: RunService;
  issueSource: IssueSource;
  config: FactoryConfig;
}): FastifyInstance {
  const app = Fastify();
  app.get('/api/roadmap', async () => {
    const data = loadChocolate(deps.repoRoot);
    const runsByContract = new Map<string, ReturnType<SqliteRunStore['listRunsByContract']>[number]>();
    for (const c of data.contracts) {
      const runs = deps.store.listRunsByContract(c.id);
      if (runs[0]) runsByContract.set(c.id, runs[0]);
    }
    const pending = new Set(
      [...runsByContract.entries()].filter(([, r]) => r.state === 'awaiting-decision').map(([id]) => id),
    );
    const failed = new Set([...runsByContract.entries()].filter(([, r]) => r.state === 'failed').map(([id]) => id));
    const view = data.roadmap
      ? buildRoadmapView({
          contracts: data.contracts,
          invalidFiles: data.invalidContracts.map((i) => i.file),
          roadmap: data.roadmap,
          runsByContract,
          pendingGateByContract: pending,
          failedByContract: failed,
        })
      : { milestones: [], invalidFiles: data.invalidContracts.map((i) => i.file) };
    return {
      ...view,
      runtimeAvailable: true,
      crossRefErrors: data.crossRefErrors,
      roadmapError: data.roadmapError,
    };
  });
  app.get('/api/contracts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = loadChocolate(deps.repoRoot);
    const contract = data.contracts.find((c) => c.id === id);
    if (!contract) return reply.code(404).send({ error: `unknown contract ${id}` });
    return contract;
  });
  app.get('/api/inbox', async () => deps.issueSource.listEligible(deps.config.issue_label));
  app.post('/api/runs/claim', async (req, reply) => {
    const { issue } = req.body as { issue: IssueRef };
    const data = loadChocolate(deps.repoRoot);
    let contract = data.contracts.find(
      (c) => c.linked_issue?.number === issue.number && c.linked_issue?.repo === issue.repo,
    );
    if (!contract) {
      contract = {
        id: `issue-${issue.number}`,
        title: `Issue #${issue.number}`,
        intent: `Imported from ${issue.url} — operator to complete intent.`,
        acceptance_criteria: [],
        constraints: [],
        out_of_scope: [],
        linked_issue: issue,
        milestone: data.roadmap?.milestones[0]?.id ?? 'v1',
        dependencies: [],
      };
      saveContract(deps.repoRoot, contract);
    }
    if (data.invalidContracts.length > 0)
      return reply.code(400).send({ error: `invalid contract files: ${data.invalidContracts.map((i) => i.file).join(', ')}` });
    const revision = contractRevision(
      readFileSync(join(deps.repoRoot, '.chocolate', 'contracts', `${contract.id}.yaml`), 'utf8'),
    );
    return deps.runService.claim({ issue, contract, contractRevision: revision });
  });
  app.get('/api/runs', async () => deps.store.listRuns());
  app.get('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = deps.store.getRun(id);
    if (!run) return reply.code(404).send({ error: `unknown run ${id}` });
    return {
      run,
      events: deps.store.events(id),
      evidence: deps.store.evidence(id),
      gateDecisions: deps.store.gateDecisions(id),
    };
  });
  app.post('/api/runs/:id/advance', async (req) => deps.runService.advance((req.params as { id: string }).id));
  app.post('/api/runs/:id/gate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { gate: GateId; action: 'approve' | 'rework' | 'override'; reason?: string };
    try {
      return await deps.runService.actOnGate(id, body);
    } catch (e) {
      if (e instanceof HardGateOverrideError || e instanceof OverrideReasonRequiredError)
        return reply.code(400).send({ error: e.message });
      throw e;
    }
  });
  app.put('/api/contracts/:id', async (req, reply) => {
    const contract = req.body as Contract;
    try {
      const revision = saveContract(deps.repoRoot, contract);
      deps.runService.invalidateForContract(contract.id, revision);
      return { revision };
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });
  return app;
}
