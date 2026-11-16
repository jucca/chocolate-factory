import { describe, expect, it } from 'vitest';
import { buildWaves, parseAcceptanceIds, parsePlan, topLevelDirs } from '../../../src/engine/playbook/planDoc.js';

function table(rows: string[][]): string {
  const header = '| ID | Goal | Files (create/modify) | Depends on | Verify with |';
  const rule = '| --- | --- | --- | --- | --- |';
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
  return `${header}\n${rule}\n${body}\n`;
}

const TWO_UNITS = `
See U9 mentioned in prose, not as a row.
${table([
  ['U1', 'add a', 'new:src/a.ts, src/b.ts', '-', 'pnpm test src/a.test.ts'],
  ['U2', 'add c', 'src/c.ts', 'U1', 'pnpm test src/c.test.ts'],
])}
`;

describe('parsePlan', () => {
  it('reads a two-unit table and keeps the new: prefix', () => {
    expect(parsePlan(TWO_UNITS)).toEqual([
      {
        id: 'U1',
        goal: 'add a',
        files: ['new:src/a.ts', 'src/b.ts'],
        dependsOn: [],
        verify: 'pnpm test src/a.test.ts',
      },
      {
        id: 'U2',
        goal: 'add c',
        files: ['src/c.ts'],
        dependsOn: ['U1'],
        verify: 'pnpm test src/c.test.ts',
      },
    ]);
  });

  it('treats an empty depends cell as none and splits commas', () => {
    const units = parsePlan(table([
      ['U1', 'add a', 'new:src/a.ts', '', 'pnpm test a'],
      ['U2', 'add b', 'src/b.ts', 'U1, U3', 'pnpm test b'],
    ]));
    expect(units[0].dependsOn).toEqual([]);
    expect(units[1].dependsOn).toEqual(['U1', 'U3']);
  });
});

describe('buildWaves', () => {
  it('places a unit only after its dependency', () => {
    expect(buildWaves(parsePlan(TWO_UNITS)).map((wave) => wave.map((unit) => unit.id))).toEqual([['U1'], ['U2']]);
  });

  it('keeps independent units that touch different files in one wave, in id order', () => {
    const units = parsePlan(table([
      ['U2', 'b', 'src/b.ts', '-', 'pnpm test b'],
      ['U1', 'a', 'src/a.ts', '-', 'pnpm test a'],
    ]));
    expect(buildWaves(units).map((wave) => wave.map((unit) => unit.id))).toEqual([['U1', 'U2']]);
  });

  it('moves the later id to the next wave when two units share a file', () => {
    const units = parsePlan(table([
      ['U2', 'second', 'src/a.ts', '-', 'pnpm test b'],
      ['U1', 'first', 'new:src/a.ts', '-', 'pnpm test a'],
    ]));
    expect(buildWaves(units).map((wave) => wave.map((unit) => unit.id))).toEqual([['U1'], ['U2']]);
  });

  it('moves each later id into its own wave when three units share a file', () => {
    const units = parsePlan(table([
      ['U3', 'c', 'src/a.ts', '-', 'pnpm test c'],
      ['U1', 'a', 'new:src/a.ts', '-', 'pnpm test a'],
      ['U2', 'b', 'src/a.ts', '-', 'pnpm test b'],
    ]));
    expect(buildWaves(units).map((wave) => wave.map((unit) => unit.id))).toEqual([['U1'], ['U2'], ['U3']]);
  });

  it('compares unit ids numerically so U10 is later than U2', () => {
    const units = parsePlan(table([
      ['U10', 'later', 'src/a.ts', '-', 'pnpm test later'],
      ['U2', 'earlier', 'src/a.ts', '-', 'pnpm test earlier'],
    ]));
    expect(buildWaves(units).map((wave) => wave.map((unit) => unit.id))).toEqual([['U2'], ['U10']]);
  });

  it('throws when U1 and U2 depend on each other', () => {
    const units = parsePlan(table([
      ['U1', 'a', 'src/a.ts', 'U2', 'pnpm test a'],
      ['U2', 'b', 'src/b.ts', 'U1', 'pnpm test b'],
    ]));
    expect(() => buildWaves(units)).toThrow(/cycle/);
  });
});

describe('parseAcceptanceIds', () => {
  it('returns AC1 and AC2 from acceptance lines', () => {
    const markdown = [
      '- AC1: The inbox lists the issue',
      '- note: not an id',
      '- AC2: The inbox filters by label',
    ].join('\n');
    expect(parseAcceptanceIds(markdown)).toEqual(['AC1', 'AC2']);
  });
});

describe('topLevelDirs', () => {
  it('returns the first path segment of each file token', () => {
    expect(topLevelDirs('see src/a.ts and web/src/b.tsx')).toEqual(['src', 'web']);
  });

  it('returns each directory once, in first-seen order', () => {
    expect(topLevelDirs('web/a.ts then src/b.ts then web/c.ts and src/a.test.ts')).toEqual(['web', 'src']);
  });
});
