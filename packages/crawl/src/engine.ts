import { AppError } from '@agentic-seo/core';
import type { Db, Tx } from '@agentic-seo/db';
import { schema } from '@agentic-seo/db';
import {
  buildUserAgent,
  type HostLease,
  type HostLimiter,
  MemoryRobotsCache,
  parseRetryAfter,
  type RedirectHop,
  Robots,
  type RobotsCache,
} from '@agentic-seo/fetch';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { extractHtml } from './extract';
import type { PageFacts, PageLink } from './facts';
import { crawlFetch, crawlFetchOptions } from './fetch-options';
import { type ForcedFinalize, finalizeAudit } from './finalize';
import type { AuditHooks, AuditRef } from './hooks';
import { auditHooks } from './hooks-registry';
import { limitsOf } from './limits';
import { type SeedSiteOptions, seedSite } from './seed';
import {
  claimPageWrite,
  type FrontierSeed,
  type LinkRow,
  lockAudit,
  markFrontier,
  recordPageProgress,
  refreshCounters,
  releaseChunkLeases,
  storeDiscoveries,
  storeEdges,
  storePage,
  storeSnapshot,
} from './store';
import { hostOf, isInternalUrl, isUnderSection, normalizeUrl, pageId, sectionOf, siteHostsOf, snapshotId, urlHash } from './url';

// One crawl chunk (crawler-and-audits.md §2): seed the audit (robots, sitemaps, HTTP probe) if the
// worker has not yet, lease at most 200 pending URLs, fetch them with a rolling concurrency window
// through the SSRF guard and the global host limiter, store each page's facts, links and
// discoveries in one tenant transaction, then either enqueue the next chunk or finalize the audit.
//
// Every page commit is fenced (`claimPageWrite`): the page's transaction takes the audit row
// `FOR SHARE` and checks its frontier row is still leased by this chunk. A resume after a cancel, a
// forced finalize or an expired-lease takeover therefore writes nothing — not a snapshot, not an
// edge, not a hook — instead of adding to a finished audit. A chunk that leases nothing always
// either finalizes (quota-blocked rows are marked `section_quota`) or schedules its successor.
//
// Redirects are followed here, one hop at a time (`maxRedirects: 0`), so every hop is checked
// against the site's hosts, robots.txt and the destination host's limiter before it is fetched.

/** The payload of a `crawl_chunk` job. `chunk` is the unique lease generation (a database sequence). */
export interface CrawlChunkPayload {
  workspaceId: string;
  auditId: string;
  chunk: number;
}

/** What one chunk did, for the worker's log line and the tests. */
export interface CrawlChunkResult {
  /** URLs leased by this chunk. */
  leased: number;
  /** URLs fetched and stored. */
  processed: number;
  /** Pages that finished but were dropped because the audit or the lease moved on. */
  dropped: number;
  /** Leases released unfinished because the chunk stopped (cancelled, deadline). */
  released: number;
  /** Whether this chunk finalized the audit. */
  finalized: boolean;
  /** Whether pending URLs remained when the chunk stopped, and a successor was scheduled. */
  more: boolean;
  /** The audit stopped being `running` while the chunk worked. */
  stopped: boolean;
}

/** The persistence boundaries a test can interrupt to simulate a killed worker. */
export type CrawlBoundary = 'afterFetch' | 'insidePageWrite' | 'afterPageCommit' | 'beforeFinalize';

export interface CrawlEngineOptions {
  /** The global per-host limiter; the worker creates one `PgHostLimiter` per process. */
  limiter: HostLimiter;
  /** The server version, for the honest user agent. */
  version?: string;
  /** A chunk stops taking new pages after this long and releases what it did not start. Default 4 min. */
  softDeadlineMs?: number;
  /** The most URLs one chunk leases (the design's ~200). */
  chunkSize?: number;
  /** How long the crawl_seed step may take before its fetches abort. Default 60 s. */
  seedDeadlineMs?: number;
  /** Caps for the seed's sitemap read (a test injects a small one; production uses the defaults). */
  seedSitemapCaps?: { maxDocuments?: number; maxQueuedSitemaps?: number; maxUrls?: number };
  /** Redirect hops followed per page before the chain is recorded and stopped. Default 10. */
  maxRedirects?: number;
  /** How often a chunk checks for cancellation while pages are in flight. Default 2 s. */
  cancelPollMs?: number;
  /** Called to enqueue the next chunk; `runAt` postpones it past a host backoff. */
  enqueueNext?: (payload: CrawlChunkPayload, options?: { runAt?: Date }) => Promise<void> | void;
  now?: () => number;
  logger?: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void };
  /**
   * Test-only: runs at each persistence boundary. Throwing simulates a worker dying exactly there,
   * which is how the killed-worker tests interrupt a chunk between the fetch and the commit, after
   * a commit, and before the finalize.
   */
  boundary?: (point: CrawlBoundary, row: { urlHash: string; url: string } | null) => void | Promise<void>;
  /** Test-only fetch seam for the seed step (the fixture site). */
  seedFetch?: SeedSiteOptions['fetch'];
}

type AuditRow = typeof schema.audits.$inferSelect;
type SiteRow = typeof schema.sites.$inferSelect;
type FrontierRow = typeof schema.crawlFrontier.$inferSelect;

