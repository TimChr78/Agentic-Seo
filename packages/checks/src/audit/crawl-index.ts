import type { Tx } from '@agentic-seo/db';
import { sql } from 'drizzle-orm';

// The finalize checks read the crawl tables through transaction-local working tables, never by
// loading the audit into the process (crawler-and-audits.md §1 "Bounded memory"):
//
// - `fz_pages` holds only the columns a check needs (`facts->'html'->>'title'` and friends), one row
//   per snapshot. The full `PageFacts` — links, images, JSON-LD — never leaves the database.
// - `fz_sitemap_urls` holds the URLs the audit's sitemaps listed.
// - `fz_canonical` holds one edge per authoritative page that declares a canonical for another URL
//   on the site.
// - `fz_eval_pages` holds the authoritative page keys the score's denominator counts.
// - `fz_eval` holds every (check, subject) pair this audit actually judged, so the issue lifecycle
//   can tell a pass from "not re-checked" without loading the findings.
//
// The tables are `TEMP ... ON COMMIT DROP`, so they live exactly as long as the finalize
// transaction and are invisible to other sessions. Everything that can be grouped or joined is
// (titles, descriptions, content hashes, link edges, canonicals, hreflang); the result rows a check
// reads are streamed in keyset batches of FINALIZE_BATCH, and each batch's findings are written
// before the next batch is read, so peak memory is bounded by the batch, not the crawl.

/** Rows per keyset batch. A crawl of 100,000 pages costs the same memory as one of 1,000. */
export const FINALIZE_BATCH = 1_000;

export interface AuditRef {
  workspaceId: string;
  auditId: string;
}

/** One row of a streamed check result: the issue's subject and its capped evidence. */
export interface EvidenceRow {
  subject_key: string;
  subject: string;
  evidence: { items: unknown[]; total: number; truncated: boolean };
  affected_pages: number;
  affected_urls: string[];
}

/** Reads keyset batches of `build(after)`; `keyOf` is the row's sort key. */
export async function* streamBatches<Row>(
  tx: Tx,
  build: (after: string | null) => ReturnType<typeof sql>,
  keyOf: (row: Row) => string,
): AsyncGenerator<Row[]> {
  let after: string | null = null;
  for (;;) {
    const result = await tx.execute(build(after));
    const rows = result.rows as unknown as Row[];
    if (!rows.length) return;
    yield rows;
    if (rows.length < FINALIZE_BATCH) return;
    after = keyOf(rows[rows.length - 1] as Row);
  }
}

/**
 * Creates and fills the working tables for one audit. Every read is workspace and audit scoped, so
 * row-level security still applies; the tables themselves are session-local and dropped at commit.
 * Returns the number of evaluated pages (200 HTML responses, one per final URL).
 */
