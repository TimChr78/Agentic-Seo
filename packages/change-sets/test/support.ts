import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
/** The shape packages/fetch resolves a name to; a test only needs loopback. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

// Two local fixtures, so no test in this package reaches the internet:
//
// - `startFakeGitHub` is an in-memory repository that speaks the REST calls GitHubClient makes. It
//   models commits as file snapshots, so a branch, a merge and a revert behave the way the client
//   expects, and it can drop the response to a pull-request creation after recording it — which is
//   the timeout a retried apply job must survive.
// - `startSiteFixture` is the "deployed site": mutable pages plus `/version.txt`, which is how the
//   ADR's direct-upload deploy publishes the commit it built. A test changes a page to model a
//   deploy, so verification sees the page the deploy serves.

export interface FakeCall {
  method: string;
  path: string;
  body: unknown;
  headers: IncomingHttpHeaders;
  at: number;
}

const DONE = Symbol('handled');

/** One path in the fake repository's tree: what the git tree API reports for it. */
export interface FakeTreeEntry {
  type: 'blob' | 'commit';
  mode: string;
  sha: string;
}

interface Commit {
  /** The tree sha the client sees; a commit's whole entry set. */
  tree: string;
  parents: string[];
  message: string;
}

export interface FakePullRequest {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  draft: boolean;
  htmlUrl: string;
  headSha: string;
  baseSha: string;
}

