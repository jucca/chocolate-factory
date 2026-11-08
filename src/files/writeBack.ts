// src/files/writeBack.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { Contract, Roadmap } from '../domain/types.js';
import { parseContract, parseRoadmap } from '../domain/schemas.js';

export class UnparseableFileError extends Error {
  constructor(public file: string) { super(`refusing to overwrite unparseable file: ${file}`); this.name = 'UnparseableFileError'; }
}
export function contractRevision(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
export function saveContract(repoRoot: string, contract: Contract): string {
  const dir = join(repoRoot, '.chocolate', 'contracts');
  const file = join(dir, `${contract.id}.yaml`);
  if (existsSync(file)) {
    try {
      parseContract(parse(readFileSync(file, 'utf8')));
    } catch {
      throw new UnparseableFileError(file);
    }
  }
  mkdirSync(dir, { recursive: true });
  const content = stringify(contract);
  writeFileSync(file, content);
  const roadmapPath = join(repoRoot, '.chocolate', 'roadmap.yaml');
  if (existsSync(roadmapPath)) {
    try {
      const roadmap = parseRoadmap(parse(readFileSync(roadmapPath, 'utf8')));
      const milestone = roadmap.milestones.find((m) => m.id === contract.milestone);
      if (milestone && !milestone.contracts.includes(contract.id)) {
        milestone.contracts.push(contract.id);
        const roadmapContent = stringify(roadmap);
        writeFileSync(roadmapPath, roadmapContent);
      }
    } catch {
      /* leave roadmap unchanged when unparseable */
    }
  }
  return contractRevision(content);
}
export function saveRoadmap(repoRoot: string, roadmap: Roadmap): void {
  const file = join(repoRoot, '.chocolate', 'roadmap.yaml');
  if (existsSync(file)) {
    try {
      parseRoadmap(parse(readFileSync(file, 'utf8')));
    } catch {
      throw new UnparseableFileError(file);
    }
  }
  const content = stringify(roadmap);
  mkdirSync(join(repoRoot, '.chocolate'), { recursive: true });
  writeFileSync(file, content);
}
