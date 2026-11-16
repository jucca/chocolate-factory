import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Flow } from '../../domain/types.js';
import type { PhaseInput, PhaseOutput, RunEngine } from '../runEngine.js';
import { runCommitPhase } from './phases/commitPhase.js';
import { runImplementPhase } from './phases/implementPhase.js';
import { runPlanPhase } from './phases/planPhase.js';
import { runSpecPhase, type PhaseContext } from './phases/specPhase.js';
import { runTestPhase } from './phases/testPhase.js';
import { runVerifyPhase } from './phases/verifyPhase.js';

function readPlaybook(name: string): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'playbooks', name), 'utf8');
}

export class PlaybookRunEngine implements RunEngine {
  constructor(private ctx: PhaseContext) {}

  async runPhase(input: PhaseInput): Promise<PhaseOutput> {
    const run = this.ctx.store.getRun(input.runId);
    if (!run) throw new Error(`unknown run ${input.runId}`);
    const flow: Flow = run.flow;
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
