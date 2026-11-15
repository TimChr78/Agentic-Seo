import { findGitHubConnection, githubSettings } from '@agentic-seo/change-sets';
import { CHANGE_TYPES, EDITOR_CAPABILITIES, type SiteMapping } from '@agentic-seo/changes';
import { checkById } from '@agentic-seo/checks';
import { schema, type Tx } from '@agentic-seo/db';
import { addDays, gscScopeOf, pageMatchKeys, today as searchConsoleToday } from '@agentic-seo/search-data';
import { logger } from '@agentic-seo/telemetry';
import { and, eq, sql } from 'drizzle-orm';

// The facts a run reasons over (agents-and-autonomy.md §5, "full audit run"). Everything here comes
// from a table or the check catalogue — never from a model — and the payload is bounded so a site
// with thousands of issues cannot blow the prompt or the budget. `MAX_FACTS_CHARS` is the cap the
// run enforces (about 6,000 tokens at ~4 characters per token); issues are dropped worst-last until
// the payload fits, and the drop is visible in `truncated`.
//
// The numbers in this payload are also the only numbers a recommendation may state: the validator
// compares every figure in the rationale and the expected-impact summary with `metricNumbers`, which
// is built from the same semantic fields. Ids are deliberately not part of that set — a hash
// contains digits, and an invented metric must not pass by matching one.

const WINDOW_DAYS = 28;
const LAST_YEAR_OFFSET = 364;

/** How much of the payload one run may send to a model. */
export const MAX_FACTS_CHARS = 24_000;
/** The most issues one payload carries, worst first. */
export const MAX_FACTS_ISSUES = 40;
/** Evidence samples per issue. */
const MAX_SAMPLES = 3;
/** Page URLs per issue in the payload. */
const MAX_URLS_PER_ISSUE = 5;

export type ChangeSupport = 'mapping' | 'manual';

export interface FactIssue {
  id: string;
  checkId: string;
  checkTitle: string;
  severity: string;
  category: string;
  state: string;
  affectedPages: number;
  evaluatedPages: number;
  /** GSC clicks over 28 days for the issue's pages; null without a connected property. */
  clicks28d: number | null;
  /** The change type the catalogue says fixes it, when one does. */
  fixChange: string | null;
  urls: string[];
  samples: { value: string | null; expected: string | null; detail: string | null; subject: string | null }[];
}

export interface FactsPayload {
  site: { name: string; domain: string; businessType: string | null; local: boolean };
  searchConsole: { connected: boolean; dataThrough: string | null };
  audit: {
    id: string;
    finishedAt: string | null;
    pagesCrawled: number;
    pagesEvaluated: number;
    score: number | null;
    notEvaluated: { category: string; reason: string }[];
  } | null;
  counts: { openIssues: number; issuesInPayload: number; openRecommendations: number; pagesEvaluated: number };
  issues: FactIssue[];
  /** Which Phase 1 change types this site's connector can apply, and how. */
  changeSupport: { connector: string | null; types: { type: string; support: ChangeSupport }[] };
  /** Recommendations already open for the site, so a run does not restate them. */
  existing: { id: string; title: string; status: string }[];
  periods: { windowDays: number; lastYearOffsetDays: number };
  limits: { maxRecommendations: number };
  truncated: boolean;
}

/** The site's latest completed audit, or the one the caller named. */
async function auditFor(tx: Tx, workspaceId: string, siteId: string, auditId?: string) {
  const [audit] = await tx
    .select()
    .from(schema.audits)
    .where(
      auditId
        ? and(eq(schema.audits.workspaceId, workspaceId), eq(schema.audits.siteId, siteId), eq(schema.audits.id, auditId))
        : and(eq(schema.audits.workspaceId, workspaceId), eq(schema.audits.siteId, siteId), eq(schema.audits.state, 'completed')),
    )
    .orderBy(sql`${schema.audits.finishedAt} DESC NULLS LAST`, sql`${schema.audits.createdAt} DESC`)
    .limit(1);
  if (!audit) return null;
  const [score] = await tx
    .select({
      score: schema.auditScores.score,
      pagesEvaluated: schema.auditScores.pagesEvaluated,
      notEvaluated: schema.auditScores.notEvaluated,
    })
    .from(schema.auditScores)
    .where(and(eq(schema.auditScores.workspaceId, workspaceId), eq(schema.auditScores.auditId, audit.id)));
  return { audit, score };
}

