import { type CommandContext, defineCommand } from '@agentic-seo/commands';
import { AppError } from '@agentic-seo/core';
import { schema, type Tx } from '@agentic-seo/db';
import {
  beginAuthorization,
  ConnectionView,
  connectionForSite,
  connectionSecrets,
  connectionView,
  connectorOf,
  GSC_CONNECTOR_ID,
  type HttpClient,
  liveConnection,
  revokedColumns,
  revokeTokens,
} from '@agentic-seo/integrations';
import type { ProviderGateway } from '@agentic-seo/providers';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { addDays, dayString, daysBetween } from './dates';
import { parseProperty, propertyMatchesSite, suggestProperty } from './properties';

// The Search Console commands (agents-and-autonomy.md §2 `search.*`, data-providers.md §5). Reads
// cost nothing and are action class `read`; connecting, selecting a property and disconnecting are
// people-only `settings` changes (design §3 fixed rules). Search facts are read from the two
// datasets; the live Google calls go through the provider gateway, never directly.

declare module '@agentic-seo/commands' {
  interface Services {
    /** The installation's Google OAuth client; absent when the server was not configured for GSC. */
    googleOAuth?: { clientId: string; clientSecret: string };
    /** Test seam for the Google revoke endpoint; production uses packages/fetch's egress guard. */
    integrationHttp?: HttpClient;
    /** Enqueues a Graphile Worker task; the server wires it to addJob. */
    enqueueTask?: (identifier: string, payload: Record<string, unknown>) => Promise<void>;
  }
}

const SiteId = z.string().uuid().describe('Site id');
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a calendar day, YYYY-MM-DD');
const SearchType = z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).default('web');

const SETUP_DOC = 'docs/setup/google-search-console.md';

function gateway(ctx: CommandContext): ProviderGateway {
  const providers = ctx.services.providers;
  if (!providers) throw new AppError('precondition_failed', 'The provider gateway is not configured on this server.');
  return providers;
}

function oauthClient(ctx: CommandContext) {
  const client = ctx.services.googleOAuth;
  if (!client?.clientId || !client.clientSecret)
    throw new AppError(
      'precondition_failed',
      `Google Search Console is not set up on this server. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET from the Google Cloud console, then restart (${SETUP_DOC}).`,
    );
  return client;
}

function publicUrl(ctx: CommandContext): string {
  const url = ctx.services.publicUrl;
  if (!url) throw new AppError('precondition_failed', 'The server has no PUBLIC_URL, so the Google redirect cannot be built.');
  return url;
}

const callerOf = (ctx: CommandContext) =>
  ctx.principal.type === 'user'
    ? { type: 'person' as const, id: ctx.principal.userId }
    : { type: 'agent' as const, id: ctx.principal.agent.id };

async function loadSite(tx: Tx, workspaceId: string, siteId: string) {
  const [site] = await tx
    .select()
    .from(schema.sites)
    .where(and(eq(schema.sites.workspaceId, workspaceId), eq(schema.sites.id, siteId)));
  if (!site) throw new AppError('not_found', `Site ${siteId} does not exist in this workspace.`);
  if (site.archived)
    throw new AppError('conflict', `Site “${site.name}” (${site.primaryDomain}) is archived. Search Console cannot be connected to it.`);
  return site;
}

/** The site's active GSC connection, or the reason it is not usable yet. */
async function activeConnection(tx: Tx, workspaceId: string, siteId: string) {
  const row = await liveConnection(tx, workspaceId, siteId, GSC_CONNECTOR_ID);
  if (!row) throw new AppError('precondition_failed', 'Search Console is not connected for this site. Run search.gsc.connect first.');
  if (row.state === 'pending')
    throw new AppError(
      'precondition_failed',
      'The Search Console connection has not finished authorizing. Run search.gsc.connect and complete the Google sign-in.',
    );
  if (row.state === 'error')
    throw new AppError('conflict', row.lastError ?? 'The Search Console connection needs to be reconnected. Run search.gsc.connect.');
  return row;
}

function propertyOf(row: { settings: Record<string, unknown> }): string {
  const property = row.settings.property;
  if (typeof property !== 'string' || !property)
    throw new AppError(
      'precondition_failed',
      'No Search Console property is selected for this site. Run search.gsc.properties, then search.gsc.select.',
    );
  return property;
}

const propertyView = z.object({
  property: z.string(),
  permissionLevel: z.string(),
  kind: z.enum(['domain', 'urlPrefix', 'unknown']),
  matchesSite: z.boolean(),
  selected: z.boolean(),
});

