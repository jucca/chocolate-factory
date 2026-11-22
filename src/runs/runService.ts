import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Contract, EngineKind, FactoryConfig, Flow, GateId, IssueRef, Phase, RunRecord } from '../domain/types.js';
import { GATE_KIND, PHASES } from '../domain/types.js';
import type { SqliteRunStore } from '../store/runStore.js';
import { evaluateGate } from '../gates/gateEvaluator.js';
import type { RunEngine } from '../engine/runEngine.js';
import { attemptDir, openQuestionBullets, recordAnswers } from '../engine/playbook/runFolder.js';
import type { ChocolateData } from '../files/chocolateFiles.js';
import { appendExecPlanLog, writeExecPlan } from './execPlan.js';

export class HardGateOverrideError extends Error {
  constructor(gate: GateId) {
    super(`hard gate ${gate} cannot be overridden`);
  }
}
export class OverrideReasonRequiredError extends Error {
  constructor() {
    super('override requires a recorded reason');
  }
}
export class PlaybookClaimError extends Error {
  constructor() { super('playbook claim requires a non-empty worker command for workers.default.command and workers.implement.command'); }
}
export class OpenQuestionsError extends Error {
  constructor() { super('spec approval requires answers to open questions'); }
}
export interface FilesPort {
  load(): ChocolateData;
  readContractFile(contractId: string): string;
  saveContract(c: Contract): string;
}

const GATE_AFTER_PHASE: Partial<Record<Phase, GateId>> = { spec: 'spec', plan: 'plan', verify: 'verify', commit: 'commit' };
const now = () => new Date().toISOString();

export class RunService {
  private advancing = new Map<string, Promise<RunRecord>>();
  constructor(private deps: {
    store: SqliteRunStore;
    engine: RunEngine;
    files: FilesPort;
    config: FactoryConfig;
    repoRoot: string;
    onTerminal?: (run: RunRecord) => Promise<void>;
  }) {}

  claim(input: { issue: IssueRef | null; contract: Contract; contractRevision: string; flow?: Flow; engine?: EngineKind }): RunRecord {
    const active = this.deps.store.listRunsByContract(input.contract.id).find((r) => r.state !== 'commit-ready' && r.state !== 'failed');
    if (active) return active;
    const flow = input.flow ?? 'feature';
    const engine = input.engine ?? 'simulator';
    if (engine === 'playbook') {
      const defaultCommand = this.deps.config.workers?.default?.command;
      const implementCommand = this.deps.config.workers?.implement?.command;
      if (!defaultCommand?.length || !implementCommand?.length) throw new PlaybookClaimError();
    }
    const id = `run-${randomUUID().slice(0, 8)}`;
    const run = this.deps.store.createRun({
      id,
      contractId: input.contract.id,
      contractRevision: input.contractRevision,
      issue: input.issue,
      phase: 'spec',
      state: 'running',
      currentAttempt: 1,
      execPlanRef: `.chocolate/exec-plans/${id}.md`,
      flow,
      engine,
    });
    this.deps.store.appendEvent({
      runId: id,
      attempt: 1,
      type: 'run_claimed',
      phase: 'spec',
      message: `claimed from ${input.issue ? `issue #${input.issue.number}` : 'manual contract'}`,
      createdAt: now(),
      data: {},
    });
    writeExecPlan(this.deps.repoRoot, run, input.contract);
    return run;
  }

  advance(runId: string): Promise<RunRecord> {
    const current = this.advancing.get(runId);
    if (current) return current;
    const promise = this.advanceRun(runId).finally(() => {
      this.advancing.delete(runId);
    });
    this.advancing.set(runId, promise);
    return promise;
  }