/** Clicks over 28 days per normalised page key, for the issues' pages only. */
async function clicksByPage(
  tx: Tx,
  input: { workspaceId: string; siteId: string; property: string; searchType: string },
  urls: string[],
  now: Date,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!urls.length) return out;
  const today = searchConsoleToday(now);
  const keys = pageMatchKeys(urls);
  if (!keys.length) return out;
  const { rows } = await tx.execute<{ page_key: string; clicks: string }>(sql`
    SELECT page_key, COALESCE(SUM(clicks), 0)::text AS clicks
      FROM gsc_page_aggregates
     WHERE workspace_id = ${input.workspaceId}
       AND site_id = ${input.siteId}
       AND property = ${input.property}
       AND search_type = ${input.searchType}
       AND page_key = ANY(ARRAY[${sql.join(
         keys.map((key) => sql`${key}`),
         sql`, `,
       )}]::text[])
       AND date BETWEEN ${addDays(today, -(WINDOW_DAYS - 1))} AND ${today}
     GROUP BY page_key`);
  for (const row of rows) out.set(row.page_key, Number(row.clicks));
  return out;
}

/** The change types a GitHub mapping supports, or every Phase 1 type as a manual edit. */
async function changeSupportFor(tx: Tx, workspaceId: string, siteId: string): Promise<FactsPayload['changeSupport']> {
  const row = await findGitHubConnection(tx, workspaceId, siteId);
  const settings = row ? githubSettings.safeParse(row.settings) : null;
  if (!row || !settings?.success) return { connector: null, types: CHANGE_TYPES.map((type) => ({ type, support: 'manual' as const })) };
  const mapping: SiteMapping = settings.data.mapping;
  const supported = new Set<string>();
  for (const rule of mapping.rules) for (const type of EDITOR_CAPABILITIES[rule.editor]) supported.add(type);
  if (mapping.redirects) supported.add('redirect');
  return {
    connector: 'github',
    types: CHANGE_TYPES.map((type) => ({ type, support: supported.has(type) ? ('mapping' as const) : ('manual' as const) })),
  };
}

/** The recommendations already open for the site, so the strategist can dedupe against them. */
async function openRecommendations(tx: Tx, workspaceId: string, siteId: string, limit = 20) {
  const { rows } = await tx.execute<{ id: string; name: string; state: string; published: boolean }>(sql`
    SELECT a.id, a.name, v.state, a.published_version IS NOT NULL AS published
      FROM artifacts a
      JOIN artifact_versions v ON v.workspace_id = a.workspace_id AND v.artifact_id = a.id AND v.number = a.latest_version
     WHERE a.workspace_id = ${workspaceId}
       AND a.site_id = ${siteId}
       AND a.type = 'recommendation'
       AND a.archived = false
       AND v.state IN ('draft', 'in_review', 'published')
     ORDER BY a.updated_at DESC
     LIMIT ${limit}`);
  return rows.map((row) => ({ id: row.id, title: row.name, status: row.published ? 'accepted' : 'proposed' }));
}

/** One issue's evidence samples, from the capped evidence the audit stored. */
function samplesOf(evidence: unknown): FactIssue['samples'] {
  const items = (evidence as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_SAMPLES).flatMap((raw) => {
    if (typeof raw !== 'object' || raw === null) return [];
    const item = raw as Record<string, unknown>;
    const text = (key: string) => (typeof item[key] === 'string' ? (item[key] as string).slice(0, 200) : null);
    return [{ value: text('value'), expected: text('expected'), detail: text('detail'), subject: text('subject') ?? text('sourceUrl') }];
  });
}