const DEFAULT_CHUNK_SIZE = 200;
const START_CONCURRENCY = 4;
const MIN_CONCURRENCY = 2;
const MAX_CONCURRENCY = 16;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** The robots cache is per process: a site's rules change slowly, and every replica reads its own. */
let robotsCache: RobotsCache = new MemoryRobotsCache(1_000);

/** Test-only: forget cached robots rules. */
export function resetRobotsCache(): void {
  robotsCache = new MemoryRobotsCache(1_000);
}

const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** The next lease generation. A database sequence, so two chunks can never share one. */
export async function nextChunkNumber(db: Db): Promise<number> {
  const { rows } = await db.app.query<{ nextval: string }>("SELECT nextval('crawl_chunk_seq')::text AS nextval");
  return Number(rows[0]?.nextval);
}

interface LeaseResult {
  audit: AuditRow;
  site: SiteRow | null;
  rows: FrontierRow[];
  /** Every pending row was quota-blocked and has now been skipped as `section_quota`. */
  quotaExhausted: boolean;
  state: AuditRow['state'];
}

interface SectionAllowance {
  section: string;
  allowed: number;
}

/**
 * Selects pending rows with the per-section quota applied *inside* the query (the row's rank in
 * its section must not exceed how many more pages that section may have). Applying it here, before
 * `LIMIT`, is what stops a quota-blocked section from filling the candidate window and starving
 * every other section.
 */
async function selectCandidates(
  tx: Tx,
  workspaceId: string,
  auditId: string,
  options: { linked: boolean; allowances: readonly SectionAllowance[]; limit: number },
): Promise<{ urlHash: string; section: string }[]> {
  const allowed = options.allowances.filter((entry) => entry.allowed > 0);
  if (allowed.length === 0 || options.limit <= 0) return [];
  const sectionList = sql`ARRAY[${sql.join(
    allowed.map((entry) => sql`${entry.section}`),
    sql`, `,
  )}]::text[]`;
  const allowanceList = sql`ARRAY[${sql.join(
    allowed.map((entry) => sql`${entry.allowed}`),
    sql`, `,
  )}]::int[]`;
  const { rows } = await tx.execute<{ url_hash: string; section: string }>(sql`
    WITH cfg AS (
      SELECT c.section, c.allowed
      FROM unnest(${sectionList}, ${allowanceList}) AS c(section, allowed)
    ), ranked AS (
      SELECT f.url_hash, f.section, f.depth, f.in_sitemap,
             row_number() OVER (
               PARTITION BY f.section
               ORDER BY f.depth NULLS LAST, f.in_sitemap, f.url_hash
             ) AS rn
      FROM crawl_frontier f
      WHERE f.workspace_id = ${workspaceId} AND f.audit_id = ${auditId}
        AND f.state = 'pending'
        AND f.depth IS ${options.linked ? sql.raw('NOT NULL') : sql.raw('NULL')}
    )
    SELECT r.url_hash, r.section
    FROM ranked r
    JOIN cfg c ON c.section = r.section
    WHERE r.rn <= c.allowed
    ORDER BY r.depth NULLS LAST, r.in_sitemap, r.url_hash
    LIMIT ${options.limit}`);
  return rows.map((row) => ({ urlHash: row.url_hash, section: row.section }));
}

/**
 * Leases up to `chunkSize` pending URLs. The audit row is locked while the budget and the section
 * quota are read, so two chunks cannot both decide there is room; the lease itself is one atomic
 * update, and a row another chunk holds is skipped.
 *
 * If no candidate is eligible while pending rows remain, every pending row is in a section that has
 * spent its quota: they are marked `skipped` with reason `section_quota` (and coverage records the
 * truncation), so the chunk can finalize instead of returning with work that can never be done.
 */
