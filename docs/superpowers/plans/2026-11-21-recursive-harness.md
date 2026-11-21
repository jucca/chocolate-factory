# Recursive Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a playbook run keep one tested tool in the product pull request and open one capped playbook pull request on the factory repo after the run finishes.

**Architecture:** Pure toolbox and playbook-diff rules decide what may be kept. `GitCli` reads and restores `chocolate-tools/` at a base SHA. Implement holds a legal toolbox change; the test phase runs the new tool's test once. A reflector runs only after a playbook run is commit-ready or failed, and a publisher opens `playbook/<runId>` from a worktree. Playbooks are snapshotted at process start.

**Tech Stack:** Node.js 22, TypeScript, Vitest, existing `GitPort` / `WorkerPort` / `CommandRunner` fakes.

## Global Constraints

- Toolbox directory is `chocolate-tools/` at the target repo root.
- Manifest section shape is `## <name>`, then `use: one sentence`, then `test: <one command>`.
- `NOTES.md` cap is 80 lines. Spec and plan inject `manifest.md` plus `NOTES.md` capped at 80 lines together. A missing file at the base SHA is empty. An empty toolbox appends nothing.
- One new tool directory per wave. When the base SHA already has a tool, that wave also deletes exactly one base tool. Otherwise the addition is not held.
- A notes-only edit is not held. A second new tool is not held. A new tool with a blank `test` line is not held.
- Playbook paths under `src/engine/playbooks/` are never held.
- Tool test runs once, before the plan commands. Failure or a dirty tree restores `chocolate-tools/` to the base SHA, commits `chore: revert toolbox` when the tree is dirty, and appends `tool: reverted <name>`. The feature run continues.
- Changed playbook lines are the multiset difference of the before and after line lists, ignoring one trailing empty line from a final newline. Cap is 40. Additions greater than deletions are discarded.
- Editable playbook files are only `spec.md`, `plan-feature.md`, `plan-bug.md`, `implement.md`, `verify.md`, and `commit.md`.
- Reflection runs once per finished playbook attempt, only from commit-ready or failed, only when `status.md` exists and has no `- reflect:` line. Simulator runs do not reflect.
- A non-git factory root writes `reflect: skipped` and does not call the worker.
- Discard reasons are `worker-<status>`, `over-cap`, `grows`, `outside`, and `empty`. Publish failures write `reflect: discarded publish-<reason>`. Success writes `reflect: pr <url>`.
- The publisher branch is `playbook/<runId>`. Worktree path is `.chocolate/runtime/worktrees/playbook-<runId>` under the factory root. Push is `git push -u origin HEAD` with no force. Default branch is `origin/HEAD` when present, otherwise `main`.
- The worker prompt for reflection contains attempt artifact paths and contents only. It does not contain `evaluateGate`.
- `reflect.md` lines are `REASON: <one line>` and `DROP: <tool name or none>`.
- A throw from reflection does not change the run state.
- Do not add methods to `GitPort`. Add `ToolboxGit` instead.

---

### Task 1: Toolbox rules

**Files:**
- Create: `src/engine/playbook/toolbox.ts`
- Test: `tests/engine/playbook/toolbox.test.ts`

**Interfaces:**
- Consumes: `porcelainEntries` from `src/engine/playbook/porcelain.ts`
- Produces:
  - `export const TOOLBOX_DIR = 'chocolate-tools'`
  - `export const NOTES_CAP = 80`
  - `export interface ToolEntry { name: string; use: string; test: string }`
  - `export function parseManifest(markdown: string): ToolEntry[]`
  - `export function capLines(text: string, max: number): string`
  - `export function renderToolbox(manifest: string, notes: string): string`
  - `export function diffDirectories(base: readonly string[], head: readonly string[]): { added: string[]; removed: string[] }`
  - `export function decideHold(input: { baseTools: readonly string[]; added: readonly string[]; removed: readonly string[]; notesLines: number; notesChanged: boolean; tests: Readonly<Record<string, string>> }): boolean`
  - `export function toolboxHoldPaths(porcelain: string, accept: boolean): string[]`
  - `export function toolboxPrompt(text: string): string`
  - `export function implementToolboxPrompt(drop: string | null): string`

- [ ] **Step 1: Write the failing test**

Create `tests/engine/playbook/toolbox.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  decideHold,
  diffDirectories,
  implementToolboxPrompt,
  parseManifest,
  renderToolbox,
  toolboxHoldPaths,
  toolboxPrompt,
} from '../../../src/engine/playbook/toolbox.js';

const MANIFEST = [
  '## widget',
  'use: parse the widget',
  'test: node widget.test.js',
  '## other',
  'use: other',
  'test: node other.test.js',
].join('\n');

describe('toolbox rules', () => {
  it('parses manifest sections', () => {
    expect(parseManifest(MANIFEST)).toEqual([
      { name: 'widget', use: 'parse the widget', test: 'node widget.test.js' },
      { name: 'other', use: 'other', test: 'node other.test.js' },
    ]);
  });

  it('caps the injected toolbox at 80 lines', () => {
    const notes = Array.from({ length: 90 }, (_, i) => `n${i}`).join('\n');
    expect(renderToolbox('## widget\nuse: u\ntest: t', notes).split('\n')).toHaveLength(80);
    expect(renderToolbox('', '')).toBe('');
    expect(toolboxPrompt('')).toBe('');
    expect(toolboxPrompt('## widget')).toBe('\n## Toolbox\n## widget');
  });

  it('holds one new tool on an empty base and rejects a second', () => {
    const tests = { widget: 'node widget.test.js', extra: 'node extra.test.js' };
    expect(decideHold({ baseTools: [], added: ['widget'], removed: [], notesLines: 1, notesChanged: false, tests })).toBe(true);
    expect(decideHold({ baseTools: [], added: ['widget', 'extra'], removed: [], notesLines: 1, notesChanged: false, tests })).toBe(false);
    expect(decideHold({ baseTools: [], added: ['widget'], removed: [], notesLines: 1, notesChanged: false, tests: { widget: '  ' } })).toBe(false);
  });

  it('requires a paired delete once the base has a tool', () => {
    const tests = { widget: 'node widget.test.js' };
    expect(decideHold({ baseTools: ['old'], added: ['widget'], removed: [], notesLines: 1, notesChanged: false, tests })).toBe(false);
    expect(decideHold({ baseTools: ['old'], added: ['widget'], removed: ['old'], notesLines: 1, notesChanged: true, tests })).toBe(true);
    expect(decideHold({ baseTools: ['old'], added: ['widget'], removed: ['missing'], notesLines: 1, notesChanged: false, tests })).toBe(false);
    expect(decideHold({ baseTools: ['old'], added: [], removed: [], notesLines: 81, notesChanged: true, tests })).toBe(false);
    expect(decideHold({ baseTools: [], added: [], removed: [], notesLines: 2, notesChanged: true, tests })).toBe(false);
  });

  it('holds chocolate-tools paths only when the change is accepted', () => {
    const porcelain = '?? chocolate-tools/widget/a.js\n M src/engine/playbooks/spec.md\n';
    expect(toolboxHoldPaths(porcelain, true)).toEqual(['chocolate-tools/widget/a.js']);
    expect(toolboxHoldPaths(porcelain, false)).toEqual([]);
  });

  it('names the directories added and removed', () => {
    expect(diffDirectories(['old'], ['old', 'widget'])).toEqual({ added: ['widget'], removed: [] });
    expect(diffDirectories(['old', 'widget'], ['widget'])).toEqual({ added: [], removed: ['old'] });
  });

  it('states the implement rule and an optional drop', () => {
    expect(implementToolboxPrompt(null)).toContain('chocolate-tools/<name>/');
    expect(implementToolboxPrompt(null)).not.toContain('Drop:');
    expect(implementToolboxPrompt('old')).toContain('Drop: old');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/engine/playbook/toolbox.test.ts`