export interface GatherFactsInput {
  workspaceId: string;
  siteId: string;
  /** The audit to read; when absent, the latest completed one. */
  auditId?: string;
  maxRecommendations: number;
  now?: Date;
}

/**
 * Builds the bounded facts payload. Reads only: no crawl, no provider call, no model. The cap is
 * applied by dropping issues from the end of the worst-first list, so the payload keeps what a
 * strategist needs most when a site has more issues than fit.
 */
export async function gatherFacts(tx: Tx, input: GatherFactsInput): Promise<FactsPayload> {
  const now = input.now ?? new Date();
  const [site] = await tx
    .select({
      name: schema.sites.name,
      domain: schema.sites.primaryDomain,
      businessType: schema.sites.businessType,
      local: schema.sites.isLocalBusiness,
    })
    .from(schema.sites)
    .where(and(eq(schema.sites.workspaceId, input.workspaceId), eq(schema.sites.id, input.siteId)));
  const found = await auditFor(tx, input.workspaceId, input.siteId, input.auditId);
  // The live connection's selected property and search type: the same scope reach and evidence use,
  // so a property the site was moved off never inflates the numbers a model reasons over.
  const scope = await gscScopeOf(tx, input.workspaceId, input.siteId);
  const connected = scope.ok;

  let dataThrough: string | null = null;
  if (scope.ok) {
    const [latest] = await tx
      .select({ date: sql<string | null>`max(${schema.gscPageAggregates.date})::text` })
      .from(schema.gscPageAggregates)
      .where(
        and(
          eq(schema.gscPageAggregates.workspaceId, input.workspaceId),
          eq(schema.gscPageAggregates.siteId, input.siteId),
          eq(schema.gscPageAggregates.property, scope.property),
          eq(schema.gscPageAggregates.searchType, scope.searchType),
        ),
      );
    dataThrough = latest?.date ?? null;
  }

  const issueRows = await tx
    .select()
    .from(schema.issues)
    .where(and(eq(schema.issues.workspaceId, input.workspaceId), eq(schema.issues.siteId, input.siteId), eq(schema.issues.state, 'open')))
    .orderBy(
      sql`CASE ${schema.issues.severity} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`,
      sql`${schema.issues.affectedPages} DESC`,
      schema.issues.id,
    )
    .limit(MAX_FACTS_ISSUES);

  const allUrls = issueRows.flatMap((row) => (row.affectedUrls.length ? row.affectedUrls : [row.subject]));
  const clicks = scope.ok
    ? await clicksByPage(
        tx,
        { workspaceId: input.workspaceId, siteId: input.siteId, property: scope.property, searchType: scope.searchType },
        allUrls,
        now,
      )
    : new Map<string, number>();

  const issues: FactIssue[] = issueRows.map((row) => {
    const urls = (row.affectedUrls.length ? row.affectedUrls : [row.subject]).filter((url) => /^https?:\/\//.test(url));
    const check = checkById(row.checkId);
    let issueClicks: number | null = null;
    if (connected && urls.length) {
      issueClicks = 0;
      let measured = false;
      for (const key of pageMatchKeys(urls)) {
        const value = clicks.get(key);
        if (value !== undefined) {
          issueClicks += value;
          measured = true;
        }
      }
      if (!measured) issueClicks = null;
    }
    return {
      id: row.id,
      checkId: row.checkId,
      checkTitle: check?.title ?? row.checkId,
      severity: row.severity,
      category: row.category,
      state: row.state,
      affectedPages: row.affectedPages,
      evaluatedPages: row.evaluatedPages,
      clicks28d: issueClicks,
      fixChange: check?.fix?.change ?? null,
      urls: urls.slice(0, MAX_URLS_PER_ISSUE),
      samples: samplesOf(row.evidence),
    };
  });

  const [counts] = (
    await tx.execute<{ open: string }>(sql`
      SELECT count(*)::text AS open FROM issues
       WHERE workspace_id = ${input.workspaceId} AND site_id = ${input.siteId} AND state = 'open'`)
  ).rows;

  const facts: FactsPayload = {
    site: {
      name: site?.name ?? 'This site',
      domain: site?.domain ?? '',
      businessType: site?.businessType ?? null,
      local: site?.local ?? false,
    },
    searchConsole: { connected, dataThrough },
    audit: found
      ? {
          id: found.audit.id,
          finishedAt: found.audit.finishedAt?.toISOString() ?? null,
          pagesCrawled: found.audit.pagesCrawled,
          pagesEvaluated: found.score?.pagesEvaluated ?? 0,
          score: found.score?.score ?? null,
          notEvaluated: (found.score?.notEvaluated ?? []).slice(0, 10),
        }
      : null,
    counts: {
      openIssues: Number(counts?.open ?? 0),
      issuesInPayload: issues.length,
      openRecommendations: 0,
      pagesEvaluated: found?.score?.pagesEvaluated ?? 0,
    },
    issues,
    changeSupport: await changeSupportFor(tx, input.workspaceId, input.siteId),
    existing: await openRecommendations(tx, input.workspaceId, input.siteId),
    periods: { windowDays: WINDOW_DAYS, lastYearOffsetDays: LAST_YEAR_OFFSET },
    limits: { maxRecommendations: input.maxRecommendations },
    truncated: false,
  };
  facts.counts.openRecommendations = facts.existing.length;
  facts.counts.issuesInPayload = facts.issues.length;

  // Bound the payload by dropping the weakest issues; the counts stay honest about the total. The
  // cap measures `factsText` — the exact string the model receives, escaping included — so the
  // transmitted payload can never exceed it.
  while (facts.issues.length > 0 && factsText(facts).length > MAX_FACTS_CHARS) {
    facts.issues.pop();
    facts.truncated = true;
  }
  if (facts.truncated) {
    facts.counts.issuesInPayload = facts.issues.length;
    logger.info(
      { siteId: input.siteId, sent: facts.issues.length, open: facts.counts.openIssues },
      'recommendation facts truncated to the payload cap',
    );
  }
  return facts;
}

/**
 * The numbers a recommendation may state, as strings: the counts, page totals, click figures and
 * periods the payload carries. Ids, URLs and hashes are excluded on purpose — digits inside them
 * would let an invented metric through.
 */
export function metricNumbers(facts: FactsPayload): Set<string> {
  const numbers = new Set<string>();
  const add = (value: number | null | undefined) => {
    if (typeof value === 'number' && Number.isFinite(value)) numbers.add(String(Math.trunc(value)));
  };
  add(facts.periods.windowDays);
  add(facts.periods.lastYearOffsetDays);
  add(facts.limits.maxRecommendations);
  add(facts.counts.openIssues);
  add(facts.counts.issuesInPayload);
  add(facts.counts.openRecommendations);
  add(facts.counts.pagesEvaluated);
  if (facts.audit) {
    add(facts.audit.pagesCrawled);
    add(facts.audit.pagesEvaluated);
    add(facts.audit.score);
  }
  for (const issue of facts.issues) {
    add(issue.affectedPages);
    add(issue.evaluatedPages);
    add(issue.clicks28d);
  }
  return numbers;
}

/**
 * Escapes the three characters that could close one of the prompt's XML-style delimiters or open
 * another: page titles, issue evidence samples and check names are attacker-controlled text, and a
 * `</facts><task>…` inside one must reach the model as data, not as markup. `factsText` is the exact
 * string a call receives, so the cap measures what is sent.
 */
export const escapeDelimiters = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A stable, model-readable rendering of the payload: what the two calls actually receive, escaped.
 * The cap in `gatherFacts` measures this string, never a shorter serialisation of the same facts.
 */
export const factsText = (facts: FactsPayload): string => escapeDelimiters(JSON.stringify(facts, null, 2));
