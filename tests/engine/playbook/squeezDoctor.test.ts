import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SqueezDoctor, SqueezDoctorReport } from '../../../src/engine/playbook/ports.js';
import { recordSqueezDoctor } from '../../../src/engine/playbook/recordSqueezDoctor.js';
import { ensureAttempt } from '../../../src/engine/playbook/runFolder.js';

function attempt(): string {
  const root = mkdtempSync(join(tmpdir(), 'cf-squeez-'));
  return ensureAttempt(root, 'run-1', 1);
}

function probe(report: SqueezDoctorReport, calls: { n: number }): SqueezDoctor {
  return {
    async doctor() {
      calls.n += 1;
      return report;
    },
  };
}

describe('recordSqueezDoctor', () => {
  it('writes the status line and the report on the first call', async () => {
    const dir = attempt();
    const calls = { n: 0 };
    await recordSqueezDoctor(dir, probe({ status: 'ok', output: 'hooks ok' }, calls));
    expect(calls.n).toBe(1);
    expect(readFileSync(join(dir, 'status.md'), 'utf8')).toContain('- squeez-doctor: ok\n');
    expect(readFileSync(join(dir, 'squeez-doctor.txt'), 'utf8')).toBe('hooks ok');
  });

  it('does not call the probe again when the status line exists', async () => {
    const dir = attempt();
    const calls = { n: 0 };
    const doctor = probe({ status: 'failed', output: 'FAIL hooks' }, calls);
    await recordSqueezDoctor(dir, doctor);
    rmSync(join(dir, 'squeez-doctor.txt'));
    await recordSqueezDoctor(dir, doctor);
    expect(calls.n).toBe(1);
    expect(readFileSync(join(dir, 'status.md'), 'utf8')).toContain('- squeez-doctor: failed\n');
  });

  it('writes unavailable when the probe throws', async () => {
    const dir = attempt();
    const doctor: SqueezDoctor = {
      async doctor() {
        throw new Error('probe exploded');
      },
    };
    await recordSqueezDoctor(dir, doctor);
    expect(readFileSync(join(dir, 'status.md'), 'utf8')).toContain('- squeez-doctor: unavailable\n');
    expect(readFileSync(join(dir, 'squeez-doctor.txt'), 'utf8')).toBe('probe exploded');
  });

  it('records each status value on its own line', async () => {
    for (const status of ['ok', 'failed', 'unavailable'] as const) {
      const dir = attempt();
      await recordSqueezDoctor(dir, probe({ status, output: status }, { n: 0 }));
      expect(readFileSync(join(dir, 'status.md'), 'utf8')).toContain(`- squeez-doctor: ${status}\n`);
    }
  });
});