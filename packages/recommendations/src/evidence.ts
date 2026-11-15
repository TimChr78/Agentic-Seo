import { schema, type Tx } from '@agentic-seo/db';
import { addDays, pageMatchKeys, today as searchConsoleToday } from '@agentic-seo/search-data';
import { and, eq, sql } from 'drizzle-orm';

// Evidence is what a recommendation rests on (domain-model.md §4): an issue, a finding, a page with
// Search Console data, or an audit. The schema requires at least one item; this module is what makes
// the ids true. It runs at create/update and again before a run creates its drafts, inside the
// workspace transaction, so an id from another site or another workspace is refused with a sentence
// a person can act on rather than a foreign-key error or, worse, a row nobody notices.
//
// A `search_fact` names a page URL rather than a row id: Search Console facts are aggregates keyed by
// (property, date, page), and the page is the thing a recommendation is about (see 0008's schema).

export type EvidenceKind = 'issue' | 'finding' | 'search_fact' | 'audit';

export interface EvidenceItem {
  kind: EvidenceKind;
  id: string;
  note: string;
}

export interface SearchFactSummary {
  url: string;
  /** Clicks over the 28 days ending at the newest day of data; null when the page has no rows. */
  clicks: number | null;
  impressions: number | null;
  /** Average position over the same window, one decimal; null without rows. */
  position: number | null;
  dataThrough: string | null;
}

export interface ResolvedEvidence {
  item: EvidenceItem;
  /** The pages this evidence puts in play, for the reach estimate. */
  urls: string[];
  issue?: {
    id: string;
    checkId: string;
    subject: string;
    severity: string;
    category: string;
    state: string;
    affectedPages: number;
    evaluatedPages: number;
    affectedUrls: string[];
  };
  finding?: {
    id: string;
    auditId: string;
    checkId: string;
    subject: string;
    severity: string;
    category: string;
    affectedPages: number;
    affectedUrls: string[];
    evidence: unknown;
  };
  audit?: { id: string; finishedAt: string | null; pagesCrawled: number; score: number | null };
  searchFact?: SearchFactSummary;
}

export interface EvidenceProblem {
  index: number;
  id: string;
  problem: string;
}

export type EvidenceResolution = { ok: true; items: ResolvedEvidence[] } | { ok: false; problems: EvidenceProblem[] };

const WINDOW_DAYS = 28;

const isUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

/** The 28-day summary of one page's Search Console rows, or nulls when it has none. */
async function searchFactOf(tx: Tx, workspaceId: string, siteId: string, url: string, now: Date): Promise<SearchFactSummary> {
  const keys = pageMatchKeys([url]);
  const today = searchConsoleToday(now);
  const { rows } = await tx.execute<{ clicks: string; impressions: string; position: string | null; latest: string | null; n: string }>(sql`
    SELECT COALESCE(SUM(clicks), 0)::text AS clicks,
           COALESCE(SUM(impressions), 0)::text AS impressions,
           (CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) / SUM(impressions) ELSE NULL END)::text AS position,
           max(date)::text AS latest,
           count(*)::text AS n
      FROM gsc_page_aggregates
     WHERE workspace_id = ${workspaceId}
       AND site_id = ${siteId}
       AND page_key = ANY(ARRAY[${sql.join(
         keys.map((key) => sql`${key}`),
         sql`, `,
       )}]::text[])
       AND date BETWEEN ${addDays(today, -(WINDOW_DAYS - 1))} AND ${today}`);
  const row = rows[0];
  if (!row || Number(row.n) === 0) return { url, clicks: null, impressions: null, position: null, dataThrough: null };
  return {
    url,
    clicks: Number(row.clicks),
    impressions: Number(row.impressions),
    position: row.position === null ? null : Math.round(Number(row.position) * 10) / 10,
    dataThrough: row.latest,
  };
}

/**
 * Resolves every evidence item against this workspace and site. All items are checked even after one
 * fails, so a caller sees every problem at once instead of fixing them one at a time.
 */
