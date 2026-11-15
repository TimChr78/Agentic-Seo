import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubClient, GitHubError } from '../src/github';
import { closeFakeServers, type FakeCall, type FakeReply, startFakeServer } from './support';

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const OWNER = 'acme';
const REPO = 'site';

afterEach(closeFakeServers);

function clientFor(origin: string): GitHubClient {
  return new GitHubClient({
    token: TOKEN,
    owner: OWNER,
    repo: REPO,
    baseUrl: origin,
    request: (url, init) => fetch(url, init),
  });
}

/** Route a fake GitHub by `METHOD /path`; an unhandled route is a 404, as GitHub would answer. */
function router(routes: Record<string, (call: FakeCall) => FakeReply>): (call: FakeCall) => FakeReply {
  return (call) => {
    const path = call.path.split('?')[0]!;
    const handler = routes[`${call.method} ${path}`];
    if (!handler) return { status: 404, body: { message: 'Not Found' } };
    return handler(call);
  };
}

async function rejection(promise: Promise<unknown>): Promise<GitHubError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GitHubError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe('GitHub client: construction', () => {
  it('refuses a non-GitHub base URL without a test request seam', () => {
    expect(() => new GitHubClient({ token: TOKEN, owner: OWNER, repo: REPO, baseUrl: 'http://127.0.0.1:9999' })).toThrow(GitHubError);
  });

  it('refuses an empty token', () => {
    expect(() => new GitHubClient({ token: '  ', owner: OWNER, repo: REPO })).toThrow(/no token/);
  });
});

