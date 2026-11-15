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
// - Only issues this audit judged are in the denominator: an issue that failed here, or whose pages
//   this audit evaluated and passed. An open issue on a page the audit never crawled is excluded
//   and reported as `unchecked_issues` on `audit_scores`, so a clean one-page audit with an old issue
//   elsewhere scores 100 rather than penalising a page it did not read.
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

/**
 * The score of one audit. `pages` holds the evaluated page keys (normalised like `page_key`);
 * `clicks` is each page's GSC clicks over the last 28 days, or null when the site has no Search
 * Console data. A page with average clicks then weighs twice a page with none.
 */
export function computeScore(input: {
  issues: readonly ScoreIssue[];
  pages: readonly string[];
  clicks: ReadonlyMap<string, number> | null;
}): ScoreResult {
  const pages = [...new Set(input.pages)];
  if (pages.length === 0) {
    return {
      score: null,
      reason: 'No page was evaluated: the audit stored no 200 HTML response, so there is nothing to score.',
      categories: [],
      pagesEvaluated: 0,
      gscWeighted: false,
    };
  }

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

  const byCategory = new Map<CheckCategory, { remaining: number; issues: number; affectedPages: number }>();
  for (const category of Object.keys(CATEGORY_WEIGHTS) as CheckCategory[])
    byCategory.set(category, { remaining: 1, issues: 0, affectedPages: 0 });

  for (const issue of input.issues) {
    const state = byCategory.get(issue.category);
    if (!state) continue;
    const urls = [...new Set(issue.affectedUrls.map(normalizePageUrl).filter((url) => weightByPage.has(url)))];
    // A site-level issue has no page identity: it affects the whole evaluated site. A page issue
    // weighs exactly the pages it names that this audit evaluated; only when none of them is in the
    // evaluated set does its affected-page count stand in (one unevaluated URL, a 404 target).
    const affectedWeight = issue.siteLevel
      ? totalWeight
      : urls.length
        ? urls.reduce((sum, url) => sum + (weightByPage.get(url) ?? 1), 0)
        : Math.max(0, issue.affectedPages) * averageWeight;
    const share = Math.min(1, Math.max(0, affectedWeight / totalWeight));
    state.remaining *= 1 - SEVERITY_FACTORS[issue.severity] * share;
    state.issues += 1;
    state.affectedPages += Math.max(1, issue.affectedPages);
  }

  const categories: CategoryScore[] = [];
  let reduction = 0;
  for (const [category, state] of byCategory) {
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
    pagesEvaluated: pages.length,
    gscWeighted,
  };
}

/**
 * Each page's GSC clicks over the last 28 days of stored data, keyed by the normalised page key
 * (packages/search-data). Null when the site has no active Search Console connection or no page
 * aggregates: the score is then unweighted rather than guessed.
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
