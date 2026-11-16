import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseContract, parseRoadmap } from '../../src/domain/schemas.js';

const root = join(import.meta.dirname, '../..');

describe('real-engine contract', () => {
  it('moves later-real-engine onto the real-engine milestone with three criteria', () => {
    const contract = parseContract(parse(readFileSync(join(root, '.chocolate/contracts/later-real-engine.yaml'), 'utf8')));
    const roadmap = parseRoadmap(parse(readFileSync(join(root, '.chocolate/roadmap.yaml'), 'utf8')));
    expect(contract.milestone).toBe('real-engine');
    expect(contract.acceptance_criteria.map((c) => c.id)).toEqual(['ac-playbook-walk', 'ac-playbook-bug', 'ac-playbook-commit']);
    expect(contract.acceptance_criteria[0].gates).toEqual(['verify', 'commit']);
    expect(contract.acceptance_criteria[0].evidence).toBe('tests/engine/playbook/feature.test.ts');
    expect(contract.acceptance_criteria[1].gates).toEqual(['verify']);
    expect(contract.acceptance_criteria[1].evidence).toBe('tests/engine/playbook/bug.test.ts');
    expect(contract.acceptance_criteria[2].gates).toEqual(['commit']);
    expect(contract.acceptance_criteria[2].evidence).toBe('tests/gates/gateEvaluator.test.ts');
    const real = roadmap.milestones.find((m) => m.id === 'real-engine');
    expect(real?.contracts).toEqual(['later-real-engine']);
    const later = roadmap.milestones.find((m) => m.id === 'later-phases');
    expect(later?.contracts).not.toContain('later-real-engine');
  });
});
