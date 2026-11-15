import { AppError, newId } from '@agentic-seo/core';
import type { Db, Tx } from '@agentic-seo/db';
import { schema } from '@agentic-seo/db';
import { MemoryRobotsCache, Robots, type RobotsCache, type RobotsRecord } from '@agentic-seo/fetch';
import { and, eq, sql } from 'drizzle-orm';
import type { RobotsTxtFacts, SiteFacts } from './facts';
import { crawlFetch, crawlFetchOptions } from './fetch-options';
import type { AuditScope } from './hooks';
import type { CrawlLimits } from './limits';
import { ROBOTS_EVIDENCE_MAX_BYTES, robotsTxtFacts } from './robots-facts';
import { probeHttpRedirect, readSitemaps, type SitemapFetch } from './sitemap';
import { type FrontierSeed, lockAudit, storeDiscoveries } from './store';
import { isInternalUrl, isUnderSection, normalizeSection, normalizeUrl, sectionOf, siteHomeUrl, siteHostsOf, urlHash } from './url';

// Seeding has two parts, deliberately split:
//
// 1. `seedAudit` runs inside `audits.run`'s transaction and touches no network: it creates the
//    audit and the URLs the audit starts from (the home page, a section's index, or the listed
//    URLs). A command transaction must not block on a site's sitemaps.
// 2. `seedSite` is the worker's `crawl_seed` step: it fetches robots.txt, the sitemaps robots.txt
//    and `/sitemap.xml` name, and the `http://` probe, then stores `SiteFacts` and the sitemap
//    URLs. Its fan-out is bounded (documents, queued sitemaps, bytes, wall time), so one hostile
//    sitemap tree cannot make an audit unbounded.
//
// Only URLs on the site's hosts enter the frontier; an external link becomes an edge when it is
// found, never a fetch.

/** The robots cache a seed fills and a chunk reads, per process. */
let seedRobotsCache: RobotsCache = new MemoryRobotsCache(1_000);

/** Test-only: forget cached robots rules. */
export function resetSeedRobotsCache(): void {
  seedRobotsCache = new MemoryRobotsCache(1_000);
}

/** The test seams a seed uses (it has no engine options). */
export interface SeedSeams {
  fetch?: SitemapFetch;
}

export interface SeedInput {
  scope: AuditScope;
  section?: string;
  urls?: string[];
  limits: CrawlLimits;
  requestedBy: { type: 'user' | 'agent'; id: string };
}

export interface SeedResult {
  audit: typeof schema.audits.$inferSelect;
  /** URLs the command itself put in the frontier (the sitemaps add more in the worker). */
  seeded: number;
}

/** The seed URLs of an audit, before deduplication, in discovery order. */
function seedUrls(site: { primaryDomain: string; hosts: string[] }, input: SeedInput): (FrontierSeed & { skippedForDepth?: boolean })[] {
  const hosts = siteHostsOf(site);
  const home = siteHomeUrl(site.primaryDomain);
  const seeds: (FrontierSeed & { skippedForDepth?: boolean })[] = [];
  const seen = new Set<string>();
  const add = (url: string, options: { depth: number | null; discoveredBy: FrontierSeed['discoveredBy'] }) => {
    const hash = urlHash(url);
    if (seen.has(hash)) return;
    seen.add(hash);
    seeds.push({
      url,
      urlHash: hash,
      depth: options.depth,
      discoveredBy: options.discoveredBy,
      discoveredFrom: null,
      inSitemap: false,
      section: sectionOf(url),
    });
  };

  if (input.scope === 'list' || input.scope === 'page') {
    for (const raw of input.urls ?? []) {
      const url = normalizeUrl(raw);
      if (url && isInternalUrl(url, hosts)) add(url, { depth: null, discoveredBy: 'list' });
    }
    return seeds;
  }

  if (input.scope === 'section' && input.section) {
    const section = normalizeSection(input.section);
    const sectionUrl = normalizeUrl(`https://${site.primaryDomain}${section === '/' ? '/' : `${section}/`}`);
    if (sectionUrl) add(sectionUrl, { depth: 0, discoveredBy: 'seed' });
    return seeds;
  }

  add(home, { depth: 0, discoveredBy: 'seed' });
  return seeds;
}

/**
 * Creates the audit row and its initial frontier without any network I/O. Runs inside
 * `audits.run`'s transaction, so a refusal (an archived or unverified site) leaves no half-created
 * audit. robots.txt, sitemaps and the HTTPS probe are read by the worker's first `crawl_chunk`.
 */
