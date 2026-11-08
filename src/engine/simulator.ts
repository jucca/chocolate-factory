import type { Contract, Phase } from '../domain/types.js';
import type { PhaseOutput, RunEngine } from './runEngine.js';

export class SimulatorRunEngine implements RunEngine {
  constructor(private opts: { failAt?: Phase } = {}) {}
  async runPhase(input: { phase: Phase; attempt: number; contract: Contract }): Promise<PhaseOutput> {
    if (this.opts.failAt === input.phase) throw new Error(`simulated failure at ${input.phase}`);
    const criterionIds = input.contract.acceptance_criteria.map((c) => c.id);
    const isVerify = input.phase === 'verify';
    return {
      events: [{ type: 'phase_completed', message: `simulated ${input.phase} phase completed (attempt ${input.attempt})` }],
      evidence: [{
        attempt: input.attempt, phase: input.phase, producerPhase: input.phase,
        criterionIds, kind: isVerify ? 'verification-check' : `${input.phase}-summary`,
        summary: isVerify
          ? `independent simulated verification of ${criterionIds.join(', ') || 'no criteria'}`
          : `simulated ${input.phase} output for contract ${input.contract.id}`,
      }],
    };
  }
}
