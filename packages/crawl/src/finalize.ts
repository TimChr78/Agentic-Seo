import type { Db, Tx } from '@agentic-seo/db';
import { schema } from '@agentic-seo/db';
import { and, eq, sql } from 'drizzle-orm';
import type { PageFacts, SiteFacts } from './facts';
import type { Coverage, TruncationReason } from './hooks';
import { auditHooks } from './hooks-registry';
import { type CrawlLimits, DEFAULT_LIMITS, limitsOf, MAX_PAGES } from './limits';
import { siteHomeUrl } from './url';

// Atomic completion (crawler-and-audits.md §2): in one transaction, lock the audit, confirm nothing
// is pending or leased, compute `Coverage`, call `onFinalize` (site-level checks read `link_edges`
// here), keep the link-graph summary, drop the edges, and record the final state and counters.
//
// Two chunks finishing at once finalize exactly once: the second waits on the row lock, then sees
// `finished_at` and returns. A cancelled audit finalizes too — its remaining URLs are skipped as
// `cancelled` — so the pages it did crawl stay viewable.

export { DEFAULT_LIMITS, MAX_PAGES };

/** The finalize a reconciler forces on a stalled or over-time audit. */
export interface ForcedFinalize {
  state: 'partial' | 'failed';
  /** The sentence stored as `state_reason` and shown to a person. */
  reason: string;
  /** The truncation reasons added to coverage. */
  reasons: readonly TruncationReason[];
  /** Why the URLs that were never finished are skipped. */
  skipPendingAs: string;
}

export interface FinalizeOptions {
  force?: ForcedFinalize;
}

const TERMINAL = new Set(['completed', 'partial', 'failed']);

/** Counts of the frontier states an audit may still be in. */
async function frontierCounts(tx: Tx, workspaceId: string, auditId: string) {
  const { rows } = await tx.execute<{ pending: string; leased: string; crawled: string; discovered: string }>(sql`
    SELECT count(*) FILTER (WHERE state = 'pending')::text AS pending,
           count(*) FILTER (WHERE state = 'leased')::text AS leased,
           count(*) FILTER (WHERE state = 'crawled')::text AS crawled,
           count(*)::text AS discovered
    FROM crawl_frontier WHERE workspace_id = ${workspaceId} AND audit_id = ${auditId}`);
  const row = rows[0];
  return {
    pending: Number(row?.pending ?? 0),
    leased: Number(row?.leased ?? 0),
    crawled: Number(row?.crawled ?? 0),
    discovered: Number(row?.discovered ?? 0),
  };
}

/** What the coverage reasons are, from the frontier itself. */
async function coverageReasons(
  tx: Tx,
  audit: typeof schema.audits.$inferSelect,
  counts: Awaited<ReturnType<typeof frontierCounts>>,
  limits: CrawlLimits,
  nowMs: number,
): Promise<Set<TruncationReason>> {
  const reasons = new Set<TruncationReason>();
  if (audit.state === 'cancelled') reasons.add('cancelled');
  const { rows } = await tx.execute<{ skip_reason: string; n: string }>(sql`
    SELECT skip_reason, count(*)::text AS n FROM crawl_frontier
    WHERE workspace_id = ${audit.workspaceId} AND audit_id = ${audit.id}
      AND state = 'skipped' AND skip_reason IS NOT NULL
    GROUP BY skip_reason`);
  for (const row of rows) {
    if (row.skip_reason === 'depth_limit') reasons.add('depth_limit');
    if (row.skip_reason === 'robots') reasons.add('robots');
    if (row.skip_reason === 'section_quota') reasons.add('section_quota');
  }
  if (counts.crawled >= limits.maxPages && counts.discovered > counts.crawled) reasons.add('page_limit');
  if (audit.startedAt && nowMs - audit.startedAt.getTime() >= limits.maxDurationMs) reasons.add('time_limit');
  // The extractor caps a page's links and images. A page whose links were cut short means the graph
  // is missing edges — and therefore possibly pages — so graph checks cannot claim completeness.
  const truncatedPages = await tx.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM page_snapshots
    WHERE workspace_id = ${audit.workspaceId} AND audit_id = ${audit.id}
      AND facts #>> '{html,linksTruncated}' = 'true'`);
  if (Number(truncatedPages.rows[0]?.n ?? 0) > 0) reasons.add('links_truncated');
  // Sitemap seeding stopped at a cap: its list is not the site's whole list, which orphan detection
  // depends on.
  const siteFacts = (audit.siteFacts ?? null) as SiteFacts | null;
  if (siteFacts?.sitemapsTruncated === true) reasons.add('sitemaps_truncated');
  const failed = await tx.execute<{ failed: string }>(sql`
    SELECT count(*)::text AS failed FROM page_snapshots
    WHERE workspace_id = ${audit.workspaceId} AND audit_id = ${audit.id}
      AND (status >= 500 OR (facts ->> 'fetchError') IS NOT NULL)`);
  // `crawled` already includes the pages that failed, so it is the attempted count.
  const attempted = counts.crawled;
  if (attempted >= 5 && Number(failed.rows[0]?.failed ?? 0) / attempted > 0.2) reasons.add('errors');
  return reasons;
}

