// src/files/writeBack.ts
import { readFileSync, writeFileSync } from 'node:fs';
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
  const file = join(repoRoot, '.chocolate', 'contracts', `${contract.id}.yaml`);
  try { parseContract(parse(readFileSync(file, 'utf8'))); }
  catch { throw new UnparseableFileError(file); }
  const content = stringify(contract);
  writeFileSync(file, content);
  return contractRevision(content);
}
export function saveRoadmap(repoRoot: string, roadmap: Roadmap): void {
  const file = join(repoRoot, '.chocolate', 'roadmap.yaml');
  try { parseRoadmap(parse(readFileSync(file, 'utf8'))); }
  catch { throw new UnparseableFileError(file); }
  writeFileSync(file, stringify(roadmap));
}
