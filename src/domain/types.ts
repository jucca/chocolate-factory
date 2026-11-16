export const PHASES = ['spec', 'plan', 'implement', 'test', 'verify', 'commit'] as const;
export type Phase = (typeof PHASES)[number];
export type GateId = 'spec' | 'plan' | 'verify' | 'commit';
export const GATE_KIND: Record<GateId, 'soft' | 'hard'> = {
  spec: 'soft', plan: 'soft', verify: 'hard', commit: 'hard',
};

export interface IssueRef { tracker: 'github'; repo: string; number: number; url: string; }
export interface AcceptanceCriterion { id: string; statement: string; gates: GateId[]; evidence: string; }
export interface Contract {
  id: string; title: string; intent: string;
  acceptance_criteria: AcceptanceCriterion[];
  constraints: string[]; out_of_scope: string[];
  linked_issue: IssueRef | null; milestone: string; dependencies: string[];
}
export interface Milestone { id: string; title: string; intent: string; contracts: string[]; }
export interface Roadmap { milestones: Milestone[]; }
export interface FactoryConfig {
  issue_label: string;
  issue_source: { repo: string };
  gates: Record<GateId, 'soft' | 'hard'>;
  runtime: string;
}
export const DEFAULT_CONFIG: FactoryConfig = {
  issue_label: 'chocolate:ready',
  issue_source: { repo: '' },
  gates: { ...GATE_KIND },
  runtime: '.chocolate/runtime',
};

export type ContractStatus =
  | 'invalid' | 'blocked' | 'not-started' | 'in-progress'
  | 'in-review' | 'commit-ready' | 'failed' | 'done';
export type RunState = 'running' | 'awaiting-decision' | 'failed' | 'commit-ready';

export interface RunRecord {
  id: string; contractId: string; contractRevision: string;
  issue: IssueRef | null; phase: Phase; state: RunState;
  currentAttempt: number; execPlanRef: string; createdAt: string;
}
export interface RunEvent {
  id: string; runId: string; attempt: number; type: string;
  phase: Phase | null; message: string; createdAt: string;
  data: Record<string, unknown>;
}
export interface EvidenceRecord {
  id: string; runId: string; attempt: number; phase: Phase;
  producerPhase: Phase; criterionIds: string[]; kind: string;
  summary: string; createdAt: string;
}
export interface GateEvaluation {
  gate: GateId; attempt: number; outcome: 'pass' | 'fail';
  passedCriterionIds: string[]; missingCriterionIds: string[];
  reasons: string[]; evidenceIds: string[];
}
export interface GateDecisionRecord {
  id: string; runId: string; attempt: number; gate: GateId;
  evaluationOutcome: 'pass' | 'fail';
  action: 'approve' | 'rework' | 'override' | 'reject-hard';
  reason: string | null; contractRevision: string; createdAt: string;
}
