import { execFile } from 'node:child_process';
import type { SqueezDoctor, SqueezDoctorReport } from './ports.js';

const DEFAULT_COMMAND = ['squeez', 'doctor'];
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

export class ProcessSqueezDoctor implements SqueezDoctor {
  private readonly command: string[];
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;

  constructor(options: { command?: string[]; timeoutMs?: number; maxBuffer?: number } = {}) {
    this.command = options.command ?? DEFAULT_COMMAND;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  }

  doctor(): Promise<SqueezDoctorReport> {
    const [bin, ...args] = this.command;
    return new Promise((resolve) => {
      if (!bin) {
        resolve({ status: 'unavailable', output: 'missing command' });
        return;
      }
      execFile(bin, args, { timeout: this.timeoutMs, maxBuffer: this.maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : '';
        const errText = typeof stderr === 'string' ? stderr : '';
        const text = out + errText;
        if (!err) {
          resolve({ status: 'ok', output: text });
          return;
        }
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES') {
          resolve({ status: 'unavailable', output: err.message });
          return;
        }
        if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          resolve({ status: 'failed', output: `squeez doctor report exceeded ${this.maxBuffer} bytes` });
          return;
        }
        const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
        if (killed) {
          resolve({ status: 'failed', output: `squeez doctor timed out after ${this.timeoutMs}ms` });
          return;
        }
        if (typeof code === 'number') {
          resolve({ status: 'failed', output: text === '' ? `squeez doctor exited ${code}` : text });
          return;
        }
        resolve({ status: 'unavailable', output: err.message });
      });
    });
  }
}