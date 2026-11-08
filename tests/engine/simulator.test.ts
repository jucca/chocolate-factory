import { describe, it, expect } from 'vitest';
import { SimulatorRunEngine } from '../../src/engine/simulator.js';
import type { Contract } from '../../src/domain/types.js';

const contract: Contract = { id: 'a', title: 'A', intent: 'x', constraints: [], out_of_scope: [], linked_issue: null, milestone: 'm1', dependencies: [],
  acceptance_criteria: [{ id: 'ac-1', statement: 's', gates: ['verify'], evidence: 'verification-check' }] };

describe('SimulatorRunEngine', () => {
  it('emits phase evidence for implement', async () => {
    const out = await new SimulatorRunEngine().runPhase({ phase: 'implement', attempt: 1, contract });
    expect(out.evidence[0]).toMatchObject({ phase: 'implement', producerPhase: 'implement', criterionIds: ['ac-1'] });
  });
  it('verify evidence is independently produced by verify, kind verification-check', async () => {
    const out = await new SimulatorRunEngine().runPhase({ phase: 'verify', attempt: 1, contract });
    expect(out.evidence[0]).toMatchObject({ producerPhase: 'verify', kind: 'verification-check' });
  });
  it('throws at the injected failing phase', async () => {
    await expect(new SimulatorRunEngine({ failAt: 'test' }).runPhase({ phase: 'test', attempt: 1, contract }))
      .rejects.toThrowError(/simulated failure at test/);
  });
  it('does not throw at other phases when failAt is set', async () => {
    await expect(new SimulatorRunEngine({ failAt: 'test' }).runPhase({ phase: 'spec', attempt: 1, contract })).resolves.toBeDefined();
  });
});
