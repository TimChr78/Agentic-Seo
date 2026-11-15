import { redactCredentials } from '@agentic-seo/core';
import { buildUserAgent, checkEgressUrl, egressFetch } from '@agentic-seo/fetch';

// A small read/write client for the GitHub REST API (ADR-0007's first connector). It rides
// packages/fetch's egress guard: production points at https://api.github.com and nowhere else,
// the name is resolved and pinned by the guard, and a redirect is refused. Tests inject a request
// seam and a local base URL; the fixed host is enforced when they do not.
//
// The token is passed per call by the caller and never appears in a message, an error or a log
// line: GitHub's own error text goes through core's redaction before it is shown. Rate limits are
// reported, not slept on — a worker job can be retried later, and a request that waited an hour
// would hold a database connection for nothing.
//
// The operations are the minimum a pull-request connector needs: read a ref and a file, make one
// commit from several file edits, open and read a PR, detect a push after approval (compare SHAs),
// compare commits for deployment detection, and revert a merge only when the files still match it.

export const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
/** A cap on commit-list pagination: 100 pages of 100 is far beyond a reviewable pull request. */
const MAX_COMMIT_PAGES = 100;

export type GitHubErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'unsafe_revert'
  | 'invalid';

export interface GitHubErrorOptions {
  status?: number;
  /** When a rate-limited request may be retried. */
  retryAt?: Date;
  details?: unknown;
  cause?: unknown;
}

/** A GitHub failure with a code and a message written for a person or an agent to act on. */
export class GitHubError extends Error {
  readonly code: GitHubErrorCode;
  readonly status: number | undefined;
  readonly retryAt: Date | undefined;
  readonly details: unknown;

  constructor(code: GitHubErrorCode, message: string, options: GitHubErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GitHubError';
    this.code = code;
    this.status = options.status;
    this.retryAt = options.retryAt;
    this.details = options.details;
  }
}

/** The request seam: production is `egressFetch`, a test is the global fetch against a local server. */
export type GitHubRequest = (url: string, init: RequestInit) => Promise<Response>;

export interface GitHubClientOptions {
  token: string;
  owner: string;
  repo: string;
  /**
   * Test-only request seam. When it is absent, requests go through the egress guard to
   * {@link GITHUB_API_ORIGIN}; when it is present, `baseUrl` may point at a local fake server.
   */
  request?: GitHubRequest;
  /** Test-only API base. It is refused with the default request, so production cannot leave GitHub. */
  baseUrl?: string;
  /** Default `AgenticSEO/0.0.0`; production passes its build version. */
  userAgent?: string;
  apiVersion?: string;
}

export interface GitHubFile {
  path: string;
  /** The git blob SHA. */
  sha: string;
  content: string;
  size: number;
}

export interface GitHubRef {
  branch: string;
  sha: string;
}

export interface GitHubPullRequest {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  headSha: string;
  baseSha: string;
  mergeableState: string | null;
  draft: boolean;
  htmlUrl: string;
}

export interface GitHubCommitSummary {
  sha: string;
  message: string;
  authorName: string | null;
  date: string | null;
}

/** A commit's identity: its tree and parents, for verifying a commit a retried job adopts. */
export interface GitHubCommit {
  sha: string;
  treeSha: string;
  parents: string[];
}

/** One blob entry of a tree, with the git object SHA. */
export interface GitHubTreeEntry {
  path: string;
  sha: string;
}

export type CompareStatus = 'ahead' | 'behind' | 'diverged' | 'identical';

export interface GitHubComparison {
  status: CompareStatus;
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
}

export interface GitHubDeployment {
  id: number;
  sha: string;
  ref: string;
  environment: string;
  createdAt: string | null;
}

export interface GitHubDeploymentStatus {
  id: number;
  state: string;
  description: string | null;
  createdAt: string | null;
}

export interface CommitFile {
  path: string;
  /** The new contents; `null` deletes the file. */
  content: string | null;
}

export interface CommitAuthor {
  name: string;
  email: string;
}

export interface CommitFilesInput {
  branch: string;
  /** The commit the branch points at; the new commit's parent. */
  baseSha: string;
  message: string;
  files: CommitFile[];
  author?: CommitAuthor;
  committer?: CommitAuthor;
}

export interface CommitFilesResult {
  commitSha: string;
  treeSha: string;
  files: { path: string; blobSha: string | null }[];
}

