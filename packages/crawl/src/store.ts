import { schema, type Tx } from '@agentic-seo/db';
import { and, eq, sql } from 'drizzle-orm';
import type { PageFacts } from './facts';

// The writes one crawled page makes, all in the caller's tenant transaction: the snapshot, the
// stable page row, link edges, newly discovered frontier rows, and then the frontier state. The
// order matters (crawler-and-audits.md §2): discoveries are persisted before the page is marked
// crawled, so a killed chunk never loses a URL it saw.

export interface FrontierSeed {
  url: string;
  urlHash: string;
  depth: number | null;
  discoveredBy: 'seed' | 'link' | 'sitemap' | 'redirect' | 'list';
  discoveredFrom: string | null;
  inSitemap: boolean;
  section: string;
}

export interface LinkRow {
  fromUrlHash: string;
  toUrlHash: string;
  toUrl: string;
  rel: string[];
  anchor: string;
  internal: boolean;
}

/** Stores or replaces one page's snapshot (the id is deterministic, so a retry upserts). */
export async function storeSnapshot(
  tx: Tx,
  values: { workspaceId: string; id: string; siteId: string; auditId: string; page: PageFacts },
): Promise<boolean> {
  const { page } = values;
  const contentHash = page.html?.contentHash ?? null;
  // `xmax = 0` is true only for a row this statement inserted, not one the upsert updated: the page
  // counters move by the delta, so a re-stored page is not counted twice.
  const [row] = await tx
    .insert(schema.pageSnapshots)
    .values({
      workspaceId: values.workspaceId,
      id: values.id,
      siteId: values.siteId,
      auditId: values.auditId,
      url: page.url,
      finalUrl: page.finalUrl,
      status: page.status,
      facts: page as unknown as Record<string, unknown>,
      contentHash,
      fetchedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [schema.pageSnapshots.workspaceId, schema.pageSnapshots.id],
      set: {
        finalUrl: page.finalUrl,
        status: page.status,
        facts: page as unknown as Record<string, unknown>,
        contentHash,
        fetchedAt: new Date(),
      },
    })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  return row?.inserted === true;
}

/** Upserts the stable per-site page row that a snapshot updates. */
export async function storePage(
  tx: Tx,
  values: { workspaceId: string; siteId: string; pageId: string; auditId: string; url: string; status: number },
): Promise<void> {
  await tx
    .insert(schema.pages)
    .values({
      workspaceId: values.workspaceId,
      id: values.pageId,
      siteId: values.siteId,
      url: values.url,
      lastAuditId: values.auditId,
      lastStatus: values.status,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [schema.pages.workspaceId, schema.pages.siteId, schema.pages.url],
      set: {
        lastAuditId: values.auditId,
        lastStatus: values.status,
        lastSeenAt: new Date(),
      },
    });
}

/** Inserts a page's link edges, merging the rel tokens when a page links a URL twice. */
export async function storeEdges(tx: Tx, workspaceId: string, auditId: string, rows: readonly LinkRow[]): Promise<void> {
  if (rows.length === 0) return;
  const c = schema.linkEdges;
  const values = rows.map((row) => ({
    workspaceId,
    auditId,
    fromUrlHash: row.fromUrlHash,
    toUrlHash: row.toUrlHash,
    toUrl: row.toUrl,
    rel: row.rel,
    anchor: row.anchor,
    internal: row.internal,
  }));
  // Chunked so one dense page cannot exceed Postgres' bind-parameter limit.
  for (let index = 0; index < values.length; index += 500) {
    await tx
      .insert(c)
      .values(values.slice(index, index + 500))
      .onConflictDoUpdate({
        target: [c.workspaceId, c.auditId, c.fromUrlHash, c.toUrlHash],
        set: {
          rel: sql`ARRAY(SELECT DISTINCT unnest(${c.rel} || excluded.rel) ORDER BY 1)`,
          anchor: sql`CASE WHEN ${c.anchor} = '' THEN excluded.anchor ELSE ${c.anchor} END`,
        },
      });
  }
}

/**
 * Adds discovered URLs to the frontier. An existing row keeps its state; a sitemap sighting sets
 * `in_sitemap`, and a link sighting fills a missing depth (click depth beats "sitemap only").
 * `depth_limit` skips are inserted as skipped so coverage can explain the truncation.
 *
 * Returns how many URLs were new (inserted rather than updated), which is the `pages_discovered`
 * delta the page commit records.
 */
