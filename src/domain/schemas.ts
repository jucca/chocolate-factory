// src/domain/schemas.ts
import { z } from 'zod';
import type { Contract, Roadmap, FactoryConfig, GateId } from './types.js';
import { GATE_KIND } from './types.js';

export class SchemaError extends Error {
  constructor(public issues: string[]) { super(issues.join('; ')); this.name = 'SchemaError'; }
}
function parse<T>(schema: z.ZodType<T>, raw: unknown, label: string): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new SchemaError(r.error.issues.map((i) => `${label}: ${i.path.join('.')} ${i.message}`));
  return r.data;
}

const gateId = z.enum(['spec', 'plan', 'verify', 'commit']);
const issueRef = z.object({ tracker: z.literal('github'), repo: z.string().min(1), number: z.number().int().positive(), url: z.string().url() });
const criterion = z.object({
  id: z.string().min(1), statement: z.string().min(1),
  gates: z.array(gateId).min(1, 'criterion must map to at least one gate'),
  evidence: z.string().min(1),
}).superRefine((c, ctx) => {
  if (c.gates.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `criterion ${c.id} has no gate mapping`, path: ['gates'] });
});
const contractSchema = z.object({
  id: z.string().min(1), title: z.string().min(1), intent: z.string().min(1),
  acceptance_criteria: z.array(criterion), constraints: z.array(z.string()),
  out_of_scope: z.array(z.string()), linked_issue: issueRef.nullable(),
  milestone: z.string().min(1), dependencies: z.array(z.string()),
});
const roadmapSchema = z.object({
  milestones: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), intent: z.string(), contracts: z.array(z.string()) })),
});
const configSchema = z.object({
  issue_label: z.string().min(1), issue_source: z.object({ repo: z.string() }),
  gates: z.object({ spec: z.enum(['soft', 'hard']), plan: z.enum(['soft', 'hard']), verify: z.enum(['soft', 'hard']), commit: z.enum(['soft', 'hard']) }),
  runtime: z.string().min(1),
}).superRefine((cfg, ctx) => {
  (Object.keys(GATE_KIND) as GateId[]).forEach((g) => {
    if (GATE_KIND[g] === 'hard' && cfg.gates[g] !== 'hard')
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `gate ${g} must remain hard`, path: ['gates', g] });
  });
});

export function parseContract(raw: unknown): Contract { return parse(contractSchema, raw, 'contract') as Contract; }
export function parseRoadmap(raw: unknown): Roadmap { return parse(roadmapSchema, raw, 'roadmap') as Roadmap; }
export function parseConfig(raw: unknown): FactoryConfig { return parse(configSchema, raw, 'config') as FactoryConfig; }

export function validateCrossRefs(contracts: Contract[], roadmap: Roadmap): string[] {
  const errs: string[] = [];
  const byId = new Map(contracts.map((c) => [c.id, c]));
  const milestoneIds = new Set(roadmap.milestones.map((m) => m.id));
  for (const m of roadmap.milestones) for (const id of m.contracts) {
    if (!byId.has(id)) errs.push(`roadmap milestone ${m.id} references missing contract ${id}`);
    else if (byId.get(id)!.milestone !== m.id) errs.push(`contract ${id} declares milestone ${byId.get(id)!.milestone} but is listed under ${m.id}`);
  }
  for (const c of contracts) {
    if (!milestoneIds.has(c.milestone)) errs.push(`contract ${c.id} references missing milestone ${c.milestone}`);
    for (const d of c.dependencies) if (!byId.has(d)) errs.push(`contract ${c.id} depends on missing contract ${d}`);
  }
  return errs;
}
