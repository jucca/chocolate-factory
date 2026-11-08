import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { buildApp } from './app.js';
import { SqliteRunStore } from '../store/runStore.js';
import { RunService, type FilesPort } from '../runs/runService.js';
import { SimulatorRunEngine } from '../engine/simulator.js';
import { GithubIssueSource, defaultGhRunner } from '../issues/githubIssueSource.js';
import { loadChocolate, saveContract } from '../files/chocolateFiles.js';

export async function startServer(repoRoot: string): Promise<void> {
  const data = loadChocolate(repoRoot);
  const config = data.config;
  const store = new SqliteRunStore(join(repoRoot, config.runtime, 'chocolate.db'));
  const files: FilesPort = {
    load: () => loadChocolate(repoRoot),
    readContractFile: (id) => readFileSync(join(repoRoot, '.chocolate', 'contracts', `${id}.yaml`), 'utf8'),
    saveContract: (c) => saveContract(repoRoot, c),
  };
  const runService = new RunService({ store, engine: new SimulatorRunEngine(), files, config, repoRoot });
  const issueSource = new GithubIssueSource({ repo: config.issue_source.repo, runGh: defaultGhRunner });
  const app = buildApp({ repoRoot, store, runService, issueSource, config });
  await app.listen({ host: '127.0.0.1', port: 4200 });
  console.log('chocolate cockpit: http://127.0.0.1:4200');
}
