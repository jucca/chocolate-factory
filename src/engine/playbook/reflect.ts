import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { RunRecord } from '../../domain/types.js';
import { PLAYBOOK_FILES } from './playbookSnapshot.js';
import { porcelainEntries } from './porcelain.js';
import type { GitPort, WorkerPort } from './ports.js';
import { appendStatus, attemptDir } from './runFolder.js';

export interface PlaybookPublisher {
  publish(input: { factoryRoot: string; runId: string; files: Record<string, string>; body: string }): Promise<string>;
}

function textLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

export function lineChange(before: string, after: string): { added: number; deleted: number } {
  const counts = new Map<string, number>();
  for (const line of textLines(before)) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of textLines(after)) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) counts.set(line, remaining - 1);
    else added += 1;
  }
  let deleted = 0;
  for (const remaining of counts.values()) deleted += remaining;
  return { added, deleted };
}

const ALLOWED = new Set<string>(PLAYBOOK_FILES);

export function judgePlaybooks(
  snapshot: Readonly<Record<string, string>>,
  proposed: Readonly<Record<string, string>>,
): { ok: true; files: Record<string, string> } | { ok: false; reason: string } {
  const files: Record<string, string> = {};
  let added = 0;
  let deleted = 0;
  for (const [name, text] of Object.entries(proposed)) {
    if (!ALLOWED.has(name)) return { ok: false, reason: 'outside' };
    const previous = snapshot[name] ?? '';
    if (previous === text) continue;
    files[name] = text;
    const change = lineChange(previous, text);
    added += change.added;
    deleted += change.deleted;
  }
  if (Object.keys(files).length === 0) return { ok: false, reason: 'empty' };
  if (added + deleted > 40) return { ok: false, reason: 'over-cap' };
  if (added > deleted) return { ok: false, reason: 'grows' };
  return { ok: true, files };
}

function existingArtifacts(dir: string): string[] {
  const names: string[] = [];
  for (const name of ['brief.md', 'plan.md', 'implement.md', 'status.md'] as const) {
    if (existsSync(join(dir, name))) names.push(name);
  }
  for (const name of readdirSync(dir).filter((entry) => entry.startsWith('review-') && entry.endsWith('.md')).sort()) {
    names.push(name);
  }
  if (existsSync(join(dir, 'pr.md'))) names.push('pr.md');
  return names;
}

function buildPrompt(dir: string, snapshot: Readonly<Record<string, string>>): string {
  const blocks: string[] = [];
  for (const name of existingArtifacts(dir)) {
    const path = join(dir, name);
    blocks.push(`${path}\n${readFileSync(path, 'utf8')}`);
  }
  const reflectPath = join(dir, 'reflect.md');
  const proposedDir = join(dir, 'reflect-playbooks');
  blocks.push(`Write the whole file ${reflectPath} with REASON: and DROP:.`);
  blocks.push(`Write the whole file for each changed playbook under ${proposedDir}. Use only ${PLAYBOOK_FILES.join(', ')}.`);
  for (const name of PLAYBOOK_FILES) {
    blocks.push(`Current ${name}\n${snapshot[name] ?? ''}`);
  }
  return blocks.join('\n');
}

