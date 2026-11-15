import { type CommandContext, defineCommand } from '@agentic-seo/commands';
import { AppError, decodeTimestampCursor, encodeTimestampCursor } from '@agentic-seo/core';
import { schema } from '@agentic-seo/db';
import { and, asc, desc, eq, gt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { enqueueFirstChunk } from './enqueue';
import { DEFAULT_LIMITS, MAX_PAGES } from './limits';
import { liveAuditId, seedAudit } from './seed';
import { isInternalUrl, normalizeSection, normalizeUrl, siteHostsOf } from './url';

// The audit commands (crawler-and-audits.md §2): start a crawl, watch it, read its pages, cancel it.
// Every capability goes through the registry, so REST, MCP and the UI share validation, permissions,
// tenancy and the action ledger. Reads use `sites:read`; starting and cancelling use `audits:run`
// and the `crawl` action class, so an agent's decision is judged by the policy engine like any
// other write.

const AuditId = z.string().min(1).max(64).describe('Audit id, e.g. adt_0192f3c2b4');
const SiteId = z.string().uuid().describe('Site id');

const CoverageSchema = z.object({
  scope: z.enum(['site', 'section', 'list', 'page']),
  graph: z.enum(['complete', 'truncated']),
  reasons: z.array(
    z.enum([
      'page_limit',
      'depth_limit',
      'time_limit',
      'robots',
      'errors',
      'cancelled',
      'section_quota',
      'links_truncated',
      'sitemaps_truncated',
    ]),
  ),
  pagesCrawled: z.number().int(),
  pagesDiscovered: z.number().int(),
  section: z.string().optional(),
  urls: z.array(z.string()).optional(),
});

const LimitsSchema = z.object({
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGES)
    .default(DEFAULT_LIMITS.maxPages)
    .describe(`Pages to crawl. Default ${DEFAULT_LIMITS.maxPages}; hard cap ${MAX_PAGES}`),
  maxDepth: z
    .number()
    .int()
    .min(0)
    .max(100)
    .default(DEFAULT_LIMITS.maxDepth)
    .describe('Click depth to follow from the seed. Default 10; sitemap-only URLs are not depth limited'),
  maxDurationMs: z
    .number()
    .int()
    .min(60_000)
    .max(24 * 60 * 60 * 1000)
    .default(DEFAULT_LIMITS.maxDurationMs)
    .describe('Wall-clock budget in milliseconds. Default 30 minutes'),
});

export const AuditSchema = z.object({
  id: AuditId,
  siteId: SiteId,
  scope: z.enum(['site', 'section', 'list', 'page']),
  section: z.string().nullable().describe('The path prefix of a section audit'),
  urls: z.array(z.string()).nullable().describe('The exact URLs of a list or page audit'),
  limits: LimitsSchema,
  renderMode: z.enum(['never', 'auto', 'always']),
  state: z.enum(['queued', 'running', 'finalizing', 'completed', 'partial', 'failed', 'cancelled']),
  stateReason: z.string().nullable().describe('Why the audit is partial or failed, or that it was cancelled'),
  coverage: CoverageSchema.nullable().describe('Whether the audit saw the whole link graph, and why not'),
  pagesCrawled: z.number().int(),
  pagesDiscovered: z.number().int(),
  pagesFailed: z.number().int().describe('Pages that failed to load: a fetch error or a 5xx status'),
  requestedByType: z.enum(['user', 'agent']),
  requestedById: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  lastProgressAt: z.string(),
  createdAt: z.string(),
});

export type AuditView = z.output<typeof AuditSchema>;

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

