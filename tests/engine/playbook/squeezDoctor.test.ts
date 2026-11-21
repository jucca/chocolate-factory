import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SqueezDoctor, SqueezDoctorReport } from '../../../src/engine/playbook/ports.js';
import { ProcessSqueezDoctor } from '../../../src/engine/playbook/processSqueezDoctor.js';
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

describe('ProcessSqueezDoctor', () => {
  it('returns ok and concatenates stdout and stderr', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-squeez-bin-'));
    const script = join(root, 'doctor.mjs');
    writeFileSync(script, "process.stdout.write('OUT'); process.stderr.write('ERR');\n");
    const report = await new ProcessSqueezDoctor({ command: [process.execPath, script] }).doctor();
    expect(report).toEqual({ status: 'ok', output: 'OUTERR' });
  });

  it('returns failed with the exit line when the capture is empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-squeez-bin-'));
    const script = join(root, 'doctor.mjs');
    writeFileSync(script, 'process.exit(3);\n');
    const report = await new ProcessSqueezDoctor({ command: [process.execPath, script] }).doctor();
    expect(report).toEqual({ status: 'failed', output: 'squeez doctor exited 3' });
  });

  it('returns unavailable when the executable is missing', async () => {
    const report = await new ProcessSqueezDoctor({ command: ['/this/squeez/does/not/exist'] }).doctor();
    expect(report.status).toBe('unavailable');
    expect(report.output).toContain('ENOENT');
  });

  it('returns failed with the timeout line when the process exceeds the limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-squeez-bin-'));
    const script = join(root, 'doctor.mjs');
    writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    const report = await new ProcessSqueezDoctor({
      command: [process.execPath, script],
      timeoutMs: 200,
    }).doctor();
    expect(report).toEqual({ status: 'failed', output: 'squeez doctor timed out after 200ms' });
  });

  it('returns failed with the size line when output exceeds maxBuffer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-squeez-bin-'));
    const script = join(root, 'doctor.mjs');
    writeFileSync(script, "process.stdout.write('x'.repeat(50));\n");
    const report = await new ProcessSqueezDoctor({
      command: [process.execPath, script],
      maxBuffer: 20,
    }).doctor();
    expect(report).toEqual({ status: 'failed', output: 'squeez doctor report exceeded 20 bytes' });
  });
});