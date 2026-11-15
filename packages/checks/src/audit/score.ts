import type { Tx } from '@agentic-seo/db';
import { normalizePageUrl } from '@agentic-seo/search-data';
import { sql } from 'drizzle-orm';
import type { CheckCategory, Severity } from '../check';

// The health score (crawler-and-audits.md §6): score = 100 − Σ_category weight_c × penalty_c, where
// penalty_c grows with the severity of the open issues in the category and the share of evaluated
// pages they affect, weighted by each page's GSC click share when page aggregates exist.
//
// Page identity and coverage:
//
// - An issue weighs its own subject pages (`issues.affected_urls`), never its capped evidence: a
//   duplicate-title issue for one page is one affected page, however many URLs its evidence lists.
// - A site-level issue (robots.txt, a sitemap, http-to-https) has no page identity; it is weighted
//   as the whole evaluated site, because the site check that found it failing covers the site.
// - Only the issues this audit judged are in the denominator: the issues that failed in it. An open
//   issue the audit did not judge (its pages were not evaluated, or its per-check gate did not hold)
//   is excluded and reported as `unchecked_issues` on `audit_scores`, so a clean one-page audit with
//   an old issue elsewhere scores 100 rather than penalising a page it did not read. An issue the
//   audit judged and that passed was resolved by the lifecycle before the score runs.
//
// Memory (crawler-and-audits.md §1 "Bounded memory"): the audit path never holds the evaluated pages,
// the GSC rows or the open issues as arrays. Page keys and clicks stream into transaction-local
// tables in fixed batches, and the opens issues stream past a constant-size accumulator with one
// category entry each, so finalize's memory is a function of the batch size, not of the site.
//
// Constants and why:
//
// - Weights sum to 1, so the score is on a fixed 0–100 scale whatever the catalogue size. The
//   weights say what a person loses when a category is broken: indexability and crawlability first
//   (a page Google cannot index barely competes), then status/links and on-page, then security,
//   structured data and the smaller international and image signals.
// - A category's penalty is capped at 100 (its weight, so at most 24 points). One broken category
//   can therefore never zero the score, as §6 requires.
// - The penalty is multiplicative in the remaining share: `1 − Π(1 − severityFactor × share)`.
//   It is monotonic in severity and in the share of affected pages, it never exceeds the cap, and
//   many small issues do not add up faster than the pages they cover.
// - No pages evaluated means no score, with a reason. The design rule is absolute: no data never
//   means healthy.

/** How much of the 0–100 score each category can cost at its cap (sums to 1). */
export const CATEGORY_WEIGHTS: Record<CheckCategory, number> = {
  crawlability: 0.22,
  indexability: 0.24,
  status_links: 0.15,
  on_page: 0.15,
  structured_data: 0.06,
  images: 0.04,
  security: 0.1,
  international: 0.04,
};

/** The share of a category's cap one issue can claim, before its affected-page share scales it. */
export const SEVERITY_FACTORS: Record<Severity, number> = {
  critical: 1,
  high: 0.8,
  medium: 0.55,
  low: 0.3,
  info: 0.1,
};

/** A category's penalty never exceeds this; its weight then bounds what one category can cost. */
export const CATEGORY_PENALTY_CAP = 100;

/** Rows per batch when the score streams pages, clicks or issues. */
export const SCORE_BATCH = 1_000;

/** The reason recorded when an audit evaluated no page at all. */
const NO_PAGES_REASON = 'No page was evaluated: the audit stored no 200 HTML response, so there is nothing to score.';

/**
 * The categories this phase does not evaluate, with the reason the UI shows beside the score
 * (design §4.5 "Not evaluated" rows). Keep these sentences actionable and specific.
 */
export const NOT_EVALUATED_CATEGORIES: readonly { category: string; reason: string }[] = [
  { category: 'performance', reason: 'Performance is not evaluated yet: Core Web Vitals arrive in Phase 2.' },
  {
    category: 'mobile_rendering',
    reason: 'Mobile and rendering are not evaluated yet: no renderer is configured, and rendering arrives in Phase 2.',
  },
  { category: 'geo', reason: 'GEO and AI crawler checks arrive in a later Phase 1 task.' },
  { category: 'agent_readiness', reason: 'Agent-readiness checks arrive in Phase 5.' },
  { category: 'local', reason: 'Local checks arrive in Phase 4.' },
  { category: 'ecommerce', reason: 'E-commerce checks arrive in a later phase.' },
  { category: 'programmatic', reason: 'Programmatic checks arrive in a later phase.' },
  {
    category: 'judged',
    reason: 'LLM-judged checks (E-E-A-T, search intent, citability) arrive in Phase 2 with sampling and budgets.',
  },
];

