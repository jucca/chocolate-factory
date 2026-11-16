import type { Contract, EvidenceRecord, Phase } from '../domain/types.js';

export interface PhaseOutput {
  events: { type: string; message: string }[];
  evidence: Omit<EvidenceRecord, 'id' | 'runId' | 'createdAt'>[];
}
export interface RunEngine {
  runPhase(input: { phase: Phase; attempt: number; contract: Contract }): Promise<PhaseOutput>;
}