export async function resolveEvidence(
  tx: Tx,
  input: { workspaceId: string; siteId: string; items: readonly EvidenceItem[]; now?: Date },
): Promise<EvidenceResolution> {
  const now = input.now ?? new Date();
  const resolved: ResolvedEvidence[] = [];
  const problems: EvidenceProblem[] = [];
  for (const [index, item] of input.items.entries()) {
    if (item.kind === 'issue') {
      const [row] = await tx
        .select()
        .from(schema.issues)
        .where(
          and(eq(schema.issues.workspaceId, input.workspaceId), eq(schema.issues.siteId, input.siteId), eq(schema.issues.id, item.id)),
        );
      if (!row) {
        problems.push({
          index,
          id: item.id,
          problem: `issue ${item.id} does not exist for this site. An issue id comes from audits.issues; an id from another site or workspace cannot be evidence here`,
        });
        continue;
      }
      const urls = row.affectedUrls.length ? [...row.affectedUrls] : isUrl(row.subject) ? [row.subject] : [];
      resolved.push({
        item,
        urls,
        issue: {
          id: row.id,
          checkId: row.checkId,
          subject: row.subject,
          severity: row.severity,
          category: row.category,
          state: row.state,
          affectedPages: row.affectedPages,
          evaluatedPages: row.evaluatedPages,
          affectedUrls: [...row.affectedUrls],
        },
      });
      continue;
    }
    if (item.kind === 'finding') {
      const [row] = await tx
        .select()
        .from(schema.findings)
        .where(
          and(
            eq(schema.findings.workspaceId, input.workspaceId),
            eq(schema.findings.siteId, input.siteId),
            eq(schema.findings.id, item.id),
          ),
        );
      if (!row) {
        problems.push({
          index,
          id: item.id,
          problem: `finding ${item.id} does not exist for this site. A finding id comes from audits.findings`,
        });
        continue;
      }
      const urls = row.affectedUrls.length ? [...row.affectedUrls] : isUrl(row.subject) ? [row.subject] : [];
      resolved.push({
        item,
        urls,
        finding: {
          id: row.id,
          auditId: row.auditId,
          checkId: row.checkId,
          subject: row.subject,
          severity: row.severity,
          category: row.category,
          affectedPages: row.affectedPages,
          affectedUrls: [...row.affectedUrls],
          evidence: row.evidence,
        },
      });
      continue;
    }
    if (item.kind === 'audit') {
      const [row] = await tx
        .select()
        .from(schema.audits)
        .where(
          and(eq(schema.audits.workspaceId, input.workspaceId), eq(schema.audits.siteId, input.siteId), eq(schema.audits.id, item.id)),
        );
      if (!row) {
        problems.push({ index, id: item.id, problem: `audit ${item.id} does not exist for this site. An audit id comes from audits.list` });
        continue;
      }
      const [score] = await tx
        .select({ score: schema.auditScores.score })
        .from(schema.auditScores)
        .where(and(eq(schema.auditScores.workspaceId, input.workspaceId), eq(schema.auditScores.auditId, row.id)));
      resolved.push({
        item,
        // An audit is the whole site, not a page set: it never widens the reach estimate.
        urls: [],
        audit: {
          id: row.id,
          finishedAt: row.finishedAt?.toISOString() ?? null,
          pagesCrawled: row.pagesCrawled,
          score: score?.score ?? null,
        },
      });
      continue;
    }
    if (!isUrl(item.id)) {
      problems.push({
        index,
        id: item.id,
        problem: 'a search_fact evidence id must be the absolute URL of a page, e.g. https://example.com/pricing/',
      });
      continue;
    }
    const summary = await searchFactOf(tx, input.workspaceId, input.siteId, item.id, now);
    if (summary.clicks === null) {
      problems.push({
        index,
        id: item.id,
        problem: `page ${item.id} has no Search Console data for this site in the last ${WINDOW_DAYS} days, so it cannot be search_fact evidence`,
      });
      continue;
    }
    resolved.push({ item, urls: [item.id], searchFact: summary });
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, items: resolved };
}

/** The distinct pages the evidence puts in play, for `estimateReach`. */
export const pagesOf = (items: readonly ResolvedEvidence[]): string[] => [...new Set(items.flatMap((item) => item.urls))];

/** A one-line problem list for an error message or a dropped run item. */
export const problemsText = (problems: readonly EvidenceProblem[]): string =>
  problems.map((problem) => `${problem.id}: ${problem.problem}`).join('; ');
