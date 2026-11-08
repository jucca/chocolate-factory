import { useEffect, useState } from 'react';
import { api, type RunDetailDTO } from './api';

const GATES = ['spec', 'plan', 'verify', 'commit'] as const;
const HARD = new Set(['verify', 'commit']);
export function RunDetail({ runId }: { runId: string }) {
  const [detail, setDetail] = useState<RunDetailDTO | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const reload = () => api.getRun(runId).then(setDetail).catch((e: Error) => setError(e.message));
  useEffect(() => { void reload(); }, [runId]);
  if (!detail) return <p>Loading run…</p>;
  const act = async (gate: string, action: string) => {
    try { await api.actOnGate(runId, { gate, action, reason: reason || undefined }); setReason(''); await reload(); }
    catch (e) { setError((e as Error).message); }
  };
  return (
    <section aria-label="Run detail">
      <h3>{detail.run.id} — {detail.run.contractId}</h3>
      <p>Phase: {detail.run.phase} · State: {detail.run.state} · Attempt: {detail.run.currentAttempt}</p>
      <p>Exec plan: <code>{detail.run.execPlanRef}</code></p>
      <button onClick={() => api.advance(runId).then(reload)}>Advance phase</button>
      {error && <p role="alert">{error}</p>}
      <h4>Gate actions</h4>
      {GATES.map((gate) => (
        <div key={gate}>
          <strong>{gate}</strong>{HARD.has(gate) ? ' (hard — no override)' : ' (soft)'}
          <button onClick={() => act(gate, 'approve')}>Approve</button>
          {!HARD.has(gate) && <>
            <button onClick={() => act(gate, 'rework')}>Rework</button>
            <input aria-label={`override reason for ${gate}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="override reason (required)" />
            <button onClick={() => act(gate, 'override')}>Override with reason</button>
          </>}
        </div>
      ))}
      <h4>Evidence</h4>
      <ul>{detail.evidence.map((e) => <li key={e.id}>[{e.producerPhase}/{e.kind}] {e.summary} (attempt {e.attempt})</li>)}</ul>
      <h4>Gate decisions</h4>
      <ul>{detail.gateDecisions.map((d) => <li key={d.id}>{d.gate}: {d.action} ({d.evaluationOutcome}){d.reason ? ` — “${d.reason}”` : ''} · attempt {d.attempt}</li>)}</ul>
      <h4>Events</h4>
      <ol>{detail.events.map((e) => <li key={e.id}>{e.createdAt} [{e.type}] {e.message} (attempt {e.attempt})</li>)}</ol>
    </section>
  );
}
