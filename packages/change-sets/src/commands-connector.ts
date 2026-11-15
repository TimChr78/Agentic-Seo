import { defineCommand } from '@agentic-seo/commands';
import { AppError } from '@agentic-seo/core';
import { schema, type Tx } from '@agentic-seo/db';
import {
  ConnectionView,
  clearedSecrets,
  connectionForSite,
  connectionSecrets,
  connectionView,
  revokedColumns,
  sealConnectionSecrets,
} from '@agentic-seo/integrations';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  clientFor,
  DeploySettings,
  findGitHubConnection,
  GITHUB_CONNECTOR_ID,
  githubAppError,
  githubConnector,
  parseSettings,
  slugOf,
  tokenOf,
} from './connector';

// The GitHub connector's own commands (ADR-0007). Connecting, changing and disconnecting a
// connection are a person's settings decision (design §3 fixed rules: credentials and connections
// are never an agent's call), so every one is humans-only and classed `settings`.
//
// The token is write-only in the strongest sense this codebase has: it is sealed on the connection,
// the command declares the input field sensitive (so the audit log and the idempotency store hash it
// away), and nothing here ever puts it in an output, an error or a log line. Reading a repository
// through it at connect time is the validation: a token that cannot read the base branch is refused
// before anything is stored.

const SiteId = z.string().uuid().describe('Site id');

async function loadSite(tx: Tx, workspaceId: string, siteId: string) {
  const [site] = await tx
    .select()
    .from(schema.sites)
    .where(and(eq(schema.sites.workspaceId, workspaceId), eq(schema.sites.id, siteId)));
  if (!site) throw new AppError('not_found', `Site ${siteId} does not exist in this workspace.`);
  if (site.archived) throw new AppError('conflict', `Site “${site.name}” (${site.primaryDomain}) is archived, so it cannot be changed.`);
  return site;
}

const ConnectorSettingsInput = z.object({
  owner: z.string().min(1).max(100).describe('The GitHub user or organisation that owns the repository, e.g. TimChr78'),
  repo: z.string().min(1).max(100).describe('The repository name, e.g. martechsignal'),
  baseBranch: z.string().min(1).max(255).default('main').describe('The branch change sets branch from and their pull requests target'),
  mapping: z
    .unknown()
    .describe(
      'Routes -> source files for this repository (packages/changes SiteMappingSchema); see change-types and the ADR for the shape',
    ),
  deploy: DeploySettings.describe('How a merge becomes live for this site'),
  deployTimeoutHours: z
    .number()
    .int()
    .min(1)
    .max(720)
    .default(48)
    .describe('How long a merged change may wait for its deployment before it is reported as not detected'),
});

export const githubConnect = defineCommand({
  name: 'connectors.github.connect',
  title: 'Connect GitHub',
  description:
    'Connects one site to its GitHub repository so change sets can be applied as pull requests. Give a fine-grained personal access token with Contents read/write and Pull requests read/write for that repository; the token is validated by reading the base branch, sealed, and never returned. Also give the route-to-source mapping: without it no change can be applied. A person must do this; an agent cannot. Free.',
  input: ConnectorSettingsInput.extend({
    siteId: SiteId,
    token: z
      .string()
      .min(20)
      .max(500)
      .describe('A fine-grained GitHub personal access token: Contents read/write, Pull requests read/write, for this repository only'),
  }),
  output: z.object({
    connection: ConnectionView,
    repository: z.string().describe('owner/repo the connection applies to'),
    baseBranch: z.string(),
    baseSha: z.string().describe('The base branch head the connection was validated against'),
  }),
  permission: 'sites:write',
  effect: 'write',
  humansOnly: true,
  actionClass: 'settings',
  sensitive: ['token'],
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const site = await loadSite(ctx.tx, ctx.principal.workspaceId, input.siteId);
    const settings = parseSettings(input);
    const client = clientFor(settings, input.token, ctx.services.github);
    // The one validation that matters: a token that cannot read the branch cannot commit to it.
    const head = await client.getBranchHead(settings.baseBranch).catch((error: unknown) => {
      throw githubAppError(error);
    });

    const row = await connectionForSite(ctx.tx, {
      workspaceId: ctx.principal.workspaceId,
      siteId: site.id,
      connector: GITHUB_CONNECTOR_ID,
      label: githubConnector.label,
    });
    const sealed = await sealConnectionSecrets(ctx.tx, row, ctx.services.keyProvider, { token: input.token });
    const [updated] = await ctx.tx
      .update(schema.connections)
      .set({
        settings: settings as unknown as Record<string, unknown>,
        secrets: sealed.blob,
        secretsKeyId: sealed.keyId,
        state: 'active',
        lastError: null,
        // A new repository is a new meaning for this connection: a job that started on the old one
        // must not write a pull request into the new one.
        generation: sql`${schema.connections.generation} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.connections.workspaceId, ctx.principal.workspaceId), eq(schema.connections.id, row.id)))
      .returning();
    return {
      connection: connectionView(updated!),
      repository: slugOf(settings),
      baseBranch: settings.baseBranch,
      baseSha: head.sha,
    };
  },
});

export const githubUpdate = defineCommand({
  name: 'connectors.github.update',
  title: 'Change the GitHub connection settings',
  description:
    'Changes the repository, base branch, source mapping or deploy detector of a connected site. It never takes a token: use connectors.github.connect again to replace the credential. The mapping is validated the moment it is saved, so a bad one never reaches a change set. A person must do this; an agent cannot. Free.',
  input: ConnectorSettingsInput.extend({ siteId: SiteId }),
  output: z.object({ connection: ConnectionView, repository: z.string(), baseBranch: z.string(), baseSha: z.string() }),
  permission: 'sites:write',
  effect: 'write',
  humansOnly: true,
  actionClass: 'settings',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const site = await loadSite(ctx.tx, ctx.principal.workspaceId, input.siteId);
    const settings = parseSettings(input);
    const row = await findGitHubConnection(ctx.tx, ctx.principal.workspaceId, site.id);
    if (!row) throw new AppError('not_found', 'The GitHub connector is not connected to this site, so there is nothing to change.');
    if (row.state === 'revoked') throw new AppError('conflict', 'This GitHub connection was disconnected. Run connectors.github.connect.');
    const token = await tokenOf(ctx.tx, row, ctx.services.keyProvider);
    const head = await clientFor(settings, token, ctx.services.github)
      .getBranchHead(settings.baseBranch)
      .catch((error: unknown) => {
        throw githubAppError(error);
      });
    const [updated] = await ctx.tx
      .update(schema.connections)
      .set({
        settings: settings as unknown as Record<string, unknown>,
        state: 'active',
        lastError: null,
        generation: sql`${schema.connections.generation} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.connections.workspaceId, ctx.principal.workspaceId), eq(schema.connections.id, row.id)))
      .returning();
    return {
      connection: connectionView(updated!),
      repository: slugOf(settings),
      baseBranch: settings.baseBranch,
      baseSha: head.sha,
    };
  },
});

