import type { Contract, Roadmap, ContractStatus, RunRecord } from './types.js';

export interface ContractView {
  id: string; title: string; intent: string; status: ContractStatus;
  milestone: string; dependencies: string[];
  acceptanceCriteria: { id: string; statement: string }[];
  latestRunId: string | null;
}
export interface MilestoneView { id: string; title: string; intent: string; contracts: ContractView[]; }
export interface RoadmapView { milestones: MilestoneView[]; invalidFiles: string[]; }

const SATISFIED: ContractStatus[] = ['commit-ready', 'done'];
export function deriveContractStatus(input: {
  valid: boolean; contract: Contract; dependencyStatuses: ContractStatus[];
  latestRun: RunRecord | null; pendingGate: boolean; latestAttemptFailed: boolean;
}): ContractStatus {
  if (!input.valid) return 'invalid';
  if (input.dependencyStatuses.some((s) => !SATISFIED.includes(s))) return 'blocked';
  if (!input.latestRun) return 'not-started';
  if (input.latestRun.state === 'commit-ready') return 'commit-ready';
  if (input.latestAttemptFailed || input.latestRun.state === 'failed') return 'failed';
  if (input.pendingGate || input.latestRun.state === 'awaiting-decision') return 'in-review';
  return 'in-progress';
}

export function buildRoadmapView(data: {
  contracts: Contract[]; invalidFiles: string[]; roadmap: Roadmap;
  runsByContract: Map<string, RunRecord>; pendingGateByContract: Set<string>; failedByContract: Set<string>;
}): RoadmapView {
  const byId = new Map(data.contracts.map((c) => [c.id, c]));
  const statusOf = (c: Contract): ContractStatus => deriveContractStatus({
    valid: true, contract: c,
    dependencyStatuses: c.dependencies.map((d) => byId.has(d)
      ? statusOf(byId.get(d)!) : 'invalid'),
    latestRun: data.runsByContract.get(c.id) ?? null,
    pendingGate: data.pendingGateByContract.has(c.id),
    latestAttemptFailed: data.failedByContract.has(c.id),
  });
  return {
    invalidFiles: data.invalidFiles,
    milestones: data.roadmap.milestones.map((m) => ({
      id: m.id, title: m.title, intent: m.intent,
      contracts: m.contracts.filter((id) => byId.has(id)).map((id) => {
        const c = byId.get(id)!;
        return { id: c.id, title: c.title, intent: c.intent, status: statusOf(c), milestone: c.milestone,
          dependencies: [...c.dependencies], acceptanceCriteria: c.acceptance_criteria.map((a) => ({ id: a.id, statement: a.statement })),
          latestRunId: data.runsByContract.get(c.id)?.id ?? null };
      }),
    })),
  };
}