function slash(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function coversAttempt(path: string, attemptRel: string): boolean {
  const file = slash(path);
  const attempt = slash(attemptRel);
  if (file === '' || attempt === '') return false;
  return file === attempt || file.startsWith(`${attempt}/`) || attempt.startsWith(`${file}/`);
}

function porcelainKey(entry: { path: string; untracked: boolean }): string {
  return `${entry.untracked ? 'u' : 't'}:${entry.path}`;
}

async function revertProductCheckout(
  git: Pick<GitPort, 'statusPorcelain' | 'revert' | 'deleteUntracked'>,
  repoRoot: string,
  dir: string,
  before: ReadonlySet<string>,
): Promise<void> {
  const porcelain = await git.statusPorcelain(repoRoot);
  const attemptRel = relative(repoRoot, dir);
  const tracked: string[] = [];
  const untracked: string[] = [];
  const seenTracked = new Set<string>();
  const seenUntracked = new Set<string>();
  for (const entry of porcelainEntries(porcelain)) {
    if (coversAttempt(entry.path, attemptRel) || before.has(porcelainKey(entry))) continue;
    if (entry.untracked) {
      if (seenUntracked.has(entry.path)) continue;
      seenUntracked.add(entry.path);
      untracked.push(entry.path);
    } else if (!seenTracked.has(entry.path)) {
      seenTracked.add(entry.path);
      tracked.push(entry.path);
    }
  }
  if (tracked.length > 0) await git.revert(repoRoot, tracked);
  if (untracked.length > 0) await git.deleteUntracked(repoRoot, untracked);
}

function parseReason(markdown: string): string {
  for (const line of markdown.split('\n')) {
    if (line.startsWith('REASON:')) return line.slice('REASON:'.length).trim();
  }
  return '';
}

function readProposed(dir: string): Record<string, string> {
  const proposedDir = join(dir, 'reflect-playbooks');
  if (!existsSync(proposedDir)) return {};
  const proposed: Record<string, string> = {};
  for (const entry of readdirSync(proposedDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    proposed[entry.name] = readFileSync(join(proposedDir, entry.name), 'utf8');
  }
  return proposed;
}

function discardMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('publish-') ? message : `publish-${message}`;
}

export function makeReflector(deps: {
  workers: WorkerPort;
  publisher: PlaybookPublisher;
  snapshot: Record<string, string>;
  factoryRoot: string;
  repoRoot: string;
  isRepo: (root: string) => Promise<boolean>;
  git: Pick<GitPort, 'statusPorcelain' | 'revert' | 'deleteUntracked'>;
}): (run: RunRecord) => Promise<void> {
  return async (run: RunRecord) => {
    if (run.engine !== 'playbook') return;
    if (run.state !== 'commit-ready' && run.state !== 'failed') return;
    const dir = attemptDir(deps.repoRoot, run.id, run.currentAttempt);
    const statusPath = join(dir, 'status.md');
    if (!existsSync(statusPath)) return;
    for (const line of readFileSync(statusPath, 'utf8').split('\n')) {
      if (line.startsWith('- reflect:')) return;
    }
    if (!(await deps.isRepo(deps.factoryRoot))) {
      appendStatus(dir, '- reflect: skipped');
      return;
    }
    let before = new Set<string>();
    try {
      before = new Set(porcelainEntries(await deps.git.statusPorcelain(deps.repoRoot)).map(porcelainKey));
      const report = await deps.workers.run({
        role: 'default',
        runDir: dir,
        repoRoot: deps.repoRoot,
        prompt: buildPrompt(dir, deps.snapshot),
        allowedFiles: ['reflect.md'],
        unitId: 'reflect',
      });
      await revertProductCheckout(deps.git, deps.repoRoot, dir, before);
      if (report.status !== 'done') {
        appendStatus(dir, `- reflect: discarded worker-${report.status}`);
        return;
      }
      const reasonPath = join(dir, 'reflect.md');
      const reason = existsSync(reasonPath) ? parseReason(readFileSync(reasonPath, 'utf8')) : '';
      const judged = judgePlaybooks(deps.snapshot, readProposed(dir));
      if (!judged.ok) {
        appendStatus(dir, `- reflect: discarded ${judged.reason}`);
        return;
      }
      const url = await deps.publisher.publish({
        factoryRoot: deps.factoryRoot,
        runId: run.id,
        files: judged.files,
        body: reason,
      });
      appendStatus(dir, `- reflect: pr ${url}`);
    } catch (error) {
      try {
        await revertProductCheckout(deps.git, deps.repoRoot, dir, before);
      } catch {
        // The original failure is the one status.md records.
      }
      appendStatus(dir, `- reflect: discarded ${discardMessage(error)}`);
    }
  };
}