/** One open issue as the score sees it. */
export interface ScoreIssue {
  category: CheckCategory;
  severity: Severity;
  /**
   * The issue's own subject pages (its identity), not its evidence: an issue on one page weighs one
   * page however many URLs its capped evidence names. Empty for a site-level issue.
   */
  affectedUrls: readonly string[];
  /** How many pages the issue covers, used when its pages are not in the evaluated set. */
  affectedPages: number;
  /**
   * The issue has no page identity (its subject is the site itself: robots.txt, a sitemap, the
   * http-to-https redirect). It is weighted as the whole evaluated site, since the audit that
   * evaluated the site check found it failing; see the score's documentation.
   */
  siteLevel?: boolean;
}

export interface CategoryScore {
  category: CheckCategory;
  weight: number;
  penalty: number;
  contribution: number;
  issues: number;
  affectedPages: number;
}

export interface ScoreResult {
  score: number | null;
  reason: string | null;
  categories: CategoryScore[];
  pagesEvaluated: number;
  gscWeighted: boolean;
}

const round = (value: number, places = 2): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** The score's only per-category state, so its working set never grows with the site. */
export interface CategoryState {
  /** The category's surviving share: the product of `1 − severityFactor × affectedShare`. */
  remaining: number;
  issues: number;
  affectedPages: number;
}

/** One accumulator per evaluated category, in the catalogue's weight order. */
export function emptyCategoryStates(): Map<CheckCategory, CategoryState> {
  const states = new Map<CheckCategory, CategoryState>();
  for (const category of Object.keys(CATEGORY_WEIGHTS) as CheckCategory[])
    states.set(category, { remaining: 1, issues: 0, affectedPages: 0 });
  return states;
}

/**
 * Folds one failing issue into the accumulator. `affectedWeight` is the traffic weight of the issue's
 * own pages (the whole site for a site-level issue); `totalWeight` is the weight of every evaluated
 * page, so the two give the issue's share.
 */
export function addToCategory(
  states: Map<CheckCategory, CategoryState>,
  issue: { category: CheckCategory; severity: Severity; affectedPages: number },
  affectedWeight: number,
  totalWeight: number,
): void {
  const state = states.get(issue.category);
  if (!state || totalWeight <= 0) return;
  const share = Math.min(1, Math.max(0, affectedWeight / totalWeight));
  state.remaining *= 1 - SEVERITY_FACTORS[issue.severity] * share;
  state.issues += 1;
  state.affectedPages += Math.max(1, issue.affectedPages);
}

/** Turns the accumulated per-category shares into the published score. */
export function finalizeScore(
  states: ReadonlyMap<CheckCategory, CategoryState>,
  pagesEvaluated: number,
  gscWeighted: boolean,
): ScoreResult {
  if (pagesEvaluated === 0) {
    return { score: null, reason: NO_PAGES_REASON, categories: [], pagesEvaluated: 0, gscWeighted: false };
  }
  const categories: CategoryScore[] = [];
  let reduction = 0;
  for (const category of Object.keys(CATEGORY_WEIGHTS) as CheckCategory[]) {
    const state = states.get(category) ?? { remaining: 1, issues: 0, affectedPages: 0 };
    const weight = CATEGORY_WEIGHTS[category];
    const penalty = CATEGORY_PENALTY_CAP * (1 - state.remaining);
    const contribution = weight * penalty;
    reduction += contribution;
    categories.push({
      category,
      weight,
      penalty: round(penalty),
      contribution: round(contribution),
      issues: state.issues,
      affectedPages: state.affectedPages,
    });
  }
  return {
    score: Math.max(0, Math.min(100, Math.round(100 - reduction))),
    reason: null,
    categories,
    pagesEvaluated,
    gscWeighted,
  };
}

/**
 * The score of one audit from in-memory issues: the reference implementation the unit tests pin.
 * The audit path (`prepareScoreTables` + `scoreOpenIssues`) applies the same arithmetic while
 * streaming, so it never builds these arrays; keep the two in step.
 */