async function listProperties(ctx: CommandContext, row: typeof schema.connections.$inferSelect, siteId: string, refresh = false) {
  const result = await gateway(ctx).call<{ sites: { siteUrl: string; permissionLevel: string }[] }>({
    workspaceId: ctx.principal.workspaceId,
    port: 'SearchConsole',
    operation: 'sites',
    request: {},
    caller: callerOf(ctx),
    purpose: `List the Search Console properties this connection can read (site ${siteId})`,
    siteId,
    credentialKey: row.id,
    refresh,
  });
  return result.data.sites;
}

export const gscConnect = defineCommand({
  name: 'search.gsc.connect',
  title: 'Connect Google Search Console',
  description:
    'Starts the Google authorization for this site and returns the URL to open. Sign in with the Google account that can read the site’s Search Console property and allow read-only access. A person must do this; an agent cannot. Free.',
  input: z.object({ siteId: SiteId }),
  output: z.object({ connectionId: z.string(), url: z.string(), redirectUri: z.string() }),
  permission: 'sites:write',
  effect: 'write',
  humansOnly: true,
  actionClass: 'settings',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const client = oauthClient(ctx);
    const url = publicUrl(ctx);
    const site = await loadSite(ctx.tx, ctx.principal.workspaceId, input.siteId);
    const connector = connectorOf(GSC_CONNECTOR_ID);
    const row = await connectionForSite(ctx.tx, {
      workspaceId: ctx.principal.workspaceId,
      siteId: site.id,
      connector: connector.id,
      label: connector.label,
    });
    const started = await beginAuthorization(ctx.tx, { row, kp: ctx.services.keyProvider, client, publicUrl: url, connector });
    return { connectionId: row.id, url: started.url, redirectUri: started.redirectUri };
  },
});

export const gscProperties = defineCommand({
  name: 'search.gsc.properties',
  title: 'Search Console properties',
  description:
    'Lists the Search Console properties the connected Google account can read, and marks the ones that match this site’s domain (a domain property or a URL prefix). Use it before search.gsc.select to choose the property to read. Costs nothing.',
  input: z.object({ siteId: SiteId }),
  output: z.object({
    connectionId: z.string(),
    selected: z.string().nullable(),
    suggested: z.string().nullable(),
    properties: z.array(propertyView),
  }),
  permission: 'sites:read',
  effect: 'read',
  actionClass: 'read',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const site = await loadSite(ctx.tx, ctx.principal.workspaceId, input.siteId);
    const row = await activeConnection(ctx.tx, ctx.principal.workspaceId, site.id);
    const sites = await listProperties(ctx, row, site.id);
    const names = sites.map((entry) => entry.siteUrl);
    const selected = typeof row.settings.property === 'string' ? (row.settings.property as string) : null;
    return {
      connectionId: row.id,
      selected,
      suggested: suggestProperty(names, { domain: site.primaryDomain, hosts: site.hosts }),
      properties: sites.map((entry) => ({
        property: entry.siteUrl,
        permissionLevel: entry.permissionLevel,
        kind: parseProperty(entry.siteUrl).kind,
        matchesSite: propertyMatchesSite(entry.siteUrl, { domain: site.primaryDomain, hosts: site.hosts }),
        selected: entry.siteUrl === selected,
      })),
    };
  },
});

export const gscSelect = defineCommand({
  name: 'search.gsc.select',
  title: 'Select the Search Console property',
  description:
    'Chooses which Search Console property this site reads. The property must be one the connected Google account can access; run search.gsc.properties first. A person must do this; an agent cannot. Free.',
  input: z.object({ siteId: SiteId, property: z.string().min(1).max(2_000) }),
  output: ConnectionView,
  permission: 'sites:write',
  effect: 'write',
  humansOnly: true,
  actionClass: 'settings',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const site = await loadSite(ctx.tx, ctx.principal.workspaceId, input.siteId);
    const row = await activeConnection(ctx.tx, ctx.principal.workspaceId, site.id);
    // The live list, not a cached one: a re-authorization can change which properties are visible.
    const sites = await listProperties(ctx, row, site.id, true);
    if (!sites.some((entry) => entry.siteUrl === input.property)) {
      const available = sites.map((entry) => entry.siteUrl).join(', ') || 'none';
      throw new AppError(
        'invalid_input',
        `“${input.property}” is not a property this Google account can read. Properties available: ${available}. Run search.gsc.properties to see them.`,
      );
    }
    const previous = typeof row.settings.property === 'string' ? row.settings.property : null;
    const now = new Date();
    const [updated] = await ctx.tx
      .update(schema.connections)
      .set({ settings: { ...row.settings, property: input.property }, state: 'active', lastError: null, updatedAt: now })
      .where(and(eq(schema.connections.workspaceId, ctx.principal.workspaceId), eq(schema.connections.id, row.id)))
      .returning();
    // A different property needs its own 16-month backfill; the old watermarks describe the old
    // property. The facts already stored stay, keyed by their property, so nothing mixes.
    if (previous !== input.property)
      await ctx.tx
        .update(schema.gscSyncState)
        .set({ backfillComplete: false, backfillThrough: null, lastFinalDate: null, lastFetchedAt: null, lastError: null, updatedAt: now })
        .where(and(eq(schema.gscSyncState.workspaceId, ctx.principal.workspaceId), eq(schema.gscSyncState.siteId, site.id)));
    return connectionView(updated!);
  },
});

