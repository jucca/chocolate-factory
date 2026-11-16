export interface WorkUnit {
  id: string;
  goal: string;
  files: string[];
  dependsOn: string[];
  verify: string;
}

export function parsePlan(markdown: string): WorkUnit[] {
  const units: WorkUnit[] = [];
  for (const line of markdown.split('\n')) {
    const cells = tableCells(line);
    if (cells.length < 5 || !/^U\d+$/.test(cells[0])) continue;
    units.push({
      id: cells[0],
      goal: cells[1],
      files: splitList(cells[2]),
      dependsOn: splitList(cells[3]),
      verify: cells[4],
    });
  }
  return units;
}

export function parseAcceptanceIds(markdown: string): string[] {
  const ids: string[] = [];
  for (const line of markdown.split('\n')) {
    const match = line.match(/^- (AC\d+):/);
    if (match) ids.push(match[1]);
  }
  return ids;
}

export function topLevelDirs(text: string): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/[\w.@+-]+(?:\/[\w.@+-]+)+/g)) {
    const dir = match[0].split('/')[0];
    if (seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

export function buildWaves(units: WorkUnit[]): WorkUnit[][] {
  let pending = [...units];
  const placed = new Set<string>();
  const waves: WorkUnit[][] = [];
  while (pending.length > 0) {
    const ready = pending
      .filter((unit) => unit.dependsOn.every((dep) => placed.has(dep)))
      .sort((a, b) => unitNumber(a.id) - unitNumber(b.id));
    if (ready.length === 0) throw new Error('cycle in work units');
    const wave: WorkUnit[] = [];
    const paths = new Set<string>();
    for (const unit of ready) {
      const files = unit.files.map(stripNew);
      if (files.some((file) => paths.has(file))) continue;
      wave.push(unit);
      for (const file of files) paths.add(file);
    }
    if (wave.length === 0) throw new Error('cycle in work units');
    for (const unit of wave) placed.add(unit.id);
    const chosen = new Set(wave.map((unit) => unit.id));
    pending = pending.filter((unit) => !chosen.has(unit.id));
    waves.push(wave);
  }
  return waves;
}

function tableCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return [];
  const cells = trimmed.split('|').map((cell) => cell.trim());
  if (cells[0] === '') cells.shift();
  if (cells[cells.length - 1] === '') cells.pop();
  return cells;
}

function splitList(cell: string): string[] {
  if (cell === '' || cell === '-') return [];
  return cell.split(',').map((part) => part.trim()).filter((part) => part !== '' && part !== '-');
}

function stripNew(file: string): string {
  return file.startsWith('new:') ? file.slice(4) : file;
}

function unitNumber(id: string): number {
  const match = /^U(\d+)$/.exec(id);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}
