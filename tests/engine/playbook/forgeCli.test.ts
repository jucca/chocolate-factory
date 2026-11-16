import { describe, expect, it } from 'vitest';
import { ForgeCli } from '../../../src/engine/playbook/forgeCli.js';
import type { PullRequestView } from '../../../src/engine/playbook/ports.js';

const prJson = {
  url: 'https://github.com/o/r/pull/4',
  number: 4,
  isDraft: false,
  headRefOid: 'abc123',
  headRefName: 'feat/gh-1',
};

const prView: PullRequestView = {
  url: prJson.url,
  number: 4,
  isDraft: false,
  headSha: 'abc123',
  headBranch: 'feat/gh-1',
};

function client(run: (args: string[]) => string) {
  const calls: string[][] = [];
  const cli = new ForgeCli({
    runGh: async (args) => {
      calls.push(args);
      return run(args);
    },
  });
  return { calls, cli };
}

describe('ForgeCli', () => {
  it('reads the default branch and returns null when gh throws', async () => {
    const ok = client(() => 'main\n');
    expect(await ok.cli.defaultBranch('o/r')).toBe('main');
    expect(ok.calls).toEqual([['repo', 'view', 'o/r', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name']]);
    const bad = client(() => { throw new Error('no repo'); });
    expect(await bad.cli.defaultBranch('o/r')).toBeNull();
  });

  it('maps issue title, body, and comment bodies', async () => {
    const { calls, cli } = client(() => JSON.stringify({ title: 'T', body: 'B', comments: [{ body: 'c1' }, { body: 'c2' }] }));
    expect(await cli.readIssue('o/r', 7)).toEqual({ title: 'T', body: 'B', comments: ['c1', 'c2'] });
    expect(calls).toEqual([['issue', 'view', '7', '--repo', 'o/r', '--comments', '--json', 'title,body,comments']]);
  });

  it('returns null when pr view throws and maps a pull request otherwise', async () => {
    const missing = new ForgeCli({ runGh: async () => { throw new Error('no pr'); } });
    expect(await missing.viewPr('/repo')).toBeNull();
    const { calls, cli } = client(() => JSON.stringify(prJson));
    expect(await cli.viewPr('/repo')).toEqual(prView);
    expect(calls).toEqual([['pr', 'view', '--json', 'url,number,isDraft,headRefOid,headRefName']]);
  });

  it('creates a pull request when none exists, with --draft only when asked', async () => {
    const created = { ...prJson, number: 3, isDraft: true, url: 'https://github.com/o/r/pull/3' };
    const viewArgs = ['pr', 'view', '--json', 'url,number,isDraft,headRefOid,headRefName'];
    let draftViews = 0;
    const draft = client((args) => {
      if (args[1] === 'view') {
        draftViews += 1;
        if (draftViews === 1) throw new Error('no pr');
        return JSON.stringify(created);
      }
      return '';
    });
    const view = await draft.cli.upsertPr({ repoRoot: '/repo', base: 'main', title: 'T', bodyPath: 'pr.md', draft: true });
    expect(view).toEqual({ ...prView, number: 3, isDraft: true, url: created.url });
    expect(draft.calls[0]).toEqual(viewArgs);
    expect(draft.calls[1]).toEqual(['pr', 'create', '--base', 'main', '--title', 'T', '--body-file', 'pr.md', '--draft']);
    expect(draft.calls[2]).toEqual(viewArgs);
    expect(draft.calls.some((args) => args[1] === 'edit')).toBe(false);

    let readyViews = 0;
    const ready = client((args) => {
      if (args[1] === 'view') {
        readyViews += 1;
        if (readyViews === 1) throw new Error('no pr');
        return JSON.stringify({ ...created, isDraft: false });
      }
      return '';
    });
    await ready.cli.upsertPr({ repoRoot: '/repo', base: 'main', title: 'T', bodyPath: 'pr.md', draft: false });
    expect(ready.calls[1]).toEqual(['pr', 'create', '--base', 'main', '--title', 'T', '--body-file', 'pr.md']);
    expect(ready.calls[1]).not.toContain('--draft');
    expect(ready.calls[2]).toEqual(viewArgs);
  });

  it('edits an existing pull request and does not create one', async () => {
    const { calls, cli } = client((args) => args[1] === 'view' ? JSON.stringify(prJson) : '');
    const view = await cli.upsertPr({ repoRoot: '/repo', base: 'main', title: 'T', bodyPath: 'body.md', draft: false });
    expect(view).toEqual(prView);
    expect(calls.some((args) => args[1] === 'create')).toBe(false);
    expect(calls[1]).toEqual(['pr', 'edit', '4', '--body-file', 'body.md']);

    const drafted = client((args) => args[1] === 'view' ? JSON.stringify(prJson) : '');
    const draftView = await drafted.cli.upsertPr({ repoRoot: '/repo', base: 'main', title: 'T', bodyPath: 'body.md', draft: true });
    expect(draftView.isDraft).toBe(true);
    expect(drafted.calls[1]).toEqual(['pr', 'edit', '4', '--body-file', 'body.md', '--draft']);
    expect(drafted.calls.some((args) => args[1] === 'create')).toBe(false);
  });

  it('parses checks, reruns failed jobs, and returns the failed log', async () => {
    const { calls, cli } = client((args) => {
      if (args[1] === 'checks') return JSON.stringify([{ name: 'test', state: 'success', bucket: 'pass', link: 'https://example.test' }]);
      if (args[1] === 'view') return 'Error: boom\n';
      return '';
    });
    expect(await cli.checks('/repo', 4)).toEqual([{ name: 'test', state: 'success', bucket: 'pass', link: 'https://example.test' }]);
    expect(calls[0]).toEqual(['pr', 'checks', '4', '--json', 'name,state,bucket,link']);
    await cli.rerunFailed('/repo', '15');
    expect(calls[1]).toEqual(['run', 'rerun', '15', '--failed']);
    expect(await cli.failedLog('/repo', '15')).toBe('Error: boom\n');
    expect(calls[2]).toEqual(['run', 'view', '15', '--log-failed']);
  });
});