export const githubDisconnect = defineCommand({
  name: 'connectors.github.disconnect',
  title: 'Disconnect GitHub',
  description:
    'Removes the stored token and marks the connection revoked. Change sets already open stay readable and their pull requests are untouched; nothing new can be applied until the site is connected again. A person must do this; an agent cannot. Free.',
  input: z.object({ siteId: SiteId }),
  output: z.object({ revoked: z.literal(true) }),
  permission: 'sites:write',
  effect: 'write',
  humansOnly: true,
  actionClass: 'settings',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const site = await loadSite(ctx.tx, ctx.principal.workspaceId, input.siteId);
    const row = await findGitHubConnection(ctx.tx, ctx.principal.workspaceId, site.id);
    if (!row) throw new AppError('not_found', 'The GitHub connector is not connected to this site, so there is nothing to disconnect.');
    // The token is sealed data, not an OAuth grant with a revocation endpoint: dropping it is the
    // disconnect. A person revokes it in GitHub's own settings if they want it dead everywhere.
    await ctx.tx
      .update(schema.connections)
      .set({ ...revokedColumns(new Date()), ...clearedSecrets() })
      .where(and(eq(schema.connections.workspaceId, ctx.principal.workspaceId), eq(schema.connections.id, row.id)));
    return { revoked: true as const };
  },
});

export const githubStatus = defineCommand({
  name: 'connectors.github.status',
  title: 'GitHub connection status',
  description:
    'Shows the site’s GitHub connection: whether it is active, the repository and base branch, which deploy detector is configured, the last error, and whether a token is stored (never the token itself). Use it to diagnose why a change set cannot be applied. Free.',
  input: z.object({ siteId: SiteId }),
  output: z.object({
    connection: ConnectionView.nullable(),
    repository: z.string().nullable(),
    baseBranch: z.string().nullable(),
    deploy: z
      .object({ detector: z.enum(['version_file', 'github_deployments']), detail: z.string() })
      .nullable()
      .describe('The configured deploy detector, with the path or environment it reads'),
    deployTimeoutHours: z.number().int().nullable(),
    hasToken: z.boolean().describe('Whether a sealed token is stored; the value is never returned'),
    sourceRules: z.number().int().describe('How many route rules the mapping has'),
  }),
  permission: 'sites:read',
  effect: 'read',
  actionClass: 'read',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const site = await loadSite(ctx.tx, ctx.principal.workspaceId, input.siteId);
    const row = await findGitHubConnection(ctx.tx, ctx.principal.workspaceId, site.id);
    if (!row) {
      return {
        connection: null,
        repository: null,
        baseBranch: null,
        deploy: null,
        deployTimeoutHours: null,
        hasToken: false,
        sourceRules: 0,
      };
    }
    const parsed = parseSettingsSafe(row.settings);
    const secrets = await connectionSecrets(ctx.tx, row, ctx.services.keyProvider);
    return {
      connection: connectionView(row),
      repository: parsed ? slugOf(parsed) : null,
      baseBranch: parsed?.baseBranch ?? null,
      deploy: parsed
        ? {
            detector: parsed.deploy.detector,
            detail: parsed.deploy.detector === 'version_file' ? parsed.deploy.path : parsed.deploy.environment,
          }
        : null,
      deployTimeoutHours: parsed?.deployTimeoutHours ?? null,
      hasToken: typeof secrets.token === 'string' && secrets.token.length > 0,
      sourceRules: parsed?.mapping.rules.length ?? 0,
    };
  },
});

/** Settings that no longer parse (the mapping was changed under a stored connection) are reported. */
function parseSettingsSafe(stored: Record<string, unknown>) {
  try {
    return parseSettings(stored);
  } catch {
    return null;
  }
}

export const githubConnectorCommands = [githubConnect, githubUpdate, githubDisconnect, githubStatus] as const;