export const gscDisconnect = defineCommand({
  name: 'search.gsc.disconnect',
  title: 'Disconnect Google Search Console',
  description:
    'Revokes the Google tokens and removes the stored credential for this site. The search data already synced is kept. A person must do this; an agent cannot. Free.',
  input: z.object({ siteId: SiteId }),
  output: z.object({ revoked: z.literal(true), googleRevoked: z.boolean() }),
  permission: 'sites:write',
  effect: 'write',
  humansOnly: true,
  actionClass: 'settings',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const site = await loadSite(ctx.tx, ctx.principal.workspaceId, input.siteId);
    const row = await liveConnection(ctx.tx, ctx.principal.workspaceId, site.id, GSC_CONNECTOR_ID);
    if (!row) throw new AppError('not_found', 'Search Console is not connected for this site, so there is nothing to disconnect.');
    const connector = connectorOf(row.connector);
    const secrets = await connectionSecrets(ctx.tx, row, ctx.services.keyProvider);
    const googleRevoked = await revokeTokens(connector, row.settings, secrets, ctx.services.integrationHttp);
    await ctx.tx
      .update(schema.connections)
      .set(revokedColumns(new Date()))
      .where(and(eq(schema.connections.workspaceId, ctx.principal.workspaceId), eq(schema.connections.id, row.id)));
    return { revoked: true as const, googleRevoked };
  },
});

const datasetStatus = z.object({
  dataset: z.enum(['property_totals', 'page_aggregates']),
  searchType: z.string(),
  lastFinalDate: z.string().nullable(),
  lastFetchedAt: z.string().nullable(),
  backfillComplete: z.boolean(),
  backfillThrough: z.string().nullable(),
  lastError: z.string().nullable(),
});

export const gscStatus = defineCommand({
  name: 'search.gsc.status',
  title: 'Search Console status',
  description:
    'Shows the Search Console connection: its state, the selected property, the last sync error and each dataset’s watermark (the newest final day, the backfill progress). Use it to diagnose “no data” or a reconnect prompt. Free.',
  input: z.object({ siteId: SiteId }),
  output: z.object({
    connection: ConnectionView.nullable(),
    property: z.string().nullable(),
    datasets: z.array(datasetStatus),
  }),
  permission: 'sites:read',
  effect: 'read',
  actionClass: 'read',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const site = await loadSite(ctx.tx, ctx.principal.workspaceId, input.siteId);
    const row = await liveConnection(ctx.tx, ctx.principal.workspaceId, site.id, GSC_CONNECTOR_ID);
    const states = await ctx.tx
      .select()
      .from(schema.gscSyncState)
      .where(and(eq(schema.gscSyncState.workspaceId, ctx.principal.workspaceId), eq(schema.gscSyncState.siteId, site.id)))
      .orderBy(asc(schema.gscSyncState.dataset));
    return {
      connection: row ? connectionView(row) : null,
      property: row && typeof row.settings.property === 'string' ? (row.settings.property as string) : null,
      datasets: states.map((state) => ({
        dataset: state.dataset,
        searchType: state.searchType,
        lastFinalDate: state.lastFinalDate,
        lastFetchedAt: state.lastFetchedAt?.toISOString() ?? null,
        backfillComplete: state.backfillComplete,
        backfillThrough: state.backfillThrough,
        lastError: state.lastError,
      })),
    };
  },
});

/** A second sync request for the same site inside a minute is refused, per the brief. */
const SYNC_COOLDOWN_MS = 60_000;