export async function prepareCrawlTables(tx: Tx, ref: AuditRef, hosts: readonly string[]): Promise<number> {
  // DDL cannot share a prepared statement with other commands, so each table is one execute.
  for (const ddl of [
    sql`CREATE TEMP TABLE IF NOT EXISTS fz_pages (
      url text PRIMARY KEY,
      final_url text NOT NULL,
      status integer NOT NULL,
      is_html boolean NOT NULL,
      ok_html boolean NOT NULL,
      canonical text,
      canonical_internal boolean NOT NULL DEFAULT false,
      title_text text,
      description_text text,
      content_hash text,
      word_count integer NOT NULL DEFAULT 0,
      depth integer,
      in_sitemap boolean NOT NULL DEFAULT false,
      robots_allowed boolean NOT NULL DEFAULT true,
      fetch_error text,
      x_robots_tag text,
      lang text,
      hreflang jsonb NOT NULL DEFAULT '[]'::jsonb,
      redirects jsonb NOT NULL DEFAULT '[]'::jsonb,
      is_https boolean NOT NULL DEFAULT false,
      home boolean NOT NULL DEFAULT false,
      has_title boolean NOT NULL DEFAULT false,
      has_description boolean NOT NULL DEFAULT false,
      has_hreflang boolean NOT NULL DEFAULT false,
      has_canonical boolean NOT NULL DEFAULT false,
      meta_noindex boolean NOT NULL DEFAULT false,
      header_noindex boolean NOT NULL DEFAULT false,
      noindex boolean NOT NULL DEFAULT false,
      authoritative boolean NOT NULL DEFAULT false,
      indexable boolean NOT NULL DEFAULT false,
      inlinks integer NOT NULL DEFAULT 0
    ) ON COMMIT DROP`,
    sql`CREATE TEMP TABLE IF NOT EXISTS fz_frontier (
      url_hash text PRIMARY KEY,
      url text NOT NULL,
      state text NOT NULL,
      skip_reason text,
      depth integer,
      in_sitemap boolean NOT NULL DEFAULT false,
      discovered_by text NOT NULL,
      discovered_from text
    ) ON COMMIT DROP`,
    sql`CREATE TEMP TABLE IF NOT EXISTS fz_edges (
      from_url_hash text NOT NULL,
      to_url_hash text NOT NULL,
      to_url text NOT NULL,
      anchor text NOT NULL DEFAULT ''
    ) ON COMMIT DROP`,
    sql`CREATE TEMP TABLE IF NOT EXISTS fz_sitemap_urls (url text PRIMARY KEY) ON COMMIT DROP`,
    sql`CREATE TEMP TABLE IF NOT EXISTS fz_canonical (source text PRIMARY KEY, target text NOT NULL) ON COMMIT DROP`,
    sql`CREATE TEMP TABLE IF NOT EXISTS fz_eval_pages (url text PRIMARY KEY) ON COMMIT DROP`,
    sql`CREATE TEMP TABLE IF NOT EXISTS fz_eval (
      check_id text NOT NULL,
      subject_key text NOT NULL,
      PRIMARY KEY (check_id, subject_key)
    ) ON COMMIT DROP`,
    sql`TRUNCATE fz_pages, fz_frontier, fz_edges, fz_sitemap_urls, fz_canonical, fz_eval_pages, fz_eval`,
  ]) {
    await tx.execute(ddl);
  }

  const hostList = sql.join(
    hosts.map((host) => sql`${host.toLowerCase()}`),
    sql`, `,
  );
  await tx.execute(sql`
    INSERT INTO fz_pages (
      url, final_url, status, is_html, ok_html, canonical, canonical_internal, title_text, description_text,
      content_hash, word_count, depth, in_sitemap, robots_allowed, fetch_error, x_robots_tag, lang, hreflang,
      redirects, is_https, home, has_title, has_description, has_hreflang, has_canonical
    )
    SELECT url,
           final_url,
           status,
           COALESCE((facts ->> 'isHtml')::boolean, false),
           status BETWEEN 200 AND 299 AND COALESCE((facts ->> 'isHtml')::boolean, false) AND facts -> 'html' IS NOT NULL,
           facts -> 'html' ->> 'canonical',
           facts -> 'html' ->> 'canonical' IS NOT NULL
             AND lower(split_part(split_part(facts -> 'html' ->> 'canonical', '/', 3), ':', 1)) = ANY(ARRAY[${hostList}]::text[]),
           nullif(btrim(regexp_replace(COALESCE(facts -> 'html' ->> 'title', ''), '[[:space:]]+', ' ', 'g')), ''),
           nullif(btrim(regexp_replace(COALESCE(facts -> 'html' ->> 'metaDescription', ''), '[[:space:]]+', ' ', 'g')), ''),
           facts -> 'html' ->> 'contentHash',
           COALESCE((facts -> 'html' ->> 'wordCount')::int, 0),
           (facts ->> 'depth')::int,
           COALESCE((facts ->> 'inSitemap')::boolean, false),
           COALESCE((facts ->> 'robotsAllowed')::boolean, true),
           facts ->> 'fetchError',
           facts -> 'headers' ->> 'xRobotsTag',
           facts -> 'html' ->> 'lang',
           COALESCE(facts -> 'html' -> 'hreflang', '[]'::jsonb),
           COALESCE(facts -> 'redirects', '[]'::jsonb),
           final_url LIKE 'https://%',
           regexp_replace(regexp_replace(final_url, '^[a-z]+://[^/]+', ''), '[?#].*$', '') IN ('/', '/index.html', '/index.htm'),
           btrim(COALESCE(facts -> 'html' ->> 'title', '')) <> '',
           facts -> 'html' ->> 'metaDescription' IS NOT NULL,
           jsonb_array_length(COALESCE(facts -> 'html' -> 'hreflang', '[]'::jsonb)) > 0,
           facts -> 'html' ->> 'canonical' IS NOT NULL
    FROM page_snapshots
    WHERE workspace_id = ${ref.workspaceId} AND audit_id = ${ref.auditId}`);

  // The frontier and the internal link edges, copied once so every later join is between
  // transaction-local tables. Joining two RLS-protected tables chooses a nested loop that re-scans
  // the frontier for every edge (18 million comparisons on a 30,000-edge audit), so the copy is what
  // keeps finalize linear in the edges.
  await tx.execute(sql`
    INSERT INTO fz_frontier (url_hash, url, state, skip_reason, depth, in_sitemap, discovered_by, discovered_from)
    SELECT url_hash, url, state, skip_reason, depth, in_sitemap, discovered_by, discovered_from
    FROM crawl_frontier
    WHERE workspace_id = ${ref.workspaceId} AND audit_id = ${ref.auditId}`);
  await tx.execute(sql`
    INSERT INTO fz_edges (from_url_hash, to_url_hash, to_url, anchor)
    SELECT from_url_hash, to_url_hash, to_url, anchor
    FROM link_edges
    WHERE workspace_id = ${ref.workspaceId} AND audit_id = ${ref.auditId} AND internal`);
  await tx.execute(sql`CREATE INDEX IF NOT EXISTS fz_edges_to_url ON fz_edges (to_url)`);

  // One authoritative page per final URL: the first snapshot by requested URL, when it is a 200
  // HTML response. Page checks, on the other hand, ran for every snapshot.
  await tx.execute(sql`
    UPDATE fz_pages p SET authoritative = true
    FROM (
      SELECT url FROM (
        SELECT url, row_number() OVER (PARTITION BY final_url ORDER BY url) AS rn
        FROM fz_pages WHERE status = 200 AND is_html
      ) ranked WHERE rn = 1
    ) first
    WHERE p.url = first.url`);

  // The noindex signals come from the page checks' findings, which ran before finalize: the
  // meta-robots and scoped X-Robots-Tag rules are parsed in exactly one place.
  await tx.execute(sql`
    UPDATE fz_pages p SET
      meta_noindex = EXISTS (
        SELECT 1 FROM findings f
        WHERE f.workspace_id = ${ref.workspaceId} AND f.audit_id = ${ref.auditId}
          AND f.check_id = 'indexability.noindex' AND f.subject_key = p.final_url),
      header_noindex = EXISTS (
        SELECT 1 FROM findings f
        WHERE f.workspace_id = ${ref.workspaceId} AND f.audit_id = ${ref.auditId}
          AND f.check_id = 'indexability.x_robots_noindex' AND f.subject_key = p.final_url)`);
  await tx.execute(sql`UPDATE fz_pages SET noindex = meta_noindex OR header_noindex`);
  await tx.execute(sql`
    UPDATE fz_pages SET indexable = authoritative AND robots_allowed AND fetch_error IS NULL
      AND NOT noindex AND (canonical IS NULL OR canonical = final_url)`);
  await tx.execute(sql`INSERT INTO fz_eval_pages (url) SELECT final_url FROM fz_pages WHERE authoritative`);

  // The URLs the audit's sitemaps listed: the crawled snapshots' own flag plus the frontier rows
  // (a listed URL that was skipped or never fetched still counts as listed).
  await tx.execute(sql`
    INSERT INTO fz_sitemap_urls (url)
    SELECT url FROM fz_pages WHERE in_sitemap
    UNION
    SELECT url FROM fz_frontier WHERE in_sitemap`);
  await tx.execute(sql`
    INSERT INTO fz_canonical (source, target)
    SELECT final_url, canonical FROM fz_pages
    WHERE authoritative AND canonical IS NOT NULL AND canonical <> final_url AND canonical_internal`);
  // The lifecycle resolves a page-check issue by its subject (a final URL for most checks).
  await tx.execute(sql`CREATE INDEX IF NOT EXISTS fz_pages_final_url ON fz_pages (final_url)`);
  // Statistics for the planner: a working table filled in this transaction has none, and without
  // them the planner nested-loops a correlated `EXISTS` into a sequential scan of the whole table.
  await tx.execute(sql`ANALYZE fz_pages`);
  await tx.execute(sql`ANALYZE fz_frontier`);
  await tx.execute(sql`ANALYZE fz_edges`);
  await tx.execute(sql`ANALYZE fz_sitemap_urls`);
  await tx.execute(sql`ANALYZE fz_canonical`);

  await tx.execute(sql`
    UPDATE fz_pages p SET inlinks = counts.n
    FROM (
      SELECT t.final_url, count(DISTINCT e.from_url_hash)::int AS n
      FROM fz_edges e
      JOIN fz_pages t ON t.url = e.to_url
      WHERE e.to_url_hash <> e.from_url_hash
      GROUP BY t.final_url
    ) counts
    WHERE p.final_url = counts.final_url`);

  return countEvaluatedPages(tx);
}