  private async advanceRun(runId: string): Promise<RunRecord> {
    let run = this.mustRun(runId);
    if (run.state === 'commit-ready' || run.state === 'failed' || run.state === 'awaiting-decision') return run;

    while (run.state === 'running') {
      const data = this.deps.files.load();
      let contract = data.contracts.find((c) => c.id === run.contractId);
      if (!contract) {
        this.failPhase(run, `contract ${run.contractId} invalid or missing`);
        return this.terminal(runId);
      }
      try {
        const out = await this.deps.engine.runPhase({ phase: run.phase, attempt: run.currentAttempt, contract, runId });
        for (const e of out.events)
          this.deps.store.appendEvent({
            runId,
            attempt: run.currentAttempt,
            type: e.type,
            phase: run.phase,
            message: e.message,
            createdAt: now(),
            data: {},
          });
        for (const ev of out.evidence) this.deps.store.appendEvidence({ ...ev, runId, createdAt: now() });
        appendExecPlanLog(
          this.deps.repoRoot,
          run.execPlanRef,
          `Completed ${run.phase} phase (attempt ${run.currentAttempt}).`,
        );
      } catch (e) {
        this.failPhase(run, e instanceof Error ? e.message : String(e));
        return this.terminal(runId);
      }

      run = this.mustRun(runId);
      contract = this.deps.files.load().contracts.find((c) => c.id === run.contractId) ?? contract;

      const gate = GATE_AFTER_PHASE[run.phase];
      if (gate) {
        const depStatuses = contract.dependencies.map((d) => this.statusHint(d));
        const evaluation = evaluateGate({
          gate,
          attempt: run.currentAttempt,
          contract,
          evidence: this.deps.store.evidence(runId).filter((e) => e.attempt === run.currentAttempt),
          dependencyStatuses: depStatuses,
          config: this.deps.config,
        });
        this.deps.store.appendEvent({
          runId,
          attempt: run.currentAttempt,
          type: 'gate_evaluated',
          phase: run.phase,
          message: `gate ${gate}: ${evaluation.outcome}`,
          createdAt: now(),
          data: { gate, outcome: evaluation.outcome, missing: evaluation.missingCriterionIds },
        });
        if (evaluation.outcome === 'fail' && GATE_KIND[gate] === 'hard') {
          this.deps.store.appendGateDecision({
            runId,
            attempt: run.currentAttempt,
            gate,
            evaluationOutcome: 'fail',
            action: 'reject-hard',
            reason: evaluation.reasons.join('; '),
            contractRevision: run.contractRevision,
            createdAt: now(),
          });
          this.deps.store.updateRunState(runId, { state: 'failed' });
          return this.terminal(runId);
        }
        this.deps.store.updateRunState(runId, { state: 'awaiting-decision' });
        return this.mustRun(runId);
      }

      run = this.moveToNextPhase(run);
      if (run.state === 'commit-ready') return this.terminal(runId);
    }

    return this.mustRun(runId);
  }

  async actOnGate(
    runId: string,
    input: { gate: GateId; action: 'approve' | 'rework' | 'override'; reason?: string; answers?: string },
  ): Promise<RunRecord> {
    const run = this.mustRun(runId);
    if (input.action === 'override') {
      if (GATE_KIND[input.gate] === 'hard') throw new HardGateOverrideError(input.gate);
      if (!input.reason || input.reason.trim() === '') throw new OverrideReasonRequiredError();
    }
    if (run.state !== 'awaiting-decision') {
      throw new Error(`run ${runId} is not awaiting-decision (state: ${run.state})`);
    }
    const expectedGate = GATE_AFTER_PHASE[run.phase];
    if (!expectedGate || input.gate !== expectedGate) {
      throw new Error(`gate ${input.gate} does not match current phase gate ${expectedGate ?? 'none'}`);
    }
    const data = this.deps.files.load();
    const contract = data.contracts.find((c) => c.id === run.contractId);
    if (!contract) throw new Error(`contract ${run.contractId} invalid or missing`);
    const evaluation = evaluateGate({
      gate: input.gate,
      attempt: run.currentAttempt,
      contract,
      evidence: this.deps.store.evidence(runId).filter((e) => e.attempt === run.currentAttempt),
      dependencyStatuses: contract.dependencies.map((d) => this.statusHint(d)),
      config: this.deps.config,
    });
    if (input.action === 'approve' && evaluation.outcome === 'fail')
      throw new Error(`gate ${input.gate} cannot be approved: ${evaluation.reasons.join('; ')}`);
    if (input.action === 'approve' && input.gate === 'spec') {
      const dir = attemptDir(this.deps.repoRoot, runId, run.currentAttempt);
      const briefPath = join(dir, 'brief.md');
      if (existsSync(briefPath)) {
        const questions = openQuestionBullets(readFileSync(briefPath, 'utf8'));
        const answers = input.answers?.trim() ?? '';
        if (questions.length > 0 && answers === '') throw new OpenQuestionsError();
        if (input.answers && answers !== '') recordAnswers(dir, input.answers);
      }
    }
    this.deps.store.appendGateDecision({
      runId,
      attempt: run.currentAttempt,
      gate: input.gate,
      evaluationOutcome: evaluation.outcome,
      action: input.action,
      reason: input.reason ?? null,
      contractRevision: run.contractRevision,
      createdAt: now(),
    });
    appendExecPlanLog(
      this.deps.repoRoot,
      run.execPlanRef,
      `Gate ${input.gate}: ${input.action} (attempt ${run.currentAttempt}).`,
    );
    if (input.action === 'rework') return this.startNewAttempt(runId, input.gate === 'spec' ? 'spec' : 'plan');
    if (input.gate === 'commit') {
      this.deps.store.updateRunState(runId, { state: 'commit-ready' });
      return this.terminal(runId);
    }
    return this.moveToNextPhase(this.mustRun(runId));
  }