/** The stored `SiteFacts`, with `home` filled from the home page's snapshot when it was fetched. */
async function siteFactsFor(tx: Tx, audit: typeof schema.audits.$inferSelect, site: typeof schema.sites.$inferSelect): Promise<SiteFacts> {
  const stored = (audit.siteFacts ?? null) as SiteFacts | null;
  const [home] = await tx
    .select({ facts: schema.pageSnapshots.facts })
    .from(schema.pageSnapshots)
    .where(
      and(
        eq(schema.pageSnapshots.workspaceId, audit.workspaceId),
        eq(schema.pageSnapshots.auditId, audit.id),
        eq(schema.pageSnapshots.url, siteHomeUrl(site.primaryDomain)),
      ),
    )
    .limit(1);
  if (stored) return { ...stored, home: (home?.facts as unknown as PageFacts | undefined) ?? null };
  return {
    origin: new URL(siteHomeUrl(site.primaryDomain)).origin,
    robotsTxt: {
      url: new URL('/robots.txt', siteHomeUrl(site.primaryDomain)).href,
      status: 0,
      fetchError: 'the audit did not record robots.txt facts',
      parseErrors: [],
      sitemaps: [],
      disallowAllFor: [],
      body: null,
    },
    sitemaps: [],
    home: (home?.facts as unknown as PageFacts | undefined) ?? null,
    httpRedirectsToHttps: null,
  };
}

/**
 * Keeps the link-graph summary and drops the audit's edges (crawler-and-audits.md §2). Runs after
 * `onFinalize`, so site-level checks still see every edge.
 */
