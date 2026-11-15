import type { ReachEstimate } from '@agentic-seo/commands';
import { schema, type Tx } from '@agentic-seo/db';
import { findLiveConnection, GSC_CONNECTOR_ID } from '@agentic-seo/integrations';
import { and, eq, sql } from 'drizzle-orm';
import { addDays, daysBetween, today as searchConsoleToday } from './dates';
import { homePageOf, pageMatchKeys } from './urls';

// Reach: the traffic at risk of one action (agents-and-autonomy.md §3). The policy engine's type
// lives in packages/commands; this is the Phase 1 estimate over page aggregates. It is exported,
// not yet wired into change-set approvals (a later task does that), so no caller changes.
//
// `known` needs both an active Search Console connection and page aggregates newer than four days.
// Anything else is `unknown` with a reason a person can act on; unknown reach always needs a
// person, it never merely drops a level.
//
// URLs are matched on `page_key`, the normalised column the sync writes, so the value the caller
// names and the value Google returned go through one function: "/", "/a/" and "/a", and "/a?x=1"
// and "/a/?x=1", are the pages a person means.
//
// Last year's window starts 364 days back, so its weekdays line up with this year's and a weekend
// is not compared with a midweek.

const WINDOW_DAYS = 28;
const LAST_YEAR_OFFSET = 364;
const FRESH_DAYS = 4;

export interface ReachInput {
  workspaceId: string;
  siteId: string;
  /** The URLs a change touches; trailing-slash variants count as the same page. */
  urls: string[];
  now?: Date;
}

interface Sums {
  clicks: number;
  impressions: number;
  rows: number;
}

const unknown = (reason: string): ReachEstimate => ({ kind: 'unknown', reason });

/** The only search surface Phase 1 syncs; Phase 2 adds types without a rewrite. */
export const PHASE1_SEARCH_TYPE = 'web';

/**
 * Where a site's Search Console numbers come from: the live connection's selected property and the
 * web search type. Every reader that sums `gsc_page_aggregates` (reach, recommendation evidence and
 * the facts payload) goes through this, so two properties a person connected over the years are
 * never added together. `reason` is written for a person and names what to do next.
 */
export type GscScope = { ok: true; property: string; searchType: string } | { ok: false; reason: string };

export async function gscScopeOf(tx: Tx, workspaceId: string, siteId: string): Promise<GscScope> {
  // The live connection, never the revoked history beside it: after a disconnect and a reconnect the
  // estimate must read the replacement, not the first row the planner happens to return.
  const connection = await findLiveConnection(tx, workspaceId, siteId, GSC_CONNECTOR_ID);
  if (!connection) return { ok: false, reason: 'Search Console is not connected for this site' };
  if (connection.state !== 'active')
    return {
      ok: false,
      reason: `Search Console needs to be reconnected for this site${connection.lastError ? `: ${connection.lastError}` : ''}`,
    };
  const property = connection.settings.property;
  if (typeof property !== 'string' || !property) return { ok: false, reason: 'No Search Console property is selected for this site' };
  return { ok: true, property, searchType: PHASE1_SEARCH_TYPE };
}

export async function estimateReach(tx: Tx, input: ReachInput): Promise<ReachEstimate> {
  const now = input.now ?? new Date();
  const today = searchConsoleToday(now);

  const [site] = await tx
    .select({ domain: schema.sites.primaryDomain })
    .from(schema.sites)
    .where(and(eq(schema.sites.workspaceId, input.workspaceId), eq(schema.sites.id, input.siteId)));
  if (!site) return unknown('This site does not exist in this workspace, so its traffic at risk cannot be estimated.');

  const scope = await gscScopeOf(tx, input.workspaceId, input.siteId);
  if (!scope.ok) return unknown(scope.reason);
  const { property } = scope;

  const [latest] = await tx
    .select({ date: sql<string | null>`max(${schema.gscPageAggregates.date})::text` })
    .from(schema.gscPageAggregates)
    .where(
      and(
        eq(schema.gscPageAggregates.workspaceId, input.workspaceId),
        eq(schema.gscPageAggregates.siteId, input.siteId),
        eq(schema.gscPageAggregates.property, property),
        eq(schema.gscPageAggregates.searchType, scope.searchType),
      ),
    );
  const latestDate = latest?.date ?? null;
  if (!latestDate) return unknown('Search Console page data has not been synced for this site yet');
  if (latestDate < addDays(today, -FRESH_DAYS)) {
    const age = daysBetween(latestDate, today);
    return unknown(`Search Console data is ${age} ${age === 1 ? 'day' : 'days'} old`);
  }

  const keys = pageMatchKeys(input.urls);
  if (!keys.length)
    return {
      kind: 'known',
      affectedUrls: 0,
      clicksAtRisk: 0,
      impressionsAtRisk: 0,
      clicksAtRiskLastYear: 0,
      impressionsAtRiskLastYear: 0,
      criticalPages: [homePageOf(site.domain)],
      dataThrough: latestDate,
    };

  const sums = async (start: string, end: string): Promise<Sums> => {
    const result = await tx.execute<{ clicks: string; impressions: string; rows: string }>(sql`
      SELECT
        COALESCE(SUM(clicks), 0)::text AS clicks,
        COALESCE(SUM(impressions), 0)::text AS impressions,
        COUNT(*)::text AS rows
      FROM gsc_page_aggregates
      WHERE workspace_id = ${input.workspaceId}
        AND site_id = ${input.siteId}
        AND property = ${property}
        AND search_type = ${scope.searchType}
        AND page_key = ANY(ARRAY[${sql.join(
          keys.map((key) => sql`${key}`),
          sql`, `,
        )}]::text[])
        AND date BETWEEN ${start} AND ${end}`);
    const row = result.rows[0];
    return { clicks: Number(row?.clicks ?? 0), impressions: Number(row?.impressions ?? 0), rows: Number(row?.rows ?? 0) };
  };

  const currentStart = addDays(today, -(WINDOW_DAYS - 1));
  const current = await sums(currentStart, today);
  const lastYearStart = addDays(currentStart, -LAST_YEAR_OFFSET);
  const lastYear = await sums(lastYearStart, addDays(today, -LAST_YEAR_OFFSET));

  return {
    kind: 'known',
    affectedUrls: keys.length,
    // Null means the page has no search history at all; zero is a real, measured zero.
    clicksAtRisk: current.rows ? current.clicks : null,
    impressionsAtRisk: current.rows ? current.impressions : null,
    clicksAtRiskLastYear: lastYear.rows ? lastYear.clicks : null,
    impressionsAtRiskLastYear: lastYear.rows ? lastYear.impressions : null,
    criticalPages: [homePageOf(site.domain)],
    dataThrough: latestDate,
  };
}
