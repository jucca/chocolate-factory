import { execFile } from 'node:child_process';
import type { IssueRef } from '../domain/types.js';
import type { IssueListResult, IssueSource } from './issueSource.js';

export type GhRunner = (args: string[]) => Promise<string>;
export const defaultGhRunner: GhRunner = (args) => new Promise((resolve, reject) => {
  execFile('gh', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => err ? reject(err) : resolve(stdout));
});

interface GhIssue { number: number; url: string; }
export class GithubIssueSource implements IssueSource {
  private cache: { issues: IssueRef[]; syncedAt: string } | null = null;
  constructor(private deps: { repo: string; runGh: GhRunner }) {}
  async listEligible(label: string): Promise<IssueListResult> {
    try {
      const out = await this.deps.runGh(['issue', 'list', '--repo', this.deps.repo, '--label', label, '--state', 'open', '--json', 'number,url,labels', '--limit', '100']);
      const issues = (JSON.parse(out) as GhIssue[]).map((i) => ({ tracker: 'github' as const, repo: this.deps.repo, number: i.number, url: i.url }));
      this.cache = { issues, syncedAt: new Date().toISOString() };
      return { kind: 'fresh', issues, syncedAt: this.cache.syncedAt };
    } catch (e) {
      return { kind: 'stale', issues: this.cache?.issues ?? [], lastSyncedAt: this.cache?.syncedAt ?? null, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