export function computeScore(input: {
  issues: readonly ScoreIssue[];
  pages: readonly string[];
  clicks: ReadonlyMap<string, number> | null;
}): ScoreResult {
  const pages = [...new Set(input.pages)];
  if (pages.length === 0) return finalizeScore(emptyCategoryStates(), 0, false);

  const clicks = input.clicks;
  const totalClicks = clicks === null ? 0 : [...clicks.values()].reduce((sum, value) => sum + value, 0);
  const gscWeighted = clicks !== null && totalClicks > 0;
  const meanClicks = gscWeighted ? totalClicks / pages.length : 0;
  const weightOf = (page: string): number => {
    if (!gscWeighted) return 1;
    const value = clicks?.get(page) ?? 0;
    return 1 + value / meanClicks;
  };
  const weightByPage = new Map(pages.map((page) => [page, weightOf(page)]));
  const totalWeight = [...weightByPage.values()].reduce((sum, value) => sum + value, 0);
  const averageWeight = totalWeight / pages.length;

  const states = emptyCategoryStates();
  for (const issue of input.issues) {
    const urls = [...new Set(issue.affectedUrls.map(normalizePageUrl).filter((url) => weightByPage.has(url)))];
    // A site-level issue has no page identity: it affects the whole evaluated site. A page issue
    // weighs exactly the pages it names that this audit evaluated; only when none of them is in the
    // evaluated set does its affected-page count stand in (one unevaluated URL, a 404 target).
    const affectedWeight = issue.siteLevel
      ? totalWeight
      : urls.length
        ? urls.reduce((sum, url) => sum + (weightByPage.get(url) ?? 1), 0)
        : Math.max(0, issue.affectedPages) * averageWeight;
    addToCategory(states, issue, affectedWeight, totalWeight);
  }

  return finalizeScore(states, pages.length, gscWeighted);
}

/** What the score needs to know about the evaluated pages once the working tables are filled. */
export interface ScoreWindow {
  /** Distinct evaluated page keys, normalised like `page_key`. */
  pages: number;
  /** The summed traffic weight of those pages (their count when Search Console is absent). */
  totalWeight: number;
  gscWeighted: boolean;
}

/**
 * Fills the score's working tables without holding the site in memory: the evaluated page keys and
 * the site's Search Console page clicks stream into `fz_page_keys` and `fz_clicks` in fixed batches,
 * each key normalised in Node exactly as `page_key` (packages/search-data) so the two sides agree.
 * `fz_page_weights` then carries one weight per page, computed in SQL.
 */
