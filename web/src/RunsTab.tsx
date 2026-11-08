import { useEffect, useState } from 'react';
import { api, type InboxDTO, type RunDTO } from './api';
import { RunDetail } from './RunDetail';

export function RunsTab() {
  const [inbox, setInbox] = useState<InboxDTO | null>(null);
  const [runs, setRuns] = useState<RunDTO[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const reload = async () => {
    try { setInbox(await api.getInbox()); setRuns(await api.listRuns()); }
    catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void reload(); }, []);
  return (
    <section aria-label="Runs">
      <h2>Issue inbox</h2>
      <button onClick={reload}>Refresh inbox</button>
      {inbox?.kind === 'stale' && <p role="alert">GitHub unreachable — showing last synced issues from {inbox.lastSyncedAt ?? 'never'}: {inbox.error}</p>}
      {inbox?.kind === 'fresh' && <p>Last synced: {inbox.syncedAt}</p>}
      <ul>{inbox?.issues.map((i) => (
        <li key={i.number}>#{i.number} {i.url}
          <button onClick={() => api.claim(i).then((r) => { setSelected(r.id); return reload(); })}>Claim &amp; start run</button>
        </li>))}
      </ul>
      {error && <p role="alert">{error}</p>}
      <h2>Runs</h2>
      <ul>{runs.map((r) => (
        <li key={r.id}><button onClick={() => setSelected(r.id)}>{r.id}</button> {r.contractId} — {r.phase} · {r.state} · attempt {r.currentAttempt}</li>))}
      </ul>
      {selected && <RunDetail runId={selected} />}
    </section>
  );
}
