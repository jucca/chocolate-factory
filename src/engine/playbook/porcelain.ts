import type { GitPort } from './ports.js';

export interface PorcelainEntry {
  path: string;
  untracked: boolean;
}

export function porcelainEntries(porcelain: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue;
    const untracked = line.slice(0, 2) === '??';
    const arrow = line.lastIndexOf(' -> ');
    if (arrow !== -1) {
      const left = unquote(stripStatus(line.slice(0, arrow)));
      const right = unquote(line.slice(arrow + 4));
      if (left !== '') entries.push({ path: left, untracked });
      if (right !== '') entries.push({ path: right, untracked });
      continue;
    }
    const path = unquote(line.slice(3));
    if (path !== '') entries.push({ path, untracked });
  }
  return entries;
}

export async function revertOutside(
  git: Pick<GitPort, 'revert' | 'deleteUntracked'>,
  repoRoot: string,
  porcelain: string,
  allowed: ReadonlySet<string>,
  hold: ReadonlySet<string> = new Set(),
): Promise<void> {
  const tracked: string[] = [];
  const untracked: string[] = [];
  const seenTracked = new Set<string>();
  const seenUntracked = new Set<string>();
  for (const entry of porcelainEntries(porcelain)) {
    if (allowed.has(entry.path) || hold.has(entry.path)) continue;
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

function stripStatus(left: string): string {
  if (left.length >= 3 && left[2] === ' ') return left.slice(3);
  const match = left.match(/^[ MADRCU?!]{1,2}\s+(.*)$/);
  return match ? match[1] : left.trim();
}

function unquote(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}