export async function prepareScoreTables(tx: Tx, ref: { workspaceId: string; siteId: string }): Promise<ScoreWindow> {
  for (const ddl of [
    sql`CREATE TEMP TABLE IF NOT EXISTS fz_page_keys (page_key text PRIMARY KEY) ON COMMIT DROP`,
    sql`CREATE TEMP TABLE IF NOT EXISTS fz_clicks (page_key text PRIMARY KEY, clicks float8 NOT NULL) ON COMMIT DROP`,
    sql`CREATE TEMP TABLE IF NOT EXISTS fz_page_weights (page_key text PRIMARY KEY, weight float8 NOT NULL) ON COMMIT DROP`,
    sql`TRUNCATE fz_page_keys, fz_clicks, fz_page_weights`,
  ]) {
    await tx.execute(ddl);
  }

  // The evaluated pages, one normalised key each, streamed in keyset batches.
  let after: string | null = null;
  for (;;) {
    const pageBatch = await tx.execute(sql`
      SELECT url FROM fz_eval_pages
      WHERE ${after === null}::boolean OR url > ${after}
      ORDER BY url
      LIMIT ${SCORE_BATCH}`);
    const rows = pageBatch.rows as unknown as { url: string }[];
    if (!rows.length) break;
    const keys = [...new Set(rows.map((row) => normalizePageUrl(row.url)))];
    await tx.execute(sql`
      INSERT INTO fz_page_keys (page_key)
      SELECT unnest(ARRAY[${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      )}]::text[])
      ON CONFLICT DO NOTHING`);
    if (rows.length < SCORE_BATCH) break;
    after = rows[rows.length - 1]?.url ?? null;
  }

  // The site's clicks over the last 28 days of stored data, keyed by the normalised page key. No
  // active connection (or no aggregates) leaves the table empty: the score is then unweighted.
  const { rows: connectionRows } = await tx.execute<{ property: string | null }>(sql`
    SELECT settings ->> 'property' AS property
    FROM connections
    WHERE workspace_id = ${ref.workspaceId} AND site_id = ${ref.siteId}
      AND connector = 'google-search-console' AND state = 'active'
    ORDER BY updated_at DESC
    LIMIT 1`);
  const property = connectionRows[0]?.property ?? null;
  if (property) {
    let clickAfter: string | null = null;
    for (;;) {
      const clickBatch = await tx.execute(sql`
        WITH latest AS (
          SELECT max(date) AS last FROM gsc_page_aggregates
          WHERE workspace_id = ${ref.workspaceId} AND site_id = ${ref.siteId}
            AND property = ${property} AND search_type = 'web'
        )
        SELECT page_key, SUM(clicks)::float8 AS clicks
        FROM gsc_page_aggregates, latest
        WHERE workspace_id = ${ref.workspaceId} AND site_id = ${ref.siteId}
          AND property = ${property} AND search_type = 'web'
          AND latest.last IS NOT NULL AND date BETWEEN latest.last - 27 AND latest.last
          AND (${clickAfter === null}::boolean OR page_key > ${clickAfter})
        GROUP BY page_key
        ORDER BY page_key
        LIMIT ${SCORE_BATCH}`);
      const rows = clickBatch.rows as unknown as { page_key: string; clicks: number }[];
      if (!rows.length) break;
      const keys = rows.map((row) => normalizePageUrl(row.page_key));
      const clicks = rows.map((row) => Number(row.clicks));
      await tx.execute(sql`
        INSERT INTO fz_clicks (page_key, clicks)
        SELECT unnest(ARRAY[${sql.join(
          keys.map((key) => sql`${key}`),
          sql`, `,
        )}]::text[]), unnest(ARRAY[${sql.join(
          clicks.map((value) => sql`${value}`),
          sql`, `,
        )}]::float8[])
        ON CONFLICT (page_key) DO UPDATE SET clicks = fz_clicks.clicks + excluded.clicks`);
      if (rows.length < SCORE_BATCH) break;
      clickAfter = rows[rows.length - 1]?.page_key ?? null;
    }
  }

  const totalsResult = await tx.execute(sql`
    SELECT (SELECT count(*)::int FROM fz_page_keys) AS pages,
           (SELECT COALESCE(sum(clicks), 0)::float8 FROM fz_clicks) AS clicks,
           (SELECT count(*)::int FROM fz_clicks) AS click_rows`);
  const totals = totalsResult.rows as unknown as { pages: number; clicks: number; click_rows: number }[];
  const pages = Number(totals[0]?.pages ?? 0);
  const totalClicks = Number(totals[0]?.clicks ?? 0);
  const gscWeighted = Number(totals[0]?.click_rows ?? 0) > 0 && totalClicks > 0;
  if (pages === 0) return { pages: 0, totalWeight: 0, gscWeighted: false };

  // A page's weight: 1 + its clicks over the mean, so a page with average traffic weighs twice a
  // page with none. `totalClicks / pages` is the mean; the table keeps the intermediate sums out of
  // Node.
  await tx.execute(sql`
    INSERT INTO fz_page_weights (page_key, weight)
    SELECT k.page_key,
           CASE WHEN ${gscWeighted}::boolean
                  AND ${totalClicks}::float8 > 0
                  AND ${pages}::int > 0
             THEN 1 + COALESCE(c.clicks, 0) * ${pages}::float8 / ${totalClicks}::float8
             ELSE 1 END
    FROM fz_page_keys k
    LEFT JOIN fz_clicks c ON c.page_key = k.page_key`);
  const weightResult = await tx.execute(sql`
    SELECT COALESCE(sum(weight), 0)::float8 AS total FROM fz_page_weights`);
  const weightRows = weightResult.rows as unknown as { total: number }[];
  await tx.execute(sql`ANALYZE fz_page_weights`);

  return { pages, totalWeight: Number(weightRows[0]?.total ?? 0), gscWeighted };
}

/** The weights of the pages a batch of issues names, looked up in SQL, never kept as a site map. */
async function batchWeights(tx: Tx, urls: Iterable<string>): Promise<Map<string, number>> {
  const keys = [...new Set(urls)];
  const weights = new Map<string, number>();
  for (let index = 0; index < keys.length; index += SCORE_BATCH) {
    const chunk = keys.slice(index, index + SCORE_BATCH);
    const { rows } = await tx.execute<{ page_key: string; weight: number }>(sql`
      SELECT page_key, weight FROM fz_page_weights
      WHERE page_key = ANY(ARRAY[${sql.join(
        chunk.map((key) => sql`${key}`),
        sql`, `,
      )}]::text[])`);
    for (const row of rows) weights.set(row.page_key, Number(row.weight));
  }
  return weights;
}

/**
 * The audit's score and its unchecked coverage, streamed: the open issues are read in keyset batches
 * and each batch's page weights are looked up in SQL, so memory is the batch size. An issue counts
 * only when it failed in this audit (a finding, `fz_latest`); the lifecycle has already resolved the
 * issues this audit judged and that passed, and everything still open is not re-checked here.
 */
