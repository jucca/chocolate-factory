import type { CheckView, ForgePort, IssueText, PullRequestView } from './ports.js';

const prFields = 'url,number,isDraft,headRefOid,headRefName';
const prViewArgs = ['pr', 'view', '--json', prFields];

interface GhPullRequest {
  url: string;
  number: number;
  isDraft: boolean;
  headRefOid: string;
  headRefName: string;
}

function parsePr(raw: string): PullRequestView {
  const parsed = JSON.parse(raw) as GhPullRequest;
  return {
    url: parsed.url,
    number: parsed.number,
    isDraft: parsed.isDraft,
    headSha: parsed.headRefOid,
    headBranch: parsed.headRefName,
  };
}

export class ForgeCli implements ForgePort {
  constructor(private deps: { runGh: (args: string[]) => Promise<string> }) {}

  async defaultBranch(repo: string): Promise<string | null> {
    try {
      const out = await this.deps.runGh(['repo', 'view', repo, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name']);
      return out.trim();
    } catch {
      return null;
    }
  }

  async readIssue(repo: string, number: number): Promise<IssueText> {
    const out = await this.deps.runGh(['issue', 'view', String(number), '--repo', repo, '--comments', '--json', 'title,body,comments']);
    const parsed = JSON.parse(out) as { title: string; body: string; comments: { body: string }[] };
    return { title: parsed.title, body: parsed.body, comments: parsed.comments.map((comment) => comment.body) };
  }

  async viewPr(repoRoot: string): Promise<PullRequestView | null> {
    void repoRoot;
    try {
      return parsePr(await this.deps.runGh(prViewArgs));
    } catch {
      return null;
    }
  }

  async upsertPr(input: { repoRoot: string; base: string; title: string; bodyPath: string; draft: boolean }): Promise<PullRequestView> {
    void input.repoRoot;
    let current: PullRequestView | null;
    try {
      current = parsePr(await this.deps.runGh(prViewArgs));
    } catch {
      current = null;
    }
    if (current) {
      const args = ['pr', 'edit', String(current.number), '--body-file', input.bodyPath];
      if (input.draft) args.push('--draft');
      await this.deps.runGh(args);
      return { ...current, isDraft: input.draft };
    }
    const args = ['pr', 'create', '--base', input.base, '--title', input.title, '--body-file', input.bodyPath];
    if (input.draft) args.push('--draft');
    await this.deps.runGh(args);
    return parsePr(await this.deps.runGh(prViewArgs));
  }

  async checks(repoRoot: string, prNumber: number): Promise<CheckView[]> {
    void repoRoot;
    const out = await this.deps.runGh(['pr', 'checks', String(prNumber), '--json', 'name,state,bucket,link']);
    const parsed = JSON.parse(out) as CheckView[];
    return parsed.map((check) => ({ name: check.name, state: check.state, bucket: check.bucket, link: check.link }));
  }

  async rerunFailed(repoRoot: string, runId: string): Promise<void> {
    void repoRoot;
    await this.deps.runGh(['run', 'rerun', runId, '--failed']);
  }

  async failedLog(repoRoot: string, runId: string): Promise<string> {
    void repoRoot;
    return this.deps.runGh(['run', 'view', runId, '--log-failed']);
  }
}
