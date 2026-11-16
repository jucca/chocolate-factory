import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Contract, RunRecord } from '../domain/types.js';

export function renderExecPlan(run: RunRecord, contract: Contract): string {
  return (
    [
      `# Exec Plan — ${run.id}`,
      '',
      `- Contract: ${contract.id} — ${contract.title}`,
      `- Issue: ${run.issue ? `${run.issue.repo}#${run.issue.number} ${run.issue.url}` : 'none'}`,
      `- Attempt: ${run.currentAttempt}`,
      `- Phase: ${run.phase}`,
      '',
      '## Acceptance criteria',
      ...contract.acceptance_criteria.map((c) => `- [ ] ${c.id}: ${c.statement} (gates: ${c.gates.join(', ')})`),
      '',
      '## Log',
      '- Run created by operator claim.',
    ].join('\n') + '\n'
  );
}

export function writeExecPlan(repoRoot: string, run: RunRecord, contract: Contract): void {
  const dir = join(repoRoot, '.chocolate', 'exec-plans');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(repoRoot, run.execPlanRef), renderExecPlan(run, contract));
}

export function appendExecPlanLog(repoRoot: string, execPlanRef: string, line: string): void {
  const path = join(repoRoot, execPlanRef);
  const body = readFileSync(path, 'utf8');
  const entry = line.startsWith('-') ? line : `- ${line}`;
  const trimmed = entry.endsWith('\n') ? entry : `${entry}\n`;
  if (!body.includes('## Log')) {
    appendFileSync(path, `\n## Log\n${trimmed}`);
    return;
  }
  appendFileSync(path, trimmed);
}