  startNewAttempt(runId: string, fromPhase: Phase): RunRecord {
    const run = this.mustRun(runId);
    const attempt = run.currentAttempt + 1;
    this.deps.store.startAttempt(runId, attempt);
    this.deps.store.updateRunState(runId, { phase: fromPhase, state: 'running' });
    this.deps.store.appendEvent({
      runId,
      attempt,
      type: 'attempt_started',
      phase: fromPhase,
      message: `new attempt ${attempt} from ${fromPhase}`,
      createdAt: now(),
      data: { fromPhase },
    });
    return this.mustRun(runId);
  }

  invalidateForContract(contractId: string, newRevision: string): void {
    for (const run of this.deps.store.listRunsByContract(contractId)) {
      if (run.state === 'commit-ready') continue;
      this.deps.store.appendEvent({
        runId: run.id,
        attempt: run.currentAttempt,
        type: 'approvals_invalidated',
        phase: run.phase,
        message: `contract revised to ${newRevision}; downstream approvals superseded`,
        createdAt: now(),
        data: { newRevision, supersededRevision: run.contractRevision },
      });
      this.deps.store.updateRunState(run.id, { phase: 'spec', state: 'running', contractRevision: newRevision });
    }
  }

  private statusHint(contractId: string): 'commit-ready' | 'in-progress' {
    const runs = this.deps.store.listRunsByContract(contractId);
    return runs.some((r) => r.state === 'commit-ready') ? 'commit-ready' : 'in-progress';
  }
  private failPhase(run: RunRecord, message: string): void {
    this.deps.store.appendEvent({
      runId: run.id,
      attempt: run.currentAttempt,
      type: 'phase_failed',
      phase: run.phase,
      message,
      createdAt: now(),
      data: {},
    });
    this.deps.store.updateRunState(run.id, { state: 'failed' });
  }
  private moveToNextPhase(run: RunRecord): RunRecord {
    const next = PHASES[PHASES.indexOf(run.phase) + 1];
    if (!next) {
      this.deps.store.updateRunState(run.id, { state: 'commit-ready' });
      return this.mustRun(run.id);
    }
    this.deps.store.updateRunState(run.id, { phase: next, state: 'running' });
    return this.mustRun(run.id);
  }
  private async terminal(runId: string): Promise<RunRecord> {
    const run = this.mustRun(runId);
    if ((run.state === 'failed' || run.state === 'commit-ready') && run.engine === 'playbook' && this.deps.onTerminal) {
      try {
        await this.deps.onTerminal(run);
      } catch {
        // The reflector records its own failure.
      }
    }
    return this.mustRun(runId);
  }
  private mustRun(runId: string): RunRecord {
    const run = this.deps.store.getRun(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    return run;
  }
}
