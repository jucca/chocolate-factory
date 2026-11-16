import { useState } from 'react';
import { RoadmapTab } from './RoadmapTab';
import { RunsTab } from './RunsTab';

export function App() {
  const [tab, setTab] = useState<'roadmap' | 'runs'>('roadmap');
  return (
    <main>
      <h1>Chocolate Factory</h1>
      <nav role="tablist" aria-label="Cockpit">
        <button role="tab" aria-selected={tab === 'roadmap'} onClick={() => setTab('roadmap')}>Roadmap</button>
        <button role="tab" aria-selected={tab === 'runs'} onClick={() => setTab('runs')}>Runs</button>
      </nav>
      {tab === 'roadmap' ? <RoadmapTab /> : <RunsTab />}
    </main>
  );
}