export const gscSync = defineCommand({
  name: 'search.gsc.sync',
  title: 'Sync Search Console now',
  description:
    'Queues a Search Console sync for this site: it backfills 16 months on the first run and refreshes the last few provisional days afterwards. Costs nothing; a second request within a minute is refused. Use it after connecting or when the data looks stale.',
  input: z.object({ siteId: SiteId }),
  output: z.object({ enqueued: z.literal(true), siteId: z.string() }),
  permission: 'sites:read',
  effect: 'write',
  actionClass: 'read',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const enqueue = ctx.services.enqueueTask;
    if (!enqueue)
      throw new AppError('precondition_failed', 'Background jobs are not configured on this server, so the sync cannot be queued.');
    const site = await loadSite(ctx.tx, ctx.principal.workspaceId, input.siteId);
    const row = await activeConnection(ctx.tx, ctx.principal.workspaceId, site.id);
    propertyOf(row);
    const now = new Date();
    if (row.lastSyncRequestedAt && now.getTime() - row.lastSyncRequestedAt.getTime() < SYNC_COOLDOWN_MS) {
      const seconds = Math.ceil((SYNC_COOLDOWN_MS - (now.getTime() - row.lastSyncRequestedAt.getTime())) / 1000);
      throw new AppError(
        'conflict',
        `A Search Console sync for this site was requested less than a minute ago. Try again in ${seconds} seconds.`,
      );
    }
    await ctx.tx
      .update(schema.connections)
      .set({ lastSyncRequestedAt: now, updatedAt: now })
      .where(and(eq(schema.connections.workspaceId, ctx.principal.workspaceId), eq(schema.connections.id, row.id)));
    const job = () => enqueue('gsc_sync', { workspaceId: ctx.principal.workspaceId, siteId: site.id });
    // Queue only after this transaction commits, so the worker cannot read a row that is not there yet.
    if (ctx.afterCommit) ctx.afterCommit(job);
    else await job();
    return { enqueued: true as const, siteId: site.id };
  },
});

const MAX_RANGE_DAYS = 550;

function rangeOf(input: { startDate?: string; endDate?: string }, now: Date) {
  const today = dayString(now);
  const end = input.endDate ?? today;
  const start = input.startDate ?? addDays(end, -27);
  if (start > end) throw new AppError('invalid_input', `The start date ${start} is after the end date ${end}.`);
  if (daysBetween(start, end) + 1 > MAX_RANGE_DAYS)
    throw new AppError('invalid_input', `The range is longer than ${MAX_RANGE_DAYS} days. Ask for a shorter period.`);
  return { start, end };
}

const DATASET_TABLES = { property_totals: 'gsc_property_totals', page_aggregates: 'gsc_page_aggregates' } as const;

/** The first day in the range that Google may still revise, per dataset. */
async function provisionalFrom(
  tx: Tx,
  workspaceId: string,
  siteId: string,
  property: string,
  dataset: keyof typeof DATASET_TABLES,
  searchType: string,
  start: string,
  end: string,
) {
  const result = await tx.execute<{ date: string | null }>(sql`
    SELECT min(date)::text AS date
    FROM ${sql.identifier(DATASET_TABLES[dataset])}
    WHERE workspace_id = ${workspaceId}
      AND site_id = ${siteId}
      AND property = ${property}
      AND search_type = ${searchType}
      AND NOT is_final
      AND date BETWEEN ${start} AND ${end}`);
  return result.rows[0]?.date ?? null;
}

const totals = z.object({
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  position: z.number(),
});

export const searchPerformance = defineCommand({
  name: 'search.performance',
  title: 'Search performance',
  description:
    'Daily Search Console clicks, impressions, click-through rate and average position for the site’s property, with totals for the period. Data newer than about three days is provisional (reported as provisionalFrom). Use it for trend and period questions; free.',
  input: z.object({ siteId: SiteId, startDate: Day.optional(), endDate: Day.optional(), searchType: SearchType }),
  output: z.object({
    property: z.string(),
    startDate: z.string(),
    endDate: z.string(),
    series: z.array(totals.extend({ date: z.string() })),
    totals,
    provisionalFrom: z.string().nullable(),
  }),
  permission: 'sites:read',
  effect: 'read',
  actionClass: 'read',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const site = await loadSite(ctx.tx, ctx.principal.workspaceId, input.siteId);
    const row = await activeConnection(ctx.tx, ctx.principal.workspaceId, site.id);
    const property = propertyOf(row);
    const { start, end } = rangeOf(input, new Date());
    const rows = await ctx.tx
      .select()
      .from(schema.gscPropertyTotals)
      .where(
        and(
          eq(schema.gscPropertyTotals.workspaceId, ctx.principal.workspaceId),
          eq(schema.gscPropertyTotals.siteId, site.id),
          eq(schema.gscPropertyTotals.property, property),
          eq(schema.gscPropertyTotals.searchType, input.searchType),
          gte(schema.gscPropertyTotals.date, start),
          lte(schema.gscPropertyTotals.date, end),
        ),
      )
      .orderBy(asc(schema.gscPropertyTotals.date));
    const clicks = rows.reduce((sum, r) => sum + r.clicks, 0);
    const impressions = rows.reduce((sum, r) => sum + r.impressions, 0);
    const weighted = rows.reduce((sum, r) => sum + r.position * r.impressions, 0);
    return {
      property,
      startDate: start,
      endDate: end,
      series: rows.map((r) => ({
        date: r.date,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      })),
      totals: {
        clicks,
        impressions,
        ctr: impressions > 0 ? clicks / impressions : 0,
        position: impressions > 0 ? weighted / impressions : rows.length ? rows.reduce((sum, r) => sum + r.position, 0) / rows.length : 0,
      },
      provisionalFrom: await provisionalFrom(
        ctx.tx,
        ctx.principal.workspaceId,
        site.id,
        property,
        'property_totals',
        input.searchType,
        start,
        end,
      ),
    };
  },
});

