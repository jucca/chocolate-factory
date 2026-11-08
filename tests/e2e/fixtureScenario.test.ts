import { describe, it, expect } from 'vitest';
describe('fixture scenario placeholder-free contract', () => {
  it('roadmap DTO exposes plain-language stakeholder fields', async () => {
    const { buildRoadmapView } = await import('../../src/domain/derivedStatus.js');
    const v = buildRoadmapView({ contracts: [], invalidFiles: [], roadmap: { milestones: [] }, runsByContract: new Map(), pendingGateByContract: new Set(), failedByContract: new Set() });
    expect(v).toEqual({ milestones: [], invalidFiles: [] });
  });
});