/** The evaluated pages (200 HTML responses, one per final URL): the score's denominator. */
export async function countEvaluatedPages(tx: Tx): Promise<number> {
  const { rows } = await tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM fz_eval_pages`);
  return Number(rows[0]?.n ?? 0);
}

/**
 * The gate a page check's `appliesTo` corresponds to, and the subject a finding of that check is
 * grouped by. The mapping is explicit so a check added to the catalogue without an entry fails the
 * `page check gates` test instead of silently never resolving its issues. `subject` is the
 * requested URL for checks about the request (status, redirects, the scheme) and the final URL for
 * checks about the document. The lifecycle and the score read the pairs this map implies from
 * `fz_judged` (store.ts), which folds the map into one set of SQL inserts, so the mapping has a
 * single definition and no Node loop visits a page per check.
 */
export type PageGate =
  | 'none'
  | 'ok_html'
  | 'title'
  | 'description'
  | 'hreflang'
  | 'canonical'
  | 'indexable'
  | 'indexable_not_home'
  | 'https';

export const PAGE_CHECK_GATES: Record<string, { gate: PageGate; subject: 'url' | 'final_url' }> = {
  'status.client_error': { gate: 'none', subject: 'url' },
  'status.server_error': { gate: 'none', subject: 'url' },
  'status.fetch_failed': { gate: 'none', subject: 'url' },
  'redirect.chain': { gate: 'none', subject: 'url' },
  'redirect.loop': { gate: 'none', subject: 'url' },
  'redirect.temporary': { gate: 'none', subject: 'url' },
  'https.not_used': { gate: 'none', subject: 'url' },
  'image.missing_alt': { gate: 'ok_html', subject: 'final_url' },
  'image.link_missing_alt': { gate: 'ok_html', subject: 'final_url' },
  'image.no_dimensions': { gate: 'ok_html', subject: 'final_url' },
  'indexability.noindex': { gate: 'ok_html', subject: 'final_url' },
  'indexability.x_robots_noindex': { gate: 'ok_html', subject: 'final_url' },
  'canonical.missing': { gate: 'indexable', subject: 'final_url' },
  'canonical.multiple': { gate: 'ok_html', subject: 'final_url' },
  'canonical.outside_head': { gate: 'ok_html', subject: 'final_url' },
  'canonical.conflict_noindex': { gate: 'canonical', subject: 'final_url' },
  'hreflang.invalid_code': { gate: 'hreflang', subject: 'final_url' },
  'hreflang.missing_self': { gate: 'hreflang', subject: 'final_url' },
  'title.missing': { gate: 'ok_html', subject: 'final_url' },
  'title.empty': { gate: 'ok_html', subject: 'final_url' },
  'title.too_long': { gate: 'title', subject: 'final_url' },
  'title.too_short': { gate: 'title', subject: 'final_url' },
  'title.multiple': { gate: 'ok_html', subject: 'final_url' },
  'description.missing': { gate: 'ok_html', subject: 'final_url' },
  'description.too_long': { gate: 'description', subject: 'final_url' },
  'description.too_short': { gate: 'description', subject: 'final_url' },
  'description.multiple': { gate: 'ok_html', subject: 'final_url' },
  'h1.missing': { gate: 'ok_html', subject: 'final_url' },
  'h1.multiple': { gate: 'ok_html', subject: 'final_url' },
  'headings.skipped_level': { gate: 'ok_html', subject: 'final_url' },
  'content.thin': { gate: 'indexable_not_home', subject: 'final_url' },
  'html.lang_missing': { gate: 'ok_html', subject: 'final_url' },
  'viewport.missing': { gate: 'ok_html', subject: 'final_url' },
  'https.mixed_content': { gate: 'ok_html', subject: 'final_url' },
  'https.insecure_form': { gate: 'ok_html', subject: 'final_url' },
  'links.nofollow_internal': { gate: 'ok_html', subject: 'final_url' },
  'links.insecure_internal': { gate: 'https', subject: 'final_url' },
  'schema.parse_error': { gate: 'ok_html', subject: 'final_url' },
  'schema.missing_type': { gate: 'ok_html', subject: 'final_url' },
  'schema.deprecated_type': { gate: 'ok_html', subject: 'final_url' },
  'schema.rich_result_restricted': { gate: 'ok_html', subject: 'final_url' },
  'schema.missing_required': { gate: 'ok_html', subject: 'final_url' },
  'schema.missing_recommended': { gate: 'ok_html', subject: 'final_url' },
};

/** Records that a site-level check judged the site's origin (a full site audit only). */
export async function recordSiteCheckEvaluations(tx: Tx, origin: string, checkIds: readonly string[]): Promise<void> {
  if (!checkIds.length) return;
  await tx.execute(sql`
    INSERT INTO fz_eval (check_id, subject_key)
    SELECT id, ${origin}::text FROM unnest(ARRAY[${sql.join(
      checkIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::text[]) AS id
    ON CONFLICT DO NOTHING`);
}
