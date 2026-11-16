import type { Contract, EvidenceRecord, Phase } from '../domain/types.js';

export interface PhaseInput {
  phase: Phase;
  attempt: number;
  contract: Contract;
  runId: string;
}
export interface PhaseOutput {
  events: { type: string; message: string }[];
  evidence: Omit<EvidenceRecord, 'id' | 'runId' | 'createdAt'>[];
}
export interface RunEngine {
  runPhase(input: PhaseInput): Promise<PhaseOutput>;
}