export async function seedAudit(
  tx: Tx,
  workspaceId: string,
  site: typeof schema.sites.$inferSelect,
  input: SeedInput,
): Promise<SeedResult> {
  const home = siteHomeUrl(site.primaryDomain);
  const auditId = newId('adt');
  const now = new Date();
  // The skeleton `SiteFacts`; the worker's crawl_seed step fills robotsTxt, sitemaps and the probe.
  const siteFacts: SiteFacts = {
    origin: new URL(home).origin,
    robotsTxt: robotsTxtFacts({ url: new URL('/robots.txt', home).href, status: 0, fetchError: null, body: '' }),
    sitemaps: [],
    home: null,
    httpRedirectsToHttps: null,
  };

  await tx.insert(schema.audits).values({
    workspaceId,
    id: auditId,
    siteId: site.id,
    scope: input.scope,
    section: input.scope === 'section' ? normalizeSection(input.section ?? '/') : null,
    urls: input.scope === 'list' || input.scope === 'page' ? (input.urls ?? []).map((url) => normalizeUrl(url) ?? url) : null,
    limits: input.limits,
    renderMode: 'never',
    state: 'queued',
    siteFacts: siteFacts as unknown as Record<string, unknown>,
    requestedByType: input.requestedBy.type,
    requestedById: input.requestedBy.id,
    lastProgressAt: now,
    createdAt: now,
  });

  const seeds = seedUrls(site, input);
  await storeDiscoveries(tx, workspaceId, auditId, seeds);

  await tx
    .update(schema.audits)
    .set({ pagesDiscovered: seeds.length })
    .where(and(eq(schema.audits.workspaceId, workspaceId), eq(schema.audits.id, auditId)));

  const [audit] = await tx
    .select()
    .from(schema.audits)
    .where(and(eq(schema.audits.workspaceId, workspaceId), eq(schema.audits.id, auditId)));
  if (!audit) throw new AppError('conflict', 'The audit could not be created; try again.');
  return { audit, seeded: seeds.length };
}

/** Fetches robots.txt once and keeps the record, so the audit's chunks use the same rules. */
async function readRobots(
  site: { primaryDomain: string; hosts: string[] },
  fetch: SitemapFetch,
  signal: AbortSignal,
): Promise<{ facts: RobotsTxtFacts; record: RobotsRecord }> {
  const home = siteHomeUrl(site.primaryDomain);
  const url = new URL('/robots.txt', home).href;
  const hosts = siteHostsOf(site);
  const fetchedAt = Date.now();
  let status = 0;
  let body = '';
  let fetchError: string | null = null;
  try {
    const result = await fetch(url, {
      maxBytes: ROBOTS_EVIDENCE_MAX_BYTES,
      truncate: true,
      maxRedirects: 5,
      totalTimeoutMs: 15_000,
      signal,
      allowRedirect: (target) => (isInternalUrl(target.href, hosts) ? true : `${target.href} is not on this site's hosts.`),
    });
    status = result.status;
    // Google reads the first 500 KiB and ignores the rest; only complete lines become rules.
    if (status >= 200 && status < 300) {
      const text = result.text;
      body = result.truncated ? text.slice(0, Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) + 1) : text;
    }
  } catch (error) {
    const kind = (error as { kind?: unknown } | null)?.kind;
    // A guard refusal is not "robots.txt is unavailable": the whole site is unreachable, so the
    // audit is refused with the reason rather than started against nothing.
    if (kind === 'blocked_address' || kind === 'blocked_scheme' || kind === 'blocked_port' || kind === 'blocked_credentials') {
      throw new AppError(
        'precondition_failed',
        `The crawl cannot start: ${error instanceof Error ? error.message : String(error)}. Allow the host for this site in its settings if it is private, then try again.`,
      );
    }
    fetchError = error instanceof Error ? error.message : String(error);
  }
  const ttl = status === 0 || status === 429 || status >= 500 ? 5 * 60 * 1000 : 6 * 60 * 60 * 1000;
  const record: RobotsRecord = { origin: new URL(home).origin, status, body, fetchedAt, expiresAt: fetchedAt + ttl };
  if (fetchError) record.error = fetchError;
  await seedRobotsCache.set(record);
  return {
    facts: robotsTxtFacts({ url, status, fetchError, body }),
    record,
  };
}

export interface SeedSiteOptions extends SeedSeams {
  /** Aborts every fetch of the seed step. */
  signal?: AbortSignal;
  /** How long the whole seed step may take. Default 60 s. */
  deadlineMs?: number;
  /** Caps for the sitemap read; production uses {@link SITEMAP_MAX_DOCUMENTS} and friends. */
  sitemapCaps?: { maxDocuments?: number; maxQueuedSitemaps?: number; maxUrls?: number };
  now?: () => number;
  logger?: { warn(obj: unknown, msg?: string): void };
}

export type SeedSiteOutcome =
  | { state: 'seeded'; robots: RobotsTxtFacts; sitemaps: SiteFacts['sitemaps']; sitemapUrls: number; truncated: boolean }
  | { state: 'skipped' };

/**
 * The worker's crawl_seed step: reads robots.txt, the sitemaps and the HTTP probe for a queued
 * audit, then stores `SiteFacts` and the sitemap URLs. Idempotent (a retried chunk re-reads and
 * upserts), and does its network I/O outside any transaction. A guard refusal is rethrown as
 * `precondition_failed`; the chunk turns that into a `failed` audit with the reason.
 */