describe('GitHub client: files and refs', () => {
  it('reads a file through the contents API and decodes base64', async () => {
    const fake = await startFakeServer(
      router({
        'GET /repos/acme/site/contents/about/index.html': () => ({
          body: {
            type: 'file',
            path: 'about/index.html',
            sha: 'blob1',
            size: 13,
            encoding: 'base64',
            content: Buffer.from('<title>x</title>').toString('base64'),
          },
        }),
      }),
    );
    const file = await clientFor(fake.origin).getFile('about/index.html', 'main');
    expect(file).toEqual({ path: 'about/index.html', sha: 'blob1', content: '<title>x</title>', size: 13 });
    expect(fake.calls[0]!.path).toBe('/repos/acme/site/contents/about/index.html?ref=main');
    expect(fake.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('maps a missing file to a typed not-found with an actionable message', async () => {
    const fake = await startFakeServer(router({}));
    const error = await rejection(clientFor(fake.origin).getFile('missing.html', 'main'));
    expect(error.code).toBe('not_found');
    expect(error.message).toContain('missing.html');
    expect(error.message).not.toContain(TOKEN);
  });

  it('filters a tree to blob paths under a prefix', async () => {
    const fake = await startFakeServer(
      router({
        'GET /repos/acme/site/git/trees/main': () => ({
          body: {
            truncated: false,
            tree: [
              { path: 'content/drafts/a-2026-01-01.md', type: 'blob' },
              { path: 'content/drafts/b-2026-01-02.md', type: 'blob' },
              { path: 'content/drafts', type: 'tree' },
              { path: 'about/index.html', type: 'blob' },
            ],
          },
        }),
      }),
    );
    const tree = await clientFor(fake.origin).listTree('main', 'content/drafts/');
    expect(tree).toEqual({ paths: ['content/drafts/a-2026-01-01.md', 'content/drafts/b-2026-01-02.md'], truncated: false });
  });

  it('reads the default branch and its head', async () => {
    const fake = await startFakeServer(
      router({
        'GET /repos/acme/site': () => ({ body: { default_branch: 'main' } }),
        'GET /repos/acme/site/git/ref/heads/main': () => ({ body: { object: { sha: 'head1' } } }),
      }),
    );
    expect(await clientFor(fake.origin).getDefaultBranch()).toEqual({ branch: 'main', sha: 'head1' });
  });
});

describe('GitHub client: one commit with several edits', () => {
  it('sequences blobs, tree, commit and ref update', async () => {
    let blob = 0;
    const fake = await startFakeServer(
      router({
        'POST /repos/acme/site/git/blobs': () => {
          blob += 1;
          return { status: 201, body: { sha: `blob${blob}` } };
        },
        'GET /repos/acme/site/git/commits/base1': () => ({ body: { tree: { sha: 'tree0' } } }),
        'POST /repos/acme/site/git/trees': () => ({ status: 201, body: { sha: 'tree1' } }),
        'POST /repos/acme/site/git/commits': () => ({ status: 201, body: { sha: 'commit1' } }),
        'PATCH /repos/acme/site/git/refs/heads/feat/change': () => ({ body: { object: { sha: 'commit1' } } }),
      }),
    );

    const result = await clientFor(fake.origin).commitFiles({
      branch: 'feat/change',
      baseSha: 'base1',
      message: 'Update the about page title',
      files: [
        { path: 'about/index.html', content: '<title>New</title>' },
        { path: 'old/page.html', content: null },
      ],
      author: { name: 'Agentic SEO', email: 'bot@example.com' },
      committer: { name: 'Agentic SEO', email: 'bot@example.com' },
    });

    expect(result).toEqual({
      commitSha: 'commit1',
      treeSha: 'tree1',
      files: [
        { path: 'about/index.html', blobSha: 'blob1' },
        { path: 'old/page.html', blobSha: null },
      ],
    });
    const tree = fake.calls.find((call) => call.method === 'POST' && call.path === '/repos/acme/site/git/trees');
    expect(tree?.body).toMatchObject({
      base_tree: 'tree0',
      tree: [
        { path: 'about/index.html', mode: '100644', type: 'blob', sha: 'blob1' },
        { path: 'old/page.html', mode: '100644', type: 'blob', sha: null },
      ],
    });
    const commit = fake.calls.find((call) => call.method === 'POST' && call.path === '/repos/acme/site/git/commits');
    expect(commit?.body).toMatchObject({
      message: 'Update the about page title',
      tree: 'tree1',
      parents: ['base1'],
      author: { name: 'Agentic SEO', email: 'bot@example.com' },
    });
    const patch = fake.calls.find((call) => call.method === 'PATCH');
    expect(patch?.body).toEqual({ sha: 'commit1', force: false });
    expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /repos/acme/site/git/blobs',
      'GET /repos/acme/site/git/commits/base1',
      'POST /repos/acme/site/git/trees',
      'POST /repos/acme/site/git/commits',
      'PATCH /repos/acme/site/git/refs/heads/feat/change',
    ]);
  });

  it('maps an existing branch to a conflict', async () => {
    const fake = await startFakeServer(
      router({
        'POST /repos/acme/site/git/refs': () => ({ status: 422, body: { message: 'Reference already exists' } }),
      }),
    );
    const error = await rejection(clientFor(fake.origin).createBranch('feat/x', 'abc'));
    expect(error.code).toBe('conflict');
  });
});

describe('GitHub client: pull requests', () => {
  const prBody = {
    number: 7,
    state: 'closed',
    merged: true,
    merge_commit_sha: 'merge7',
    head: { sha: 'head7' },
    base: { sha: 'base7' },
    mergeable_state: 'clean',
    draft: false,
    html_url: 'https://github.com/acme/site/pull/7',
  };

  it('opens a draft PR and reads it back', async () => {
    const fake = await startFakeServer(
      router({
        'POST /repos/acme/site/pulls': (call) => ({
          status: 201,
          body: { ...prBody, state: 'open', merged: false, merge_commit_sha: null, draft: (call.body as { draft: boolean }).draft },
        }),
        'GET /repos/acme/site/pulls/7': () => ({ body: prBody }),
      }),
    );
    const client = clientFor(fake.origin);
    const opened = await client.openPullRequest({ title: 'Title', body: 'Body', head: 'feat/x', base: 'main', draft: true });
    expect(opened).toMatchObject({ number: 7, state: 'open', draft: true, headSha: 'head7', baseSha: 'base7' });
    expect(fake.calls[0]!.body).toMatchObject({ head: 'feat/x', base: 'main', draft: true });

    expect(await client.getPullRequest(7)).toEqual({
      number: 7,
      state: 'closed',
      merged: true,
      mergeCommitSha: 'merge7',
      headSha: 'head7',
      baseSha: 'base7',
      mergeableState: 'clean',
      draft: false,
      htmlUrl: 'https://github.com/acme/site/pull/7',
    });
  });

  it('lists the PR commits and returns the head SHA to compare with the approved one', async () => {
    const fake = await startFakeServer(
      router({
        'GET /repos/acme/site/pulls/7': () => ({ body: { head: { sha: 'c2' } } }),
        'GET /repos/acme/site/pulls/7/commits': () => ({
          body: [
            { sha: 'c1', commit: { message: 'First', author: { name: 'A', date: '2026-01-01T00:00:00Z' } } },
            { sha: 'c2', commit: { message: 'Second', author: { name: 'B', date: '2026-01-02T00:00:00Z' } } },
          ],
        }),
      }),
    );
    expect(await clientFor(fake.origin).listPullRequestCommits(7)).toEqual({
      headSha: 'c2',
      commits: [
        { sha: 'c1', message: 'First', authorName: 'A', date: '2026-01-01T00:00:00Z' },
        { sha: 'c2', message: 'Second', authorName: 'B', date: '2026-01-02T00:00:00Z' },
      ],
    });
  });

  it('takes the head SHA from the PR and reads every commit page', async () => {
    const fake = await startFakeServer(
      router({
        'GET /repos/acme/site/pulls/8': () => ({ body: { head: { sha: 'head-final' } } }),
        'GET /repos/acme/site/pulls/8/commits': (call) =>
          call.path.includes('page=2')
            ? { body: [{ sha: 'c3', commit: { message: 'Third', author: { name: 'C', date: '2026-01-03T00:00:00Z' } } }] }
            : {
                body: [
                  { sha: 'c1', commit: { message: 'First', author: { name: 'A', date: '2026-01-01T00:00:00Z' } } },
                  { sha: 'c2', commit: { message: 'Second', author: { name: 'B', date: '2026-01-02T00:00:00Z' } } },
                ],
                headers: { link: '</repos/acme/site/pulls/8/commits?per_page=100&page=2>; rel="next"' },
              },
      }),
    );
    const listed = await clientFor(fake.origin).listPullRequestCommits(8);
    // The head is not the last commit of the first page when the PR has more than one page.
    expect(listed.headSha).toBe('head-final');
    expect(listed.commits.map((commit) => commit.sha)).toEqual(['c1', 'c2', 'c3']);
    expect(fake.calls.filter((call) => call.path.startsWith('/repos/acme/site/pulls/8/commits'))).toHaveLength(2);
  });

  it('compares commits', async () => {
    const fake = await startFakeServer(
      router({
        'GET /repos/acme/site/compare/merge1...deployed1': () => ({
          body: { status: 'ahead', ahead_by: 2, behind_by: 0, total_commits: 2 },
        }),
      }),
    );
    expect(await clientFor(fake.origin).compareCommits('merge1', 'deployed1')).toEqual({
      status: 'ahead',
      aheadBy: 2,
      behindBy: 0,
      totalCommits: 2,
    });
  });

  it('detects whether a file is unchanged between the merge and the branch head', async () => {
    const fake = await startFakeServer(
      router({
        'GET /repos/acme/site/contents/about/index.html': () => ({
          body: { type: 'file', path: 'about/index.html', sha: 'same', encoding: 'base64', content: Buffer.from('x').toString('base64') },
        }),
      }),
    );
    expect(await clientFor(fake.origin).fileUnchanged('about/index.html', 'merge1', 'head1')).toEqual({
      unchanged: true,
      firstSha: 'same',
      secondSha: 'same',
    });
  });
});

describe('GitHub client: failures', () => {
  it('turns a rate limit into a typed error with the reset time and no token', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3_600;
    const fake = await startFakeServer(
      router({
        'GET /repos/acme/site': () => ({
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
          body: { message: 'API rate limit exceeded' },
        }),
      }),
    );
    const error = await rejection(clientFor(fake.origin).getDefaultBranch());
    expect(error.code).toBe('rate_limit');
    expect(error.retryAt).toBeInstanceOf(Date);
    expect(error.retryAt?.getTime()).toBe(reset * 1_000);
    expect(error.message).not.toContain(TOKEN);
  });

  it('maps 422 to a validation error and redacts a token echoed by GitHub', async () => {
    const fake = await startFakeServer(
      router({
        'POST /repos/acme/site/pulls': () => ({
          status: 422,
          body: { message: `Validation Failed for ${TOKEN}`, errors: [{ field: 'head', message: 'No commits between main and feat/x' }] },
        }),
      }),
    );
    const error = await rejection(clientFor(fake.origin).openPullRequest({ title: 'T', body: 'B', head: 'feat/x', base: 'main' }));
    expect(error.code).toBe('validation');
    expect(error.message).toContain('No commits between main and feat/x');
    expect(error.message).not.toContain(TOKEN);
  });

  it('maps 401 to an unauthorized error that says what to do', async () => {
    const fake = await startFakeServer(router({ 'GET /repos/acme/site': () => ({ status: 401, body: { message: 'Bad credentials' } }) }));
    const error = await rejection(clientFor(fake.origin).getDefaultBranch());
    expect(error.code).toBe('unauthorized');
    expect(error.message).toContain('fine-grained token');
    expect(error.message).not.toContain(TOKEN);
  });

  it('keeps the token out of the whole error object when the request seam throws', async () => {
    const client = new GitHubClient({
      token: TOKEN,
      owner: OWNER,
      repo: REPO,
      baseUrl: 'http://127.0.0.1:9',
      request: async () => {
        throw new Error(`socket hang up while sending (authorization: Bearer ${TOKEN})`);
      },
    });
    const error = await rejection(client.getDefaultBranch());
    expect(error.code).toBe('network');
    // The message is redacted, but the cause chain, the details and `util.inspect` are all read by
    // loggers, so every one of them has to be clean too.
    const texts: string[] = [error.message, inspect(error), JSON.stringify(error.details ?? null)];
    let current: unknown = error;
    while (current instanceof Error) {
      texts.push(current.message, inspect(current));
      current = current.cause;
    }
    for (const text of texts) expect(text).not.toContain(TOKEN);
  });
});