export interface OpenPullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

export interface RevertPullRequestInput {
  /** The merge commit of the change set being reverted. */
  mergeCommitSha: string;
  /** Every file the change set touched. */
  paths: readonly string[];
  /** The new branch to open the revert from. */
  branch: string;
  /** The branch the revert PR targets; defaults to the repository's default branch. */
  base?: string;
  title: string;
  body: string;
  draft?: boolean;
  /** Author and committer for the revert commit; default to GitHub's token identity. */
  author?: CommitAuthor;
  committer?: CommitAuthor;
  /**
   * Refuse when a touched file changed after `mergeCommitSha` (the ADR's safe-rollback rule).
   * Defaults to true; a caller that wants a proposal rather than a revert sets it false.
   */
  requireUnchanged?: boolean;
}

export interface RevertPullRequestResult {
  pullRequest: GitHubPullRequest;
  commitSha: string;
  files: { path: string; blobSha: string | null }[];
}

interface CallOptions {
  /** What a 404 is about, for the message: "the branch feat/x", "the file about/index.html". */
  notFound?: string;
}

interface CallResult<T> {
  data: T;
  headers: Record<string, string>;
}

function redact(text: string): string {
  return redactCredentials(text);
}

/**
 * A copy of a thrown error that is safe to keep as a `cause`: the message is redacted and nothing
 * of the original stack or its own cause chain survives. A seam error can carry the request (and
 * therefore the bearer token) in its text, and `Error.cause` is read by loggers and `util.inspect`,
 * so the original must not be attached even when the outer message is clean.
 */
function sanitisedCause(error: unknown): Error {
  if (error instanceof Error) {
    const copy = new Error(redact(error.message));
    copy.name = error.name;
    return copy;
  }
  return new Error(redact(String(error)));
}

/** A path with each segment encoded, keeping the slashes. */
function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function headerValue(response: Response, name: string): string | undefined {
  return response.headers.get(name) ?? undefined;
}

function retryAtFrom(response: Response): Date | null {
  const now = Date.now();
  const retryAfter = headerValue(response, 'retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return new Date(now + seconds * 1_000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return new Date(date);
  }
  const reset = headerValue(response, 'x-ratelimit-reset');
  if (reset) {
    const epoch = Number(reset);
    if (Number.isFinite(epoch) && epoch > 0) return new Date(epoch * 1_000);
  }
  return null;
}

/** The `rel="next"` target of a Link header (`<...>; rel="next", <...>; rel="last"`), or null. */
function nextLink(headers: Record<string, string>): string | null {
  const link = headers.link;
  if (!link) return null;
  for (const part of link.split(',')) {
    const matched = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part.trim());
    if (matched) return matched[1]!;
  }
  return null;
}

function isRateLimited(response: Response, status: number): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  return headerValue(response, 'x-ratelimit-remaining') === '0' || headerValue(response, 'retry-after') !== undefined;
}

function bodyMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const message = (body as { message?: unknown }).message;
  const errors = (body as { errors?: unknown }).errors;
  const parts: string[] = [];
  if (typeof message === 'string' && message.trim()) parts.push(message.trim());
  if (Array.isArray(errors)) {
    for (const error of errors) {
      if (typeof error !== 'object' || error === null) continue;
      const text = (error as { message?: unknown }).message;
      const field = (error as { field?: unknown }).field;
      if (typeof text === 'string' && text.trim())
        parts.push(typeof field === 'string' && field.trim() ? `${field}: ${text.trim()}` : text.trim());
    }
  }
  return parts.length ? parts.join('; ') : null;
}