Expected: FAIL because `toolbox.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/engine/playbook/toolbox.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/engine/playbook/toolbox.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/playbook/toolbox.ts tests/engine/playbook/toolbox.test.ts
git commit -m "$(cat <<'EOF'
feat: decide which toolbox edits a run may keep

EOF
)"
```

---

### Task 2: Playbook snapshot

**Files:**
- Create: `src/engine/playbook/playbookSnapshot.ts`
- Modify: `src/engine/playbook/playbookEngine.ts`
- Modify: `src/server/server.ts`
- Test: `tests/engine/playbook/playbookSnapshot.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1
- Produces:
  - `export const PLAYBOOK_FILES = ['spec.md', 'plan-feature.md', 'plan-bug.md', 'implement.md', 'verify.md', 'commit.md'] as const`
  - `export function playbookDir(): string`
  - `export function factoryRoot(): string`
  - `export function loadPlaybookSnapshot(dir: string): Record<string, string>`
  - `PlaybookRunEngine` constructor `(ctx, options?: { playbookDirectory?: string })`
  - `engine.playbook(name: string): string` returns the snapshot taken at construction

- [ ] **Step 1: Write the failing test**

Create `tests/engine/playbook/playbookSnapshot.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PlaybookRunEngine } from '../../../src/engine/playbook/playbookEngine.js';
import { PLAYBOOK_FILES, loadPlaybookSnapshot } from '../../../src/engine/playbook/playbookSnapshot.js';
import type { PhaseContext } from '../../../src/engine/playbook/phases/specPhase.js';

function writePlaybooks(dir: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of PLAYBOOK_FILES) writeFileSync(join(dir, name), text);
}