function auditView(row: typeof schema.audits.$inferSelect): AuditView {
  return {
    id: row.id,
    siteId: row.siteId,
    scope: row.scope,
    section: row.section,
    urls: row.urls,
    limits: {
      maxPages: (row.limits as { maxPages?: number }).maxPages ?? DEFAULT_LIMITS.maxPages,
      maxDepth: (row.limits as { maxDepth?: number }).maxDepth ?? DEFAULT_LIMITS.maxDepth,
      maxDurationMs: (row.limits as { maxDurationMs?: number }).maxDurationMs ?? DEFAULT_LIMITS.maxDurationMs,
    },
    renderMode: row.renderMode,
    state: row.state,
    stateReason: row.stateReason,
    coverage: (row.coverage as AuditView['coverage']) ?? null,
    pagesCrawled: row.pagesCrawled,
    pagesDiscovered: row.pagesDiscovered,
    pagesFailed: row.pagesFailed,
    requestedByType: row.requestedByType,
    requestedById: row.requestedById,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    lastProgressAt: row.lastProgressAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadAudit(ctx: CommandContext, auditId: string): Promise<typeof schema.audits.$inferSelect> {
  const [audit] = await ctx.tx
    .select()
    .from(schema.audits)
    .where(and(eq(schema.audits.workspaceId, ctx.principal.workspaceId), eq(schema.audits.id, auditId)));
  if (!audit) throw new AppError('not_found', `Audit ${auditId} does not exist in this workspace.`);
  return audit;
}

/** Postgres 23505 on `index`, directly or as the cause of a query error. */
function isUniqueViolation(error: unknown, index: string): boolean {
  for (
    let e = error as { code?: unknown; constraint?: unknown; cause?: unknown } | undefined, depth = 0;
    e && depth < 5;
    e = e.cause as typeof e, depth++
  )
    if (e.code === '23505' && e.constraint === index) return true;
  return false;
}

export const runAudit = defineCommand({
  name: 'audits.run',
  title: 'Run a crawl audit',
  description:
    'Start crawling a site and extract the facts every audit check reads. Use it after the site is verified; only one audit may run per site. Site scope crawls the home page, robots.txt and sitemaps, section scope a path prefix, list/page exactly the URLs given. It costs the site’s bandwidth (bounded by maxPages and maxDurationMs), obeys robots.txt and is polite per host. Returns the queued audit; follow it with audits.status. Rendering is not available yet: only the raw HTML is read.',
  input: z.object({
    siteId: SiteId,
    scope: z.enum(['site', 'section', 'list', 'page']).default('site'),
    section: z.string().min(1).max(500).optional().describe('The path prefix for section scope, e.g. /blog'),
    urls: z
      .array(z.string().min(1).max(2_048))
      .max(10_000)
      .optional()
      .describe('The URLs for list or page scope; each must be on the site’s hosts'),
    limits: LimitsSchema.default(LimitsSchema.parse({})),
    renderMode: z
      .enum(['never', 'auto', 'always'])
      .default('never')
      .describe('Rendering mode. Only “never” works in Phase 1: there is no renderer yet'),
  }),
  output: z.object({ audit: AuditSchema }),
  permission: 'audits:run',
  effect: 'write',
  actionClass: 'crawl',
  target: (input) => input.siteId,
  auditTarget: (output) => output.audit.id,
  handler: async (input, ctx) => {
    if (input.renderMode !== 'never')
      throw new AppError('precondition_failed', 'No renderer is configured (Phase 2). Use renderMode “never” and audit the raw HTML.');
    if (input.scope === 'section' && !input.section)
      throw new AppError('invalid_input', 'Section scope needs a section path, such as /blog.');
    if ((input.scope === 'list' || input.scope === 'page') && !input.urls?.length)
      throw new AppError('invalid_input', 'List and page scope need at least one URL in `urls`.');

    const [site] = await ctx.tx
      .select()
      .from(schema.sites)
      .where(and(eq(schema.sites.workspaceId, ctx.principal.workspaceId), eq(schema.sites.id, input.siteId)));
    if (!site) throw new AppError('not_found', `Site ${input.siteId} does not exist in this workspace.`);
    if (site.archived) throw new AppError('conflict', `Site “${site.name}” is archived, so it cannot be crawled.`);
    if (site.verifiedAt === null)
      throw new AppError(
        'precondition_failed',
        'Verify site ownership before crawling it. A site is verified with a DNS TXT record or a meta tag (sites.verify).',
      );

    const section = input.scope === 'section' ? normalizeSection(input.section ?? '/') : undefined;
    const hosts = siteHostsOf(site);
    const urls =
      input.scope === 'list' || input.scope === 'page'
        ? (input.urls ?? []).map((raw) => {
            const url = normalizeUrl(raw);
            if (url === null) throw new AppError('invalid_input', `${raw} is not an http(s) URL.`);
            if (!isInternalUrl(url, hosts))
              throw new AppError(
                'invalid_input',
                `${raw} is not on this site's hosts (${hosts.join(', ')}). A crawl only fetches the site's own pages.`,
              );
            return url;
          })
        : undefined;

    const running = await liveAuditId(ctx.tx, ctx.principal.workspaceId, site.id);
    if (running)
      throw new AppError(
        'conflict',
        `Site “${site.name}” already has a live audit (${running}). Wait for it to finish, or cancel it with audits.cancel, before starting another.`,
      );

    try {
      const seeded = await seedAudit(ctx.tx, ctx.principal.workspaceId, site, {
        scope: input.scope,
        ...(section ? { section } : {}),
        ...(urls ? { urls } : {}),
        limits: input.limits,
        requestedBy: { type: ctx.principal.type, id: ctx.principal.type === 'agent' ? ctx.principal.agent.id : ctx.principal.userId },
      });
      // Start immediately when Graphile Worker's schema is present (migration 0007's wrapper);
      // otherwise the audit stays queued and `crawl_reconcile` dispatches it within a minute.
      await enqueueFirstChunk(ctx.tx, ctx.principal.workspaceId, seeded.audit.id);
      return { audit: auditView(seeded.audit) };
    } catch (error) {
      if (isUniqueViolation(error, 'audits_one_live'))
        throw new AppError('conflict', `Site “${site.name}” already has a live audit. Wait for it to finish or cancel it first.`);
      throw error;
    }
  },
});

export const auditStatus = defineCommand({
  name: 'audits.status',
  title: 'Audit status',
  description:
    'One audit’s state, why it ended partial or failed, its counters and its coverage, plus how many URLs are pending, leased or skipped. Use it to follow a crawl; there is no ETA. Poll no more than every few seconds.',
  input: z.object({ auditId: AuditId }),
  output: z.object({
    audit: AuditSchema,
    progress: z.object({
      crawled: z.number().int(),
      discovered: z.number().int(),
      failed: z.number().int(),
      pending: z.number().int(),
      leased: z.number().int().describe('URLs a running chunk holds right now'),
      skipped: z.number().int(),
    }),
  }),
  permission: 'sites:read',
  effect: 'read',
  target: (input) => input.auditId,
  handler: async (input, ctx) => {
    const audit = await loadAudit(ctx, input.auditId);
    const { rows } = await ctx.tx.execute<{ state: string; n: string }>(sql`
      SELECT state, count(*)::text AS n FROM crawl_frontier
      WHERE workspace_id = ${ctx.principal.workspaceId} AND audit_id = ${audit.id}
      GROUP BY state`);
    const counts = new Map(rows.map((row) => [row.state, Number(row.n)]));
    return {
      audit: auditView(audit),
      progress: {
        crawled: counts.get('crawled') ?? 0,
        discovered: audit.pagesDiscovered,
        failed: audit.pagesFailed,
        pending: counts.get('pending') ?? 0,
        leased: counts.get('leased') ?? 0,
        skipped: counts.get('skipped') ?? 0,
      },
    };
  },
});

export const listAudits = defineCommand({
  name: 'audits.list',
  title: 'List audits',
  description:
    'The workspace’s audits, newest first, optionally for one site or one state. Use it to find the latest run and its state; `audits.pages` reads what an audit saw. Pages are cursored: pass `nextCursor` back as `cursor`.',
  input: z.object({
    siteId: SiteId.optional(),
    state: z.enum(['queued', 'running', 'finalizing', 'completed', 'partial', 'failed', 'cancelled']).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z.string().max(256).optional().describe('Opaque `nextCursor` from the previous page; omit for the first page'),
  }),
  output: z.object({
    audits: z.array(AuditSchema),
    nextCursor: z.string().nullable().describe('Pass as `cursor` for the next page; null on the last page'),
  }),
  permission: 'sites:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const cursor = input.cursor ? decodeTimestampCursor(input.cursor) : undefined;
    if (input.cursor && !cursor) throw new AppError('invalid_input', 'The cursor is not valid. Omit it to start from the first page.');
    const filter = and(
      input.siteId ? eq(schema.audits.siteId, input.siteId) : undefined,
      input.state ? eq(schema.audits.state, input.state) : undefined,
      cursor
        ? or(
            sql`${schema.audits.createdAt} < ${cursor.at}::timestamptz`,
            and(eq(schema.audits.createdAt, sql`${cursor.at}::timestamptz`), sql`${schema.audits.id} < ${cursor.id}`),
          )
        : undefined,
    );
    const rows = await ctx.tx
      .select({
        audit: schema.audits,
        cursorAt: sql<string>`to_char(${schema.audits.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(schema.audits)
      .where(filter)
      .orderBy(desc(schema.audits.createdAt), desc(schema.audits.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      audits: page.map((row) => auditView(row.audit)),
      nextCursor: rows.length > input.limit && last ? encodeTimestampCursor({ at: last.cursorAt, id: last.audit.id }) : null,
    };
  },
});

const PAGE_STATUS_CLASSES = ['all', 'ok', 'redirect', 'client_error', 'server_error', 'failed', 'robots'] as const;

/** A URL cursor: the last URL of the page, opaque to callers. */
const encodeUrlCursor = (url: string): string => Buffer.from(url, 'utf8').toString('base64url');
const decodeUrlCursor = (cursor: string): string | null => {
  if (cursor.length > 2_800) return null;
  try {
    const url = Buffer.from(cursor, 'base64url').toString('utf8');
    return url.startsWith('http://') || url.startsWith('https://') ? url : null;
  } catch {
    return null;
  }
};

const PageRowSchema = z.object({
  snapshotId: z.string(),
  url: z.string(),
  finalUrl: z.string(),
  status: z.number().int(),
  title: z.string().nullable().describe('The page title from the snapshot, when it has HTML'),
  depth: z.number().int().nullable().describe('Click depth from the seed; null for sitemap-only or listed URLs'),
  discoveredBy: z.enum(['seed', 'link', 'sitemap', 'redirect', 'list']),
  inSitemap: z.boolean(),
  robotsAllowed: z.boolean(),
  fetchedAt: z.string(),
});

export const auditPages = defineCommand({
  name: 'audits.pages',
  title: 'Audit pages',
  description:
    'The pages one audit stored, in URL order: status, title, depth and whether robots.txt allowed them. Filter by status class to find errors or blocked pages. Use `audits.page` for one page’s full facts. Cursored: pass `nextCursor` back as `cursor`.',
  input: z.object({
    auditId: AuditId,
    status: z
      .enum(PAGE_STATUS_CLASSES)
      .default('all')
      .describe('Status class filter; “failed” is a fetch error, “robots” a robots.txt skip'),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().max(2_800).optional().describe('Opaque `nextCursor` from the previous page; omit for the first page'),
  }),
  output: z.object({
    pages: z.array(PageRowSchema),
    nextCursor: z.string().nullable().describe('Pass as `cursor` for the next page; null on the last page'),
  }),
  permission: 'sites:read',
  effect: 'read',
  target: (input) => input.auditId,
  handler: async (input, ctx) => {
    await loadAudit(ctx, input.auditId);
    const cursor = input.cursor ? decodeUrlCursor(input.cursor) : undefined;
    if (input.cursor && !cursor) throw new AppError('invalid_input', 'The cursor is not valid. Omit it to start from the first page.');
    const s = schema.pageSnapshots;
    const facts = sql`${s.facts}`;
    const statusFilter =
      input.status === 'all'
        ? undefined
        : input.status === 'ok'
          ? sql`${s.status} BETWEEN 200 AND 299`
          : input.status === 'redirect'
            ? sql`${s.status} BETWEEN 300 AND 399`
            : input.status === 'client_error'
              ? sql`${s.status} BETWEEN 400 AND 499`
              : input.status === 'server_error'
                ? sql`${s.status} BETWEEN 500 AND 599`
                : input.status === 'failed'
                  ? sql`${s.status} = 0 AND (${facts} ->> 'robotsAllowed')::boolean`
                  : sql`${s.status} = 0 AND NOT (${facts} ->> 'robotsAllowed')::boolean`;
    const rows = await ctx.tx
      .select({
        id: s.id,
        url: s.url,
        finalUrl: s.finalUrl,
        status: s.status,
        facts: s.facts,
        fetchedAt: s.fetchedAt,
      })
      .from(s)
      .where(
        and(
          eq(s.workspaceId, ctx.principal.workspaceId),
          eq(s.auditId, input.auditId),
          cursor ? gt(s.url, cursor) : undefined,
          statusFilter,
        ),
      )
      .orderBy(asc(s.url))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      pages: page.map((row) => {
        const factsValue = row.facts as { depth?: number | null; discoveredBy?: string; inSitemap?: boolean; robotsAllowed?: boolean };
        const html = (row.facts as { html?: { title?: string | null } | null }).html ?? null;
        return {
          snapshotId: row.id,
          url: row.url,
          finalUrl: row.finalUrl,
          status: row.status,
          title: html?.title ?? null,
          depth: factsValue.depth ?? null,
          discoveredBy: (factsValue.discoveredBy ?? 'seed') as 'seed' | 'link' | 'sitemap' | 'redirect' | 'list',
          inSitemap: factsValue.inSitemap ?? false,
          robotsAllowed: factsValue.robotsAllowed ?? true,
          fetchedAt: row.fetchedAt.toISOString(),
        };
      }),
      nextCursor: rows.length > input.limit && last ? encodeUrlCursor(last.url) : null,
    };
  },
});

export const auditPage = defineCommand({
  name: 'audits.page',
  title: 'Audit page facts',
  description:
    'The full extracted facts for one page of an audit: status, redirects, headers, timings and the HTML facts (title, meta, canonical, robots, hreflang, headings, links, images, JSON-LD, word count, content hash, mixed content). Use it to explain a finding. Identify the page by `url` or by the `snapshotId` that audits.pages returns.',
  input: z.object({
    auditId: AuditId,
    url: z.string().min(1).max(2_048).optional().describe('The page URL as audits.pages lists it'),
    snapshotId: z.string().min(1).max(64).optional().describe('The snapshot id from audits.pages'),
  }),
  output: z.object({ page: z.looseObject({ url: z.string(), status: z.number() }) }),
  permission: 'sites:read',
  effect: 'read',
  target: (input) => `${input.auditId}:${input.url ?? input.snapshotId ?? ''}`,
  handler: async (input, ctx) => {
    await loadAudit(ctx, input.auditId);
    if (!input.url && !input.snapshotId) throw new AppError('invalid_input', 'Give the page `url` or its `snapshotId`.');
    const [row] = await ctx.tx
      .select({ facts: schema.pageSnapshots.facts })
      .from(schema.pageSnapshots)
      .where(
        and(
          eq(schema.pageSnapshots.workspaceId, ctx.principal.workspaceId),
          eq(schema.pageSnapshots.auditId, input.auditId),
          input.snapshotId ? eq(schema.pageSnapshots.id, input.snapshotId) : eq(schema.pageSnapshots.url, input.url ?? ''),
        ),
      )
      .limit(1);
    if (!row) throw new AppError('not_found', `Audit ${input.auditId} has no snapshot for ${input.url ?? input.snapshotId}.`);
    return { page: row.facts as unknown as { url: string; status: number } };
  },
});

export const cancelAudit = defineCommand({
  name: 'audits.cancel',
  title: 'Cancel an audit',
  description:
    'Stop an audit. A running chunk finishes the pages it has in flight and stops within a few pages; the pages already crawled stay viewable, and the audit is finalized with reason “cancelled”. Use it to free the site for a new audit or to stop a crawl that was too broad.',
  input: z.object({ auditId: AuditId }),
  output: z.object({ audit: AuditSchema }),
  permission: 'audits:run',
  effect: 'write',
  actionClass: 'crawl',
  target: (input) => input.auditId,
  handler: async (input, ctx) => {
    const audit = await loadAudit(ctx, input.auditId);
    // Take the audit row lock first (the crawl's one lock order, `lockAudit`) and decide on the
    // locked row: an audit can finish between an unlocked read and its update, and cancelling a
    // completed audit would rewrite its ending. The update is conditional as well, so even a path
    // that skipped the lock cannot turn a finished audit into a cancelled one.
    const [locked] = await ctx.tx
      .select()
      .from(schema.audits)
      .where(and(eq(schema.audits.workspaceId, ctx.principal.workspaceId), eq(schema.audits.id, audit.id)))
      .for('update');
    const current = locked ?? audit;
    if (current.finishedAt !== null || current.state === 'completed' || current.state === 'partial' || current.state === 'failed')
      throw new AppError('conflict', `Audit ${current.id} has already finished (${current.state}); there is nothing to cancel.`);
    if (current.state === 'cancelled') return { audit: auditView(current) };
    const [updated] = await ctx.tx
      .update(schema.audits)
      .set({ state: 'cancelled', stateReason: 'cancelled', lastProgressAt: new Date() })
      .where(
        and(
          eq(schema.audits.workspaceId, ctx.principal.workspaceId),
          eq(schema.audits.id, current.id),
          sql`${schema.audits.state} IN ('queued', 'running')`,
        ),
      )
      .returning();
    if (!updated) throw new AppError('conflict', `This audit already finished (${current.state}); it was not cancelled.`);
    return { audit: auditView(updated) };
  },
});

export const auditCommands = [runAudit, auditStatus, listAudits, auditPages, auditPage, cancelAudit] as const;
