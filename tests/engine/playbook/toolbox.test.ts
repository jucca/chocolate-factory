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