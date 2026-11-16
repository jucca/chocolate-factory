import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_YAML, ROADMAP_YAML, CONTRACT_TEMPLATE_YAML, EXEC_PLAN_TEMPLATE_MD, AGENTS_MAP_MD, DOCS_INDEX_MD } from './templates.js';

export class AlreadyStampedError extends Error { constructor(root: string) { super(`repo already stamped: ${root}`); } }
export function stampRepo(repoRoot: string): { created: string[] } {
  const base = join(repoRoot, '.chocolate');
  if (existsSync(base)) throw new AlreadyStampedError(repoRoot);
  const created: string[] = [];
  for (const d of ['.chocolate', '.chocolate/contracts', '.chocolate/templates', '.chocolate/docs', '.chocolate/exec-plans', '.chocolate/runtime']) {
    mkdirSync(join(repoRoot, d), { recursive: true }); created.push(d);
  }
  const files: [string, string][] = [
    ['.chocolate/config.yaml', CONFIG_YAML], ['.chocolate/roadmap.yaml', ROADMAP_YAML],
    ['.chocolate/AGENTS.md', AGENTS_MAP_MD], ['.chocolate/docs/index.md', DOCS_INDEX_MD],
    ['.chocolate/templates/contract.yaml', CONTRACT_TEMPLATE_YAML], ['.chocolate/templates/exec-plan.md', EXEC_PLAN_TEMPLATE_MD],
  ];
  for (const [rel, content] of files) { writeFileSync(join(repoRoot, rel), content); created.push(rel); }
  const giPath = join(repoRoot, '.gitignore');
  const gi = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  if (!gi.includes('/.chocolate/runtime/')) appendFileSync(giPath, `${gi.endsWith('\n') || gi === '' ? '' : '\n'}/.chocolate/runtime/\n`);
  const rootAgents = join(repoRoot, 'AGENTS.md');
  if (!existsSync(rootAgents)) writeFileSync(rootAgents, '# Agents\n\nSee `.chocolate/AGENTS.md` for the Chocolate Factory map.\n');
  return { created };
}
