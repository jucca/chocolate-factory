// tests/domain/types.test.ts
import { describe, it, expect } from 'vitest';
import { PHASES, GATE_KIND, DEFAULT_CONFIG } from '../../src/domain/types.js';

describe('domain constants', () => {
  it('fixes phase order', () => {
    expect(PHASES).toEqual(['spec', 'plan', 'implement', 'test', 'verify', 'commit']);
  });
  it('fixes gate kinds: spec/plan soft, verify/commit hard', () => {
    expect(GATE_KIND).toEqual({ spec: 'soft', plan: 'soft', verify: 'hard', commit: 'hard' });
  });
  it('defaults the eligibility label to chocolate:ready', () => {
    expect(DEFAULT_CONFIG.issue_label).toBe('chocolate:ready');
    expect(DEFAULT_CONFIG.runtime).toBe('.chocolate/runtime');
  });
});
