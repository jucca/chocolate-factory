import { useEffect, useState } from 'react';
import { api, type ContractDTO, type ContractView, type RoadmapDTO } from './api';

function ContractEditor({ view }: { view: ContractView }) {
  const [editing, setEditing] = useState(false);
  const [contract, setContract] = useState<ContractDTO | null>(null);
  const [title, setTitle] = useState(view.title);
  const [intent, setIntent] = useState(view.intent);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const open = async () => {
    setError('');
    setSaved(false);
    try {
      const full = await api.getContract(view.id);
      setContract(full);
      setTitle(full.title);
      setIntent(full.intent);
      setEditing(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const save = async () => {
    if (!contract) return;
    setError('');
    try {
      await api.saveContract({ ...contract, title, intent });
      setSaved(true);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <li>
      <strong>{view.title}</strong> — {view.intent} <em>[{view.status}]</em>
      {view.dependencies.length > 0 && <span> depends on: {view.dependencies.join(', ')}</span>}
      <ul>{view.acceptanceCriteria.map((a) => <li key={a.id}>{a.statement}</li>)}</ul>
      <button type="button" onClick={() => void open()}>Edit contract</button>
      {editing && (
        <div aria-label={`Edit ${view.id}`}>
          <label>Title <input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label>Intent <textarea value={intent} onChange={(e) => setIntent(e.target.value)} rows={3} /></label>
          <button type="button" onClick={() => void save()}>Save</button>
          <button type="button" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      )}
      {saved && <span> Saved.</span>}
      {error && <span role="alert"> {error}</span>}
    </li>
  );
}

export function RoadmapTab() {
  const [data, setData] = useState<RoadmapDTO | null>(null);
  const [error, setError] = useState('');
  const reload = () => api.getRoadmap().then(setData).catch((e: Error) => setError(e.message));
  useEffect(() => { void reload(); }, []);
  if (error) return <p role="alert">Roadmap unavailable: {error}</p>;
  if (!data) return <p>Loading roadmap…</p>;
  return (
    <section aria-label="Roadmap">
      {!data.runtimeAvailable && <p>Runtime unavailable — statuses shown without run data.</p>}
      {data.invalidFiles.length > 0 && <p role="alert">Invalid contract files (runs blocked): {data.invalidFiles.join(', ')}</p>}
      {data.milestones.map((m) => (
        <article key={m.id}>
          <h2>{m.title}</h2><p>{m.intent}</p>
          <ul>{m.contracts.map((c) => <ContractEditor key={c.id} view={c} />)}</ul>
        </article>
      ))}
    </section>
  );
}
