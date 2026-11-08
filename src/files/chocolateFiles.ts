// src/files/chocolateFiles.ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Contract, Roadmap, FactoryConfig } from '../domain/types.js';
import { parseContract, parseRoadmap, parseConfig, validateCrossRefs } from '../domain/schemas.js';

export interface ChocolateData {
  contracts: Contract[];
  invalidContracts: { file: string; error: string }[];
  roadmap: Roadmap | null; roadmapError: string | null;
  config: FactoryConfig; crossRefErrors: string[];
}
export function loadChocolate(repoRoot: string): ChocolateData {
  const base = join(repoRoot, '.chocolate');
  const config = parseConfig(parse(readFileSync(join(base, 'config.yaml'), 'utf8')));
  const contracts: Contract[] = []; const invalidContracts: { file: string; error: string }[] = [];
  const dir = join(base, 'contracts');
  if (existsSync(dir)) for (const f of readdirSync(dir).filter((x) => x.endsWith('.yaml')).sort()) {
    try { contracts.push(parseContract(parse(readFileSync(join(dir, f), 'utf8')))); }
    catch (e) { invalidContracts.push({ file: f, error: e instanceof Error ? e.message : String(e) }); }
  }
  let roadmap: Roadmap | null = null; let roadmapError: string | null = null;
  try { roadmap = parseRoadmap(parse(readFileSync(join(base, 'roadmap.yaml'), 'utf8'))); }
  catch (e) { roadmapError = e instanceof Error ? e.message : String(e); }
  return { contracts, invalidContracts, roadmap, roadmapError, config, crossRefErrors: roadmap ? validateCrossRefs(contracts, roadmap) : [] };
}
