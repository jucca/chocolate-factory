import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, dirname, join, resolve } from 'node:path';

export interface CursorWorkerSpawn {
  (input: { bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }): Promise<{
    code: number | null;
    error: NodeJS.ErrnoException | null;
  }>;
}

const STATUS_LINE = /^STATUS: (done|partial|blocked)$/m;

function resolveAgainst(cwd: string, value: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

export async function runCursorWorker(input: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  spawnAgent: CursorWorkerSpawn;
}): Promise<number> {
  const repoValue = input.env.CHOCOLATE_REPO;
  const repo = repoValue ? resolveAgainst(input.cwd, repoValue) : input.cwd;
  const promptArg = input.argv.length === 0 ? undefined : input.argv[input.argv.length - 1];
  if (!promptArg) {
    process.stderr.write('usage: chocolate-cursor-worker <prompt-file>\n');
    return 1;
  }
  const promptPath = resolveAgainst(input.cwd, promptArg);
  const runValue = input.env.CHOCOLATE_RUN_DIR;
  const reportDir = runValue ? resolveAgainst(input.cwd, runValue) : dirname(promptPath);
  const reportPath = join(reportDir, 'worker-report.md');

  let promptText: string;
  try {
    promptText = readFileSync(promptPath, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeFileSync(reportPath, `STATUS: blocked\nprompt unreadable: ${message}\n`);
    return 0;
  }

  try {
    unlinkSync(reportPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }

  const agentBin = input.env.CHOCOLATE_AGENT_BIN || 'agent';
  const forwarded = input.argv.slice(0, -1);
  const result = await input.spawnAgent({
    bin: agentBin,
    cwd: repo,
    env: input.env,
    args: [
      ...forwarded,
      '-p', '--force', '--trust', '--sandbox', 'disabled', '--output-format', 'text',
      '--workspace', repo,
      promptText,
    ],
  });

  if (existsReport(reportPath)) return 0;

  if (result.error) {
    writeFileSync(reportPath, `STATUS: blocked\nagent spawn failed: ${result.error.message}\n`);
    return 0;
  }
  if (result.code === 0) {
    writeFileSync(reportPath, 'STATUS: done\n');
    return 0;
  }
  const codeText = result.code === null ? 'null' : String(result.code);
  writeFileSync(reportPath, `STATUS: blocked\nagent exited ${codeText}\n`);
  return 0;
}

function existsReport(path: string): boolean {
  try {
    return STATUS_LINE.test(readFileSync(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}