export async function storeDiscoveries(
  tx: Tx,
  workspaceId: string,
  auditId: string,
  rows: readonly (FrontierSeed & { skippedForDepth?: boolean })[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const c = schema.crawlFrontier;
  const values: (typeof c.$inferInsert)[] = rows.map((row) => ({
    workspaceId,
    auditId,
    urlHash: row.urlHash,
    url: row.url,
    state: row.skippedForDepth ? 'skipped' : 'pending',
    skipReason: row.skippedForDepth ? 'depth_limit' : null,
    depth: row.depth,
    discoveredBy: row.discoveredBy,
    discoveredFrom: row.discoveredFrom,
    inSitemap: row.inSitemap,
    section: row.section,
    attempts: 0,
  }));
  let inserted = 0;
  for (let index = 0; index < values.length; index += 500) {
    const returned = await tx
      .insert(c)
      .values(values.slice(index, index + 500))
      .onConflictDoUpdate({
        target: [c.workspaceId, c.auditId, c.urlHash],
        set: {
          inSitemap: sql`${c.inSitemap} OR excluded.in_sitemap`,
          depth: sql`COALESCE(${c.depth}, excluded.depth)`,
          // A sitemap URL that a link later reaches keeps its sitemap credit but gains a depth.
          discoveredBy: sql`CASE WHEN ${c.discoveredBy} = 'sitemap' AND excluded.depth IS NOT NULL THEN 'link' ELSE ${c.discoveredBy} END`,
        },
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    inserted += returned.filter((row) => row.inserted).length;
  }
  return inserted;
}

/**
 * Marks a frontier row crawled or skipped, clearing its lease. Only the chunk that holds the
 * lease may do so: a late write from a chunk whose lease the reconciler released (or another chunk
 * re-leased) matches no row and changes nothing.
 */
export async function markFrontier(
  tx: Tx,
  workspaceId: string,
  auditId: string,
  urlHash: string,
  chunk: number,
  state: 'crawled' | 'skipped',
  skipReason: string | null,
): Promise<void> {
  await tx
    .update(schema.crawlFrontier)
    .set({ state, skipReason, leaseChunk: null, leaseExpiresAt: null })
    .where(
      and(
        eq(schema.crawlFrontier.workspaceId, workspaceId),
        eq(schema.crawlFrontier.auditId, auditId),
        eq(schema.crawlFrontier.urlHash, urlHash),
        eq(schema.crawlFrontier.state, 'leased'),
        eq(schema.crawlFrontier.leaseChunk, chunk),
      ),
    );
}

/** Releases a chunk's leases; a killed or over-deadline chunk calls it, and so does a retry. */
export async function releaseChunkLeases(tx: Tx, workspaceId: string, auditId: string, chunk: number): Promise<number> {
  const result = await tx.execute<{ url_hash: string }>(sql`
    UPDATE crawl_frontier
    SET state = 'pending', lease_chunk = NULL, lease_expires_at = NULL
    WHERE workspace_id = ${workspaceId} AND audit_id = ${auditId} AND lease_chunk = ${chunk} AND state = 'leased'
    RETURNING url_hash`);
  return result.rows.length;
}

/** Releases every expired lease of an audit (the reconciler's first repair step). */
export async function releaseExpiredLeases(tx: Tx, workspaceId: string, auditId: string): Promise<number> {
  const result = await tx.execute<{ url_hash: string }>(sql`
    UPDATE crawl_frontier
    SET state = 'pending', lease_chunk = NULL, lease_expires_at = NULL
    WHERE workspace_id = ${workspaceId} AND audit_id = ${auditId}
      AND state = 'leased' AND lease_expires_at < now()
    RETURNING url_hash`);
  return result.rows.length;
}

/**
 * Recomputes an audit's counters from the rows themselves. Every chunk finishes with it (once, not
 * once per page) and finalize runs it again, so the counters are exactly right even after a retry or
 * a reconciler repair. It deliberately does not touch `last_progress_at`: that moves only when a
 * page actually commits (`recordPageProgress`).
 */
export async function refreshCounters(tx: Tx, workspaceId: string, auditId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE audits a SET
      pages_crawled = (SELECT count(*) FROM crawl_frontier f WHERE f.workspace_id = a.workspace_id AND f.audit_id = a.id AND f.state = 'crawled'),
      pages_discovered = (SELECT count(*) FROM crawl_frontier f WHERE f.workspace_id = a.workspace_id AND f.audit_id = a.id),
      pages_failed = (
        SELECT count(*) FROM page_snapshots s
        WHERE s.workspace_id = a.workspace_id AND s.audit_id = a.id
          AND (s.status >= 500 OR (s.facts ->> 'fetchError') IS NOT NULL)
      )
    WHERE a.workspace_id = ${workspaceId} AND a.id = ${auditId}`);
}

/** What one committed page adds to the counters; every field is a delta, not a total. */
export interface PageProgressDelta {
  /** 1 when the page's snapshot was new, 0 when the page was re-stored. */
  crawled: number;
  /** 1 when the new page failed to load (a fetch error or a 5xx status). */
  failed: number;
  /** Frontier rows this page discovered that were new. */
  discovered: number;
}

/**
 * Records that one page committed: the counter deltas and `last_progress_at`, in the same
 * transaction as the page's writes. The deltas are computed in that transaction (the snapshot's
 * and the frontier rows' own insert/update answers), so the page commit costs one indexed update
 * instead of recounting the whole audit — the page fence serialises commits, so the critical
 * section must stay short. Finalize recounts exactly once. The reconciler measures stalls from
 * `last_progress_at`, so a crawl that keeps committing pages is never mistaken for a stalled one.
 */
export async function recordPageProgress(
  tx: Tx,
  workspaceId: string,
  auditId: string,
  atMs: number,
  delta: PageProgressDelta,
): Promise<void> {
  await tx.execute(sql`
    UPDATE audits SET
      pages_crawled = pages_crawled + ${delta.crawled},
      pages_failed = pages_failed + ${delta.failed},
      pages_discovered = pages_discovered + ${delta.discovered},
      last_progress_at = to_timestamp(${atMs} / 1000.0)
    WHERE workspace_id = ${workspaceId} AND id = ${auditId}`);
}

/**
 * THE ONE LOCK ORDER for a crawl audit's writes, everywhere:
 *   1. the `audits` row (`lockAudit`, `FOR UPDATE`),
 *   2. `crawl_frontier` rows of that audit,
 *   3. the page's snapshot, page, edge and link-stat rows.
 *
 * Page commits (`claimPageWrite`), chunk lease release and cleanup (`abandonChunk`,
 * `releaseExpiredLeases`, the retry release in `leaseBatch`), seed persistence and finalize all take
 * the audit lock first. A path that needs two of these locks must not take them the other way round:
 * a cleanup that locked frontier rows and then waited for the audit row deadlocked against a page
 * commit that held the audit row and wanted one of those frontier rows (SQLSTATE 40P01).
 */
export async function lockAudit(tx: Tx, workspaceId: string, auditId: string) {
  const [audit] = await tx
    .select()
    .from(schema.audits)
    .where(and(eq(schema.audits.workspaceId, workspaceId), eq(schema.audits.id, auditId)))
    .for('update');
  return audit ?? null;
}

/**
 * The fence every page write passes before it may store anything: the audit must still be
 * `running`, and the frontier row must still be leased by this chunk.
 *
 * The audit row is locked `FOR UPDATE` — the same lock finalize takes, first in the order documented
 * on `lockAudit` — so page commits and finalization are mutually exclusive: a page that starts first
 * commits before the finalize can finish, and a page that starts after it waits and then sees a
 * finished audit, so it writes nothing. Page commits therefore serialise with each other as well;
 * fetching stays concurrent and the commit is a few short statements, which is a cheap price for a
 * fence with no lock upgrade deadlocks. A lease the reconciler released (or another chunk took over)
 * no longer matches the chunk number, so a resumed chunk cannot write into a finished audit or over
 * another chunk's page.
 */
export async function claimPageWrite(
  tx: Tx,
  fence: { workspaceId: string; auditId: string; chunk: number; urlHash: string },
): Promise<boolean> {
  const audit = await lockAudit(tx, fence.workspaceId, fence.auditId);
  if (audit?.state !== 'running') return false;

  const [row] = await tx
    .select({ state: schema.crawlFrontier.state, leaseChunk: schema.crawlFrontier.leaseChunk })
    .from(schema.crawlFrontier)
    .where(
      and(
        eq(schema.crawlFrontier.workspaceId, fence.workspaceId),
        eq(schema.crawlFrontier.auditId, fence.auditId),
        eq(schema.crawlFrontier.urlHash, fence.urlHash),
      ),
    )
    .for('update');
  return row?.state === 'leased' && row.leaseChunk === fence.chunk;
}
