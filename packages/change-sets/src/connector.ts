import { GitHubClient, GitHubError, type GitHubRequest, parseMapping, SiteMappingSchema } from '@agentic-seo/changes';
import type { CommandContext } from '@agentic-seo/commands';
import { AppError } from '@agentic-seo/core';
import type { schema, Tx } from '@agentic-seo/db';
import { connectionSecrets, defineConnector, findLiveConnection, registerConnector } from '@agentic-seo/integrations';
import type { KeyProvider } from '@agentic-seo/secrets';
import { z } from 'zod';

// The GitHub pull-request connector (ADR-0007, the first connector). A change set is applied by
// opening a pull request against one repository; a person's merge is the apply, and the deploy is
// detected separately (merge is not deployment).
//
// One connection per site. The settings are the repository, the base branch, the person-written
// source mapping (packages/changes' schema, validated here so a bad mapping never reaches the
// database) and the deploy detector. The secret is a fine-grained personal access token with
// Contents read/write and Pull requests read/write. GitHub App authentication is a later task; the
// token is sealed exactly like the Google OAuth tokens, and no command or event ever returns it.

declare module '@agentic-seo/commands' {
  interface Services {
    /**
     * Test seam for GitHub: a request function and base URL, so a test points the client at a local
     * fake instead of api.github.com. Production passes neither, and the client's egress guard then
     * refuses any origin but GitHub's API.
     */
    github?: GitHubSeam;
  }
}

export interface GitHubSeam {
  request?: GitHubRequest;
  baseUrl?: string;
}

/** The connector id stored on every GitHub connection. */
export const GITHUB_CONNECTOR_ID = 'github';

/**
 * How a merge becomes live (ADR-0007 review update). `version_file` is a direct-upload deploy that
 * GitHub never sees: the site serves a file whose first line is the deployed commit SHA.
 * `github_deployments` reads the Deployments API for a Git-integrated deploy.
 */
export const DeploySettings = z.discriminatedUnion('detector', [
  z.strictObject({
    detector: z.literal('version_file'),
    path: z
      .string()
      .regex(/^\/[^\s]*$/, 'A version file path starts with "/", e.g. /version.txt')
      .max(1024)
      .default('/version.txt')
      .describe('The path the deployed site serves the build’s version file on, e.g. /version.txt'),
  }),
  z.strictObject({
    detector: z.literal('github_deployments'),
    environment: z
      .string()
      .min(1)
      .max(100)
      .default('production')
      .describe('The GitHub deployment environment that serves the site, e.g. production or github-pages'),
  }),
]);
export type DeploySettings = z.output<typeof DeploySettings>;

export const githubSettings = z.strictObject({
  owner: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9_.-]+$/, 'A GitHub owner is a user or organisation name'),
  repo: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9_.-]+$/, 'A GitHub repository name'),
  baseBranch: z
    .string()
    .min(1)
    .max(255)
    .default('main')
    .describe('The branch change sets are branched from and their pull requests target'),
  mapping: SiteMappingSchema.describe('Routes -> source files for this repository, written by a person (ADR-0007)'),
  deploy: DeploySettings,
  deployTimeoutHours: z
    .number()
    .int()
    .min(1)
    .max(720)
    .default(48)
    .describe('How long a merged change may wait for its deployment before it is reported as not detected'),
});
export type GitHubSettings = z.output<typeof githubSettings>;

/**
 * The sealed credential. A fine-grained personal access token: Contents read and write (to read the
 * base head and to commit on a branch) and Pull requests read and write (to open and read the PR).
 * The token is never echoed: commands mark the input field sensitive, and errors from GitHub are
 * redacted before they leave the client.
 */
export const githubSecrets = z.strictObject({
  token: z.string().min(20).max(500).describe('A fine-grained GitHub personal access token for the repository'),
});
export type GitHubSecrets = z.output<typeof githubSecrets>;

export const githubConnector = defineConnector({
  id: GITHUB_CONNECTOR_ID,
  label: 'GitHub pull request',
  description:
    'Apply change sets to a static site as a pull request: one commit on a branch, a person merges it, and the deploy is detected before verification.',
  auth: 'api_key',
  settings: githubSettings,
  secrets: githubSecrets,
});

registerConnector(githubConnector);

/** A connection row plus its parsed settings. */
export interface GitHubConnection {
  row: typeof schema.connections.$inferSelect;
  settings: GitHubSettings;
  token: string;
}

function settingsOf(row: typeof schema.connections.$inferSelect): GitHubSettings {
  const parsed = githubSettings.safeParse(row.settings);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new AppError(
      'precondition_failed',
      `The GitHub connection for this site is incomplete (${first ? `${first.path.join('.') || 'settings'}: ${first.message}` : 'invalid settings'}). Run connectors.github.update.`,
    );
  }
  return parsed.data;
}

