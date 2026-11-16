// tests/issues/githubIssueSource.test.ts
import { describe, it, expect } from 'vitest';
import { GithubIssueSource } from '../../src/issues/githubIssueSource.js';
import { FakeIssueSource } from '../../src/issues/issueSource.js';

const ghIssue = JSON.stringify([{ number: 7, title: 'Fix login', url: 'https://github.com/o/r/issues/7', labels: [{ name: 'chocolate:ready' }] }]);
describe('GithubIssueSource', () => {
  it('maps gh issue list output to IssueRefs and reports fresh', async () => {
    const src = new GithubIssueSource({ repo: 'o/r', runGh: async () => ghIssue });
    const r = await src.listEligible('chocolate:ready');
    expect(r.kind).toBe('fresh');
    if (r.kind === 'fresh') { expect(r.issues).toEqual([{ tracker: 'github', repo: 'o/r', number: 7, url: 'https://github.com/o/r/issues/7' }]); expect(r.syncedAt.length).toBeGreaterThan(0); }
  });
  it('returns stale with last cache and error when gh fails after a success', async () => {
    let fail = false;
    const src = new GithubIssueSource({ repo: 'o/r', runGh: async () => { if (fail) throw new Error('network unreachable'); return ghIssue; } });
    await src.listEligible('chocolate:ready'); fail = true;
    const r = await src.listEligible('chocolate:ready');
    expect(r.kind).toBe('stale');
    if (r.kind === 'stale') { expect(r.issues).toHaveLength(1); expect(r.error).toContain('network unreachable'); expect(r.lastSyncedAt).not.toBeNull(); }
  });
  it('returns stale with empty issues when the first fetch fails', async () => {
    const src = new GithubIssueSource({ repo: 'o/r', runGh: async () => { throw new Error('gh not found'); } });
    const r = await src.listEligible('chocolate:ready');
    expect(r).toMatchObject({ kind: 'stale', issues: [] });
  });
  it('FakeIssueSource returns its issues as fresh', async () => {
    const r = await new FakeIssueSource([{ tracker: 'github', repo: 'o/r', number: 1, url: 'https://github.com/o/r/issues/1' }]).listEligible('anything');
    expect(r.kind).toBe('fresh');
  });
});
