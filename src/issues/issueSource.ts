import type { IssueRef } from '../domain/types.js';

export type IssueListResult =
  | { kind: 'fresh'; issues: IssueRef[]; syncedAt: string }
  | { kind: 'stale'; issues: IssueRef[]; lastSyncedAt: string | null; error: string };

export interface IssueSource { listEligible(label: string): Promise<IssueListResult>; }

export class FakeIssueSource implements IssueSource {
  constructor(private issues: IssueRef[]) {}
  async listEligible(_label: string): Promise<IssueListResult> {
    return { kind: 'fresh', issues: this.issues, syncedAt: new Date().toISOString() };
  }
}