describe('playbook snapshot', () => {
  it('keeps the text captured at load after the file changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-playbooks-'));
    writePlaybooks(dir, 'ORIGINAL\n');
    const snapshot = loadPlaybookSnapshot(dir);
    writeFileSync(join(dir, 'spec.md'), 'CHANGED\n');
    expect(snapshot['spec.md']).toBe('ORIGINAL\n');
    const engine = new PlaybookRunEngine({} as PhaseContext, { playbookDirectory: dir });
    writeFileSync(join(dir, 'implement.md'), 'CHANGED\n');
    expect(engine.playbook('implement.md')).toBe('ORIGINAL\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/engine/playbook/playbookSnapshot.test.ts`

Expected: FAIL because `playbookSnapshot.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/engine/playbook/playbookSnapshot.ts`:

```ts
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
```

Replace `src/engine/playbook/playbookEngine.ts` with:

```ts
import type { Flow } from '../../domain/types.js';
import type { PhaseInput, PhaseOutput, RunEngine } from '../runEngine.js';
import { runCommitPhase } from './phases/commitPhase.js';
import { runImplementPhase } from './phases/implementPhase.js';
import { runPlanPhase } from './phases/planPhase.js';
import { runSpecPhase, type PhaseContext } from './phases/specPhase.js';
import { runTestPhase } from './phases/testPhase.js';
import { runVerifyPhase } from './phases/verifyPhase.js';
import { loadPlaybookSnapshot, playbookDir } from './playbookSnapshot.js';

export class PlaybookRunEngine implements RunEngine {
  private snapshot: Record<string, string>;

  constructor(private ctx: PhaseContext, options?: { playbookDirectory?: string }) {
    this.snapshot = loadPlaybookSnapshot(options?.playbookDirectory ?? playbookDir());
  }

  playbook(name: string): string {
    return this.snapshot[name] ?? '';
  }

  async runPhase(input: PhaseInput): Promise<PhaseOutput> {
    const run = this.ctx.store.getRun(input.runId);
    if (!run) throw new Error(`unknown run ${input.runId}`);
    const flow: Flow = run.flow;
    const readPlaybook = (name: string) => this.playbook(name);
    const ctx = { ...this.ctx, flow, readPlaybook };
    switch (input.phase) {
      case 'spec':
        return runSpecPhase(input, ctx);
      case 'plan':
        return runPlanPhase(input, ctx);
      case 'implement':
        return runImplementPhase(input, ctx);
      case 'test':
        return runTestPhase(input, ctx);
      case 'verify':
        return runVerifyPhase(input, ctx);
      case 'commit':
        return runCommitPhase(input, ctx);
      default: {
        const unexpected: never = input.phase;
        throw new Error(`unknown phase ${unexpected}`);
      }
    }
  }
}
```

In `src/server/server.ts`, delete the local `readPlaybook` function and its unused `readFileSync`, `dirname`, `join`, and `fileURLToPath` imports if they become unused. Construct the engine as `new PlaybookRunEngine({ ... })` with no `readPlaybook` field. `PhaseContext` still requires `readPlaybook`. Pass `readPlaybook: () => ''` in the server object; the engine replaces it inside `runPhase`. Keep the rest of the server object unchanged.

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run tests/engine/playbook/playbookSnapshot.test.ts tests/engine/playbook/feature.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/playbook/playbookSnapshot.ts src/engine/playbook/playbookEngine.ts src/server/server.ts tests/engine/playbook/playbookSnapshot.test.ts
git commit -m "$(cat <<'EOF'
feat: snapshot phase playbooks at process start

EOF
)"
```

---

### Task 3: Show and restore a tree

**Files:**
- Modify: `src/engine/playbook/ports.ts`
- Modify: `src/engine/playbook/gitCli.ts`
- Modify: `tests/engine/playbook/gitCli.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `export interface ToolboxGit { show(repoRoot: string, rev: string, path: string): Promise<string | null>; restoreTree(repoRoot: string, rev: string, path: string): Promise<void> }`
  - `GitCli` implements both methods. `show` returns file text or `null` when `git show rev:path` fails. `restoreTree` runs `git checkout <rev> -- <path>` when that succeeds, then `git clean -fd -- <path>`.

- [ ] **Step 1: Write the failing test**

Add this case to `tests/engine/playbook/gitCli.test.ts` inside the existing `describe`, using the existing `initRepo` and `git` helpers:

```ts
it('shows a file at a revision and restores that tree', async () => {
  const root = initRepo();
  const cli = new GitCli();
  const base = await cli.headSha(root);
  expect(await cli.show(root, base, 'missing')).toBeNull();
  expect(await cli.show(root, base, 'README')).toBe('hello\n');
  writeFileSync(join(root, 'README'), 'dirty\n');
  writeFileSync(join(root, 'extra.txt'), 'x\n');
  await cli.restoreTree(root, base, 'README');
  expect(readFileSync(join(root, 'README'), 'utf8')).toBe('hello\n');
  expect(await cli.statusPorcelain(root)).not.toContain('README');
});
```

Add `show` and `restoreTree` to the import from `GitCli` only if the test calls them on the class instance. The instance already has the methods once implemented. No import change is required if the test uses `cli.show`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/engine/playbook/gitCli.test.ts`

Expected: FAIL because `show` is not a function.

- [ ] **Step 3: Write minimal implementation**

Add to `src/engine/playbook/ports.ts`:

```ts
export interface ToolboxGit {
  show(repoRoot: string, rev: string, path: string): Promise<string | null>;
  restoreTree(repoRoot: string, rev: string, path: string): Promise<void>;
}
```

Add to `GitCli` in `src/engine/playbook/gitCli.ts`:

```ts
async show(repoRoot: string, rev: string, path: string): Promise<string | null> {
  try {
    return await git(repoRoot, ['show', `${rev}:${path}`]);
  } catch {
    return null;
  }
}

async restoreTree(repoRoot: string, rev: string, path: string): Promise<void> {
  try {
    await git(repoRoot, ['checkout', rev, '--', path]);
  } catch {
    // The path is absent at that revision.
  }
  try {
    await git(repoRoot, ['clean', '-fd', '--', path]);
  } catch {
    // Nothing untracked under that path.
  }
}
```

Do not add these methods to `GitPort`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/engine/playbook/gitCli.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/playbook/ports.ts src/engine/playbook/gitCli.ts tests/engine/playbook/gitCli.test.ts
git commit -m "$(cat <<'EOF'
feat: read and restore a file tree at a revision

EOF
)"
```

---

### Task 4: Hold a legal tool and inject toolbox text

**Files:**
- Modify: `src/engine/playbook/phases/specPhase.ts`
- Modify: `src/engine/playbook/phases/planPhase.ts`
- Modify: `src/engine/playbook/phases/implementPhase.ts`
- Modify: `src/engine/playbook/toolbox.ts`
- Test: `tests/engine/playbook/toolboxRead.test.ts`
- Test: `tests/engine/playbook/implementPhase.test.ts`

**Interfaces:**
- Consumes: `decideHold`, `diffDirectories`, `parseManifest`, `renderToolbox`, `toolboxHoldPaths`, `toolboxPrompt`, `implementToolboxPrompt`, `TOOLBOX_DIR`, `ToolboxGit`
- Produces:
  - `export async function readToolboxText(git: ToolboxGit | undefined, repoRoot: string, sha: string): Promise<string>`
  - `export function latestDrop(repoRoot: string, present: readonly string[]): string | null`
  - `PhaseContext.toolboxGit?: ToolboxGit`
  - Spec and plan prompts gain `toolboxPrompt(text)` built from the base SHA
  - Implement prompts gain `implementToolboxPrompt(drop)`
  - `guardScope` adds hold paths from `toolboxHoldPaths` before `revertOutside`

- [ ] **Step 1: Write the failing tests**

Create `tests/engine/playbook/toolboxRead.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { latestDrop, readToolboxText } from '../../../src/engine/playbook/toolbox.js';
import type { ToolboxGit } from '../../../src/engine/playbook/ports.js';

function git(files: Record<string, string | null>): ToolboxGit {
  return {
    show: async (_root, _rev, path) => files[path] ?? null,
    restoreTree: async () => {},
  };
}

describe('toolbox read', () => {
  it('renders the manifest and notes at the base sha', async () => {
    const text = await readToolboxText(git({
      'chocolate-tools/manifest.md': '## widget\nuse: u\ntest: t\n',
      'chocolate-tools/NOTES.md': 'remember\n',
    }), '/repo', 'abc');
    expect(text).toContain('## widget');
    expect(text).toContain('remember');
  });

  it('treats a missing file as empty', async () => {
    expect(await readToolboxText(git({}), '/repo', 'abc')).toBe('');
    expect(await readToolboxText(undefined, '/repo', 'abc')).toBe('');
  });

  it('returns the newest drop whose tool is still present', () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-drop-'));
    const older = join(root, '.chocolate', 'runtime', 'runs', 'run-a', 'attempt-1');
    const newer = join(root, '.chocolate', 'runtime', 'runs', 'run-b', 'attempt-1');
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });
    writeFileSync(join(older, 'reflect.md'), 'REASON: old\nDROP: old\n');
    writeFileSync(join(newer, 'reflect.md'), 'REASON: new\nDROP: widget\n');
    expect(latestDrop(root, ['widget'])).toBe('widget');
    expect(latestDrop(root, ['other'])).toBeNull();
  });
});
```

Add this test to `tests/engine/playbook/implementPhase.test.ts`. Extend `setup` options with `toolboxGit?: ToolboxGit` and `manifest?: string`. When `toolboxGit` is set, put it on the phase context. When `manifest` is set, write it to `join(root, 'chocolate-tools/manifest.md')` before the phase runs, creating the directory. Capture `revert` paths as the existing `reverts` array does.

```ts
it('holds one new tool and reverts a playbook edit', async () => {
  const rootFiles: Record<string, string | null> = { 'chocolate-tools/manifest.md': '' };
  const h = setup({
    toolboxGit: {
      show: async (_root, _rev, path) => rootFiles[path] ?? null,
      restoreTree: async () => {},
    },
    manifest: '## widget\nuse: u\ntest: node t.js\n',
    git: {
      statusPorcelain: async () => '?? chocolate-tools/widget/a.js\n?? chocolate-tools/manifest.md\n M src/engine/playbooks/spec.md\n',
    },
  });
  await runImplementPhase(h.input, h.ctx);
  const reverted = h.reverts.flat();
  expect(reverted).toContain('src/engine/playbooks/spec.md');
  expect(reverted).not.toContain('chocolate-tools/widget/a.js');
  expect(h.workerRuns[0].prompt).toContain('Toolbox rule:');
});
```

The existing `setup` return value must expose `reverts`, `workerRuns`, `input`, and `ctx`. It already returns those names if the current return object uses them; if a name differs, use the name the harness already returns and do not rename the existing fields. Add `toolboxGit` onto `ctx` only for this test's option. Do not require `toolboxGit` for the other tests.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/engine/playbook/toolboxRead.test.ts tests/engine/playbook/implementPhase.test.ts`

Expected: FAIL because `readToolboxText` is not exported and the new implement test fails.

- [ ] **Step 3: Write minimal implementation**

Append to `src/engine/playbook/toolbox.ts`:

```ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolboxGit } from './ports.js';

export async function readToolboxText(git: ToolboxGit | undefined, repoRoot: string, sha: string): Promise<string> {
  if (!git) return '';
  const manifest = (await git.show(repoRoot, sha, `${TOOLBOX_DIR}/manifest.md`)) ?? '';
  const notes = (await git.show(repoRoot, sha, `${TOOLBOX_DIR}/NOTES.md`)) ?? '';
  return renderToolbox(manifest, notes);
}

export function latestDrop(repoRoot: string, present: readonly string[]): string | null {
  const runs = join(repoRoot, '.chocolate', 'runtime', 'runs');
  if (!existsSync(runs)) return null;
  let best: { mtime: number; drop: string } | null = null;
  for (const runId of readdirSync(runs)) {
    const runDir = join(runs, runId);
    if (!statSync(runDir).isDirectory()) continue;
    for (const attempt of readdirSync(runDir)) {
      const path = join(runDir, attempt, 'reflect.md');
      if (!existsSync(path)) continue;
      const mtime = statSync(path).mtimeMs;
      const drop = dropName(readFileSync(path, 'utf8'));
      if (drop && (!best || mtime >= best.mtime)) best = { mtime, drop };
    }
  }
  if (!best || best.drop === 'none' || !present.includes(best.drop)) return null;
  return best.drop;
}

function dropName(markdown: string): string | null {
  for (const line of markdown.split('\n')) {
    if (line.startsWith('DROP:')) return line.slice('DROP:'.length).trim();
  }
  return null;
}
```

Merge the new imports with the existing `toolbox.ts` imports. Do not import `node:fs` twice.

Add to `PhaseContext` in `src/engine/playbook/phases/specPhase.ts`:

```ts
toolboxGit?: ToolboxGit;
```

Import `ToolboxGit` from `../ports.js`, and import `readToolboxText`, `toolboxPrompt` from `../toolbox.js`.

In `runSpecPhase`, after the branch is created and before the worker prompt is built, read the head SHA and append the toolbox prompt:

```ts
const toolboxSha = await ctx.git.headSha(repoRoot);
const toolbox = toolboxPrompt(await readToolboxText(ctx.toolboxGit, repoRoot, toolboxSha));
const prompt = [ctx.readPlaybook('spec.md'), intakePath, briefPath, `type: ${ctx.flow}`, toolbox].filter((part) => part !== '').join('\n');
```

The existing `headSha` call that writes `status.md` stays. Two reads are fine.

In `planPhase.ts`, import the same helpers. In both the bug planner prompt and `dispatchPlan`, append `toolboxPrompt(await readToolboxText(...))`. The SHA is the part after `@` in `readStatusValue(dir, 'base')`. If that value is missing, pass `''` as the SHA. `readToolboxText` then shows nothing useful and returns empty when the git port returns null. Use a local helper in the phase file:

```ts
function baseSha(value: string | null): string {
  const at = value?.lastIndexOf('@') ?? -1;
  if (!value || at < 0 || at === value.length - 1) return '';
  return value.slice(at + 1);
}
```

Do not throw from the plan phase when the base line is missing. The implement phase already has its own throwing `baseSha`; leave that one as it is.

In `implementPhase.ts`:

- Import `decideHold`, `diffDirectories`, `implementToolboxPrompt`, `latestDrop`, `parseManifest`, `toolboxHoldPaths`, `TOOLBOX_DIR` from `../toolbox.js`.
- Import `existsSync` is already imported. Also import `readFileSync` (already imported).
- At the start of `runImplementPhase`, after `dir` is known:

```ts
const base = baseSha(readStatusValue(dir, 'base'));
const baseManifest = ctx.toolboxGit ? (await ctx.toolboxGit.show(repoRoot, base, `${TOOLBOX_DIR}/manifest.md`)) ?? '' : '';
const present = parseManifest(baseManifest).map((entry) => entry.name);
const drop = ctx.toolboxGit ? latestDrop(repoRoot, present) : null;
const toolboxRule = ctx.toolboxGit ? implementToolboxPrompt(drop) : '';
```

Pass `toolboxRule` into `runUnit` and then `dispatchUnit`, and append it to the prompt array when it is non-empty.

- Change `guardScope` to accept the base SHA string already computed for bugs, and also compute toolbox hold. The current bug path passes `base` only when there is a repro. Read the base SHA inside `guardScope` from status when `ctx.toolboxGit` is set. On a missing base line, skip the toolbox hold.

```ts
async function legalToolboxHold(ctx: PhaseContext, dir: string, porcelain: string): Promise<string[]> {
  if (!ctx.toolboxGit) return [];
  const base = readStatusValue(dir, 'base');
  const at = base?.lastIndexOf('@') ?? -1;
  if (!base || at < 0 || at === base.length - 1) return [];
  const sha = base.slice(at + 1);
  const baseManifest = (await ctx.toolboxGit.show(ctx.repoRoot, sha, `${TOOLBOX_DIR}/manifest.md`)) ?? '';
  const baseNotes = (await ctx.toolboxGit.show(ctx.repoRoot, sha, `${TOOLBOX_DIR}/NOTES.md`)) ?? '';
  const manifestPath = join(ctx.repoRoot, TOOLBOX_DIR, 'manifest.md');
  const notesPath = join(ctx.repoRoot, TOOLBOX_DIR, 'NOTES.md');
  const headManifest = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
  const headNotes = existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : '';
  const baseEntries = parseManifest(baseManifest);
  const headEntries = parseManifest(headManifest);
  const { added, removed } = diffDirectories(
    baseEntries.map((entry) => entry.name),
    headEntries.map((entry) => entry.name),
  );
  const tests: Record<string, string> = {};
  for (const entry of headEntries) tests[entry.name] = entry.test;
  const notesLines = headNotes === '' ? 0 : headNotes.split('\n').filter((line, index, all) => !(index === all.length - 1 && line === '')).length;
  const accept = decideHold({
    baseTools: baseEntries.map((entry) => entry.name),
    added,
    removed,
    notesLines,
    notesChanged: headNotes !== baseNotes,
    tests,
  });
  return toolboxHoldPaths(porcelain, accept);
}
```

In `guardScope`, `const extra = await legalToolboxHold(ctx, dir, porcelain)` and `for (const path of extra) hold.add(path)` before `revertOutside`. The directory argument is the attempt directory. `runUnit` has `dir`. Pass `dir` into `guardScope`.

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run tests/engine/playbook/toolboxRead.test.ts tests/engine/playbook/implementPhase.test.ts tests/engine/playbook/specPhase.test.ts tests/engine/playbook/planFeature.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/playbook/toolbox.ts src/engine/playbook/phases/specPhase.ts src/engine/playbook/phases/planPhase.ts src/engine/playbook/phases/implementPhase.ts tests/engine/playbook/toolboxRead.test.ts tests/engine/playbook/implementPhase.test.ts
git commit -m "$(cat <<'EOF'
feat: keep one legal toolbox edit and show it to later prompts

EOF
)"
```

---

### Task 5: Run the new tool's test once

**Files:**
- Modify: `src/engine/playbook/phases/testPhase.ts`
- Test: `tests/engine/playbook/testPhase.test.ts`

**Interfaces:**
- Consumes: `ToolboxGit`, `parseManifest`, `diffDirectories`, `TOOLBOX_DIR`, `appendStatus`
- Produces: test phase behavior. Before plan commands, if the working-tree manifest has exactly one tool name that the base manifest does not, run that entry's `test` command once. On `ok: false` or a non-empty porcelain after the command, call `restoreTree(repo, sha, 'chocolate-tools')`, `commitAll` when porcelain is still non-empty, and append `tool: reverted <name>`. A passing clean command does not restore.

- [ ] **Step 1: Write the failing test**

Add `toolboxGit?: ToolboxGit` to the `setup` options type and set `toolboxGit: options.toolboxGit` on the context object. Import `ToolboxGit` from `ports.js` and `mkdirSync` from `node:fs`. `setup` already returns `root`, `dir`, `input`, `ctx`, and `order`. `order` already records `cmd:<command>`. Do not wrap `commands.run`.

`show` returning `''` means the base has no tools. The phase's first `statusPorcelain` call is the clean-tree check and must return `''`.

```ts
function widgetManifest(root: string): void {
  mkdirSync(join(root, 'chocolate-tools'), { recursive: true });
  writeFileSync(join(root, 'chocolate-tools/manifest.md'), '## widget\nuse: u\ntest: node t.js\n');
}