/** The git object SHA GitHub reports for a blob: sha1("blob <bytes>\0" + content). */
const blobSha = (content: string) =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(content, 'utf8')}\0`)
    .update(content, 'utf8')
    .digest('hex');

/** A local GitHub REST server with an in-memory repository. */
export class FakeGitHub {
  readonly owner = 'acme';
  readonly repo = 'site';
  readonly branches = new Map<string, string>();
  readonly commits = new Map<string, Commit>();
  readonly trees = new Map<string, Map<string, FakeTreeEntry>>();
  readonly blobs = new Map<string, string>();
  readonly pullRequests: FakePullRequest[] = [];
  readonly calls: FakeCall[] = [];
  readonly deployments: { id: number; sha: string; environment: string; state: string }[] = [];
  /** When set, the next pull-request creation records the PR and then drops the connection. */
  timeoutNextPullRequest = false;
  /** Every response the server wrote, for a test that asserts a path was never called. */
  readonly paths: string[] = [];
  private server!: Server;
  private counter = 0;
  origin = '';

  constructor(
    readonly defaultBranch: string,
    files: Record<string, string>,
  ) {
    const initial = this.newSha();
    const tree = `tree-${initial}`;
    const snapshot = new Map<string, FakeTreeEntry>();
    for (const [path, content] of Object.entries(files)) snapshot.set(path, this.blobEntry(content));
    this.trees.set(tree, snapshot);
    this.commits.set(initial, { tree, parents: [], message: 'seed' });
    this.branches.set(defaultBranch, initial);
  }

  private newSha(): string {
    this.counter += 1;
    return this.counter.toString(16).padStart(40, '0');
  }

  /** A regular-file entry for some content, stored as a blob. */
  private blobEntry(content: string): FakeTreeEntry {
    const sha = blobSha(content);
    this.blobs.set(sha, content);
    return { type: 'blob', mode: '100644', sha };
  }

  async start(): Promise<this> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = raw;
        }
        const call: FakeCall = {
          method: request.method ?? 'GET',
          path: request.url ?? '/',
          body,
          headers: request.headers,
          at: Date.now(),
        };
        this.calls.push(call);
        this.paths.push(call.path);
        if (this.handle(call, response) === DONE) return;
        this.json(response, 404, { message: 'Not Found' });
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server?.closeAllConnections?.();
      this.server?.close(() => resolve());
    });
  }

  /** The seam a command or worker gets: the real fetch against this server. */
  get seam() {
    return { request: (url: string, init: RequestInit) => fetch(url, init), baseUrl: this.origin };
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(payload);
  }

  /** The entries at a branch or commit, or null when it does not exist. */
  private entriesAt(ref: string): Map<string, FakeTreeEntry> | null {
    const sha = this.branches.get(ref) ?? (this.commits.has(ref) ? ref : null);
    if (!sha) return null;
    const commit = this.commits.get(sha);
    if (!commit) return null;
    return this.trees.get(commit.tree) ?? new Map();
  }

  filesAt(ref: string): Map<string, string> | null {
    const entries = this.entriesAt(ref);
    if (!entries) return null;
    const files = new Map<string, string>();
    for (const [path, entry] of entries) if (entry.type === 'blob') files.set(path, this.blobs.get(entry.sha) ?? '');
    return files;
  }

  /** The commit a branch points at, or null. */
  headOf(branch: string): string | null {
    return this.branches.get(branch) ?? null;
  }

  /** Writes a file straight onto a branch, the way a person editing the pull request would. */
  pushToBranch(branch: string, files: Record<string, string>): string {
    const entries = new Map(this.entriesAt(branch) ?? []);
    for (const [path, content] of Object.entries(files)) entries.set(path, this.blobEntry(content));
    return this.commitOn(branch, entries, 'push');
  }

  /**
   * Writes any tree entry onto a branch, the way a pushed commit can: a different mode (an
   * executable bit, a symlink), a submodule, or a deletion with `null`. A test uses it to model what
   * a pull request can carry that the reviewed change did not.
   */
  pushEntry(branch: string, path: string, entry: FakeTreeEntry | null): string {
    const entries = new Map(this.entriesAt(branch) ?? []);
    if (entry === null) entries.delete(path);
    else entries.set(path, entry);
    return this.commitOn(branch, entries, 'push');
  }

  /**
   * Rewrites a branch's head commit as a single commit on its base with a mutated entry set: the way
   * a squashed or force-pushed pull-request commit can carry something the reviewed change did not.
   */
  rewriteHead(branch: string, mutate: (entries: Map<string, FakeTreeEntry>, blob: (content: string) => FakeTreeEntry) => void): string {
    const headSha = this.branches.get(branch);
    if (!headSha) throw new Error(`no branch ${branch}`);
    const head = this.commits.get(headSha);
    if (!head) throw new Error(`no commit ${headSha}`);
    const entries = new Map(this.trees.get(head.tree) ?? []);
    mutate(entries, (content) => this.blobEntry(content));
    const sha = this.newSha();
    const tree = `tree-${sha}`;
    this.trees.set(tree, entries);
    this.commits.set(sha, { tree, parents: head.parents.slice(0, 1), message: head.message });
    this.branches.set(branch, sha);
    for (const pr of this.pullRequests) if (pr.head === branch) pr.headSha = sha;
    return sha;
  }

  /** A commit with the given entries whose parent is the branch's head. */
  private commitOn(branch: string, entries: Map<string, FakeTreeEntry>, message: string): string {
    const parent = this.branches.get(branch);
    if (!parent) throw new Error(`no branch ${branch}`);
    const sha = this.newSha();
    const tree = `tree-${sha}`;
    this.trees.set(tree, entries);
    this.commits.set(sha, { tree, parents: [parent], message });
    this.branches.set(branch, sha);
    for (const pr of this.pullRequests) if (pr.head === branch) pr.headSha = sha;
    return sha;
  }

  /** Stores a blob as an interrupted commit sequence would have left it, and returns its SHA. */
  putBlob(content: string): string {
    const sha = blobSha(content);
    this.blobs.set(sha, content);
    return sha;
  }

  /** Merges a pull request: a merge commit with the head's files and the base updated. */
  merge(number: number): string {
    const pr = this.pullRequests.find((candidate) => candidate.number === number);
    if (!pr) throw new Error(`no pull request #${number}`);
    const head = new Map(this.entriesAt(pr.head) ?? this.entriesAt(pr.headSha) ?? []);
    const baseSha = this.branches.get(pr.base)!;
    const sha = this.newSha();
    const tree = `tree-${sha}`;
    this.trees.set(tree, head);
    this.commits.set(sha, { tree, parents: [baseSha, this.branches.get(pr.head) ?? pr.headSha], message: `Merge #${number}` });
    this.branches.set(pr.base, sha);
    pr.merged = true;
    pr.state = 'closed';
    pr.mergeCommitSha = sha;
    return sha;
  }

  /** Closes a pull request without merging it. */
  closePr(number: number): void {
    const pr = this.pullRequests.find((candidate) => candidate.number === number);
    if (pr) pr.state = 'closed';
  }

  /** A deployment with a status, for the github_deployments detector. */
  deploy(sha: string, environment = 'production', state = 'success'): void {
    this.deployments.push({ id: this.deployments.length + 1, sha, environment, state });
  }

  private isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length) {
      const sha = queue.shift()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      for (const parent of this.commits.get(sha)?.parents ?? []) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  private pullRequestFrom(pr: FakePullRequest): Record<string, unknown> {
    return {
      number: pr.number,
      state: pr.state,
      merged: pr.merged,
      merge_commit_sha: pr.mergeCommitSha,
      head: { sha: pr.headSha },
      base: { sha: this.branches.get(pr.base) ?? pr.baseSha },
      mergeable_state: 'clean',
      draft: pr.draft,
      html_url: `${this.origin}/${this.owner}/${this.repo}/pull/${pr.number}`,
    };
  }

  /** Routes one call; returns DONE when it answered. */
  private handle(call: FakeCall, response: ServerResponse): typeof DONE | undefined {
    const url = new URL(call.path, 'http://fake');
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    // /repos/{owner}/{repo}/...
    if (segments[0] !== 'repos' || segments[1] !== this.owner || segments[2] !== this.repo) return;
    const rest = segments.slice(3);
    const method = call.method;
    const decodeRef = (value: string) => value;

    if (rest.length === 0 && method === 'GET') {
      this.json(response, 200, { default_branch: this.defaultBranch });
      return DONE;
    }
    if (rest[0] === 'git' && rest[1] === 'ref' && rest[2] === 'heads' && method === 'GET') {
      const branch = decodeRef(rest.slice(3).join('/'));
      const sha = this.branches.get(branch);
      if (!sha) {
        this.json(response, 404, { message: 'Not Found' });
        return DONE;
      }
      this.json(response, 200, { ref: `refs/heads/${branch}`, object: { sha } });
      return DONE;
    }
    if (rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && method === 'PATCH') {
      const branch = decodeRef(rest.slice(3).join('/'));
      const sha = String((call.body as { sha?: string } | null)?.sha ?? '');
      if (!this.branches.has(branch)) {
        this.json(response, 422, { message: 'Reference does not exist' });
        return DONE;
      }
      this.branches.set(branch, sha);
      this.json(response, 200, { object: { sha } });
      return DONE;
    }
    if (rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      const body = (call.body ?? {}) as { ref?: string; sha?: string };
      const branch = String(body.ref ?? '').replace(/^refs\/heads\//, '');
      if (this.branches.has(branch)) {
        this.json(response, 422, { message: 'Reference already exists' });
        return DONE;
      }
      this.branches.set(branch, String(body.sha ?? ''));
      this.json(response, 201, { ref: body.ref, object: { sha: body.sha } });
      return DONE;
    }
    if (rest[0] === 'git' && rest[1] === 'commits' && method === 'GET') {
      const sha = decodeRef(rest[2] ?? '');
      const commit = this.commits.get(sha) ?? this.commits.get(this.branches.get(sha) ?? '');
      if (!commit) {
        this.json(response, 404, { message: 'Not Found' });
        return DONE;
      }
      this.json(response, 200, {
        sha,
        message: commit.message,
        tree: { sha: commit.tree },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      });
      return DONE;
    }
    if (rest[0] === 'git' && rest[1] === 'blobs' && method === 'POST') {
      const content = String((call.body as { content?: string } | null)?.content ?? '');
      const sha = blobSha(content);
      this.blobs.set(sha, content);
      this.json(response, 201, { sha });
      return DONE;
    }
    if (rest[0] === 'git' && rest[1] === 'trees' && method === 'POST') {
      const body = (call.body ?? {}) as {
        base_tree?: string;
        tree?: { path: string; mode?: string; type?: string; sha: string | null }[];
      };
      const entries = new Map(this.trees.get(String(body.base_tree ?? '')) ?? new Map<string, FakeTreeEntry>());
      for (const entry of body.tree ?? []) {
        if (entry.sha === null) entries.delete(entry.path);
        else
          entries.set(entry.path, {
            type: entry.type === 'commit' ? 'commit' : 'blob',
            mode: entry.mode ?? '100644',
            sha: entry.sha,
          });
      }
      const sha = this.newSha();
      this.trees.set(sha, entries);
      this.json(response, 201, { sha });
      return DONE;
    }
    if (rest[0] === 'git' && rest[1] === 'commits' && method === 'POST') {
      const body = (call.body ?? {}) as { message?: string; tree?: string; parents?: string[] };
      const tree = String(body.tree ?? '');
      const sha = this.newSha();
      this.commits.set(sha, { tree, parents: body.parents ?? [], message: body.message ?? '' });
      this.json(response, 201, { sha });
      return DONE;
    }
    if (rest[0] === 'contents' && method === 'GET') {
      const path = rest.slice(1).join('/');
      const ref = url.searchParams.get('ref') ?? this.branches.get(this.defaultBranch)!;
      const entry = this.entriesAt(ref)?.get(path);
      if (entry?.type !== 'blob') {
        this.json(response, 404, { message: 'Not Found' });
        return DONE;
      }
      const content = this.blobs.get(entry.sha) ?? '';
      this.json(response, 200, {
        type: 'file',
        path,
        sha: entry.sha,
        size: Buffer.byteLength(content, 'utf8'),
        encoding: 'base64',
        content: Buffer.from(content, 'utf8').toString('base64'),
      });
      return DONE;
    }
    if (rest[0] === 'git' && rest[1] === 'trees' && method === 'GET') {
      const ref = decodeRef(rest[2] ?? '');
      const entries = this.entriesAt(ref);
      if (!entries) {
        this.json(response, 404, { message: 'Not Found' });
        return DONE;
      }
      this.json(response, 200, {
        truncated: false,
        tree: [...entries].map(([path, entry]) => ({ path, type: entry.type, mode: entry.mode, sha: entry.sha })),
      });
      return DONE;
    }
    if (rest[0] === 'pulls' && method === 'POST') {
      const body = (call.body ?? {}) as { title?: string; body?: string; head?: string; base?: string; draft?: boolean };
      const head = String(body.head ?? '');
      const existing = this.pullRequests.find((pr) => pr.head === head && pr.state === 'open');
      if (existing) {
        this.json(response, 422, { message: 'A pull request already exists for this head' });
        return DONE;
      }
      const pr: FakePullRequest = {
        number: this.pullRequests.length + 1,
        head,
        base: String(body.base ?? this.defaultBranch),
        title: String(body.title ?? ''),
        body: String(body.body ?? ''),
        state: 'open',
        merged: false,
        mergeCommitSha: null,
        draft: body.draft === true,
        htmlUrl: `${this.origin}/${this.owner}/${this.repo}/pull/${this.pullRequests.length + 1}`,
        headSha: this.branches.get(head) ?? '',
        baseSha: this.branches.get(String(body.base ?? this.defaultBranch)) ?? '',
      };
      this.pullRequests.push(pr);
      if (this.timeoutNextPullRequest) {
        // The pull request exists; the caller never learns that. The retry must adopt it.
        this.timeoutNextPullRequest = false;
        response.destroy();
        return DONE;
      }
      this.json(response, 201, this.pullRequestFrom(pr));
      return DONE;
    }
    if (rest[0] === 'pulls' && rest.length === 1 && method === 'GET') {
      const head = url.searchParams.get('head') ?? '';
      const branch = head.includes(':') ? head.slice(head.indexOf(':') + 1) : head;
      const state = url.searchParams.get('state') ?? 'open';
      const list = this.pullRequests.filter((pr) => pr.head === branch && (state === 'all' || pr.state === state));
      this.json(
        response,
        200,
        list.map((pr) => this.pullRequestFrom(pr)),
      );
      return DONE;
    }
    if (rest[0] === 'pulls' && rest[1] && method === 'GET') {
      const pr = this.pullRequests.find((candidate) => candidate.number === Number(rest[1]));
      if (!pr) {
        this.json(response, 404, { message: 'Not Found' });
        return DONE;
      }
      this.json(response, 200, this.pullRequestFrom(pr));
      return DONE;
    }
    if (rest[0] === 'pulls' && rest[1] && method === 'PATCH') {
      const pr = this.pullRequests.find((candidate) => candidate.number === Number(rest[1]));
      if (!pr) {
        this.json(response, 404, { message: 'Not Found' });
        return DONE;
      }
      if ((call.body as { state?: string } | null)?.state === 'closed') pr.state = 'closed';
      this.json(response, 200, this.pullRequestFrom(pr));
      return DONE;
    }
    if (rest[0] === 'compare' && method === 'GET') {
      const [basePart, headPart] = (rest[1] ?? '').split('...');
      const base = this.branches.get(decodeRef(basePart ?? '')) ?? basePart ?? '';
      const head = this.branches.get(decodeRef(headPart ?? '')) ?? headPart ?? '';
      const status =
        base === head ? 'identical' : this.isAncestor(base, head) ? 'ahead' : this.isAncestor(head, base) ? 'behind' : 'diverged';
      this.json(response, 200, { status, ahead_by: status === 'ahead' ? 1 : 0, behind_by: status === 'behind' ? 1 : 0, total_commits: 1 });
      return DONE;
    }
    if (rest[0] === 'deployments' && rest.length === 1 && method === 'GET') {
      const environment = url.searchParams.get('environment');
      const list = this.deployments.filter((deployment) => !environment || deployment.environment === environment);
      this.json(
        response,
        200,
        list.map((deployment) => ({
          id: deployment.id,
          sha: deployment.sha,
          ref: 'main',
          environment: deployment.environment,
          created_at: new Date().toISOString(),
        })),
      );
      return DONE;
    }
    if (rest[0] === 'deployments' && rest[2] === 'statuses' && method === 'GET') {
      const deployment = this.deployments.find((candidate) => candidate.id === Number(rest[1]));
      this.json(
        response,
        200,
        deployment ? [{ id: 1, state: deployment.state, description: null, created_at: new Date().toISOString() }] : [],
      );
      return DONE;
    }
    return;
  }
}

/** Starts the fake GitHub and returns it ready to use. */
export async function startFakeGitHub(defaultBranch: string, files: Record<string, string>): Promise<FakeGitHub> {
  return new FakeGitHub(defaultBranch, files).start();
}

// ---------------------------------------------------------------------------------------------
// The deployed site
// ---------------------------------------------------------------------------------------------

export interface SiteFixture {
  readonly origin: string;
  readonly port: number;
  /** The allow-list and resolver entries the crawler's fetch seams need. */
  readonly allow: { privateHosts: string[]; ports: number[] };
  readonly resolver: (hostname: string) => Promise<ReadonlyArray<ResolvedAddress>>;
  setPage(path: string, html: string, status?: number): void;
  /** A redirecting route, as the deployed site serves it: status and Location. */
  setRedirect(from: string, to: string, status?: 301 | 302 | 307 | 308): void;
  /** What the build writes: the deployed commit's SHA on the first line. */
  setVersion(sha: string | null): void;
  close(): Promise<void>;
}

const LOOPBACK: ReadonlyArray<ResolvedAddress> = [{ address: '127.0.0.1', family: 4 }];

/** A mutable local site over plain HTTP: pages, redirects and the version file a deploy writes. */
export async function startSiteFixture(): Promise<SiteFixture> {
  const pages = new Map<string, { body: string; status: number; headers: Record<string, string> }>();
  let version: string | null = null;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture').pathname;
    if (path === '/version.txt') {
      if (version === null) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`${version}\nbuilt 2026-11-15T08:00:00Z\n`);
      return;
    }
    const page = pages.get(path);
    if (!page) {
      response.writeHead(404, { 'content-type': 'text/html' });
      response.end('<html><head><title>Not found</title></head><body>No such page</body></html>');
      return;
    }
    response.writeHead(page.status, { 'content-type': 'text/html; charset=utf-8', ...page.headers });
    response.end(page.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    allow: { privateHosts: ['127.0.0.1'], ports: [port] },
    resolver: async (hostname: string) => {
      if (hostname === '127.0.0.1') return LOOPBACK;
      const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
      error.code = 'ENOTFOUND';
      throw error;
    },
    setPage: (path, html, status = 200) => pages.set(path, { body: html, status, headers: {} }),
    setRedirect: (from, to, status = 301) => pages.set(from, { body: '', status, headers: { location: to } }),
    setVersion: (sha) => {
      version = sha;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** An HTML page with one title and an optional description, for a fixture route. */
export function pageHtml(title: string, description?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${
    description === undefined ? '' : `<meta name="description" content="${description}">`
  }</head><body><h1>${title}</h1></body></html>`;
}

/** A unique site domain per test, so `sites_active_domain` never collides. */
export const uniqueDomain = () => `site-${randomUUID().slice(0, 8)}.example`;
