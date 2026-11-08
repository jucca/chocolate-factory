import { stringify } from 'yaml';
import { DEFAULT_CONFIG } from '../domain/types.js';

export const CONFIG_YAML = stringify(DEFAULT_CONFIG);
export const ROADMAP_YAML = stringify({ milestones: [{ id: 'v1', title: 'V1', intent: 'First milestone — replace with your roadmap.', contracts: [] }] });
export const CONTRACT_TEMPLATE_YAML = stringify({
  id: 'replace-me', title: 'Replace me', intent: 'Plain-language intent for stakeholders.',
  acceptance_criteria: [{ id: 'ac-1', statement: 'Checkable criterion in plain language.', gates: ['verify'], evidence: 'verification-check summary' }],
  constraints: [], out_of_scope: [], linked_issue: null, milestone: 'v1', dependencies: [],
});
export const EXEC_PLAN_TEMPLATE_MD = '# Exec Plan — {{runId}}\n\n- Contract: {{contractId}}\n\n## Acceptance criteria\n\n## Log\n';
export const AGENTS_MAP_MD = [
  '# Chocolate Factory — agent map', '',
  'Read this first. Detail lives in the docs below; this file is only a map.', '',
  '- Contracts: `.chocolate/contracts/` (one YAML per feature)',
  '- Roadmap: `.chocolate/roadmap.yaml`',
  '- Config: `.chocolate/config.yaml`',
  '- Docs index: `.chocolate/docs/index.md`',
  '- Exec plans: `.chocolate/exec-plans/`',
  '- Runtime (never commit): `.chocolate/runtime/`',
].join('\n') + '\n';
export const DOCS_INDEX_MD = [
  '# Chocolate docs', '',
  '- Contract format: one YAML per feature in `.chocolate/contracts/`; every criterion maps to a gate.',
  '- Gates: spec/plan are soft (override needs a recorded reason); verify/commit are hard and fail closed.',
  '- Workflow: spec → plan → implement → test → verify → commit; success in V1 is commit-ready.',
  '- History is append-only: retries and replans are new attempts.',
].join('\n') + '\n';