function parseBody(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The client. One instance is cheap; construct it per job with the token the workspace's connector
 * stores, so a rotation takes effect on the next job.
 */
export class GitHubClient {
  readonly owner: string;
  readonly repo: string;
  private readonly token: string;
  private readonly request: GitHubRequest;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly apiVersion: string;

  constructor(options: GitHubClientOptions) {
    if (!options.token.trim())
      throw new GitHubError('invalid', 'The GitHub connector has no token. Add a fine-grained token for the repository first.');
    if (!options.owner.trim() || !options.repo.trim())
      throw new GitHubError('invalid', 'The GitHub connector needs an owner and a repository name.');
    const baseUrl = (options.baseUrl ?? GITHUB_API_ORIGIN).replace(/\/+$/, '');
    if (baseUrl !== GITHUB_API_ORIGIN && !options.request) {
      throw new GitHubError(
        'invalid',
        `The GitHub client can only talk to ${GITHUB_API_ORIGIN}; a test must inject its own request function.`,
      );
    }
    if (options.request) {
      let url: URL;
      try {
        url = new URL(baseUrl);
      } catch {
        throw new GitHubError('invalid', 'The GitHub client base URL is not a valid URL.');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new GitHubError('invalid', 'The GitHub client base URL must be http or https.');
      if (url.username || url.password) throw new GitHubError('invalid', 'The GitHub client base URL must not contain credentials.');
    } else {
      const problem = checkEgressUrl(baseUrl);
      if (problem) throw new GitHubError('invalid', `The GitHub API origin is not usable: ${problem}.`);
    }
    this.token = options.token;
    this.owner = options.owner;
    this.repo = options.repo;
    this.baseUrl = baseUrl;
    this.request = options.request ?? egressFetch;
    this.userAgent = options.userAgent ?? buildUserAgent();
    this.apiVersion = options.apiVersion ?? GITHUB_API_VERSION;
  }

  /** owner/repo, for messages. */
  get slug(): string {
    return `${this.owner}/${this.repo}`;
  }

  private async call<T>(method: string, path: string, body?: unknown, options: CallOptions = {}): Promise<CallResult<T>> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.token}`,
      'x-github-api-version': this.apiVersion,
      'user-agent': this.userAgent,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await this.request(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GitHubError('network', `GitHub could not be reached: ${redact(message)}. Check the connection and retry the job.`, {
        cause: sanitisedCause(error),
      });
    }

    const text = await response.text();
    const parsed = parseBody(text);
    const responseHeaders: Record<string, string> = {};
    for (const name of ['retry-after', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'link']) {
      const value = headerValue(response, name);
      if (value !== undefined) responseHeaders[name] = value;
    }

    if (response.ok) return { data: parsed as T, headers: responseHeaders };

    const status = response.status;
    const message = bodyMessage(parsed);
    const detail = message ? `: ${redact(message)}` : '';

    if (isRateLimited(response, status)) {
      const retryAt = retryAtFrom(response);
      const when = retryAt ? ` Retry after ${retryAt.toISOString()}.` : ' Retry the job later.';
      throw new GitHubError('rate_limit', `GitHub's rate limit for ${this.slug} is used up.${when}`, {
        status,
        ...(retryAt ? { retryAt } : {}),
        details: { rateLimitRemaining: responseHeaders['x-ratelimit-remaining'] ?? null },
      });
    }
    if (status === 401) {
      throw new GitHubError(
        'unauthorized',
        `GitHub rejected the token (401). Use a fine-grained token for ${this.slug} that can read the repository, and check that it has not expired.`,
        { status },
      );
    }
    if (status === 403) {
      throw new GitHubError(
        'forbidden',
        `The token cannot do this in ${this.slug} (403). It needs Contents read and write, and Pull requests read and write, for this repository.`,
        { status },
      );
    }
    if (status === 404) {
      const about = options.notFound ?? 'the requested record';
      throw new GitHubError(
        'not_found',
        `GitHub did not find ${about} in ${this.slug} (404). Check the path, branch or number, and that the token can read it.`,
        {
          status,
        },
      );
    }
    if (status === 409) {
      throw new GitHubError('conflict', `${this.slug} changed while the request was in flight (409). Re-read the branch and retry.`, {
        status,
      });
    }
    if (status === 422) {
      throw new GitHubError('validation', `GitHub rejected the request (422)${detail || '.'}`, {
        status,
        ...(detail ? { details: { message: redact(message ?? '') } } : {}),
      });
    }
    if (status >= 500) {
      throw new GitHubError('server', `GitHub answered ${status}${detail}. Retry the job later; nothing was changed.`, { status });
    }
    throw new GitHubError('validation', `GitHub refused the request (${status})${detail || '.'}`, { status });
  }

  private get<T>(path: string, options?: CallOptions): Promise<CallResult<T>> {
    return this.call<T>('GET', path, undefined, options);
  }

  /** The repository's default branch and its head commit. */
  async getDefaultBranch(): Promise<GitHubRef> {
    const { data } = await this.get<{ default_branch?: string }>(`/repos/${this.slug}`, { notFound: 'the repository' });
    const branch = data.default_branch;
    if (!branch) throw new GitHubError('invalid', `GitHub did not report a default branch for ${this.slug}.`);
    return this.getBranchHead(branch);
  }

  /** One branch's head commit. */
  async getBranchHead(branch: string): Promise<GitHubRef> {
    const { data } = await this.get<{ object?: { sha?: string } }>(`/repos/${this.slug}/git/ref/heads/${encodePath(branch)}`, {
      notFound: `the branch ${branch}`,
    });
    const sha = data.object?.sha;
    if (!sha) throw new GitHubError('invalid', `GitHub returned no head commit for ${branch}.`);
    return { branch, sha };
  }

  /** A file's contents at a ref (base64 through the contents API, or the blob API when large). */
  async getFile(path: string, ref?: string): Promise<GitHubFile> {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const { data } = await this.get<{
      type?: string;
      path?: string;
      sha?: string;
      size?: number;
      content?: string;
      encoding?: string;
    }>(`/repos/${this.slug}/contents/${encodePath(path)}${query}`, { notFound: `the file ${path}${ref ? ` at ${ref}` : ''}` });

    if (data.type === 'dir' || Array.isArray(data)) {
      throw new GitHubError('invalid', `${path} is a directory, not a file.`, { details: { path } });
    }
    const sha = data.sha;
    if (!sha) throw new GitHubError('invalid', `GitHub returned no blob SHA for ${path}.`);
    let content = '';
    if (data.encoding === 'base64' && typeof data.content === 'string') {
      content = Buffer.from(data.content, 'base64').toString('utf8');
    } else {
      const blob = await this.get<{ content?: string; encoding?: string }>(`/repos/${this.slug}/git/blobs/${sha}`, {
        notFound: `the contents of ${path}`,
      });
      content =
        blob.data.encoding === 'base64' && typeof blob.data.content === 'string'
          ? Buffer.from(blob.data.content, 'base64').toString('utf8')
          : '';
    }
    return { path: data.path ?? path, sha, content, size: data.size ?? Buffer.byteLength(content, 'utf8') };
  }

  /** The file at two refs, or null at either (a missing file is not an error here). */
  private async fileOrNull(path: string, ref: string): Promise<GitHubFile | null> {
    try {
      return await this.getFile(path, ref);
    } catch (error) {
      if (error instanceof GitHubError && error.code === 'not_found') return null;
      throw error;
    }
  }

  /** Every blob path under a prefix at a ref; `truncated` says GitHub omitted some. */
  async listTree(ref: string, prefix = ''): Promise<{ paths: string[]; truncated: boolean }> {
    const { data } = await this.get<{ tree?: { path?: string; type?: string }[]; truncated?: boolean }>(
      `/repos/${this.slug}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      { notFound: `the tree at ${ref}` },
    );
    const paths = (data.tree ?? [])
      .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string')
      .map((entry) => entry.path!)
      .filter((path) => path.startsWith(prefix));
    return { paths, truncated: data.truncated === true };
  }

  /**
   * Every blob under a prefix at a ref, with its git object SHA. A retried apply job compares this
   * map with the one it would write, so a branch holding anything else is never adopted.
   */
  async listTreeEntries(ref: string, prefix = ''): Promise<{ entries: GitHubTreeEntry[]; truncated: boolean }> {
    const { data } = await this.get<{ tree?: { path?: string; type?: string; sha?: string }[]; truncated?: boolean }>(
      `/repos/${this.slug}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      { notFound: `the tree at ${ref}` },
    );
    const entries = (data.tree ?? [])
      .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string' && typeof entry.sha === 'string')
      .map((entry) => ({ path: entry.path!, sha: entry.sha! }))
      .filter((entry) => entry.path.startsWith(prefix));
    return { entries, truncated: data.truncated === true };
  }

  /** One commit's tree and parents, or a typed not-found. */
  async getCommit(sha: string): Promise<GitHubCommit> {
    const { data } = await this.get<{ sha?: string; tree?: { sha?: string }; parents?: { sha?: string }[] }>(
      `/repos/${this.slug}/git/commits/${encodeURIComponent(sha)}`,
      { notFound: `the commit ${sha}` },
    );
    const treeSha = data.tree?.sha;
    if (!treeSha) throw new GitHubError('invalid', `GitHub returned no tree for commit ${sha}.`);
    return { sha: data.sha ?? sha, treeSha, parents: (data.parents ?? []).map((parent) => String(parent.sha ?? '')).filter(Boolean) };
  }

  /** Create a branch at a commit. A branch that already exists is a typed conflict. */
  async createBranch(branch: string, sha: string): Promise<void> {
    try {
      await this.call('POST', `/repos/${this.slug}/git/refs`, { ref: `refs/heads/${branch}`, sha });
    } catch (error) {
      if (error instanceof GitHubError && error.code === 'validation' && /already exists/i.test(error.message)) {
        throw new GitHubError('conflict', `The branch ${branch} already exists in ${this.slug}. Choose a new branch name.`, {
          status: 422,
        });
      }
      throw error;
    }
  }

  /**
   * One commit with several file edits (git data API: blobs -> tree -> commit -> update ref).
   * `content: null` deletes the file. Author and committer default to GitHub's token identity.
   */
  async commitFiles(input: CommitFilesInput): Promise<CommitFilesResult> {
    if (input.files.length === 0) throw new GitHubError('invalid', 'A commit needs at least one file change.');
    const blobs = new Map<string, string>();
    for (const file of input.files) {
      if (file.content === null) continue;
      const { data } = await this.call<{ sha?: string }>('POST', `/repos/${this.slug}/git/blobs`, {
        content: file.content,
        encoding: 'utf-8',
      });
      if (!data.sha) throw new GitHubError('invalid', `GitHub returned no blob SHA for ${file.path}.`);
      blobs.set(file.path, data.sha);
    }

    const base = await this.get<{ tree?: { sha?: string } }>(`/repos/${this.slug}/git/commits/${input.baseSha}`, {
      notFound: `the commit ${input.baseSha}`,
    });
    const baseTree = base.data.tree?.sha;
    if (!baseTree) throw new GitHubError('invalid', `GitHub returned no tree for commit ${input.baseSha}.`);

    const tree = await this.call<{ sha?: string }>('POST', `/repos/${this.slug}/git/trees`, {
      base_tree: baseTree,
      tree: input.files.map((file) => ({
        path: file.path,
        mode: '100644',
        type: 'blob',
        sha: file.content === null ? null : blobs.get(file.path),
      })),
    });
    const treeSha = tree.data.sha;
    if (!treeSha) throw new GitHubError('invalid', 'GitHub returned no tree SHA for the new commit.');

    const commit = await this.call<{ sha?: string }>('POST', `/repos/${this.slug}/git/commits`, {
      message: input.message,
      tree: treeSha,
      parents: [input.baseSha],
      ...(input.author ? { author: input.author } : {}),
      ...(input.committer ? { committer: input.committer } : {}),
    });
    const commitSha = commit.data.sha;
    if (!commitSha) throw new GitHubError('invalid', 'GitHub returned no SHA for the new commit.');

    await this.call('PATCH', `/repos/${this.slug}/git/refs/heads/${encodePath(input.branch)}`, { sha: commitSha, force: false });

    return {
      commitSha,
      treeSha,
      files: input.files.map((file) => ({ path: file.path, blobSha: file.content === null ? null : (blobs.get(file.path) ?? null) })),
    };
  }

  async openPullRequest(input: OpenPullRequestInput): Promise<GitHubPullRequest> {
    const { data } = await this.call<Record<string, unknown>>('POST', `/repos/${this.slug}/pulls`, {
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      draft: input.draft ?? false,
    });
    return pullRequestFrom(data);
  }

  async getPullRequest(number: number): Promise<GitHubPullRequest> {
    const { data } = await this.get<Record<string, unknown>>(`/repos/${this.slug}/pulls/${number}`, {
      notFound: `pull request #${number}`,
    });
    return pullRequestFrom(data);
  }

  /**
   * The pull request whose head is this branch, or null. A retried job uses it to adopt the pull
   * request an earlier attempt created before its response was lost, so a retry never opens a second
   * one. `state: 'all'` finds a closed or merged one too.
   */
  async findPullRequestByHead(head: string, options: { state?: 'open' | 'closed' | 'all' } = {}): Promise<GitHubPullRequest | null> {
    const query = new URLSearchParams({ head: `${this.owner}:${head}`, per_page: '10' });
    if (options.state) query.set('state', options.state);
    const { data } = await this.get<Array<Record<string, unknown>>>(`/repos/${this.slug}/pulls?${query.toString()}`);
    const first = Array.isArray(data) ? data[0] : undefined;
    if (!first) return null;
    return pullRequestFrom(first);
  }

  /**
   * A page of the PR's commits and its head SHA, so a caller can compare with the SHA a person
   * approved. The head comes from the pull request itself (`head.sha`), which is authoritative: a
   * commit list is paginated, and its last entry on the first page is not the head of a PR with
   * more than 100 commits. The list follows GitHub's `Link: rel="next"` until it runs out.
   */
  async listPullRequestCommits(number: number): Promise<{ headSha: string; commits: GitHubCommitSummary[] }> {
    const { data: pull } = await this.get<{ head?: { sha?: string } }>(`/repos/${this.slug}/pulls/${number}`, {
      notFound: `pull request #${number}`,
    });
    const headSha = String(pull.head?.sha ?? '');
    if (!headSha) throw new GitHubError('invalid', `Pull request #${number} reported no head commit.`);

    const commits: GitHubCommitSummary[] = [];
    let path: string | null = `/repos/${this.slug}/pulls/${number}/commits?per_page=100`;
    for (let page = 0; path !== null && page < MAX_COMMIT_PAGES; page += 1) {
      const result: CallResult<Array<Record<string, unknown>>> = await this.get(path, { notFound: `pull request #${number}` });
      for (const commit of result.data) {
        const commitBody = (commit.commit ?? {}) as { message?: string; author?: { name?: string; date?: string } };
        commits.push({
          sha: String(commit.sha ?? ''),
          message: commitBody.message ?? '',
          authorName: commitBody.author?.name ?? null,
          date: commitBody.author?.date ?? null,
        });
      }
      const next = nextLink(result.headers);
      path = next === null ? null : this.nextPagePath(next);
    }
    return { headSha, commits };
  }

  /**
   * The API path of a paginated link, keeping the fixed host: GitHub's Link header is absolute, and
   * the test seam points at a local server, so only the path and query are trusted.
   */
  private nextPagePath(link: string): string {
    let url: URL;
    try {
      url = new URL(link, this.baseUrl);
    } catch {
      throw new GitHubError('invalid', 'GitHub returned a page link that is not a URL.');
    }
    if (url.origin !== new URL(this.baseUrl).origin) {
      throw new GitHubError('invalid', 'GitHub returned a page link for a different host; the client does not follow it.');
    }
    return `${url.pathname}${url.search}`;
  }

  /** Compare two commits; `ahead` means `head` contains `base`. */
  async compareCommits(base: string, head: string): Promise<GitHubComparison> {
    const { data } = await this.get<{ status?: string; ahead_by?: number; behind_by?: number; total_commits?: number }>(
      `/repos/${this.slug}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      { notFound: `the comparison of ${base} and ${head}` },
    );
    const status = data.status;
    if (status !== 'ahead' && status !== 'behind' && status !== 'diverged' && status !== 'identical') {
      throw new GitHubError('invalid', `GitHub returned an unknown comparison status for ${base} and ${head}.`);
    }
    return { status, aheadBy: data.ahead_by ?? 0, behindBy: data.behind_by ?? 0, totalCommits: data.total_commits ?? 0 };
  }

  /** Whether a file's blob is the same at two refs (missing at both counts as unchanged). */
  async fileUnchanged(
    path: string,
    refA: string,
    refB: string,
  ): Promise<{ unchanged: boolean; firstSha: string | null; secondSha: string | null }> {
    const [first, second] = await Promise.all([this.fileOrNull(path, refA), this.fileOrNull(path, refB)]);
    return { unchanged: (first?.sha ?? null) === (second?.sha ?? null), firstSha: first?.sha ?? null, secondSha: second?.sha ?? null };
  }

  async closePullRequest(number: number): Promise<GitHubPullRequest> {
    const { data } = await this.call<Record<string, unknown>>('PATCH', `/repos/${this.slug}/pulls/${number}`, { state: 'closed' });
    return pullRequestFrom(data);
  }

  /** The repository's deployments, newest first, optionally for one environment. */
  async listDeployments(options: { environment?: string; perPage?: number } = {}): Promise<GitHubDeployment[]> {
    const query = new URLSearchParams({ per_page: String(options.perPage ?? 30) });
    if (options.environment) query.set('environment', options.environment);
    const { data } = await this.get<Array<Record<string, unknown>>>(`/repos/${this.slug}/deployments?${query.toString()}`, {
      notFound: 'the deployments',
    });
    return data
      .map((deployment) => ({
        id: Number(deployment.id ?? 0),
        sha: String(deployment.sha ?? ''),
        ref: String(deployment.ref ?? ''),
        environment: String(deployment.environment ?? ''),
        createdAt: typeof deployment.created_at === 'string' ? deployment.created_at : null,
      }))
      .filter((deployment) => deployment.id > 0 && deployment.sha !== '');
  }

  /** One deployment's statuses, newest first. */
  async listDeploymentStatuses(id: number): Promise<GitHubDeploymentStatus[]> {
    const { data } = await this.get<Array<Record<string, unknown>>>(`/repos/${this.slug}/deployments/${id}/statuses?per_page=100`, {
      notFound: `deployment ${id}`,
    });
    return data.map((status) => ({
      id: Number(status.id ?? 0),
      state: String(status.state ?? ''),
      description: typeof status.description === 'string' ? status.description : null,
      createdAt: typeof status.created_at === 'string' ? status.created_at : null,
    }));
  }

  /**
   * Open a revert PR whose contents come from the merge commit's parent, so the change set is undone
   * exactly. By default it refuses when a touched file changed after the merge (the ADR's safe
   * rollback rule): that is a new change set, not a revert, because a silent revert would overwrite
   * the later work.
   */
  async revertPullRequest(input: RevertPullRequestInput): Promise<RevertPullRequestResult> {
    const baseBranch = input.base ?? (await this.getDefaultBranch()).branch;
    const base = await this.getBranchHead(baseBranch);

    if (input.requireUnchanged !== false) {
      const changed: string[] = [];
      for (const path of input.paths) {
        const comparison = await this.fileUnchanged(path, input.mergeCommitSha, base.sha);
        if (!comparison.unchanged) changed.push(path);
      }
      if (changed.length > 0) {
        throw new GitHubError(
          'unsafe_revert',
          `These files changed after the merge, so an automatic revert would overwrite newer work: ${changed.join(', ')}. Propose a new change set instead.`,
          { details: { paths: changed, mergeCommitSha: input.mergeCommitSha, baseSha: base.sha } },
        );
      }
    }

    const merge = await this.get<{ parents?: { sha?: string }[] }>(`/repos/${this.slug}/git/commits/${input.mergeCommitSha}`, {
      notFound: `the merge commit ${input.mergeCommitSha}`,
    });
    const parent = merge.data.parents?.[0]?.sha;
    if (!parent) throw new GitHubError('invalid', `The merge commit ${input.mergeCommitSha} has no parent to revert to.`);

    const files: CommitFile[] = [];
    for (const path of input.paths) {
      const previous = await this.fileOrNull(path, parent);
      files.push({ path, content: previous ? previous.content : null });
    }

    await this.createBranch(input.branch, base.sha);
    const committed = await this.commitFiles({
      branch: input.branch,
      baseSha: base.sha,
      message: input.title,
      files,
      ...(input.author ? { author: input.author } : {}),
      ...(input.committer ? { committer: input.committer } : {}),
    });
    const pullRequest = await this.openPullRequest({
      title: input.title,
      body: input.body,
      head: input.branch,
      base: baseBranch,
      draft: input.draft ?? false,
    });
    return { pullRequest, commitSha: committed.commitSha, files: committed.files };
  }
}

function pullRequestFrom(data: Record<string, unknown>): GitHubPullRequest {
  const head = (data.head ?? {}) as { sha?: string };
  const base = (data.base ?? {}) as { sha?: string };
  const state = data.state === 'closed' ? 'closed' : 'open';
  const number = Number(data.number ?? 0);
  if (!number) throw new GitHubError('invalid', 'GitHub returned a pull request without a number.');
  return {
    number,
    state,
    merged: data.merged === true,
    mergeCommitSha: typeof data.merge_commit_sha === 'string' ? data.merge_commit_sha : null,
    headSha: String(head.sha ?? ''),
    baseSha: String(base.sha ?? ''),
    mergeableState: typeof data.mergeable_state === 'string' ? data.mergeable_state : null,
    draft: data.draft === true,
    htmlUrl: String(data.html_url ?? ''),
  };
}
