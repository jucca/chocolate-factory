import type { PhaseInput, PhaseOutput, RunEngine } from '../runEngine.js';
import type { SqliteRunStore } from '../../store/runStore.js';

export class DispatchRunEngine implements RunEngine {
  constructor(private deps: { store: SqliteRunStore; simulator: RunEngine; playbook: RunEngine }) {}

  runPhase(input: PhaseInput): Promise<PhaseOutput> {
    const engine = this.deps.store.getRun(input.runId)?.engine === 'playbook' ? this.deps.playbook : this.deps.simulator;
    return engine.runPhase(input);
  }
}