export async function scoreOpenIssues(
  tx: Tx,
  ref: { workspaceId: string; siteId: string },
  window: ScoreWindow,
): Promise<{ result: ScoreResult; unchecked: number }> {
  const states = emptyCategoryStates();
  if (window.pages === 0) return { result: finalizeScore(states, 0, false), unchecked: 0 };
  const averageWeight = window.totalWeight / window.pages;
  let unchecked = 0;
  let after: string | null = null;

  for (;;) {
    // `fz_judged` is the lifecycle's decision table (store.ts): the issues this audit judged. An
    // issue missing from it was not re-checked, so it cannot penalise this audit's score.
    const issueBatch = await tx.execute(sql`
      SELECT i.id, i.category, i.severity, i.affected_pages, i.affected_urls,
             EXISTS (SELECT 1 FROM fz_judged j WHERE j.check_id = i.check_id AND j.subject_key = i.subject_key) AS judged,
             EXISTS (SELECT 1 FROM fz_latest f WHERE f.check_id = i.check_id AND f.subject_key = i.subject_key) AS failed
      FROM issues i
      WHERE i.workspace_id = ${ref.workspaceId} AND i.site_id = ${ref.siteId} AND i.state = 'open'
        AND (${after === null}::boolean OR i.id > ${after})
      ORDER BY i.id
      LIMIT ${SCORE_BATCH}`);
    const rows = issueBatch.rows as unknown as {
      id: string;
      category: CheckCategory;
      severity: Severity;
      affected_pages: number;
      affected_urls: string[] | null;
      judged: boolean;
      failed: boolean;
    }[];
    if (!rows.length) break;

    const failing = rows.filter((row) => row.failed);
    const named = failing.flatMap((row) => (row.affected_urls ?? []).map((url) => normalizePageUrl(url)));
    const weights = named.length ? await batchWeights(tx, named) : new Map<string, number>();

    for (const row of failing) {
      const urls = [...new Set((row.affected_urls ?? []).map((url) => normalizePageUrl(url)))].filter((url) => weights.has(url));
      const siteLevel = (row.affected_urls ?? []).length === 0;
      const affectedWeight = siteLevel
        ? window.totalWeight
        : urls.length
          ? urls.reduce((sum, url) => sum + (weights.get(url) ?? 0), 0)
          : Math.max(0, Number(row.affected_pages)) * averageWeight;
      addToCategory(
        states,
        { category: row.category, severity: row.severity, affectedPages: Number(row.affected_pages) },
        affectedWeight,
        window.totalWeight,
      );
    }
    // An open issue this audit did not judge is coverage the score cannot claim to have measured.
    unchecked += rows.filter((row) => !row.judged).length;

    if (rows.length < SCORE_BATCH) break;
    after = rows[rows.length - 1]?.id ?? null;
  }

  return { result: finalizeScore(states, window.pages, window.gscWeighted), unchecked };
}

/**
 * Each page's GSC clicks over the last 28 days of stored data, keyed by the normalised page key
 * (packages/search-data). Null when the site has no active Search Console connection or no page
 * aggregates: the score is then unweighted rather than guessed. The command surface reads this for
 * its per-issue click counts; finalize uses the streaming tables above instead.
 */
export async function loadPageClicks(tx: Tx, ref: { workspaceId: string; siteId: string }): Promise<Map<string, number> | null> {
  const { rows: connectionRows } = await tx.execute<{ property: string | null }>(sql`
    SELECT settings ->> 'property' AS property
    FROM connections
    WHERE workspace_id = ${ref.workspaceId} AND site_id = ${ref.siteId}
      AND connector = 'google-search-console' AND state = 'active'
    ORDER BY updated_at DESC
    LIMIT 1`);
  const property = connectionRows[0]?.property ?? null;
  if (!property) return null;
  const { rows } = await tx.execute<{ page_key: string; clicks: number }>(sql`
    WITH latest AS (
      SELECT max(date) AS last FROM gsc_page_aggregates
      WHERE workspace_id = ${ref.workspaceId} AND site_id = ${ref.siteId}
        AND property = ${property} AND search_type = 'web'
    )
    SELECT page_key, SUM(clicks)::float8 AS clicks
    FROM gsc_page_aggregates, latest
    WHERE workspace_id = ${ref.workspaceId} AND site_id = ${ref.siteId}
      AND property = ${property} AND search_type = 'web'
      AND latest.last IS NOT NULL AND date BETWEEN latest.last - 27 AND latest.last
    GROUP BY page_key`);
  if (!rows.length) return null;
  return new Map(rows.map((row) => [normalizePageUrl(row.page_key), Number(row.clicks)]));
}

/** The page keys the score and the click map agree on. */
export const scorePageKey = (url: string): string => normalizePageUrl(url);