/**
 * Parses settings a command is about to store, with the mapping refusal's own sentence. Only the
 * settings fields are read, so a command input that also carries `siteId` and `token` is accepted.
 */
export function parseSettings(value: unknown): GitHubSettings {
  const raw = (value ?? {}) as Record<string, unknown>;
  const mapping = parseMapping(raw.mapping);
  if (!mapping.ok) throw new AppError('invalid_input', mapping.reason);
  const parsed = githubSettings.safeParse({
    owner: raw.owner,
    repo: raw.repo,
    baseBranch: raw.baseBranch ?? 'main',
    mapping: mapping.mapping,
    deploy: raw.deploy,
    deployTimeoutHours: raw.deployTimeoutHours ?? 48,
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new AppError(
      'invalid_input',
      `The GitHub connector settings are not valid: ${first ? `${first.path.join('.') || 'settings'} ${first.message}` : 'check each field'}.`,
    );
  }
  return parsed.data;
}

/** The token from a sealed connection, with the reconnect instruction when it is gone. */
export async function tokenOf(tx: Tx, row: typeof schema.connections.$inferSelect, kp: KeyProvider): Promise<string> {
  const secrets = await connectionSecrets(tx, row, kp);
  const parsed = githubSecrets.partial().safeParse(secrets);
  const token = parsed.success ? parsed.data.token : undefined;
  if (typeof token !== 'string' || !token) {
    throw new AppError(
      'precondition_failed',
      'The GitHub connection has no token stored. Run connectors.github.connect with a fine-grained token for the repository.',
    );
  }
  return token;
}

/** The site's live GitHub connection, or the instruction that gets one. Read-only, never locked. */
export async function findGitHubConnection(tx: Tx, workspaceId: string, siteId: string) {
  return findLiveConnection(tx, workspaceId, siteId, GITHUB_CONNECTOR_ID);
}

/** The site's active GitHub connection: its settings and its token, ready for a client. */
export async function activeConnection(
  tx: Tx,
  input: { workspaceId: string; siteId: string; kp: KeyProvider; siteName?: string },
): Promise<GitHubConnection> {
  const row = await findLiveConnection(tx, input.workspaceId, input.siteId, GITHUB_CONNECTOR_ID);
  if (!row) {
    throw new AppError(
      'precondition_failed',
      `The GitHub connector is not connected to ${input.siteName ?? 'this site'}. Run connectors.github.connect first.`,
    );
  }
  if (row.state === 'pending') {
    throw new AppError('precondition_failed', 'The GitHub connection has not finished connecting. Run connectors.github.connect again.');
  }
  if (row.state === 'error') {
    throw new AppError('conflict', row.lastError ?? 'The GitHub connection needs to be reconnected. Run connectors.github.connect.');
  }
  if (row.state !== 'active') {
    throw new AppError('conflict', `The GitHub connection is ${row.state}. Run connectors.github.connect again.`);
  }
  return { row, settings: settingsOf(row), token: await tokenOf(tx, row, input.kp) };
}

/** A client for one connection, with the test seam when the server has one. */
export function clientFor(settings: GitHubSettings, token: string, seam?: GitHubSeam): GitHubClient {
  return new GitHubClient({
    token,
    owner: settings.owner,
    repo: settings.repo,
    ...(seam?.request ? { request: seam.request } : {}),
    ...(seam?.baseUrl ? { baseUrl: seam.baseUrl } : {}),
  });
}

/** `owner/repo`, for messages and event evidence. */
export const slugOf = (settings: GitHubSettings): string => `${settings.owner}/${settings.repo}`;

/** A client for a command's connection (reads the test seam from the command context). */
export async function commandClient(ctx: CommandContext, connection: GitHubConnection): Promise<GitHubClient> {
  return clientFor(connection.settings, connection.token, ctx.services.github);
}

/**
 * A GitHub failure as the AppError the command layer returns. The message is already redacted by
 * the client (a token cannot appear in it), and a rate limit or a network failure is a
 * precondition: retry the job later, nothing was changed.
 */
export function githubAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof GitHubError) {
    switch (error.code) {
      case 'unauthorized':
        return new AppError('unauthorized', error.message);
      case 'forbidden':
        return new AppError('forbidden', error.message);
      case 'not_found':
        return new AppError('not_found', error.message);
      case 'conflict':
      case 'unsafe_revert':
        return new AppError('conflict', error.message);
      case 'validation':
      case 'invalid':
        return new AppError('invalid_input', error.message);
      case 'rate_limit':
      case 'server':
      case 'network':
        return new AppError('precondition_failed', error.message);
    }
  }
  return new AppError('precondition_failed', `GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`);
}
