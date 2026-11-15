import type { Coverage, SiteFacts } from '@agentic-seo/crawl';
import type { Tx } from '@agentic-seo/db';
import { sql } from 'drizzle-orm';
import { finalizeChecks } from '../catalogue';
import type { FinalizeCheck } from '../check';
import { type AuditRef, type EvidenceRow, FINALIZE_BATCH, prepareCrawlTables, streamBatches } from './crawl-index';
import { EMPTY_CONTENT_HASH } from './ids';
import { insertFindings } from './store';
import type { FindingDraft } from './types';

// The sixteen `evaluator: 'finalize'` checks (packages/checks/src/checks, catalogue doc
// "Cross-page definitions"), evaluated as SQL over the crawl tables.
//
// Design (crawler-and-audits.md §1 "Bounded memory"): `prepareCrawlTables` extracts the columns the
// checks read into transaction-local tables — never whole `PageFacts` — and every check below is
// one aggregate query over them. The cross-page work is grouped in SQL (GROUP BY title, description
// and content hash; the audit's internal link edges joined to the target snapshot by requested URL;
// recursive CTE; hreflang entries joined to their targets). Result rows are read in keyset batches
// of FINALIZE_BATCH and written before the next batch is read, so memory is bounded by the batch,
// not the crawl: a 10,000-page audit costs the same as a 1,000-page one.
//
// Evaluation is recorded per check and subject in `fz_eval` (crawl-index.ts). A check records a
// subject only when it could actually judge it: a canonical or hreflang target check needs the
// target's snapshot in this audit, a sitemap check needs the URL fetched (and robots-allowed), and
// graph checks record nothing when coverage truncated the graph. That is what lets the lifecycle
// resolve a fixed issue and keep an unchecked one open.
//
// Subject identity is deliberate: a redirect or status check's subject is the requested URL (the URL
// people link to); every other check's subject is the page's final URL. The evidence cap never
// changes an issue's page identity.

const byId = new Map(finalizeChecks.map((check) => [check.id, check]));

function eachCheck(id: string): FinalizeCheck {
  const check = byId.get(id);
  if (!check) throw new Error(`The catalogue has no finalize check ${id}`);
  return check;
}

/** The evidence JSON a check's query returns, shared by every row a check emits. */
type Row = EvidenceRow;

function toDraft(check: FinalizeCheck, row: Row): FindingDraft {
  return {
    checkId: check.id,
    category: check.category,
    severity: check.severity,
    // A cross-page finding is computed from the audit, not from one page hook; its subject is the
    // snapshot the finding is about, and replaying finalize upserts the same rows.
    sourceKey: row.subject_key,
    subjectKey: row.subject_key,
    subject: row.subject,
    evidence: row.evidence as FindingDraft['evidence'],
    affectedPages: Number(row.affected_pages),
    affectedUrls: row.affected_urls,
  };
}

/** Streams a check's failing rows and writes each batch before reading the next. */
async function emit(
  tx: Tx,
  ref: AuditRef & { siteId: string },
  check: FinalizeCheck,
  query: (after: string | null) => ReturnType<typeof sql>,
): Promise<number> {
  let written = 0;
  for await (const rows of streamBatches<Row>(tx, query, (row) => row.subject_key)) {
    await insertFindings(
      tx,
      ref,
      rows.map((row) => toDraft(check, row)),
    );
    written += rows.length;
  }
  return written;
}

export interface FinalizeContext {
  ref: AuditRef & { siteId: string };
  coverage: Coverage;
  site: SiteFacts;
  /** The site's primary domain and extra hosts, for "on the same site" comparisons. */
  hosts: readonly string[];
  /** The sitemap documents the audit read, for evidence. */
  sitemapUrls: readonly string[];
}

export interface FinalizeResult {
  /** Checks this audit could not evaluate, with the reason the score reports. */
  skipped: { checkId: string; reason: string }[];
  /** How many findings the finalize checks wrote. */
  findings: number;
  /** Evaluated pages (200 HTML responses, one per final URL). */
  pagesEvaluated: number;
}

/**
 * Runs every finalize check over one audit, as SQL, writing findings and evaluated subjects inside
 * the transaction that finalizes the audit (link_edges are still present).
 */
