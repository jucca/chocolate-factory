// src/store/runStore.ts
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RunRecord, RunEvent, EvidenceRecord, GateDecisionRecord, Phase, RunState } from '../domain/types.js';

export class SqliteRunStore {
  private db: InstanceType<typeof Database>;
  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, contract_revision TEXT NOT NULL,
        issue TEXT, phase TEXT NOT NULL, state TEXT NOT NULL, current_attempt INTEGER NOT NULL,
        exec_plan_ref TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, attempt INTEGER NOT NULL, type TEXT NOT NULL,
        phase TEXT, message TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, attempt INTEGER NOT NULL, phase TEXT NOT NULL,
        producer_phase TEXT NOT NULL, criterion_ids TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gate_decisions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, attempt INTEGER NOT NULL, gate TEXT NOT NULL,
        evaluation_outcome TEXT NOT NULL, action TEXT NOT NULL, reason TEXT, contract_revision TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
  }
  createRun(input: Omit<RunRecord, 'createdAt'>): RunRecord {
    const createdAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO runs (id,contract_id,contract_revision,issue,phase,state,current_attempt,exec_plan_ref,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(input.id, input.contractId, input.contractRevision, input.issue ? JSON.stringify(input.issue) : null, input.phase, input.state, input.currentAttempt, input.execPlanRef, createdAt);
    return { ...input, createdAt };
  }
  updateRunState(id: string, patch: { phase?: Phase; state?: RunState; currentAttempt?: number; contractRevision?: string }): void {
    const cur = this.getRun(id);
    if (!cur) throw new Error(`unknown run ${id}`);
    this.db
      .prepare('UPDATE runs SET phase=?, state=?, current_attempt=?, contract_revision=? WHERE id=?')
      .run(
        patch.phase ?? cur.phase,
        patch.state ?? cur.state,
        patch.currentAttempt ?? cur.currentAttempt,
        patch.contractRevision ?? cur.contractRevision,
        id,
      );
  }
  getRun(id: string): RunRecord | null {
    const r = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return r ? this.toRun(r) : null;
  }
  listRuns(): RunRecord[] {
    return (this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all() as Record<string, unknown>[]).map((r) => this.toRun(r));
  }
  listRunsByContract(contractId: string): RunRecord[] {
    return (this.db.prepare('SELECT * FROM runs WHERE contract_id=? ORDER BY created_at DESC, id DESC').all(contractId) as Record<string, unknown>[]).map((r) => this.toRun(r));
  }
  startAttempt(runId: string, attempt: number): void { this.updateRunState(runId, { currentAttempt: attempt }); }
  appendEvent(e: Omit<RunEvent, 'id'>): RunEvent {
    const row = { ...e, id: randomUUID() };
    this.db.prepare('INSERT INTO events (id,run_id,attempt,type,phase,message,created_at,data) VALUES (?,?,?,?,?,?,?,?)')
      .run(row.id, row.runId, row.attempt, row.type, row.phase, row.message, row.createdAt, JSON.stringify(row.data));
    return row;
  }
  appendEvidence(e: Omit<EvidenceRecord, 'id'>): EvidenceRecord {
    const row = { ...e, id: randomUUID() };
    this.db.prepare('INSERT INTO evidence (id,run_id,attempt,phase,producer_phase,criterion_ids,kind,summary,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(row.id, row.runId, row.attempt, row.phase, row.producerPhase, JSON.stringify(row.criterionIds), row.kind, row.summary, row.createdAt);
    return row;
  }
  appendGateDecision(d: Omit<GateDecisionRecord, 'id'>): GateDecisionRecord {
    const row = { ...d, id: randomUUID() };
    this.db.prepare('INSERT INTO gate_decisions (id,run_id,attempt,gate,evaluation_outcome,action,reason,contract_revision,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(row.id, row.runId, row.attempt, row.gate, row.evaluationOutcome, row.action, row.reason, row.contractRevision, row.createdAt);
    return row;
  }
  events(runId: string): RunEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE run_id=? ORDER BY created_at ASC').all(runId) as Record<string, unknown>[])
      .map((r) => ({ id: String(r.id), runId: String(r.run_id), attempt: Number(r.attempt), type: String(r.type), phase: (r.phase as Phase | null) ?? null, message: String(r.message), createdAt: String(r.created_at), data: JSON.parse(String(r.data)) as Record<string, unknown> }));
  }
  evidence(runId: string): EvidenceRecord[] {
    return (this.db.prepare('SELECT * FROM evidence WHERE run_id=? ORDER BY created_at ASC').all(runId) as Record<string, unknown>[])
      .map((r) => ({ id: String(r.id), runId: String(r.run_id), attempt: Number(r.attempt), phase: r.phase as Phase, producerPhase: r.producer_phase as Phase, criterionIds: JSON.parse(String(r.criterion_ids)) as string[], kind: String(r.kind), summary: String(r.summary), createdAt: String(r.created_at) }));
  }
  gateDecisions(runId: string): GateDecisionRecord[] {
    return (this.db.prepare('SELECT * FROM gate_decisions WHERE run_id=? ORDER BY created_at ASC').all(runId) as Record<string, unknown>[])
      .map((r) => ({ id: String(r.id), runId: String(r.run_id), attempt: Number(r.attempt), gate: r.gate as GateDecisionRecord['gate'], evaluationOutcome: r.evaluation_outcome as 'pass' | 'fail', action: r.action as GateDecisionRecord['action'], reason: (r.reason as string | null) ?? null, contractRevision: String(r.contract_revision), createdAt: String(r.created_at) }));
  }
  close(): void { this.db.close(); }
  private toRun(r: Record<string, unknown>): RunRecord {
    return { id: String(r.id), contractId: String(r.contract_id), contractRevision: String(r.contract_revision),
      issue: r.issue ? (JSON.parse(String(r.issue)) as RunRecord['issue']) : null, phase: r.phase as Phase,
      state: r.state as RunState, currentAttempt: Number(r.current_attempt), execPlanRef: String(r.exec_plan_ref), createdAt: String(r.created_at) };
  }
}
