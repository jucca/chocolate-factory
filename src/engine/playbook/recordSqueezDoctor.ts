import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqueezDoctor, SqueezDoctorStatus } from './ports.js';
import { appendStatus, readStatusValue } from './runFolder.js';

export async function recordSqueezDoctor(dir: string, probe: SqueezDoctor): Promise<void> {
  if (readStatusValue(dir, 'squeez-doctor') !== null) return;
  let status: SqueezDoctorStatus = 'unavailable';
  let output = '';
  try {
    const report = await probe.doctor();
    status = report.status;
    output = report.output;
  } catch (err) {
    status = 'unavailable';
    output = err instanceof Error ? err.message : String(err);
  }
  writeFileSync(join(dir, 'squeez-doctor.txt'), output);
  appendStatus(dir, `- squeez-doctor: ${status}`);
}