export async function runFinalizeChecks(tx: Tx, context: FinalizeContext): Promise<FinalizeResult> {
  const { ref, coverage } = context;
  const pagesEvaluated = await prepareCrawlTables(tx, ref, context.hosts);
  const skipped: { checkId: string; reason: string }[] = [];
  let findings = 0;

  const sitemapSource = context.sitemapUrls[0] ?? `${context.site.origin}/sitemap.xml`;
  const sitemapDetail =
    context.sitemapUrls.length > 1
      ? `Listed in one of the audit's ${context.sitemapUrls.length} sitemaps.`
      : 'Listed in the audit’s sitemap.';

  const graphTruncated = (check: FinalizeCheck): boolean => {
    if (!check.requiresCompleteGraph || coverage.graph === 'complete') return false;
    skipped.push({
      checkId: check.id,
      reason: `The link graph is truncated (${coverage.reasons.join(', ')}), so this check was not evaluated.`,
    });
    return true;
  };

  // sitemap.non_indexable_url -----------------------------------------------------------------
  {
    const check = eachCheck('sitemap.non_indexable_url');
    findings += await emit(
      tx,
      ref,
      check,
      (after) => sql`
      SELECT s.url AS subject_key, s.url AS subject,
             jsonb_build_object(
               'items', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                 'subject', s.url,
                 'value', CASE
                   WHEN p.fetch_error IS NOT NULL THEN 'The fetch failed (' || p.fetch_error || ').'
                   WHEN p.status <> 200 THEN 'The response status is ' || p.status || ', not 200.'
                   WHEN NOT p.is_html THEN 'The response is not an HTML document.'
                   WHEN p.noindex THEN CASE WHEN p.header_noindex
                     THEN 'The X-Robots-Tag header contains noindex.'
                     ELSE 'The meta robots tag contains noindex.' END
                   ELSE 'The canonical points at ' || p.canonical || ', not at this URL.'
                 END,
                 'expected', 'a URL that is indexable on its own',
                 'sourceUrl', ${sitemapSource}::text,
                 'detail', ${sitemapDetail}::text
               ))),
               'total', 1,
               'truncated', false
             ) AS evidence,
             1 AS affected_pages,
             ARRAY[s.url]::text[] AS affected_urls
      FROM fz_sitemap_urls s
      JOIN fz_pages p ON p.url = s.url
      WHERE p.robots_allowed
        AND (p.status <> 200 OR NOT p.is_html OR p.noindex OR (p.canonical IS NOT NULL AND p.canonical <> s.url))
        AND (${after}::text IS NULL OR s.url > ${after}::text)
      ORDER BY s.url
      LIMIT ${FINALIZE_BATCH}`,
    );
    // A listed URL this audit did not fetch (robots, page limit, error) is not evaluated: the
    // sitemap check cannot say whether the page is indexable.
    await tx.execute(sql`
      INSERT INTO fz_eval (check_id, subject_key)
      SELECT ${check.id}::text, s.url
      FROM fz_sitemap_urls s
      JOIN fz_pages p ON p.url = s.url
      WHERE p.robots_allowed
      ON CONFLICT DO NOTHING`);
  }

  // page.blocked_by_robots --------------------------------------------------------------------
  {
    const check = eachCheck('page.blocked_by_robots');
    findings += await emit(
      tx,
      ref,
      check,
      (after) => sql`
      SELECT f.url AS subject_key, f.url AS subject,
             jsonb_build_object(
               'items', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                 'subject', f.url,
                 'value', 'robots.txt disallows this URL for the crawler, so it was never fetched.',
                 'expected', 'a URL robots.txt allows the crawler to fetch',
                 'sourceUrl', CASE WHEN f.discovered_by = 'sitemap' THEN ${sitemapSource} ELSE f.discovered_from END,
                 'detail', CASE WHEN f.discovered_by = 'sitemap' OR f.discovered_from IS NOT NULL
                   THEN 'This URL links to it or lists it.'
                   ELSE 'The crawler discovered it as an internal URL.' END
               ))),
               'total', 1,
               'truncated', false
             ) AS evidence,
             1 AS affected_pages,
             ARRAY[f.url]::text[] AS affected_urls
      FROM fz_frontier f
      WHERE f.state = 'skipped' AND f.skip_reason = 'robots'
        AND (${after}::text IS NULL OR f.url > ${after}::text)
      ORDER BY f.url
      LIMIT ${FINALIZE_BATCH}`,
    );
    await tx.execute(sql`
      INSERT INTO fz_eval (check_id, subject_key)
      SELECT ${check.id}::text, url FROM fz_frontier
      ON CONFLICT DO NOTHING`);
  }

  // crawl.deep_page ---------------------------------------------------------------------------
  {
    const check = eachCheck('crawl.deep_page');
    if (!graphTruncated(check)) {
      findings += await emit(
        tx,
        ref,
        check,
        (after) => sql`
        SELECT p.final_url AS subject_key, p.final_url AS subject,
               jsonb_build_object(
                 'items', jsonb_build_array(jsonb_build_object(
                   'subject', p.final_url,
                   'value', 'click depth ' || p.depth,
                   'expected', 'a click depth of 4 or less'
                 )),
                 'total', 1,
                 'truncated', false
               ) AS evidence,
               1 AS affected_pages,
               ARRAY[p.final_url]::text[] AS affected_urls
        FROM fz_pages p
        WHERE p.indexable AND p.depth IS NOT NULL AND p.depth > 4
          AND (${after}::text IS NULL OR p.final_url > ${after}::text)
        ORDER BY p.final_url
        LIMIT ${FINALIZE_BATCH}`,
      );
      await tx.execute(sql`
        INSERT INTO fz_eval (check_id, subject_key)
        SELECT ${check.id}::text, final_url FROM fz_pages WHERE indexable AND depth IS NOT NULL
        ON CONFLICT DO NOTHING`);
    }
  }

  // crawl.orphan_page -------------------------------------------------------------------------
  {
    const check = eachCheck('crawl.orphan_page');
    if (!graphTruncated(check)) {
      findings += await emit(
        tx,
        ref,
        check,
        (after) => sql`
        SELECT p.final_url AS subject_key, p.final_url AS subject,
               jsonb_build_object(
                 'items', jsonb_build_array(jsonb_build_object(
                   'subject', p.final_url,
                   'value', 'No crawled page links to it.',
                   'expected', 'at least one internal link from another page',
                   'sourceUrl', ${sitemapSource}::text,
                   'detail', ${sitemapDetail}::text
                 )),
                 'total', 1,
                 'truncated', false
               ) AS evidence,
               1 AS affected_pages,
               ARRAY[p.final_url]::text[] AS affected_urls
        FROM fz_pages p
        WHERE p.authoritative AND p.in_sitemap AND p.indexable AND p.inlinks = 0
          AND (${after}::text IS NULL OR p.final_url > ${after}::text)
        ORDER BY p.final_url
        LIMIT ${FINALIZE_BATCH}`,
      );
      await tx.execute(sql`
        INSERT INTO fz_eval (check_id, subject_key)
        SELECT ${check.id}::text, final_url FROM fz_pages WHERE authoritative AND in_sitemap
        ON CONFLICT DO NOTHING`);
    }
  }

  // indexability.noindex_in_sitemap -----------------------------------------------------------
  {
    const check = eachCheck('indexability.noindex_in_sitemap');
    findings += await emit(
      tx,
      ref,
      check,
      (after) => sql`
      SELECT s.url AS subject_key, s.url AS subject,
             jsonb_build_object(
               'items', jsonb_build_array(jsonb_build_object(
                 'subject', s.url,
                 'value', concat_ws(' and ',
                   CASE WHEN p.meta_noindex THEN 'the meta robots tag (noindex)' END,
                   CASE WHEN p.header_noindex THEN 'the X-Robots-Tag header (' || COALESCE(p.x_robots_tag, 'noindex') || ')' END),
                 'expected', 'a sitemap URL that is not noindex',
                 'sourceUrl', ${sitemapSource}::text,
                 'detail', ${sitemapDetail}::text
               )),
               'total', 1,
               'truncated', false
             ) AS evidence,
             1 AS affected_pages,
             ARRAY[s.url]::text[] AS affected_urls
      FROM fz_sitemap_urls s
      JOIN fz_pages p ON p.url = s.url
      WHERE p.status = 200 AND p.is_html AND p.noindex
        AND (${after}::text IS NULL OR s.url > ${after}::text)
      ORDER BY s.url
      LIMIT ${FINALIZE_BATCH}`,
    );
    // Only a 200 HTML response can be judged for noindex; a listed 404 is sitemap.non_indexable_url.
    await tx.execute(sql`
      INSERT INTO fz_eval (check_id, subject_key)
      SELECT ${check.id}::text, s.url
      FROM fz_sitemap_urls s
      JOIN fz_pages p ON p.url = s.url
      WHERE p.status = 200 AND p.is_html
      ON CONFLICT DO NOTHING`);
  }

  // canonical.to_non_200, canonical.to_redirect, canonical.to_noindex -------------------------
  // Each subject is evaluated only when the canonical target's snapshot exists in this audit: an
  // uncrawled target cannot say whether the canonical is broken (see the canonical definitions).
  {
    const checks = ['canonical.to_non_200', 'canonical.to_redirect', 'canonical.to_noindex'].map(eachCheck);

    const evaluated = (check: FinalizeCheck) =>
      tx.execute(sql`
      INSERT INTO fz_eval (check_id, subject_key)
      SELECT ${check.id}::text, c.source
      FROM fz_canonical c
      JOIN fz_pages t ON t.url = c.target
      ON CONFLICT DO NOTHING`);
    for (const check of checks) await evaluated(check);

    const toNon200 = checks[0] as FinalizeCheck;
    findings += await emit(
      tx,
      ref,
      toNon200,
      (after) => sql`
      SELECT c.source AS subject_key, c.source AS subject,
             jsonb_build_object(
               'items', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                 'subject', c.source,
                 'value', 'canonical → ' || c.target,
                 'expected', 'a canonical that returns 200',
                 'sourceUrl', c.target,
                 'detail', 'The canonical target does not return 200: ' ||
                   CASE WHEN t.fetch_error IS NOT NULL THEN 'the fetch failed (' || t.fetch_error || ')' ELSE 'status ' || t.status END || '.'
               ))),
               'total', 1,
               'truncated', false
             ) AS evidence,
             1 AS affected_pages,
             ARRAY[c.source]::text[] AS affected_urls
      FROM fz_canonical c
      JOIN fz_pages t ON t.url = c.target
      WHERE (t.status = 0 OR t.status >= 400)
        AND (${after}::text IS NULL OR c.source > ${after}::text)
      ORDER BY c.source
      LIMIT ${FINALIZE_BATCH}`,
    );

    const toRedirect = checks[1] as FinalizeCheck;
    findings += await emit(
      tx,
      ref,
      toRedirect,
      (after) => sql`
      SELECT c.source AS subject_key, c.source AS subject,
             jsonb_build_object(
               'items', jsonb_build_array(jsonb_build_object(
                 'subject', c.source,
                 'value', 'canonical → ' || c.target,
                 'expected', 'a canonical that is the final URL, not a redirect',
                 'sourceUrl', c.target,
                 'detail', 'The canonical target redirects: ' || COALESCE(t.redirects -> 0 ->> 'status', '3') ||
                   ' to ' || COALESCE(t.redirects -> 0 ->> 'location', 'another URL') || ', ending at ' || t.final_url || '.'
               )),
               'total', 1,
               'truncated', false
             ) AS evidence,
             1 AS affected_pages,
             ARRAY[c.source]::text[] AS affected_urls
      FROM fz_canonical c
      JOIN fz_pages t ON t.url = c.target
      WHERE jsonb_array_length(t.redirects) > 0
        AND (${after}::text IS NULL OR c.source > ${after}::text)
      ORDER BY c.source
      LIMIT ${FINALIZE_BATCH}`,
    );

    const toNoindex = checks[2] as FinalizeCheck;
    findings += await emit(
      tx,
      ref,
      toNoindex,
      (after) => sql`
      SELECT c.source AS subject_key, c.source AS subject,
             jsonb_build_object(
               'items', jsonb_build_array(jsonb_build_object(
                 'subject', c.source,
                 'value', 'canonical → ' || c.target,
                 'expected', 'a canonical that is indexable',
                 'sourceUrl', c.target,
                 'detail', CASE WHEN t.header_noindex
                   THEN 'The canonical target sends an X-Robots-Tag noindex header.'
                   ELSE 'The canonical target carries a meta robots noindex.' END
               )),
               'total', 1,
               'truncated', false
             ) AS evidence,
             1 AS affected_pages,
             ARRAY[c.source]::text[] AS affected_urls
      FROM fz_canonical c
      JOIN fz_pages t ON t.url = c.target
      WHERE t.status = 200 AND t.noindex
        AND (${after}::text IS NULL OR c.source > ${after}::text)
      ORDER BY c.source
      LIMIT ${FINALIZE_BATCH}`,
    );
  }

  // canonical.chain_or_cycle ------------------------------------------------------------------
  {
    const check = eachCheck('canonical.chain_or_cycle');
    findings += await emit(
      tx,
      ref,
      check,
      (after) => sql`
      WITH RECURSIVE walk AS (
        SELECT c.source AS start, c.target AS current, 1 AS hops,
               ARRAY[c.source, c.target]::text[] AS path, false AS cycle
        FROM fz_canonical c
        UNION ALL
        SELECT w.start, c.target, w.hops + 1, w.path || c.target, c.target = ANY(w.path)
        FROM walk w
        JOIN fz_canonical c ON c.source = w.current
        WHERE NOT w.cycle AND w.hops < 50
      ), terminal AS (
        SELECT w.* FROM walk w
        WHERE w.cycle OR w.hops >= 50
           OR NOT EXISTS (SELECT 1 FROM fz_canonical c WHERE c.source = w.current)
      ), failing AS (
        SELECT DISTINCT ON (start) start, path, hops, cycle
        FROM terminal
        WHERE hops >= 2 OR cycle
        ORDER BY start, hops DESC
      )
      SELECT start AS subject_key, start AS subject,
             jsonb_build_object(
               'items', jsonb_build_array(jsonb_build_object(
                 'subject', start,
                 'value', array_to_string(path, ' → '),
                 'expected', 'one canonical hop to the final URL',
                 'detail', CASE WHEN cycle THEN 'The canonicals form a cycle.' ELSE 'The canonical chain takes ' || hops || ' hops.' END
               )),
               'total', 1,
               'truncated', false
             ) AS evidence,
             1 AS affected_pages,
             ARRAY[start]::text[] AS affected_urls
      FROM failing
      WHERE (${after}::text IS NULL OR start > ${after}::text)
      ORDER BY start
      LIMIT ${FINALIZE_BATCH}`,
    );
    // A walk that ends at an off-site target or at no/self canonical is a pass. A walk that stops
    // because the next URL was not crawled is not an evaluation: the chain could continue.
    await tx.execute(sql`
      INSERT INTO fz_eval (check_id, subject_key)
      SELECT ${check.id}::text, p.final_url
      FROM fz_pages p
      WHERE p.authoritative
        AND (p.canonical IS NULL OR p.canonical = p.final_url OR NOT p.canonical_internal
             OR EXISTS (SELECT 1 FROM fz_pages t WHERE t.url = p.canonical))
      ON CONFLICT DO NOTHING`);
  }

  // links.broken_internal and links.to_redirect -----------------------------------------------
  // The two conditions are independent: a link to /old → 301 → /missing (404) is both a redirect
  // finding and a broken-target finding.
  {
    const broken = eachCheck('links.broken_internal');
    const brokenEdges = (after: string | null) => sql`
      WITH edges AS (
        SELECT e.to_url, f.url AS source_url, t.status AS target_status,
               COALESCE(t.robots_allowed, true) AS target_robots_allowed, t.fetch_error
        FROM fz_edges e
        JOIN fz_frontier f ON f.url_hash = e.from_url_hash
        LEFT JOIN fz_pages t ON t.url = e.to_url
      ), failing AS (
        SELECT * FROM edges
        WHERE target_status IS NOT NULL
          AND NOT (target_status = 0 AND NOT target_robots_allowed)
          AND (target_status = 0 OR target_status >= 400)
      ), counted AS (
        SELECT *, count(*) OVER (PARTITION BY to_url) AS total,
               row_number() OVER (PARTITION BY to_url ORDER BY source_url) AS rn
        FROM failing
      )
      SELECT to_url AS subject_key, to_url AS subject,
             jsonb_build_object(
               'items', jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                 'subject', to_url,
                 'value', CASE WHEN target_status = 0
                   THEN 'the fetch failed (' || COALESCE(fetch_error, 'unknown error') || ')'
                   ELSE 'status ' || target_status END,
                 'expected', 'a link target that returns 200',
                 'sourceUrl', source_url,
                 'detail', 'An internal link on this page points at the broken URL.'
               )) ORDER BY source_url),
               'total', max(total),
               'truncated', max(total) > 50
             ) AS evidence,
             1 AS affected_pages,
             ARRAY[to_url]::text[] AS affected_urls
      FROM counted
      WHERE rn <= 50 AND (${after}::text IS NULL OR to_url > ${after}::text)
      GROUP BY to_url
      ORDER BY to_url
      LIMIT ${FINALIZE_BATCH}`;
    findings += await emit(tx, ref, broken, brokenEdges);

    const toRedirect = eachCheck('links.to_redirect');
    const redirectEdges = (after: string | null) => sql`
      WITH edges AS (
        SELECT e.to_url, f.url AS source_url, t.status AS target_status,
               COALESCE(t.robots_allowed, true) AS target_robots_allowed,
               t.final_url AS target_final_url, t.redirects
        FROM fz_edges e
        JOIN fz_frontier f ON f.url_hash = e.from_url_hash
        LEFT JOIN fz_pages t ON t.url = e.to_url
      ), failing AS (
        SELECT * FROM edges
        WHERE target_status IS NOT NULL
          AND NOT (target_status = 0 AND NOT target_robots_allowed)
          AND jsonb_array_length(redirects) > 0
      ), counted AS (
        SELECT *, count(*) OVER (PARTITION BY to_url) AS total,
               row_number() OVER (PARTITION BY to_url ORDER BY source_url) AS rn
        FROM failing
      )
      SELECT to_url AS subject_key, to_url AS subject,
             jsonb_build_object(
               'items', jsonb_agg(jsonb_build_object(
                 'subject', to_url,
                 'value', 'the link target redirects',
                 'expected', 'a link to the final URL instead of a redirect',
                 'sourceUrl', source_url,
                 'detail', 'The target redirects: ' || COALESCE(redirects -> 0 ->> 'status', '3') ||
                   ' to ' || COALESCE(redirects -> 0 ->> 'location', 'another URL') || ', ending at ' ||
                   COALESCE(target_final_url, to_url) || '.'
               ) ORDER BY source_url),
               'total', max(total),
               'truncated', max(total) > 50
             ) AS evidence,
             1 AS affected_pages,
             ARRAY[to_url]::text[] AS affected_urls
      FROM counted
      WHERE rn <= 50 AND (${after}::text IS NULL OR to_url > ${after}::text)
      GROUP BY to_url
      ORDER BY to_url
      LIMIT ${FINALIZE_BATCH}`;
    findings += await emit(tx, ref, toRedirect, redirectEdges);

    for (const check of [broken, toRedirect]) {
      await tx.execute(sql`
        INSERT INTO fz_eval (check_id, subject_key)
        SELECT ${check.id}::text, url FROM fz_pages
        ON CONFLICT DO NOTHING`);
    }
  }

  // title.duplicate, description.duplicate, content.duplicate ---------------------------------
  // The group is one aggregate in SQL; one finding per URL in the group is streamed, each carrying
  // the group's capped evidence (50 URLs) while its own page identity stays one page.
  {
    const duplicate = async (
      check: FinalizeCheck,
      baseWhere: ReturnType<typeof sql>,
      valueExpression: ReturnType<typeof sql>,
      valueLabel: string,
      expected: string,
      itemDetail: string,
    ): Promise<number> =>
      emit(
        tx,
        ref,
        check,
        (after) => sql`
        WITH base AS (
          SELECT final_url, ${valueExpression} AS value, word_count
          FROM fz_pages
          WHERE authoritative AND ${baseWhere}
        ), counted AS (
          SELECT final_url, value, word_count, count(*) OVER (PARTITION BY value)::int AS n,
                 row_number() OVER (PARTITION BY value ORDER BY final_url) AS member_rank
          FROM base
        ), capped AS (
          SELECT value, jsonb_agg(item ORDER BY final_url) AS items
          FROM (
            SELECT value, final_url,
                   jsonb_build_object(
                     'subject', final_url,
                     'value', ${valueLabel}::text || ': ' || value,
                     'expected', ${expected}::text,
                     'detail', ${itemDetail}::text
                   ) AS item
            FROM counted WHERE member_rank <= 50
          ) members
          GROUP BY value
        )
        SELECT c.final_url AS subject_key, c.final_url AS subject,
               jsonb_build_object(
                 'items', capped.items,
                 'total', c.n,
                 'truncated', c.n > 50
               ) AS evidence,
               1 AS affected_pages,
               ARRAY[c.final_url]::text[] AS affected_urls
        FROM counted c
        JOIN capped ON capped.value = c.value
        WHERE c.n >= 2 AND (${after}::text IS NULL OR c.final_url > ${after}::text)
        ORDER BY c.final_url
        LIMIT ${FINALIZE_BATCH}`,
      );

    const title = eachCheck('title.duplicate');
    findings += await duplicate(
      title,
      sql`indexable AND title_text IS NOT NULL`,
      sql`title_text`,
      'title',
      'a title no other page shares',
      'These pages share this title.',
    );
    const description = eachCheck('description.duplicate');
    findings += await duplicate(
      description,
      sql`indexable AND description_text IS NOT NULL`,
      sql`description_text`,
      'description',
      'a description no other page shares',
      'These pages share this meta description.',
    );
    const content = eachCheck('content.duplicate');
    findings += await emit(
      tx,
      ref,
      content,
      (after) => sql`
      WITH base AS (
        SELECT final_url, content_hash AS value, word_count
        FROM fz_pages
        WHERE authoritative AND indexable AND content_hash IS NOT NULL
          AND content_hash <> ${EMPTY_CONTENT_HASH} AND word_count > 0
      ), counted AS (
        SELECT final_url, value, word_count, count(*) OVER (PARTITION BY value)::int AS n,
               row_number() OVER (PARTITION BY value ORDER BY final_url) AS member_rank
        FROM base
      ), capped AS (
        SELECT value, jsonb_agg(item ORDER BY final_url) AS items
        FROM (
          SELECT value, final_url,
                 jsonb_build_object(
                   'subject', final_url,
                   'value', 'content hash: ' || value,
                   'expected', 'a content hash no other page shares',
                   'detail', 'The page has ' || word_count || ' words of identical main content.'
                 ) AS item
          FROM counted WHERE member_rank <= 50
        ) members
        GROUP BY value
      )
      SELECT c.final_url AS subject_key, c.final_url AS subject,
             jsonb_build_object('items', capped.items, 'total', c.n, 'truncated', c.n > 50) AS evidence,
             1 AS affected_pages,
             ARRAY[c.final_url]::text[] AS affected_urls
      FROM counted c
      JOIN capped ON capped.value = c.value
      WHERE c.n >= 2 AND (${after}::text IS NULL OR c.final_url > ${after}::text)
      ORDER BY c.final_url
      LIMIT ${FINALIZE_BATCH}`,
    );
    for (const check of [title, description, content]) {
      await tx.execute(sql`
        INSERT INTO fz_eval (check_id, subject_key)
        SELECT ${check.id}::text, final_url FROM fz_pages WHERE authoritative
        ON CONFLICT DO NOTHING`);
    }
  }

  // hreflang.missing_return and hreflang.to_non_canonical -------------------------------------
  // Both need the target crawled: an uncrawled target cannot confirm or deny the relationship.
  {
    const resolvedEntries = sql`
      WITH entries AS (
        SELECT p.final_url AS source_key, p.final_url AS source_subject, p.lang AS source_lang,
               e.entry ->> 'lang' AS lang, e.entry ->> 'href' AS target
        FROM fz_pages p
        CROSS JOIN LATERAL jsonb_array_elements(p.hreflang) AS e(entry)
        WHERE p.authoritative AND e.entry ->> 'href' <> p.final_url
      )
      SELECT en.*, t.final_url AS target_final_url, t.lang AS target_lang, t.hreflang AS target_hreflang,
             t.indexable AS target_indexable, t.status AS target_status, t.is_html AS target_is_html,
             t.noindex AS target_noindex, t.header_noindex AS target_header_noindex, t.canonical AS target_canonical
      FROM entries en
      LEFT JOIN LATERAL (
        SELECT t.* FROM fz_pages t
        WHERE t.final_url = en.target OR t.url = en.target
        ORDER BY (t.authoritative AND t.final_url = en.target) DESC, (t.final_url = en.target) DESC, t.url
        LIMIT 1
      ) t ON true`;

    const missingReturn = eachCheck('hreflang.missing_return');
    findings += await emit(
      tx,
      ref,
      missingReturn,
      (after) => sql`
      WITH resolved AS (${resolvedEntries}), failing AS (
        SELECT *, CASE WHEN source_lang IS NULL THEN lang ELSE source_lang END AS code
        FROM resolved t
        WHERE t.target_final_url IS NOT NULL AND t.target_indexable
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(t.target_hreflang) AS b(entry)
            WHERE b.entry ->> 'href' = t.source_key
              AND (lower(b.entry ->> 'lang') = 'x-default' OR t.source_lang IS NULL
                   OR split_part(lower(b.entry ->> 'lang'), '-', 1) = split_part(lower(t.source_lang), '-', 1))
          )
      ), ranked AS (
        SELECT *, count(*) OVER (PARTITION BY source_key)::int AS total,
               row_number() OVER (PARTITION BY source_key ORDER BY target) AS rn
        FROM failing
      )
      SELECT source_key AS subject_key, source_subject AS subject,
             jsonb_build_object(
               'items', jsonb_agg(jsonb_build_object(
                 'subject', source_subject,
                 'value', 'hreflang ' || lang || ' → ' || target,
                 'expected', 'a return hreflang entry on ' || target_final_url || ' with hreflang "' || code || '" or x-default',
                 'sourceUrl', target_final_url,
                 'detail', 'The target has no hreflang entry pointing back at this page for "' || code || '".'
               ) ORDER BY target),
               'total', max(total),
               'truncated', max(total) > 50
             ) AS evidence,
             1 AS affected_pages,
             ARRAY[source_key]::text[] AS affected_urls
      FROM ranked
      WHERE rn <= 50 AND (${after}::text IS NULL OR source_key > ${after}::text)
      GROUP BY source_key, source_subject
      ORDER BY source_key
      LIMIT ${FINALIZE_BATCH}`,
    );
    await tx.execute(sql`
      INSERT INTO fz_eval (check_id, subject_key)
      SELECT ${missingReturn.id}::text, en.source_key
      FROM (${resolvedEntries}) en
      WHERE en.target_final_url IS NOT NULL AND en.target_indexable
      ON CONFLICT DO NOTHING`);

    const toNonCanonical = eachCheck('hreflang.to_non_canonical');
    findings += await emit(
      tx,
      ref,
      toNonCanonical,
      (after) => sql`
      WITH resolved AS (${resolvedEntries}), reasoned AS (
        SELECT *, CASE
          WHEN target_status < 200 OR target_status >= 300 THEN 'The target is not a 2xx response (status ' || target_status || ').'
          WHEN NOT target_is_html THEN 'The target is not an HTML document.'
          WHEN target_noindex THEN 'The target is noindex.'
          WHEN target_canonical IS NOT NULL AND target_canonical <> target_final_url
            THEN 'The target declares a canonical of ' || target_canonical || '.'
        END AS why
        FROM resolved WHERE target_final_url IS NOT NULL
      ), failing AS (
        SELECT * FROM reasoned WHERE why IS NOT NULL
      ), ranked AS (
        SELECT *, count(*) OVER (PARTITION BY source_key)::int AS total,
               row_number() OVER (PARTITION BY source_key ORDER BY target) AS rn
        FROM failing
      )
      SELECT source_key AS subject_key, source_subject AS subject,
             jsonb_build_object(
               'items', jsonb_agg(jsonb_build_object(
                 'subject', source_subject,
                 'value', 'hreflang ' || lang || ' → ' || target,
                 'expected', 'an hreflang target that is its own canonical and indexable',
                 'sourceUrl', target,
                 'detail', why
               ) ORDER BY target),
               'total', max(total),
               'truncated', max(total) > 50
             ) AS evidence,
             1 AS affected_pages,
             ARRAY[source_key]::text[] AS affected_urls
      FROM ranked
      WHERE rn <= 50 AND (${after}::text IS NULL OR source_key > ${after}::text)
      GROUP BY source_key, source_subject
      ORDER BY source_key
      LIMIT ${FINALIZE_BATCH}`,
    );
    await tx.execute(sql`
      INSERT INTO fz_eval (check_id, subject_key)
      SELECT ${toNonCanonical.id}::text, en.source_key
      FROM (${resolvedEntries}) en
      WHERE en.target_final_url IS NOT NULL
      ON CONFLICT DO NOTHING`);
  }

  // The lifecycle joins this table; statistics keep that a set operation rather than a scan per
  // issue.
  await tx.execute(sql`ANALYZE fz_eval`);

  return { skipped, findings, pagesEvaluated };
}
