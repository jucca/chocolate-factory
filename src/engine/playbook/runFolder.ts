import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function attemptDir(repoRoot: string, runId: string, attempt: number): string {
  return join(repoRoot, '.chocolate', 'runtime', 'runs', runId, 'attempt-' + attempt);
}

export function ensureAttempt(repoRoot: string, runId: string, attempt: number): string {
  const dir = attemptDir(repoRoot, runId, attempt);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function openQuestionBullets(markdown: string): string[] {
  const bullets: string[] = [];
  let collecting = false;
  for (const line of markdown.split('\n')) {
    if (!collecting) {
      if (line.startsWith('## Open questions')) collecting = true;
      continue;
    }
    if (line.startsWith('## ')) break;
    if (line.startsWith('- ')) bullets.push(line.slice(2));
  }
  return bullets;
}

export function recordAnswers(dir: string, answers: string): void {
  const text = answers.trim();
  appendFileSync(join(dir, 'brief.md'), `\n## Answers\n${text}\n`);
  appendFileSync(join(dir, 'status.md'), `\n## Decisions\n- ${text}\n`);
}

export function listAttemptFiles(repoRoot: string, runId: string, attempt: number): string[] {
  const dir = attemptDir(repoRoot, runId, attempt);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
}

export function readStatusValue(dir: string, key: string): string | null {
  const path = join(dir, 'status.md');
  if (!existsSync(path)) return null;
  const prefix = `- ${key}: `;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  return null;
}

export function appendStatus(dir: string, line: string): void {
  appendFileSync(join(dir, 'status.md'), line + '\n');
}
