import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLAYBOOK_FILES = ['spec.md', 'plan-feature.md', 'plan-bug.md', 'implement.md', 'verify.md', 'commit.md'] as const;

export function factoryRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export function playbookDir(): string {
  return join(factoryRoot(), 'src', 'engine', 'playbooks');
}

export function loadPlaybookSnapshot(dir: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const name of PLAYBOOK_FILES) snapshot[name] = readFileSync(join(dir, name), 'utf8');
  return snapshot;
}