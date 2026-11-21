import { porcelainEntries } from './porcelain.js';

export const TOOLBOX_DIR = 'chocolate-tools';
export const NOTES_CAP = 80;

export interface ToolEntry {
  name: string;
  use: string;
  test: string;
}

function textLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

export function parseManifest(markdown: string): ToolEntry[] {
  const entries: ToolEntry[] = [];
  let current: ToolEntry | null = null;
  for (const line of textLines(markdown)) {
    if (line.startsWith('## ')) {
      if (current) entries.push(current);
      current = { name: line.slice(3).trim(), use: '', test: '' };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('use:')) current.use = line.slice('use:'.length).trim();
    if (line.startsWith('test:')) current.test = line.slice('test:'.length).trim();
  }
  if (current) entries.push(current);
  return entries;
}

export function capLines(text: string, max: number): string {
  return textLines(text).slice(0, max).join('\n');
}

export function renderToolbox(manifest: string, notes: string): string {
  const chunks = [manifest.trim(), notes.trim()].filter((part) => part !== '');
  if (chunks.length === 0) return '';
  return capLines(chunks.join('\n'), NOTES_CAP);
}

export function diffDirectories(base: readonly string[], head: readonly string[]): { added: string[]; removed: string[] } {
  const baseSet = new Set(base);
  const headSet = new Set(head);
  return {
    added: head.filter((name) => !baseSet.has(name)),
    removed: base.filter((name) => !headSet.has(name)),
  };
}

export function decideHold(input: {
  baseTools: readonly string[];
  added: readonly string[];
  removed: readonly string[];
  notesLines: number;
  notesChanged: boolean;
  tests: Readonly<Record<string, string>>;
}): boolean {
  if (input.notesLines > NOTES_CAP) return false;
  if (input.added.length === 0) return !input.notesChanged && input.removed.length === 0;
  if (input.added.length !== 1) return false;
  const name = input.added[0];
  if (!input.tests[name] || input.tests[name].trim() === '') return false;
  if (input.baseTools.length === 0) return input.removed.length === 0;
  return input.removed.length === 1 && input.baseTools.includes(input.removed[0]);
}

export function toolboxHoldPaths(porcelain: string, accept: boolean): string[] {
  if (!accept) return [];
  const prefix = `${TOOLBOX_DIR}/`;
  return porcelainEntries(porcelain)
    .map((entry) => entry.path)
    .filter((path) => path === TOOLBOX_DIR || path.startsWith(prefix));
}

export function toolboxPrompt(text: string): string {
  if (text.trim() === '') return '';
  return `\n## Toolbox\n${text}`;
}

export function implementToolboxPrompt(drop: string | null): string {
  const lines = [
    'Toolbox rule: you may add one directory chocolate-tools/<name>/ and a manifest section',
    '## <name>',
    'use: one sentence',
    'test: <one command>',
    'When the toolbox already has a tool, also delete exactly one existing tool directory in that same change.',
    'You may rewrite chocolate-tools/NOTES.md only in that same change. Keep NOTES.md to 80 lines.',
  ];
  if (drop) lines.push(`Drop: ${drop}`);
  return lines.join('\n');
}