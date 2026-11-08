// src/gates/gateEvaluator.ts
import type { Contract, EvidenceRecord, FactoryConfig, GateEvaluation, GateId, ContractStatus } from '../domain/types.js';

const SATISFIED: ContractStatus[] = ['commit-ready', 'done'];
export function evaluateGate(input: {
  gate: GateId; attempt: number; contract: Contract;
  evidence: EvidenceRecord[]; dependencyStatuses: ContractStatus[]; config: FactoryConfig;
}): GateEvaluation {
  const mapped = input.contract.acceptance_criteria.filter((c) => c.gates.includes(input.gate));
  const covered = (criterionId: string): EvidenceRecord | undefined => input.evidence.find((e) => {
    if (!e.criterionIds.includes(criterionId)) return false;
    if (input.gate === 'verify') return e.producerPhase === 'verify' && e.kind === 'verification-check';
    if (input.gate === 'commit') return e.producerPhase === 'verify' && e.kind === 'verification-check';
    return true;
  });
  const passedCriterionIds: string[] = []; const missingCriterionIds: string[] = [];
  for (const c of mapped) (covered(c.id) ? passedCriterionIds : missingCriterionIds).push(c.id);
  const reasons: string[] = [];
  if (missingCriterionIds.length > 0) reasons.push(`missing evidence for criteria: ${missingCriterionIds.join(', ')}`);
  if (input.gate === 'commit' && input.dependencyStatuses.some((s) => !SATISFIED.includes(s)))
    reasons.push('unmet dependency: a dependency contract is not commit-ready');
  if (mapped.length === 0) reasons.push(`no acceptance criteria map to gate ${input.gate}`);
  const evidenceIds = [...new Set(mapped.flatMap((c) => { const e = covered(c.id); return e ? [e.id] : []; }))];
  return { gate: input.gate, attempt: input.attempt, outcome: reasons.length === 0 ? 'pass' : 'fail', passedCriterionIds, missingCriterionIds, reasons, evidenceIds };
}
