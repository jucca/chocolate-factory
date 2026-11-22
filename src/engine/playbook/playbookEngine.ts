import type { Flow } from '../../domain/types.js';
import type { PhaseInput, PhaseOutput, RunEngine } from '../runEngine.js';
import { runCommitPhase } from './phases/commitPhase.js';
import { runImplementPhase } from './phases/implementPhase.js';
import { runPlanPhase } from './phases/planPhase.js';
import { runSpecPhase, type PhaseContext } from './phases/specPhase.js';
import { runTestPhase } from './phases/testPhase.js';
import { runVerifyPhase } from './phases/verifyPhase.js';
import { loadPlaybookSnapshot, playbookDir } from './playbookSnapshot.js';
import { recordSqueezDoctor } from './recordSqueezDoctor.js';
import { ensureAttempt } from './runFolder.js';

export class PlaybookRunEngine implements RunEngine {
  private snapshot: Record<string, string>;

  constructor(private ctx: PhaseContext, options?: { playbookDirectory?: string }) {
    this.snapshot = loadPlaybookSnapshot(options?.playbookDirectory ?? playbookDir());
  }

  playbook(name: string): string {
    return this.snapshot[name] ?? '';
  }

  async runPhase(input: PhaseInput): Promise<PhaseOutput> {
    const run = this.ctx.store.getRun(input.runId);
    if (!run) throw new Error(`unknown run ${input.runId}`);
    const dir = ensureAttempt(this.ctx.repoRoot, input.runId, input.attempt);
    await recordSqueezDoctor(dir, this.ctx.squeez);
    const flow: Flow = run.flow;
    const readPlaybook = (name: string) => this.playbook(name);
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