async function keepLinkStats(tx: Tx, workspaceId: string, auditId: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO page_link_stats (workspace_id, audit_id, url_hash, inlinks, outlinks, internal_inlinks, sample_anchors)
    SELECT ${workspaceId}, ${auditId}, u.url_hash,
           COALESCE(i.inlinks, 0), COALESCE(o.outlinks, 0), COALESCE(i.internal_inlinks, 0), COALESCE(i.anchors, '{}')
    FROM (
      SELECT from_url_hash AS url_hash FROM link_edges WHERE workspace_id = ${workspaceId} AND audit_id = ${auditId}
      UNION
      SELECT to_url_hash FROM link_edges WHERE workspace_id = ${workspaceId} AND audit_id = ${auditId}
    ) u
    LEFT JOIN (
      SELECT to_url_hash AS url_hash, count(*)::int AS inlinks,
             count(*) FILTER (WHERE internal)::int AS internal_inlinks,
             (array_agg(DISTINCT anchor) FILTER (WHERE anchor <> ''))[1:5] AS anchors
      FROM link_edges WHERE workspace_id = ${workspaceId} AND audit_id = ${auditId}
      GROUP BY to_url_hash
    ) i ON i.url_hash = u.url_hash
    LEFT JOIN (
      SELECT from_url_hash AS url_hash, count(*)::int AS outlinks
      FROM link_edges WHERE workspace_id = ${workspaceId} AND audit_id = ${auditId}
      GROUP BY from_url_hash
    ) o ON o.url_hash = u.url_hash
    ON CONFLICT (workspace_id, audit_id, url_hash) DO UPDATE SET
      inlinks = excluded.inlinks, outlinks = excluded.outlinks,
      internal_inlinks = excluded.internal_inlinks, sample_anchors = excluded.sample_anchors`);
  await tx.execute(sql`DELETE FROM link_edges WHERE workspace_id = ${workspaceId} AND audit_id = ${auditId}`);
}

/**
 * Finalizes an audit if it can. Returns whether this call did the finalize, so two racing chunks
 * report one completion and the other reports "not mine".
 */
export async function finalizeAudit(
  db: Db,
  ref: { workspaceId: string; auditId: string },
  options: FinalizeOptions = {},
): Promise<boolean> {
  const nowMs = Date.now();
  return db.withWorkspace(ref.workspaceId, async (tx) => {
    const [audit] = await tx
      .select()
      .from(schema.audits)
      .where(and(eq(schema.audits.workspaceId, ref.workspaceId), eq(schema.audits.id, ref.auditId)))
      .for('update');
    if (!audit) return false;
    if (audit.finishedAt || TERMINAL.has(audit.state)) return false;

    const [siteRow] = await tx
      .select()
      .from(schema.sites)
      .where(and(eq(schema.sites.workspaceId, ref.workspaceId), eq(schema.sites.id, audit.siteId)));
    if (!siteRow) return false;

    const cancelled = audit.state === 'cancelled';
    const limits = limitsOf(audit);
    let counts = await frontierCounts(tx, ref.workspaceId, ref.auditId);

    if (!options.force && !cancelled && counts.pending + counts.leased > 0) {
      if (counts.crawled < limits.maxPages) return false;
      // The page budget is spent: the URLs that were never fetched are skipped, and the audit
      // still ends `completed` with a truncated graph (the brief's page_limit rule).
      await tx.execute(sql`
        UPDATE crawl_frontier SET state = 'skipped', skip_reason = 'page_limit', lease_chunk = NULL, lease_expires_at = NULL
        WHERE workspace_id = ${ref.workspaceId} AND audit_id = ${ref.auditId} AND state IN ('pending', 'leased')`);
      counts = await frontierCounts(tx, ref.workspaceId, ref.auditId);
    }

    // Nothing can still be crawled: a cancelled audit's remaining URLs are skipped, and a forced
    // finalize records why the abandoned ones were never fetched.
    if (cancelled || options.force) {
      const reason = cancelled ? 'cancelled' : (options.force?.skipPendingAs ?? 'abandoned');
      await tx.execute(sql`
        UPDATE crawl_frontier SET state = 'skipped', skip_reason = ${reason}, lease_chunk = NULL, lease_expires_at = NULL
        WHERE workspace_id = ${ref.workspaceId} AND audit_id = ${ref.auditId} AND state IN ('pending', 'leased')`);
      counts = await frontierCounts(tx, ref.workspaceId, ref.auditId);
    }

    if (!cancelled) await tx.update(schema.audits).set({ state: 'finalizing' }).where(eq(schema.audits.id, audit.id));

    const reasons = await coverageReasons(tx, audit, counts, limits, nowMs);
    for (const reason of options.force?.reasons ?? []) reasons.add(reason);
    const ordered = [...reasons].sort();

    const coverage: Coverage = {
      scope: audit.scope,
      graph: ordered.length === 0 ? 'complete' : 'truncated',
      reasons: ordered,
      pagesCrawled: counts.crawled,
      pagesDiscovered: counts.discovered,
      ...(audit.scope === 'section' && audit.section ? { section: audit.section } : {}),
      ...(audit.scope === 'list' || audit.scope === 'page' ? { urls: audit.urls ?? undefined } : {}),
    };

    const pagesFailed = Number(
      (
        await tx.execute<{ failed: string }>(sql`
          SELECT count(*)::text AS failed FROM page_snapshots
          WHERE workspace_id = ${audit.workspaceId} AND audit_id = ${audit.id}
            AND (status >= 500 OR (facts ->> 'fetchError') IS NOT NULL)`)
      ).rows[0]?.failed ?? 0,
    );

    const timedOut = reasons.has('time_limit');
    const errorHeavy = reasons.has('errors');
    let state: 'completed' | 'partial' | 'failed' | 'cancelled';
    let stateReason: string | null;
    if (cancelled) {
      state = 'cancelled';
      stateReason = 'cancelled';
    } else if (options.force) {
      state = options.force.state;
      stateReason = options.force.reason;
    } else if (timedOut || errorHeavy) {
      state = counts.crawled > 0 ? 'partial' : 'failed';
      stateReason =
        timedOut && errorHeavy
          ? 'The audit reached its time limit and too many pages failed.'
          : timedOut
            ? 'The audit reached its time limit.'
            : 'More than 20% of the pages failed to load.';
    } else {
      state = 'completed';
      stateReason = null;
    }

    const siteFacts = await siteFactsFor(tx, audit, siteRow);
    const auditRef = { workspaceId: audit.workspaceId, siteId: audit.siteId, auditId: audit.id };
    for (const hook of auditHooks()) await hook.onFinalize?.(tx, { ...auditRef, coverage, site: siteFacts });

    await keepLinkStats(tx, audit.workspaceId, audit.id);
    await tx
      .update(schema.audits)
      .set({
        state,
        stateReason,
        coverage,
        siteFacts: siteFacts as unknown as Record<string, unknown>,
        pagesCrawled: counts.crawled,
        pagesDiscovered: counts.discovered,
        pagesFailed: pagesFailed,
        finishedAt: new Date(nowMs),
        lastProgressAt: new Date(nowMs),
      })
      .where(and(eq(schema.audits.workspaceId, audit.workspaceId), eq(schema.audits.id, audit.id)));
    return true;
  });
}