describe('GitHub client: revert', () => {
  it('refuses a revert when a touched file changed after the merge', async () => {
    const fake = await startFakeServer(
      router({
        'GET /repos/acme/site/git/ref/heads/main': () => ({ body: { object: { sha: 'head1' } } }),
        'GET /repos/acme/site/contents/about/index.html': (call) => ({
          body: {
            type: 'file',
            path: 'about/index.html',
            sha: call.path.includes('ref=merge1') ? 'merged' : 'newer',
            encoding: 'base64',
            content: Buffer.from('x').toString('base64'),
          },
        }),
      }),
    );
    const error = await rejection(
      clientFor(fake.origin).revertPullRequest({
        mergeCommitSha: 'merge1',
        paths: ['about/index.html'],
        branch: 'revert/about',
        base: 'main',
        title: 'Revert the about change',
        body: 'The change failed verification.',
      }),
    );
    expect(error.code).toBe('unsafe_revert');
    expect(error.message).toContain('about/index.html');
    expect(fake.calls.some((call) => call.method === 'POST' && call.path === '/repos/acme/site/git/refs')).toBe(false);
  });

  it('opens a revert PR from the merge commit parent contents when the files still match', async () => {
    let blob = 0;
    const fake = await startFakeServer(
      router({
        'GET /repos/acme/site/git/ref/heads/main': () => ({ body: { object: { sha: 'head1' } } }),
        'GET /repos/acme/site/contents/about/index.html': (call) => {
          if (call.path.includes('ref=parent1')) {
            return {
              body: {
                type: 'file',
                path: 'about/index.html',
                sha: 'parentBlob',
                encoding: 'base64',
                content: Buffer.from('<title>Old</title>').toString('base64'),
              },
            };
          }
          return {
            body: {
              type: 'file',
              path: 'about/index.html',
              sha: 'mergedBlob',
              encoding: 'base64',
              content: Buffer.from('<title>New</title>').toString('base64'),
            },
          };
        },
        'GET /repos/acme/site/git/commits/merge1': () => ({ body: { parents: [{ sha: 'parent1' }] } }),
        'POST /repos/acme/site/git/refs': () => ({ status: 201, body: { ref: 'refs/heads/revert/about' } }),
        'POST /repos/acme/site/git/blobs': () => {
          blob += 1;
          return { status: 201, body: { sha: `blob${blob}` } };
        },
        'GET /repos/acme/site/git/commits/head1': () => ({ body: { tree: { sha: 'tree0' } } }),
        'POST /repos/acme/site/git/trees': () => ({ status: 201, body: { sha: 'tree1' } }),
        'POST /repos/acme/site/git/commits': () => ({ status: 201, body: { sha: 'commit1' } }),
        'PATCH /repos/acme/site/git/refs/heads/revert/about': () => ({ body: { object: { sha: 'commit1' } } }),
        'POST /repos/acme/site/pulls': () => ({
          status: 201,
          body: {
            number: 9,
            state: 'open',
            merged: false,
            merge_commit_sha: null,
            head: { sha: 'commit1' },
            base: { sha: 'head1' },
            mergeable_state: 'clean',
            draft: true,
            html_url: 'https://github.com/acme/site/pull/9',
          },
        }),
      }),
    );

    const result = await clientFor(fake.origin).revertPullRequest({
      mergeCommitSha: 'merge1',
      paths: ['about/index.html'],
      branch: 'revert/about',
      base: 'main',
      title: 'Revert the about change',
      body: 'The change failed verification.',
      draft: true,
    });

    expect(result.commitSha).toBe('commit1');
    expect(result.pullRequest).toMatchObject({ number: 9, draft: true, headSha: 'commit1' });
    const blobCall = fake.calls.find((call) => call.method === 'POST' && call.path === '/repos/acme/site/git/blobs');
    expect(blobCall?.body).toEqual({ content: '<title>Old</title>', encoding: 'utf-8' });
    expect(fake.calls.find((call) => call.method === 'GET' && call.path.includes('ref=parent1'))).toBeDefined();
  });
});
