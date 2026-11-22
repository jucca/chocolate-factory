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