export async function seedSite(
  db: Db,
  ref: { workspaceId: string; auditId: string },
  options: SeedSiteOptions = {},
): Promise<SeedSiteOutcome> {
  const loaded = await db.withWorkspace(ref.workspaceId, async (tx) => {
    const [audit] = await tx
      .select()
      .from(schema.audits)
      .where(and(eq(schema.audits.workspaceId, ref.workspaceId), eq(schema.audits.id, ref.auditId)));
    if (!audit || audit.seededAt !== null || (audit.state !== 'queued' && audit.state !== 'running')) return null;
    const [site] = await tx
      .select()
      .from(schema.sites)
      .where(and(eq(schema.sites.workspaceId, ref.workspaceId), eq(schema.sites.id, audit.siteId)));
    return site ? { audit, site } : null;
  });
  if (!loaded) return { state: 'skipped' };

  const { audit, site } = loaded;
  const fetch = options.fetch ?? crawlFetch;
  const home = siteHomeUrl(site.primaryDomain);
  const hosts = siteHostsOf(site);
  const startedMs = options.now?.() ?? Date.now();
  const deadlineAt = startedMs + (options.deadlineMs ?? 60_000);
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('the seed step reached its time limit')), options.deadlineMs ?? 60_000);
  timer.unref?.();
  const signal = controller.signal;

  try {
    const { facts: robots } = await readRobots(site, fetch, signal);
    let sitemaps: SiteFacts['sitemaps'] = [];
    let sitemapUrls: string[] = [];
    let truncated = false;
    if (audit.scope === 'site' || audit.scope === 'section') {
      const robotsClient = new Robots({
        bot: { product: 'AgenticSEO' },
        cache: seedRobotsCache,
        fetchOptions: crawlFetchOptions(),
        ...(signal ? { signal } : {}),
      });
      const declared = await robotsClient.sitemaps(home).catch(() => [] as string[]);
      const startUrls = [...declared, new URL('/sitemap.xml', home).href];
      const read = await readSitemaps({
        startUrls,
        hosts,
        deadlineAt,
        signal,
        ...(options.now ? { now: options.now } : {}),
        ...(options.sitemapCaps?.maxDocuments === undefined ? {} : { maxDocuments: options.sitemapCaps.maxDocuments }),
        ...(options.sitemapCaps?.maxQueuedSitemaps === undefined ? {} : { maxQueuedSitemaps: options.sitemapCaps.maxQueuedSitemaps }),
        ...(options.sitemapCaps?.maxUrls === undefined ? {} : { maxUrls: options.sitemapCaps.maxUrls }),
        fetch,
      });
      sitemaps = read.documents;
      sitemapUrls =
        audit.scope === 'section' && audit.section ? read.urls.filter((url) => isUnderSection(url, audit.section ?? '/')) : read.urls;
      truncated = read.truncation.length > 0;
    }

    const httpRedirectsToHttps = await probeHttpRedirect(site.primaryDomain, fetch, { signal });
    const siteFacts: SiteFacts = {
      origin: new URL(home).origin,
      robotsTxt: robots,
      sitemaps,
      home: null,
      httpRedirectsToHttps,
      ...(truncated ? { sitemapsTruncated: true } : {}),
    };

    await db.withWorkspace(ref.workspaceId, async (tx) => {
      // The seed's network I/O runs outside any transaction, so the audit may have finished (a
      // cancel, a forced finalize, the reconciler) while it ran. Take the audit row lock first —
      // the crawl's one lock order (`lockAudit`) — and recheck that it is still live and unseeded
      // before writing anything; otherwise drop the whole result: no discoveries, no site facts.
      // Two seed completions of one audit are idempotent because the first stamps `seeded_at`.
      const live = await lockAudit(tx, ref.workspaceId, ref.auditId);
      if (!live || (live.state !== 'queued' && live.state !== 'running') || live.seededAt !== null) return;
      const seeds: FrontierSeed[] = sitemapUrls.map((url) => ({
        url,
        urlHash: urlHash(url),
        depth: null,
        discoveredBy: 'sitemap',
        discoveredFrom: null,
        inSitemap: true,
        section: sectionOf(url),
      }));
      await storeDiscoveries(tx, ref.workspaceId, ref.auditId, seeds);
      await tx
        .update(schema.audits)
        .set({
          siteFacts: siteFacts as unknown as Record<string, unknown>,
          seededAt: new Date(options.now?.() ?? Date.now()),
          pagesDiscovered: sql`(SELECT count(*)::int FROM crawl_frontier WHERE workspace_id = ${ref.workspaceId} AND audit_id = ${ref.auditId})`,
        })
        .where(and(eq(schema.audits.workspaceId, ref.workspaceId), eq(schema.audits.id, ref.auditId)));
    });
    return { state: 'seeded', robots, sitemaps, sitemapUrls: sitemapUrls.length, truncated };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Whether an audit of this site is still live (the unique index's answer, read for the message). */
export async function liveAuditId(tx: Tx, workspaceId: string, siteId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: schema.audits.id, state: schema.audits.state })
    .from(schema.audits)
    .where(
      and(
        eq(schema.audits.workspaceId, workspaceId),
        eq(schema.audits.siteId, siteId),
        sql`${schema.audits.state} IN ('queued', 'running', 'finalizing')`,
      ),
    )
    .limit(1);
  return row?.id ?? null;
}
