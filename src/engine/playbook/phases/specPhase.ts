import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Contract, Flow, GateId } from '../../../domain/types.js';
import type { PhaseInput, PhaseOutput } from '../../runEngine.js';
import type { CommandRunner, ForgePort, GitPort, WorkerPort } from '../ports.js';
import { dispatchWorker } from '../dispatchWorker.js';
import { appendStatus, ensureAttempt } from '../runFolder.js';
import type { FilesPort } from '../../../runs/runService.js';
import type { SqliteRunStore } from '../../../store/runStore.js';

export interface PhaseContext {
  repoRoot: string;
  files: FilesPort;
  store: SqliteRunStore;
  git: GitPort;
  forge: ForgePort;
  workers: WorkerPort;
  commands: CommandRunner;
  ci: { waitMs: number; extraIntervalMs: number };
  readPlaybook: (name: string) => string;
}

function requirementBullets(markdown: string): string[] {
  const bullets: string[] = [];
  let collecting = false;
  for (const line of markdown.split('\n')) {
    if (!collecting) {
      if (line.startsWith('## Requirements / acceptance criteria')) collecting = true;
      continue;
    }
    if (line.startsWith('## ')) break;
    if (line.startsWith('- ')) bullets.push(line.slice(2).trim());
  }
  return bullets;
}

export async function runSpecPhase(input: PhaseInput, ctx: PhaseContext & { flow: Flow }): Promise<PhaseOutput> {
  const repoRoot = ctx.repoRoot;
  if (!(await ctx.git.isRepo(repoRoot))) throw new Error('not a git checkout');
  const porcelain = await ctx.git.statusPorcelain(repoRoot);
  if (porcelain !== '') throw new Error('working tree is dirty');

  const issue = input.contract.linked_issue;
  const slug = issue ? `gh-${issue.number}` : input.contract.id;
  const branch = `${ctx.flow === 'bug' ? 'fix' : 'feat'}/${slug}`;
  const exists = await ctx.git.branchExists(repoRoot, branch);
  if (exists) {
    const head = await ctx.git.headBranch(repoRoot);
    if (head !== branch) throw new Error(`branch ${branch} already exists`);
  }

  let base: string | null = issue ? await ctx.forge.defaultBranch(issue.repo) : null;
  if (!base) base = await ctx.git.originHead(repoRoot);
  if (!base) throw new Error('default branch cannot be resolved');

  await ctx.git.fetch(repoRoot);
  if (!exists) await ctx.git.createBranch(repoRoot, branch, base);

  const dir = ensureAttempt(repoRoot, input.runId, input.attempt);
  const intake = issue
    ? await ctx.forge.readIssue(issue.repo, issue.number)
    : { title: input.contract.title, body: input.contract.intent, comments: [] as string[] };
  const intakePath = join(dir, 'intake.json');
  const briefPath = join(dir, 'brief.md');
  writeFileSync(intakePath, JSON.stringify({ title: intake.title, body: intake.body, comments: intake.comments }));

  const prompt = [ctx.readPlaybook('spec.md'), intakePath, briefPath, `type: ${ctx.flow}`].join('\n');
  writeFileSync(join(dir, 'prompt.md'), prompt);
  await dispatchWorker(ctx.workers, {
    role: 'default',
    runDir: dir,
    repoRoot,
    prompt,
    allowedFiles: [relative(repoRoot, briefPath)],
    unitId: 'spec',
  });

  if (!existsSync(briefPath)) throw new Error('brief was not written');
  const bullets = requirementBullets(readFileSync(briefPath, 'utf8'));
  if (bullets.length === 0 && input.contract.acceptance_criteria.length === 0) {
    throw new Error('brief has no requirements');
  }

  const next: Contract = {
    ...input.contract,
    acceptance_criteria: input.contract.acceptance_criteria.map((criterion) => ({
      ...criterion,
      gates: [...criterion.gates],
    })),
  };
  if (next.acceptance_criteria.length === 0) {
    next.acceptance_criteria = bullets.map((statement, index) => ({
      id: `ac-${index + 1}`,
      statement,
      gates: ['spec', 'verify', 'commit'] as GateId[],
      evidence: 'brief',
    }));
  } else {
    const first = next.acceptance_criteria[0];
    const hasSpec = next.acceptance_criteria.some((criterion) => criterion.gates.includes('spec'));
    const hasCommit = next.acceptance_criteria.some((criterion) => criterion.gates.includes('commit'));
    if (!hasSpec) first.gates.push('spec');
    if (!hasCommit) {
      first.gates.push('commit');
      if (!first.gates.includes('verify')) first.gates.push('verify');
    }
  }

  const revision = ctx.files.saveContract(next);
  ctx.store.updateRunState(input.runId, { contractRevision: revision });

  const sha = await ctx.git.headSha(repoRoot);
  appendStatus(dir, `- flow: ${ctx.flow}`);
  appendStatus(dir, `- source: ${issue ? issue.url : 'text'}`);
  appendStatus(dir, `- branch: ${branch}`);
  appendStatus(dir, `- base: ${base}@${sha}`);
  appendStatus(dir, `- phase: spec`);

  const criterionIds = next.acceptance_criteria
    .filter((criterion) => criterion.gates.includes('spec'))
    .map((criterion) => criterion.id);
  return {
    events: [{ type: 'phase_completed', message: `spec phase completed (attempt ${input.attempt})` }],
    evidence: [{
      attempt: input.attempt,
      phase: 'spec',
      producerPhase: 'spec',
      criterionIds,
      kind: 'brief',
      summary: `brief for ${criterionIds.join(', ')}`,
    }],
  };
}