/** Page cursors are opaque to callers: base64url of the offset into the same ordered aggregate. */
const encodeCursor = (offset: number) => Buffer.from(`page:${offset}`, 'utf8').toString('base64url');
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^page:(\d+)$/.exec(text);
    if (!match) throw new Error('shape');
    const offset = Number(match[1]);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('range');
    return offset;
  } catch {
    throw new AppError('invalid_input', 'The cursor is not one this command returned. Leave it out to start from the first page.');
  }
}

export const searchPages = defineCommand({
  name: 'search.pages',
  title: 'Search performance by page',
  description:
    'Top pages by Search Console clicks over a date range, with clicks, impressions, click-through rate and average position, one row per page (countries and devices summed). Use it to find the pages that carry the site’s search traffic; free.',
  input: z.object({
    siteId: SiteId,
    startDate: Day.optional(),
    endDate: Day.optional(),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().max(200).optional(),
  }),
  output: z.object({
    property: z.string(),
    startDate: z.string(),
    endDate: z.string(),
    pages: z.array(
      totals.extend({
        page: z.string(),
      }),
    ),
    nextCursor: z.string().nullable(),
    provisionalFrom: z.string().nullable(),
  }),
  permission: 'sites:read',
  effect: 'read',
  actionClass: 'read',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const site = await loadSite(ctx.tx, ctx.principal.workspaceId, input.siteId);
    const row = await activeConnection(ctx.tx, ctx.principal.workspaceId, site.id);
    const property = propertyOf(row);
    const { start, end } = rangeOf(input, new Date());
    const offset = decodeCursor(input.cursor);
    const searchType = 'web';
    const result = await ctx.tx.execute<{
      page: string;
      clicks: string;
      impressions: string;
      ctr: string;
      position: string;
    }>(sql`
      SELECT page,
        SUM(clicks)::text AS clicks,
        SUM(impressions)::text AS impressions,
        (CASE WHEN SUM(impressions) > 0 THEN SUM(clicks) / SUM(impressions) ELSE 0 END)::text AS ctr,
        (CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) / SUM(impressions) ELSE COALESCE(AVG(position), 0) END)::text AS position
      FROM gsc_page_aggregates
      WHERE workspace_id = ${ctx.principal.workspaceId}
        AND site_id = ${site.id}
        AND property = ${property}
        AND search_type = ${searchType}
        AND date BETWEEN ${start} AND ${end}
      GROUP BY page
      ORDER BY SUM(clicks) DESC, page ASC
      LIMIT ${input.limit + 1} OFFSET ${offset}`);
    const rows = result.rows.slice(0, input.limit);
    return {
      property,
      startDate: start,
      endDate: end,
      pages: rows.map((r) => ({
        page: r.page,
        clicks: Number(r.clicks),
        impressions: Number(r.impressions),
        ctr: Number(r.ctr),
        position: Number(r.position),
      })),
      nextCursor: result.rows.length > input.limit ? encodeCursor(offset + input.limit) : null,
      provisionalFrom: await provisionalFrom(
        ctx.tx,
        ctx.principal.workspaceId,
        site.id,
        property,
        'page_aggregates',
        searchType,
        start,
        end,
      ),
    };
  },
});

export const searchDataCommands = [
  gscConnect,
  gscProperties,
  gscSelect,
  gscDisconnect,
  gscStatus,
  gscSync,
  searchPerformance,
  searchPages,
] as const;