async function leaseBatch(db: Db, payload: CrawlChunkPayload, options: CrawlEngineOptions): Promise<LeaseResult | null> {
  const { workspaceId, auditId, chunk } = payload;
  const nowMs = options.now?.() ?? Date.now();
  return db.withWorkspace(workspaceId, async (tx) => {
    const [audit] = await tx
      .select()
      .from(schema.audits)
      .where(and(eq(schema.audits.workspaceId, workspaceId), eq(schema.audits.id, auditId)))
      .for('update');
    if (!audit) return null;
    if (audit.state === 'queued') {
      await tx
        .update(schema.audits)
        .set({ state: 'running', startedAt: new Date(nowMs), lastProgressAt: new Date(nowMs) })
        .where(and(eq(schema.audits.workspaceId, workspaceId), eq(schema.audits.id, auditId)));
      audit.state = 'running';
    }
    if (audit.state !== 'running') return { audit, site: null, rows: [], quotaExhausted: false, state: audit.state };

    const [site] = await tx
      .select()
      .from(schema.sites)
      .where(and(eq(schema.sites.workspaceId, workspaceId), eq(schema.sites.id, audit.siteId)));
    if (!site) return { audit, site: null, rows: [], quotaExhausted: false, state: audit.state };

    // A retried job releases what its previous attempt left leased under the same chunk number.
    await releaseChunkLeases(tx, workspaceId, auditId, chunk);

    const limits = limitsOf(audit);
    const counts = await tx.execute<{ pending: string; active: string }>(sql`
      SELECT
        count(*) FILTER (WHERE state = 'pending')::text AS pending,
        count(*) FILTER (WHERE state IN ('crawled', 'leased'))::text AS active
      FROM crawl_frontier WHERE workspace_id = ${workspaceId} AND audit_id = ${auditId}`);
    const pending = Number(counts.rows[0]?.pending ?? 0);
    const active = Number(counts.rows[0]?.active ?? 0);
    const remaining = Math.max(0, limits.maxPages - active);
    const wanted = Math.min(options.chunkSize ?? DEFAULT_CHUNK_SIZE, remaining);
    if (pending === 0 || wanted <= 0) return { audit, site, rows: [], quotaExhausted: false, state: audit.state };

    const sections = await tx.execute<{ section: string; pending: string; used: string }>(sql`
      SELECT section,
             count(*) FILTER (WHERE state = 'pending')::text AS pending,
             count(*) FILTER (WHERE state IN ('crawled', 'leased'))::text AS used
      FROM crawl_frontier
      WHERE workspace_id = ${workspaceId} AND audit_id = ${auditId}
      GROUP BY section`);
    const pendingSections = sections.rows.filter((row) => Number(row.pending) > 0);
    const sectionCap = pendingSections.length > 1 ? Math.ceil(limits.maxPages / 2) : null;
    const usedBySection = new Map(sections.rows.map((row) => [row.section, Number(row.used)]));
    const allowance = (section: string): number =>
      sectionCap === null ? wanted : Math.max(0, sectionCap - (usedBySection.get(section) ?? 0));

    // Link-discovered pages come first: breadth-first by depth. Sitemap-only pages wait until the
    // click-depth frontier is spent — or until every pending linked page is quota-blocked, which is
    // exactly the deadlock the quota used to cause: then eligible sitemap work must run instead.
    const { rows: depthCount } = await tx.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM crawl_frontier
      WHERE workspace_id = ${workspaceId} AND audit_id = ${auditId} AND state = 'pending' AND depth IS NOT NULL`);
    const pendingLinked = Number(depthCount[0]?.n ?? 0);
    const chosen: { urlHash: string; section: string }[] = [];
    const first =
      pendingLinked > 0
        ? await selectCandidates(tx, workspaceId, auditId, {
            linked: true,
            allowances: [...usedBySection.keys()].map((section) => ({ section, allowed: allowance(section) })),
            limit: wanted,
          })
        : [];
    chosen.push(...first);
    const sitemapEligible = pendingLinked === 0 || first.length === 0;
    if (sitemapEligible && chosen.length < wanted) {
      const takenBySection = new Map<string, number>();
      for (const row of chosen) takenBySection.set(row.section, (takenBySection.get(row.section) ?? 0) + 1);
      const second = await selectCandidates(tx, workspaceId, auditId, {
        linked: false,
        allowances: [...usedBySection.keys()].map((section) => ({
          section,
          allowed: allowance(section) - (takenBySection.get(section) ?? 0),
        })),
        limit: wanted - chosen.length,
      });
      chosen.push(...second);
    }

    if (chosen.length === 0) {
      if (sectionCap !== null) {
        // Every pending row sits in a section that has spent its quota: nothing eligible can ever
        // remain, so record why and let the chunk finalize.
        await tx.execute(sql`
          UPDATE crawl_frontier SET state = 'skipped', skip_reason = 'section_quota'
          WHERE workspace_id = ${workspaceId} AND audit_id = ${auditId} AND state = 'pending'`);
        return { audit, site, rows: [], quotaExhausted: true, state: audit.state };
      }
      return { audit, site, rows: [], quotaExhausted: false, state: audit.state };
    }

    const leased = await tx
      .update(schema.crawlFrontier)
      .set({
        state: 'leased',
        leaseChunk: chunk,
        leaseExpiresAt: new Date(nowMs + 2 * (options.softDeadlineMs ?? 240_000)),
        attempts: sql`${schema.crawlFrontier.attempts} + 1`,
      })
      .where(
        and(
          eq(schema.crawlFrontier.workspaceId, workspaceId),
          eq(schema.crawlFrontier.auditId, auditId),
          eq(schema.crawlFrontier.state, 'pending'),
          inArray(
            schema.crawlFrontier.urlHash,
            chosen.map((row) => row.urlHash),
          ),
        ),
      )
      .returning();
    return { audit, site, rows: leased, quotaExhausted: false, state: audit.state };
  });
}

/** Whether the audit was cancelled (or otherwise left `running`) since the chunk started. */
async function auditStopped(db: Db, workspaceId: string, auditId: string): Promise<boolean> {
  return db.withWorkspace(workspaceId, async (tx) => {
    const [audit] = await tx
      .select({ state: schema.audits.state })
      .from(schema.audits)
      .where(and(eq(schema.audits.workspaceId, workspaceId), eq(schema.audits.id, auditId)));
    return audit?.state !== 'running';
  });
}

function pageFactsForFailure(row: FrontierRow, fetchError: string | null): PageFacts {
  return {
    url: row.url,
    finalUrl: row.url,
    status: 0,
    redirects: [],
    fetchError,
    contentType: null,
    isHtml: false,
    headers: { xRobotsTag: null, contentLanguage: null, strictTransportSecurity: null, link: null },
    ttfbMs: null,
    totalMs: null,
    bytes: 0,
    depth: row.depth,
    discoveredBy: row.discoveredBy,
    inSitemap: row.inSitemap,
    robotsAllowed: true,
    html: null,
  };
}

interface PageOutcome {
  kind: 'ok' | 'error' | 'throttle' | 'dropped';
  ms: number;
  /** When a host backoff ends (from `Retry-After`), the successor chunk waits for it. */
  resumeAtMs?: number;
}

interface FetchedPage {
  facts: PageFacts;
  kind: 'ok' | 'error' | 'throttle';
  /** Epoch ms of the latest host backoff seen while fetching, if any. */
  resumeAtMs: number;
}

interface BatchContext {
  db: Db;
  audit: AuditRow;
  site: SiteRow;
  hosts: string[];
  robots: Robots;
  limiter: HostLimiter;
  hooks: readonly AuditHooks[];
  auditRef: AuditRef;
  limits: ReturnType<typeof limitsOf>;
  scope: AuditRow['scope'];
  section: string | null;
  chunk: number;
  signal: AbortSignal;
  maxRedirects: number;
  now: () => number;
  boundary: (point: CrawlBoundary, row: FrontierRow | null) => Promise<void>;
  /** Records the host's next eligible time, so the successor waits out an existing backoff. */
  noteHostBackoff: (host: string) => Promise<void>;
}

/**
 * Fetches one frontier row, one redirect hop at a time. Each hop is checked before it is fetched:
 * it must be on the site's hosts (off-site stops the chain, recorded, and the target is the final
 * URL), robots.txt must allow it (disallowed stops the chain), the destination host's limiter
 * lease is taken before the request, and a URL that was already visited ends the chain with
 * `redirect_loop` instead of following it again. The SSRF guard runs on every hop because every hop
 * is its own `safeFetch`. A 429 or 503 is attributed to the host that answered it.
 */
async function fetchPage(context: BatchContext, row: FrontierRow, userAgent: string): Promise<FetchedPage> {
  const { signal, limiter, robots, hosts } = context;
  const started = performance.now();
  const redirects: RedirectHop[] = [];
  const visited = new Set<string>([row.url]);
  let currentUrl = row.url;
  let resumeAtMs = 0;

  const stopFacts = (status: number, finalUrl: string, robotsAllowed = true): PageFacts => ({
    ...pageFactsForFailure(row, null),
    finalUrl,
    status,
    redirects: [...redirects],
    robotsAllowed,
  });

  for (let hop = 0; ; hop += 1) {
    visited.add(currentUrl);
    let allowed: boolean;
    try {
      allowed = await robots.isAllowed(currentUrl, userAgent);
    } catch (error) {
      // An unreadable robots.txt is treated as allowing the fetch; `Robots` itself already applies
      // the RFC's "unavailable means disallow" when the file answered 5xx or 429.
      if (signal.aborted) throw error;
      allowed = true;
    }
    if (!allowed) {
      // The URL this row asked for is disallowed: status 0 and `robotsAllowed: false`, which is what
      // the catalogue reads as "skipped by robots".
      return { facts: stopFacts(hop === 0 ? 0 : (redirects.at(-1)?.status ?? 0), currentUrl, false), kind: 'ok', resumeAtMs };
    }

    let delayMs: number | undefined;
    try {
      delayMs = await robots.crawlDelayMs(currentUrl);
    } catch (error) {
      if (signal.aborted) throw error;
      delayMs = undefined;
    }

    const host = hostOf(currentUrl);
    let hostLease: HostLease;
    try {
      hostLease = await limiter.acquire(host, { signal, ...(delayMs === undefined ? {} : { minDelayMs: delayMs }) });
    } catch (error) {
      // A chunk that stops while waiting for a host must not lose a backoff another replica (or an
      // earlier page) imposed on it: ask the limiter when the host is next eligible, so the
      // successor chunk is scheduled no earlier than that.
      if (signal.aborted) await context.noteHostBackoff(host);
      throw error;
    }
    try {
      const result = await crawlFetch(currentUrl, { userAgent, totalTimeoutMs: 30_000, maxRedirects: 0, signal });
      await limiter.noteResponse(host, { status: result.status, retryAfter: result.headers['retry-after'] ?? null });
      if (result.status === 429 || result.status === 503) {
        const fallback = result.status === 429 ? 30_000 : 10_000;
        resumeAtMs = Math.max(resumeAtMs, Date.now() + (parseRetryAfter(result.headers['retry-after'] ?? null, Date.now()) ?? fallback));
        await context.noteHostBackoff(host);
      }

      const location = result.headers.location;
      if (location && REDIRECT_STATUS.has(result.status)) {
        const target = normalizeUrl(location, currentUrl);
        redirects.push({ url: currentUrl, status: result.status, location: target ?? location });
        const tooMany = hop + 1 > context.maxRedirects;
        if (!target || tooMany || !isInternalUrl(target, hosts)) {
          // Off-site (or over the hop limit): record the 3xx and its target, never fetch it.
          return { facts: stopFacts(result.status, target ?? result.url), kind: 'ok', resumeAtMs };
        }
        if (visited.has(target)) {
          // A loop ends at the first repeated URL: record the hop that pointed back and stop, rather
          // than spinning until the hop limit (or forever, with a crafted chain).
          return {
            facts: { ...stopFacts(result.status, target), fetchError: 'redirect_loop' },
            kind: 'error',
            resumeAtMs,
          };
        }
        let targetAllowed = true;
        try {
          targetAllowed = await robots.isAllowed(target, userAgent);
        } catch (error) {
          if (signal.aborted) throw error;
          targetAllowed = true;
        }
        if (!targetAllowed) return { facts: stopFacts(result.status, target), kind: 'ok', resumeAtMs };
        currentUrl = target;
        continue;
      }

      const isHtml =
        result.status >= 200 && result.status < 300 && /^(text\/html|application\/xhtml\+xml)\b/i.test(result.contentType ?? '');
      const facts: PageFacts = {
        url: row.url,
        finalUrl: result.url,
        status: result.status,
        redirects: [...redirects],
        fetchError: null,
        contentType: result.contentType ?? null,
        isHtml,
        headers: {
          xRobotsTag: result.headers['x-robots-tag'] ?? null,
          contentLanguage: result.headers['content-language'] ?? null,
          strictTransportSecurity: result.headers['strict-transport-security'] ?? null,
          link: result.headers.link ?? null,
        },
        ttfbMs: Math.round(result.timings.ttfbMs),
        totalMs: Math.round(performance.now() - started),
        bytes: result.body.length,
        depth: row.depth,
        discoveredBy: row.discoveredBy,
        inSitemap: row.inSitemap,
        robotsAllowed: true,
        html: isHtml ? extractHtml(result.text, { baseUrl: result.url, hosts }) : null,
      };
      const kind = result.status === 429 || result.status === 503 ? 'throttle' : result.status >= 500 ? 'error' : 'ok';
      return { facts, kind, resumeAtMs };
    } catch (error) {
      if (signal.aborted) throw error;
      return {
        facts: { ...pageFactsForFailure(row, errorKind(error)), finalUrl: currentUrl, redirects: [...redirects] },
        kind: 'error',
        resumeAtMs,
      };
    } finally {
      await limiter.release(hostLease);
    }
  }
}

/** The guarded fetch's typed kind (`timeout`, `dns`, `blocked_address`, …), or a plain marker. */
function errorKind(error: unknown): string {
  const kind = (error as { kind?: unknown } | null)?.kind;
  return typeof kind === 'string' ? kind : 'connection';
}

/** New internal URLs a fetched page revealed: its links, then redirect targets. */
function discoveriesFor(context: BatchContext, row: FrontierRow, facts: PageFacts): FrontierSeed[] {
  // A list or page audit reads exactly the URLs it was given: their links become edges (so a
  // broken-link check still sees them) but are not followed.
  if (context.scope === 'list' || context.scope === 'page') return [];
  const nextDepth = row.depth === null ? null : row.depth + 1;
  const found = new Map<string, FrontierSeed & { skippedForDepth?: boolean }>();
  const add = (url: string, depth: number | null, discoveredBy: FrontierSeed['discoveredBy'], from: string) => {
    if (!isInternalUrl(url, context.hosts)) return;
    const hash = urlHash(url);
    if (hash === row.urlHash || found.has(hash)) return;
    if (context.scope === 'section' && context.section && !isUnderSection(url, context.section)) return;
    const tooDeep = depth !== null && depth > context.limits.maxDepth;
    found.set(hash, {
      url,
      urlHash: hash,
      depth,
      discoveredBy,
      discoveredFrom: from,
      inSitemap: false,
      section: sectionOf(url),
      ...(tooDeep ? { skippedForDepth: true } : {}),
    });
  };
  for (const link of facts.html?.links ?? []) {
    if (!link.href) continue;
    add(link.href, nextDepth, 'link', facts.url);
  }
  for (const hop of facts.redirects) {
    const target = normalizeUrl(hop.location, hop.url);
    if (target) add(target, row.depth, 'redirect', facts.url);
  }
  return [...found.values()];
}

/** The edge rows for one page: every resolvable link, internal or external. */
function edgesFor(row: FrontierRow, links: readonly PageLink[], hosts: readonly string[]): LinkRow[] {
  // One page can link the same URL twice (two anchors, or a base href); the edge is one row, with
  // the rel tokens merged and the first non-empty anchor kept.
  const byTarget = new Map<string, LinkRow>();
  for (const link of links) {
    if (link.href === null) continue;
    const hash = urlHash(link.href);
    const existing = byTarget.get(hash);
    if (existing) {
      existing.rel = [...new Set([...existing.rel, ...link.rel])];
      if (!existing.anchor && link.text) existing.anchor = link.text;
      continue;
    }
    byTarget.set(hash, {
      fromUrlHash: row.urlHash,
      toUrlHash: hash,
      toUrl: link.href,
      rel: [...new Set(link.rel)],
      anchor: link.text,
      internal: isInternalUrl(link.href, hosts),
    });
  }
  return [...byTarget.values()];
}

/**
 * Stores one page and everything it revealed, then marks the URL crawled — all in one transaction.
 * The transaction is fenced first (`claimPageWrite`): if the audit is no longer `running` or this
 * chunk no longer holds the lease, nothing is written and no hook runs. `last_progress_at` and the
 * counter deltas move in this same transaction (the snapshot's and the discoveries' own insert
 * answers), so the reconciler sees a crawl that is still working without the commit recounting the
 * audit.
 */
async function storePageResult(
  context: BatchContext,
  row: FrontierRow,
  facts: PageFacts,
  links: readonly PageLink[],
  discoveries: readonly FrontierSeed[],
): Promise<boolean> {
  const { workspaceId, id: auditId, siteId } = context.audit;
  return context.db.withWorkspace(workspaceId, async (tx) => {
    const claimed = await claimPageWrite(tx, { workspaceId, auditId, chunk: context.chunk, urlHash: row.urlHash });
    if (!claimed) return false;
    // Test seam: the transaction now holds the audit row lock (the fence) and this frontier row.
    // A test pauses here to interleave a chunk cleanup, which must wait for the audit lock.
    await context.boundary('insidePageWrite', row);
    const inserted = await storeSnapshot(tx, {
      workspaceId,
      id: snapshotId(auditId, row.urlHash),
      siteId,
      auditId,
      page: facts,
    });
    await storePage(tx, {
      workspaceId,
      siteId,
      pageId: pageId(siteId, facts.url),
      auditId,
      url: facts.url,
      status: facts.status,
    });
    await storeEdges(tx, workspaceId, auditId, edgesFor(row, links, context.hosts));
    // Discoveries are persisted before the page is marked crawled (crawler-and-audits.md §2), so a
    // crash between the two cannot lose them.
    const discovered = await storeDiscoveries(tx, workspaceId, auditId, discoveries);
    await markFrontier(
      tx,
      workspaceId,
      auditId,
      row.urlHash,
      context.chunk,
      facts.robotsAllowed ? 'crawled' : 'skipped',
      facts.robotsAllowed ? null : 'robots',
    );
    await recordPageProgress(tx, workspaceId, auditId, context.now(), {
      crawled: inserted ? 1 : 0,
      failed: inserted && (facts.status >= 500 || facts.fetchError !== null) ? 1 : 0,
      discovered,
    });
    for (const hook of context.hooks) await hook.onPage?.(tx, context.auditRef, { ...facts, snapshotId: snapshotId(auditId, row.urlHash) });
    return true;
  });
}

/**
 * Releases a chunk's leases and refreshes counters after the chunk stops early. The audit row is
 * locked first — the crawl's one lock order (`lockAudit`): the cleanup touches frontier rows and the
 * audit's counters, and a page commit holds the audit lock while it wants a frontier row, so taking
 * them the other way round deadlocked (40P01).
 */
async function abandonChunk(context: BatchContext, chunk: number): Promise<number> {
  return context.db.withWorkspace(context.audit.workspaceId, async (tx) => {
    await lockAudit(tx, context.audit.workspaceId, context.audit.id);
    const released = await releaseChunkLeases(tx, context.audit.workspaceId, context.audit.id, chunk);
    await refreshCounters(tx, context.audit.workspaceId, context.audit.id);
    return released;
  });
}

/** Fetches one frontier row and stores it; a dropped page wrote nothing. */
async function crawlOne(context: BatchContext, row: FrontierRow, userAgent: string): Promise<PageOutcome> {
  const started = performance.now();
  const fetched = await fetchPage(context, row, userAgent);
  await context.boundary('afterFetch', row);
  const committed = await storePageResult(
    context,
    row,
    fetched.facts,
    fetched.facts.html?.links ?? [],
    discoveriesFor(context, row, fetched.facts),
  );
  if (committed) await context.boundary('afterPageCommit', row);
  return { kind: committed ? fetched.kind : 'dropped', ms: performance.now() - started, resumeAtMs: fetched.resumeAtMs };
}

/**
 * The crawl_seed step: robots.txt, sitemaps and the HTTPS probe, in the worker rather than the
 * command. A guard refusal (the site resolves to a private address) ends the audit as `failed` with
 * the reason, because no page of it can ever be fetched.
 */
async function ensureSeeded(db: Db, payload: CrawlChunkPayload, options: CrawlEngineOptions): Promise<{ refused: string | null }> {
  try {
    await seedSite(
      db,
      { workspaceId: payload.workspaceId, auditId: payload.auditId },
      {
        ...(options.seedFetch ? { fetch: options.seedFetch } : {}),
        ...(options.seedDeadlineMs === undefined ? {} : { deadlineMs: options.seedDeadlineMs }),
        ...(options.seedSitemapCaps === undefined ? {} : { sitemapCaps: options.seedSitemapCaps }),
        ...(options.now ? { now: options.now } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
      },
    );
    return { refused: null };
  } catch (error) {
    if (error instanceof AppError) return { refused: error.message };
    throw error;
  }
}

/**
 * Runs one chunk. A chunk that finds no pending URL finalizes the audit if it can; a chunk that
 * leaves work behind enqueues the next one (after a host backoff, when one was seen).
 */
export async function runCrawlChunk(db: Db, payload: CrawlChunkPayload, options: CrawlEngineOptions): Promise<CrawlChunkResult> {
  const logger = options.logger ?? quietLogger;
  const now = options.now ?? Date.now;
  const result: CrawlChunkResult = { leased: 0, processed: 0, dropped: 0, released: 0, finalized: false, more: false, stopped: false };
  const ref = { workspaceId: payload.workspaceId, auditId: payload.auditId };
  const boundary = async (point: CrawlBoundary, row: FrontierRow | null) => {
    await options.boundary?.(point, row ? { urlHash: row.urlHash, url: row.url } : null);
  };

  const seeded = await ensureSeeded(db, payload, options);
  if (seeded.refused !== null) {
    const forced: ForcedFinalize = {
      state: 'failed',
      reason: seeded.refused,
      reasons: ['errors'],
      skipPendingAs: 'failed',
    };
    await boundary('beforeFinalize', null);
    result.finalized = await finalizeAudit(db, ref, { force: forced });
    logger.warn({ auditId: payload.auditId, reason: seeded.refused }, 'crawl seed refused');
    return result;
  }

  const leased = await leaseBatch(db, payload, options);
  if (!leased) return result;
  if (!leased.site || leased.state !== 'running' || leased.rows.length === 0) {
    // Nothing to fetch: no pending URL, a page budget that is spent, every pending row quota-blocked
    // (just marked `section_quota`), or a cancelled audit. Finalize decides whether it can (it
    // refuses while another chunk still holds a lease).
    await boundary('beforeFinalize', null);
    result.finalized = await finalizeAudit(db, ref);
    return result;
  }

  const hosts = siteHostsOf(leased.site);
  const userAgent = buildUserAgent({ version: options.version ?? '0.0.0' });
  const controller = new AbortController();
  // The latest host backoff any page saw (a 429/503 answer, or a limiter pause the chunk aborted
  // inside). The successor is scheduled no earlier than this.
  const backoff = { at: 0 };
  const noteHostBackoff = async (host: string): Promise<void> => {
    try {
      const at = await options.limiter.nextEligibleAt?.(host);
      if (typeof at === 'number' && at > backoff.at) backoff.at = at;
    } catch {
      // A limiter that cannot answer leaves the chunk's own `Retry-After` timing in charge.
    }
  };
  const robots = new Robots({
    bot: { product: 'AgenticSEO', version: options.version ?? '0.0.0' },
    userAgent,
    cache: robotsCache,
    fetchOptions: crawlFetchOptions(),
    signal: controller.signal,
  });
  const context: BatchContext = {
    db,
    audit: leased.audit,
    site: leased.site,
    hosts,
    robots,
    limiter: options.limiter,
    hooks: auditHooks(),
    auditRef: { workspaceId: leased.audit.workspaceId, siteId: leased.audit.siteId, auditId: leased.audit.id },
    limits: limitsOf(leased.audit),
    scope: leased.audit.scope,
    section: leased.audit.section,
    chunk: payload.chunk,
    signal: controller.signal,
    maxRedirects: options.maxRedirects ?? 10,
    now,
    boundary: (point, row) => boundary(point, row),
    noteHostBackoff,
  };

  result.leased = leased.rows.length;
  const startedAt = now();
  const deadline = startedAt + (options.softDeadlineMs ?? 240_000);
  let concurrency = START_CONCURRENCY;
  const recent: { kind: PageOutcome['kind']; ms: number }[] = [];
  let resumeAtMs = 0;
  let cursor = 0;
  let stopped = false;
  let failure: unknown;
  const inFlight = new Set<Promise<void>>();
  let pagesSinceStopCheck = 0;

  // The deadline also aborts work that is waiting (a host pause, a slow fetch): a chunk checks the
  // clock before it launches a page, and this timer covers the case where every page is already out.
  const deadlineTimer = setTimeout(
    () => {
      stopped = true;
      controller.abort(new Error('the crawl chunk reached its soft deadline'));
    },
    Math.max(1, deadline - now()),
  );
  deadlineTimer.unref?.();

  const launch = (row: FrontierRow) => {
    const task = (async () => {
      try {
        const outcome = await crawlOne(context, row, userAgent);
        if (outcome.resumeAtMs !== undefined) resumeAtMs = Math.max(resumeAtMs, outcome.resumeAtMs);
        if (outcome.kind === 'dropped') {
          result.dropped += 1;
          return;
        }
        result.processed += 1;
        recent.push(outcome);
        if (recent.length > 20) recent.shift();
        // The window adapts on the last settles: throttle or failures shrink it, steady fast pages
        // grow it. Per-host concurrency is still capped globally by the limiter.
        if (outcome.kind !== 'ok') concurrency = Math.max(MIN_CONCURRENCY, Math.floor(concurrency / 2));
        else if (recent.length >= 5) {
          const errors = recent.filter((entry) => entry.kind !== 'ok').length;
          const average = recent.reduce((sum, entry) => sum + entry.ms, 0) / recent.length;
          const throttled = recent.filter((entry) => entry.kind === 'throttle').length;
          if (throttled > 0 || errors / recent.length > 0.2) concurrency = Math.max(MIN_CONCURRENCY, concurrency - 1);
          else if (average < 1_000) concurrency = Math.min(MAX_CONCURRENCY, concurrency + 1);
        }
      } catch (error) {
        // An aborted fetch is the chunk stopping, not a page failure; anything else is a real error
        // (a hook, a database write): stop launching and rethrow once the chunk's promises settle.
        if (controller.signal.aborted) return;
        failure ??= error;
        stopped = true;
      }
    })().finally(() => {
      inFlight.delete(task);
    });
    inFlight.add(task);
  };

  while (!stopped && (cursor < leased.rows.length || inFlight.size > 0)) {
    while (!stopped && inFlight.size < concurrency && cursor < leased.rows.length) {
      if (now() > deadline) {
        stopped = true;
        controller.abort(new Error('the crawl chunk reached its soft deadline'));
        break;
      }
      // Cancellation is checked every few pages (a workspace-scoped read costs a round trip per
      // check); the command's copy says the chunk stops within a few pages, which this keeps true.
      if (pagesSinceStopCheck >= 5) {
        pagesSinceStopCheck = 0;
        if (await auditStopped(db, payload.workspaceId, payload.auditId)) {
          stopped = true;
          controller.abort(new Error('the audit was cancelled'));
          break;
        }
      }
      launch(leased.rows[cursor++] as FrontierRow);
      pagesSinceStopCheck += 1;
    }
    if (inFlight.size === 0) break;
    // Cancellation must not wait out a limiter pause or a slow host: while pages are out, poll the
    // audit every `cancelPollMs` and abort the shared controller, which rejects every limiter wait
    // and fetch the chunk still holds, so the leases are released within a few seconds.
    let pollTimer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      Promise.race(inFlight).then(() => 'page' as const),
      new Promise<'poll'>((resolve) => {
        pollTimer = setTimeout(() => resolve('poll'), options.cancelPollMs ?? 2_000);
        pollTimer.unref?.();
      }),
    ]);
    clearTimeout(pollTimer);
    if (settled === 'poll' && !stopped && (await auditStopped(db, payload.workspaceId, payload.auditId))) {
      stopped = true;
      controller.abort(new Error('the audit was cancelled'));
    }
  }

  // Wait for the pages already in flight, then decide the chunk's future. Nothing outlives the chunk:
  // every fetch, limiter wait and robots fetch received the abort signal.
  await Promise.allSettled([...inFlight]);
  clearTimeout(deadlineTimer);
  if (failure !== undefined) {
    controller.abort(new Error('the chunk failed'));
    throw failure;
  }

  const remaining = leased.rows.length - cursor;
  if (stopped || remaining > 0) {
    result.released = await abandonChunk(context, payload.chunk);
    result.stopped = await auditStopped(db, payload.workspaceId, payload.auditId);
  }

  const refreshed = await db.withWorkspace(payload.workspaceId, async (tx) => {
    await refreshCounters(tx, payload.workspaceId, payload.auditId);
    const { rows: countRows } = await tx.execute<{ pending: string; leased: string }>(sql`
      SELECT count(*) FILTER (WHERE state = 'pending')::text AS pending,
             count(*) FILTER (WHERE state = 'leased')::text AS leased
      FROM crawl_frontier WHERE workspace_id = ${payload.workspaceId} AND audit_id = ${payload.auditId}`);
    const counts = countRows[0];
    const [counters] = await tx
      .select({ pagesCrawled: schema.audits.pagesCrawled })
      .from(schema.audits)
      .where(and(eq(schema.audits.workspaceId, payload.workspaceId), eq(schema.audits.id, payload.auditId)));
    return {
      pending: Number(counts?.pending ?? 0),
      leased: Number(counts?.leased ?? 0),
      pagesCrawled: counters?.pagesCrawled ?? 0,
    };
  });

  if (result.stopped) {
    // A cancelled audit finalizes now (its remaining URLs were released and are skipped as
    // cancelled), so its crawled pages stay viewable immediately.
    await boundary('beforeFinalize', null);
    result.finalized = await finalizeAudit(db, ref);
    result.more = false;
    return result;
  }

  const budgetLeft = refreshed.pagesCrawled < context.limits.maxPages;

  if (refreshed.pending > 0 && refreshed.leased === 0 && budgetLeft) {
    // Work remains: hand it to a successor. A host backoff (429/503) postpones that successor to the
    // moment the host may be asked again, rather than having a new chunk spin on the pause.
    result.more = true;
    if (options.enqueueNext) {
      const latest = Math.max(resumeAtMs, backoff.at);
      const runAt = latest > now() ? new Date(latest) : undefined;
      await options.enqueueNext(
        { workspaceId: payload.workspaceId, auditId: payload.auditId, chunk: await nextChunkNumber(db) },
        runAt ? { runAt } : undefined,
      );
    }
  } else {
    await boundary('beforeFinalize', null);
    result.finalized = await finalizeAudit(db, ref);
  }
  logger.info({ auditId: payload.auditId, ...result, pending: refreshed.pending }, 'crawl chunk finished');
  return result;
}
