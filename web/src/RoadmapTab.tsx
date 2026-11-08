import { useEffect, useState } from 'react';
import { api, type RoadmapDTO } from './api';

export function RoadmapTab() {
  const [data, setData] = useState<RoadmapDTO | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api.getRoadmap().then(setData).catch((e: Error) => setError(e.message)); }, []);
  if (error) return <p role="alert">Roadmap unavailable: {error}</p>;
  if (!data) return <p>Loading roadmap…</p>;
  return (
    <section aria-label="Roadmap">
      {!data.runtimeAvailable && <p>Runtime unavailable — statuses shown without run data.</p>}
      {data.invalidFiles.length > 0 && <p role="alert">Invalid contract files (runs blocked): {data.invalidFiles.join(', ')}</p>}
      {data.milestones.map((m) => (
        <article key={m.id}>
          <h2>{m.title}</h2><p>{m.intent}</p>
          <ul>{m.contracts.map((c) => (
            <li key={c.id}>
              <strong>{c.title}</strong> — {c.intent} <em>[{c.status}]</em>
              {c.dependencies.length > 0 && <span> depends on: {c.dependencies.join(', ')}</span>}
              <ul>{c.acceptanceCriteria.map((a) => <li key={a.id}>{a.statement}</li>)}</ul>
            </li>))}
          </ul>
        </article>
      ))}
    </section>
  );
}