it('reverts a tool whose test leaves the tree dirty and continues', async () => {
  let porcelainCalls = 0;
  const restored: string[] = [];
  const committed: string[] = [];
  const h = setup({
    toolboxGit: {
      show: async () => '',
      restoreTree: async (_root, _rev, path) => { restored.push(path); },
    },
    git: {
      statusPorcelain: async () => {
        porcelainCalls += 1;
        return porcelainCalls === 1 ? '' : ' M src/a.ts';
      },
      commitAll: async (_root, message) => { committed.push(message); },
    },
    results: { 'node t.js': [{ ok: true, output: '' }] },
  });
  widgetManifest(h.root);
  await runTestPhase(h.input, h.ctx);
  expect(h.order[0]).toBe('cmd:node t.js');
  expect(restored).toEqual(['chocolate-tools']);
  expect(committed).toContain('chore: revert toolbox');
  expect(readFileSync(join(h.dir, 'status.md'), 'utf8')).toContain('tool: reverted widget');
  expect(h.order).toContain('cmd:pnpm test');
});

it('reverts a tool whose test fails and still runs the plan', async () => {
  const restored: string[] = [];
  const h = setup({
    toolboxGit: {
      show: async () => '',
      restoreTree: async (_root, _rev, path) => { restored.push(path); },
    },
    results: { 'node t.js': [{ ok: false, output: 'no' }] },
  });
  widgetManifest(h.root);
  await runTestPhase(h.input, h.ctx);
  expect(restored).toEqual(['chocolate-tools']);
  expect(h.order.filter((item) => item === 'cmd:node t.js')).toHaveLength(1);
  expect(h.order).toContain('cmd:pnpm test');
});

