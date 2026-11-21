import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { buildApp } from './app.js';
import { SqliteRunStore } from '../store/runStore.js';
import { RunService, type FilesPort } from '../runs/runService.js';
import { SimulatorRunEngine } from '../engine/simulator.js';
import { GithubIssueSource, defaultGhRunner } from '../issues/githubIssueSource.js';
import { loadChocolate, saveContract } from '../files/chocolateFiles.js';
import { GitCli } from '../engine/playbook/gitCli.js';
import { ForgeCli } from '../engine/playbook/forgeCli.js';
import { ProcessWorker } from '../engine/playbook/processWorker.js';
import { ShellCommandRunner } from '../engine/playbook/commandRunner.js';
import { PlaybookRunEngine } from '../engine/playbook/playbookEngine.js';
import { ProcessSqueezDoctor } from '../engine/playbook/processSqueezDoctor.js';
import { DispatchRunEngine } from '../engine/playbook/dispatchEngine.js';
import { RunWalker } from '../engine/playbook/walker.js';

function readPlaybook(name: string): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'playbooks', name), 'utf8');
}

export async function startServer(repoRoot: string): Promise<void> {
  const data = loadChocolate(repoRoot);
  const config = data.config;
  const store = new SqliteRunStore(join(repoRoot, config.runtime, 'chocolate.db'));
  const files: FilesPort = {
    load: () => loadChocolate(repoRoot),
    readContractFile: (id) => readFileSync(join(repoRoot, '.chocolate', 'contracts', `${id}.yaml`), 'utf8'),
    saveContract: (c) => saveContract(repoRoot, c),
  };
  const playbook = new PlaybookRunEngine({
    repoRoot,
    files,
    store,
    git: new GitCli(),
    forge: new ForgeCli({ runGh: defaultGhRunner }),
    workers: new ProcessWorker({
      default: config.workers.default.command,
      implement: config.workers.implement.command,
    }),
    commands: new ShellCommandRunner(),
    ci: { waitMs: 60 * 60 * 1000, extraIntervalMs: 30_000 },
    readPlaybook,
    squeez: new ProcessSqueezDoctor(),
  });
  const engine = new DispatchRunEngine({ store, simulator: new SimulatorRunEngine(), playbook });
  const runService = new RunService({ store, engine, files, config, repoRoot });
  const walker = new RunWalker(runService);
  const issueSource = new GithubIssueSource({ repo: config.issue_source.repo, runGh: defaultGhRunner });
  const app = buildApp({ repoRoot, store, runService, issueSource, config, walker });
  await app.listen({ host: '127.0.0.1', port: 4200 });
  console.log('chocolate cockpit: http://127.0.0.1:4200');
}
