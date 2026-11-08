export interface IssueRef { tracker: 'github'; repo: string; number: number; url: string; }
export interface ContractView { id: string; title: string; intent: string; status: string; milestone: string; dependencies: string[]; acceptanceCriteria: { id: string; statement: string }[]; latestRunId: string | null; }
export interface RoadmapDTO { milestones: { id: string; title: string; intent: string; contracts: ContractView[] }[]; invalidFiles: string[]; runtimeAvailable: boolean; }
export type InboxDTO = { kind: 'fresh'; issues: IssueRef[]; syncedAt: string } | { kind: 'stale'; issues: IssueRef[]; lastSyncedAt: string | null; error: string };
export interface RunDTO { id: string; contractId: string; phase: string; state: string; currentAttempt: number; execPlanRef: string; }
export interface RunDetailDTO { run: RunDTO; events: { id: string; attempt: number; type: string; phase: string | null; message: string; createdAt: string }[]; evidence: { id: string; attempt: number; producerPhase: string; kind: string; summary: string; criterionIds: string[] }[]; gateDecisions: { id: string; attempt: number; gate: string; action: string; reason: string | null; evaluationOutcome: string }[]; }

async function json<T>(res: Response): Promise<T> { if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`); return res.json() as Promise<T>; }
export const api = {
  getRoadmap: () => fetch('/api/roadmap').then((r) => json<RoadmapDTO>(r)),
  getInbox: () => fetch('/api/inbox').then((r) => json<InboxDTO>(r)),
  claim: (issue: IssueRef) => fetch('/api/runs/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ issue }) }).then((r) => json<RunDTO>(r)),
  listRuns: () => fetch('/api/runs').then((r) => json<RunDTO[]>(r)),
  getRun: (id: string) => fetch(`/api/runs/${id}`).then((r) => json<RunDetailDTO>(r)),
  advance: (id: string) => fetch(`/api/runs/${id}/advance`, { method: 'POST' }).then((r) => json<RunDTO>(r)),
  actOnGate: (id: string, body: { gate: string; action: string; reason?: string }) => fetch(`/api/runs/${id}/gate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => json<RunDTO>(r)),
  saveContract: (contract: unknown) => fetch(`/api/contracts/${(contract as { id: string }).id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(contract) }).then((r) => json<{ revision: string }>(r)),
};