it('keeps a tool whose test passes on a clean tree', async () => {
  const restored: string[] = [];
  const h = setup({
    toolboxGit: {
      show: async () => '',
      restoreTree: async (_root, _rev, path) => { restored.push(path); },
    },
    results: { 'node t.js': [{ ok: true, output: '' }] },
  });
  widgetManifest(h.root);
  await runTestPhase(h.input, h.ctx);
  expect(restored).toEqual([]);
  expect(readFileSync(join(h.dir, 'status.md'), 'utf8')).not.toContain('tool: reverted');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/engine/playbook/testPhase.test.ts`

Expected: FAIL because the tool command is not run first.

- [ ] **Step 3: Write minimal implementation**

In `runTestPhase`, after the clean-tree and branch checks and before `runUntilGreen`:

```ts
await runNewToolTest(ctx, dir);
```

```ts
async function runNewToolTest(ctx: PhaseContext, dir: string): Promise<void> {
  if (!ctx.toolboxGit) return;
  const base = readStatusValue(dir, 'base');
  const at = base?.lastIndexOf('@') ?? -1;
  if (!base || at < 0 || at === base.length - 1) return;
  const sha = base.slice(at + 1);
  const baseManifest = (await ctx.toolboxGit.show(ctx.repoRoot, sha, 'chocolate-tools/manifest.md')) ?? '';
  const manifestPath = join(ctx.repoRoot, 'chocolate-tools', 'manifest.md');
  if (!existsSync(manifestPath)) return;
  const headEntries = parseManifest(readFileSync(manifestPath, 'utf8'));
  const { added } = diffDirectories(
    parseManifest(baseManifest).map((entry) => entry.name),
    headEntries.map((entry) => entry.name),
  );
  if (added.length !== 1) return;
  const entry = headEntries.find((item) => item.name === added[0]);
  if (!entry || entry.test.trim() === '') return;
  const result = await ctx.commands.run(ctx.repoRoot, entry.test);
  appendOutput(dir, entry.test, result);
  const dirty = (await ctx.git.statusPorcelain(ctx.repoRoot)) !== '';
  if (result.ok && !dirty) return;
  await ctx.toolboxGit.restoreTree(ctx.repoRoot, sha, 'chocolate-tools');
  if ((await ctx.git.statusPorcelain(ctx.repoRoot)) !== '') {
    await ctx.git.commitAll(ctx.repoRoot, 'chore: revert toolbox');
  }
  appendStatus(dir, `- tool: reverted ${entry.name}`);
}
```

Import `parseManifest` and `diffDirectories` from `../toolbox.js`. `existsSync`, `readFileSync`, `appendStatus`, and `readStatusValue` are already imported or must be added. `appendOutput` already exists in this file.

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run tests/engine/playbook/testPhase.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/playbook/phases/testPhase.ts tests/engine/playbook/testPhase.test.ts
git commit -m "$(cat <<'EOF'
feat: run a new toolbox test once and drop it when it fails

EOF
)"
```

---

### Task 6: Reflect a finished playbook attempt

**Files:**
- Create: `src/engine/playbook/reflect.ts`
- Test: `tests/engine/playbook/reflect.test.ts`

**Interfaces:**
- Consumes: `PLAYBOOK_FILES`, `WorkerPort`, `appendStatus`, `attemptDir`, `RunRecord`
- Produces:
  - `export function lineChange(before: string, after: string): { added: number; deleted: number }`
  - `export function judgePlaybooks(snapshot: Readonly<Record<string, string>>, proposed: Readonly<Record<string, string>>): { ok: true; files: Record<string, string> } | { ok: false; reason: string }`
  - `export interface PlaybookPublisher { publish(input: { factoryRoot: string; runId: string; files: Record<string, string>; body: string }): Promise<string> }`
  - `export function makeReflector(deps: { workers: WorkerPort; publisher: PlaybookPublisher; snapshot: Record<string, string>; factoryRoot: string; repoRoot: string; isRepo: (root: string) => Promise<boolean> }): (run: RunRecord) => Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/engine/playbook/reflect.test.ts` with this file:

```ts
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { judgePlaybooks, makeReflector } from '../../../src/engine/playbook/reflect.js';
import { attemptDir } from '../../../src/engine/playbook/runFolder.js';
import type { RunRecord } from '../../../src/domain/types.js';
import type { WorkerTask } from '../../../src/engine/playbook/ports.js';

const before = 'a\n';
const replaced = 'b\n';

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1', contractId: 'c', contractRevision: 'r', issue: null,
    phase: 'commit', state: 'commit-ready', currentAttempt: 1,
    execPlanRef: 'p', createdAt: 't', flow: 'feature', engine: 'playbook',
    ...over,
  };
}

describe('judgePlaybooks', () => {
  it('discards an empty, growing, oversized, or outside diff', () => {
    expect(judgePlaybooks({ 'spec.md': before }, { 'spec.md': before })).toEqual({ ok: false, reason: 'empty' });
    expect(judgePlaybooks({ 'spec.md': before }, { 'spec.md': 'a\nb\n' })).toEqual({ ok: false, reason: 'grows' });
    expect(judgePlaybooks({ 'spec.md': before }, { 'spec.md': replaced })).toEqual({ ok: true, files: { 'spec.md': replaced } });
    const many = (prefix: string) => Array.from({ length: 21 }, (_, i) => `${prefix}${i}`).join('\n') + '\n';
    expect(judgePlaybooks({ 'spec.md': many('a') }, { 'spec.md': many('b') })).toEqual({ ok: false, reason: 'over-cap' });
    expect(judgePlaybooks({ 'spec.md': before }, { 'evil.md': 'x\n' })).toEqual({ ok: false, reason: 'outside' });
  });
});

describe('makeReflector', () => {
  it('opens one pull request and does not repeat it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-reflect-'));
    const dir = attemptDir(root, 'run-1', 1);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'status.md'), '- phase: commit\n');
    writeFileSync(join(dir, 'brief.md'), 'brief\n');
    const prompts: string[] = [];
    const published: Record<string, string>[] = [];
    const reflect = makeReflector({
      repoRoot: root,
      factoryRoot: root,
      snapshot: { 'spec.md': before },
      isRepo: async () => true,
      workers: { async run(task: WorkerTask) {
        prompts.push(task.prompt);
        mkdirSync(join(task.runDir, 'reflect-playbooks'), { recursive: true });
        writeFileSync(join(task.runDir, 'reflect.md'), 'REASON: tighten\nDROP: none\n');
        writeFileSync(join(task.runDir, 'reflect-playbooks/spec.md'), replaced);
        return { status: 'done', filesChanged: [], notes: '', route: 'default' };
      } },
      publisher: { async publish(input) { published.push(input.files); return 'https://example.test/pr/1'; } },
    });
    await reflect(run());
    expect(prompts[0]).not.toContain('evaluateGate');
    expect(published).toEqual([{ 'spec.md': replaced }]);
    expect(readFileSync(join(dir, 'status.md'), 'utf8')).toContain('reflect: pr https://example.test/pr/1');
    await reflect(run());
    expect(published).toHaveLength(1);
  });

  it('discards a blocked worker, a missing repo, a simulator run, and a publish error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-reflect-'));
    const dir = attemptDir(root, 'run-1', 1);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'status.md'), '- phase: commit\n');
    let calls = 0;
    const reflect = makeReflector({
      repoRoot: root,
      factoryRoot: root,
      snapshot: { 'spec.md': before },
      isRepo: async () => true,
      workers: { async run() { calls += 1; return { status: 'blocked', filesChanged: [], notes: '', route: 'default' }; } },
      publisher: { async publish() { throw new Error('publish-branch-exists'); } },
    });
    await expect(reflect(run())).resolves.toBeUndefined();
    expect(readFileSync(join(dir, 'status.md'), 'utf8')).toContain('reflect: discarded worker-blocked');
    writeFileSync(join(dir, 'status.md'), '- phase: commit\n');
    const skipped = makeReflector({
      repoRoot: root,
      factoryRoot: root,
      snapshot: {},
      isRepo: async () => false,
      workers: { async run() { calls += 1; return { status: 'done', filesChanged: [], notes: '', route: 'default' }; } },
      publisher: { async publish() { return 'nope'; } },
    });
    await skipped(run());
    expect(readFileSync(join(dir, 'status.md'), 'utf8')).toContain('reflect: skipped');
    const beforeCalls = calls;
    await skipped(run({ engine: 'simulator' }));
    expect(calls).toBe(beforeCalls);
  });
});
```

The blocked-worker case must not reach the publisher. Add one more test in the same file where the worker returns `done`, writes a one-line replacement, and the publisher throws `publish-branch-exists`. Assert the status line `reflect: discarded publish-branch-exists` and that the function resolves.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/engine/playbook/reflect.test.ts`

Expected: FAIL because `reflect.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/engine/playbook/reflect.ts` with `lineChange`, `judgePlaybooks`, `PlaybookPublisher`, and `makeReflector`.

`lineChange` splits with the same trailing-empty-line rule as `textLines` in `toolbox.ts`. It counts multiset additions and deletions.

`judgePlaybooks` allows only `PLAYBOOK_FILES`. Identical files are skipped. Sum the line changes. Reasons are exactly `outside`, `empty`, `over-cap`, and `grows`, in that precedence: an outside path returns immediately; then empty; then `added + deleted > 40`; then `added > deleted`.

`makeReflector` returns an async function:

1. Return when `run.engine !== 'playbook'`.
2. Return when `run.state` is not `commit-ready` or `failed`.
3. `dir = attemptDir(deps.repoRoot, run.id, run.currentAttempt)`.
4. Return when `status.md` is missing.
5. Return when any status line starts with `- reflect:`.
6. When `isRepo(factoryRoot)` is false, append `- reflect: skipped` and return without calling the worker.
7. Build the prompt from existing files among `brief.md`, `plan.md`, `implement.md`, `status.md`, every `review-*.md`, and `pr.md`. Each block is the path and the file text. Tell the worker to write `reflect.md` with `REASON:` and `DROP:` and to write changed playbooks under `reflect-playbooks/` using the six file names. Dispatch `role: 'default'`, `unitId: 'reflect'`, `allowedFiles: ['reflect.md']`.
8. When `report.status !== 'done'`, append `- reflect: discarded worker-<status>` and return.
9. Read `reflect-playbooks/*.md` into a record keyed by file name. Parse `REASON:` from `reflect.md`, default `''`.
10. `judgePlaybooks`. On failure append `- reflect: discarded <reason>`.
11. On success `const url = await publisher.publish({ factoryRoot, runId: run.id, files, body: reason })` and append `- reflect: pr <url>`.
12. Wrap steps 7 through 11 in try/catch. On throw, append `- reflect: discarded <message>` when the message starts with `publish-`, otherwise `- reflect: discarded publish-<message>`. Never rethrow.

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run tests/engine/playbook/reflect.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/playbook/reflect.ts tests/engine/playbook/reflect.test.ts
git commit -m "$(cat <<'EOF'
feat: reflect a finished playbook run into a capped diff

EOF
)"
```

---

### Task 7: Publish the playbook pull request and hook the run

**Files:**
- Create: `src/engine/playbook/playbookPublisher.ts`
- Modify: `src/runs/runService.ts`
- Modify: `src/server/server.ts`
- Test: `tests/engine/playbook/playbookPublisher.test.ts`
- Test: `tests/runs/runService.test.ts`

**Interfaces:**
- Consumes: `PlaybookPublisher` from Task 6, `makeReflector`, `factoryRoot`, `loadPlaybookSnapshot`, `playbookDir`, `GitCli`
- Produces:
  - `export function createPlaybookPublisher(options?: { runGh?: (args: string[], cwd: string) => Promise<string> }): PlaybookPublisher`
  - `RunService` deps gain `onTerminal?: (run: RunRecord) => Promise<void>`
  - `onTerminal` is awaited only when a playbook run transitions to `failed` or `commit-ready`. An already-terminal `advance` does not call it. A throw is swallowed. Simulator runs do not call it.
  - `startServer` passes `toolboxGit: git`, `onTerminal: makeReflector({ workers, publisher: createPlaybookPublisher(), snapshot, factoryRoot: factoryRoot(), isRepo: (root) => git.isRepo(root), repoRoot })`

- [ ] **Step 1: Write the failing tests**

`tests/engine/playbook/playbookPublisher.test.ts`:

- Init a temp git repo on `main` with `user.email` and `user.name`, commit `src/engine/playbooks/spec.md` containing `a\n`, and the other five playbook files so a later write has a parent directory.
- Create a bare repo and `git remote add origin` that bare path. Push main.
- Stay on `main`.
- `createPlaybookPublisher({ runGh })` where `runGh` records args and cwd and returns `https://example.test/pr/9\n`.
- Publish `{ files: { 'spec.md': 'b\n' }, body: 'tighten', runId: 'run-1', factoryRoot: root }`.
- Expect the returned URL, `runGh` args to include `pr`, `create`, `--title`, `playbook: run-1`, and not to include `--force`.
- Expect `git -C root branch --show-current` to still be `main`.
- Expect the worktree directory to be gone.
- Expect the bare repo to contain branch `playbook/run-1` whose `spec.md` is `b\n`.
- A second publish with the same run id rejects with a message that starts with `publish-branch-exists`.

`tests/runs/runService.test.ts` add:

```ts
it('calls onTerminal once when a playbook run fails and not for the simulator', async () => {
  const seen: string[] = [];
  const files = {
    load: () => ({
      contracts: [contract],
      invalidContracts: [],
      roadmap: { milestones: [{ id: 'm1', title: 'M1', intent: 'x', contracts: ['feat-a'] }] },
      roadmapError: null,
      config: { ...DEFAULT_CONFIG, workers: { default: { command: ['node'] }, implement: { command: ['node'] } } },
      crossRefErrors: [],
    }),
    readContractFile: () => 'rev',
    saveContract: () => 'rev2',
  };
  const engine = { runPhase: async () => { throw new Error('boom'); } };
  const playbook = new RunService({
    store,
    engine,
    files,
    config: files.load().config,
    repoRoot: root,
    onTerminal: async (run) => { seen.push(run.state); },
  });
  const run = playbook.claim({ issue: null, contract, contractRevision: 'rev1', engine: 'playbook' });
  const failed = await playbook.advance(run.id);
  expect(failed.state).toBe('failed');
  expect(seen).toEqual(['failed']);
  await playbook.advance(run.id);
  expect(seen).toEqual(['failed']);
});
```

Use a fresh store for this test so `beforeEach`'s simulator service is not required. A simulator claim whose engine throws, with the same `onTerminal`, expects `seen` to stay empty. Put that in the same test or a second test. The throwing engine must satisfy `RunEngine`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/engine/playbook/playbookPublisher.test.ts tests/runs/runService.test.ts`

Expected: FAIL because `createPlaybookPublisher` does not exist and `onTerminal` is not accepted.

- [ ] **Step 3: Write minimal implementation**

Create `src/engine/playbook/playbookPublisher.ts` exporting `createPlaybookPublisher`. Use `execFile` for git. Do not pass a shell string.

- If `git show-ref --verify --quiet refs/heads/playbook/<runId>` succeeds, throw `new Error('publish-branch-exists')`.
- Resolve the base with `git symbolic-ref --short refs/remotes/origin/HEAD`, strip a leading `origin/`, and use `main` when that command fails.
- `git worktree add -b playbook/<runId> <worktree> <base>`.
- Write each file to `<worktree>/src/engine/playbooks/<name>`, ensuring a trailing newline.
- `git add src/engine/playbooks`, `git commit -m "playbook: reflect <runId>"`, `git push -u origin HEAD`.
- `gh pr create --title "playbook: <runId>" --body-file <worktree>/pr-body.md`.
- `finally`: `git worktree remove --force <worktree>` when the worktree was added. Ignore removal errors.
- Wrap non-`publish-*` errors as `publish-<message>`.

In `RunService`, add `onTerminal?: (run: RunRecord) => Promise<void>` to the constructor deps. Add:

```ts
private async terminal(runId: string): Promise<RunRecord> {
  const run = this.mustRun(runId);
  if ((run.state === 'failed' || run.state === 'commit-ready') && run.engine === 'playbook' && this.deps.onTerminal) {
    try {
      await this.deps.onTerminal(run);
    } catch {
      // The reflector records its own failure.
    }
  }
  return this.mustRun(runId);
}
```

Call `return this.terminal(runId)` only on the paths that have just set `failed` or `commit-ready`: missing contract, phase throw, hard-gate reject, commit approve, and `moveToNextPhase` when the returned state is `commit-ready`. The early return for an already terminal run stays `return run` and does not call `terminal`.

In `startServer`, create one `GitCli`, pass it as `git` and `toolboxGit`, load the snapshot with `loadPlaybookSnapshot(playbookDir())`, and pass `onTerminal` as specified in the interfaces. Keep `readPlaybook: () => ''` if `PhaseContext` still requires the field.

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run tests/engine/playbook/playbookPublisher.test.ts tests/runs/runService.test.ts && pnpm test`

Expected: PASS, including the full suite.

- [ ] **Step 5: Commit**

```bash
git add src/engine/playbook/playbookPublisher.ts src/runs/runService.ts src/server/server.ts tests/engine/playbook/playbookPublisher.test.ts tests/runs/runService.test.ts
git commit -m "$(cat <<'EOF'
feat: open a playbook pull request when a playbook run finishes

EOF
)"
```
