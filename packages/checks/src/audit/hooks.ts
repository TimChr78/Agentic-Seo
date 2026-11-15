import { type AuditHooks, registerAuditHooks, siteHostsOf } from '@agentic-seo/crawl';
import { schema, type Tx } from '@agentic-seo/db';
import { and, eq } from 'drizzle-orm';
import { checks, failedResults, runPageChecks, runSiteChecks } from '../catalogue';
import type { CheckResult, SiteCheck } from '../check';
import { PAGE_CHECK_GATES, recordSiteCheckEvaluations } from './crawl-index';
import { runFinalizeChecks } from './finalize';
import { NOT_EVALUATED_CATEGORIES, prepareScoreTables, type ScoreResult, scoreOpenIssues } from './score';
import { insertFindings, replacePageFindings, syncIssues } from './store';
import type { FindingDraft } from './types';

// The crawl's audit hooks (packages/crawl/src/hooks.ts) implemented by the check catalogue:
//
// - `onPage` runs the page checks over one crawled page and stores a finding per failure, inside the
//   chunk's transaction. Findings are keyed by the snapshot (requested URL) so a retry is idempotent
//   and two requests that end at one final URL do not overwrite each other's findings.
// - `onFinalize` runs the site checks and the sixteen finalize checks (SQL, bounded memory), updates
//   the issue lifecycle and computes the health score, inside the transaction that completes the
//   audit and before the link edges are dropped (the lock order is the crawler's: the audit row is
//   already locked).
//
// Both are idempotent. The finalize step reads the audit row it is finalizing, so it must not take
// the audit lock again (it already holds it); every other statement is a set-based read or write.

/** The pages a site check's failure names, for the issue's display count. */
function affectedUrlsOf(evidence: readonly { subject?: string; sourceUrl?: string }[]): string[] {
  const urls = new Set<string>();
  for (const item of evidence) {
    for (const candidate of [item.subject, item.sourceUrl]) {
      if (candidate && (candidate.startsWith('http://') || candidate.startsWith('https://'))) urls.add(candidate);
    }
  }
  return [...urls];
}

/**
 * The issue identity of a page finding: the requested URL for checks about the request (status,
 * redirects, the scheme), the final URL for checks about the document. The snapshot is always the
 * replacement key, so a redirecting URL and its destination keep separate findings.
 */
function pageSubjectKey(checkId: string, page: { url: string; finalUrl: string }): string {
  return PAGE_CHECK_GATES[checkId]?.subject === 'url' ? page.url : page.finalUrl;
}

function pageDrafts(page: { url: string; finalUrl: string }, results: readonly CheckResult[]): FindingDraft[] {
  return failedResults(results).map((result) => {
    const subjectKey = pageSubjectKey(result.checkId, page);
    return {
      checkId: result.checkId,
      category: result.category,
      severity: result.severity,
      sourceKey: page.url,
      subjectKey,
      subject: subjectKey,
      evidence: { items: result.evidence, total: result.total, truncated: result.truncated },
      affectedPages: 1,
      affectedUrls: [subjectKey],
    };
  });
}

/**
 * The site checks' failures: one issue per site and check, whose subject is the site's origin. A
 * site-level issue has no page identity (`affectedUrls` empty), so the score weights it as the
 * whole site rather than pretending its evidence names every affected page.
 */
function siteDrafts(origin: string, results: readonly CheckResult[]): FindingDraft[] {
  return failedResults(results).map((result) => ({
    checkId: result.checkId,
    category: result.category,
    severity: result.severity,
    sourceKey: origin,
    subjectKey: origin,
    subject: origin,
    evidence: { items: result.evidence, total: result.total, truncated: result.truncated },
    affectedPages: Math.max(1, affectedUrlsOf(result.evidence).length),
    affectedUrls: [],
  }));
}

/** Stores one audit's health score, replacing a previous computation for the same audit. */
async function storeScore(
  tx: Tx,
  ref: { workspaceId: string; siteId: string; auditId: string; pagesCrawled: number },
  value: ScoreResult,
  skipped: readonly { checkId: string; reason: string }[],
  uncheckedIssues: number,
): Promise<void> {
  const row = {
    workspaceId: ref.workspaceId,
    siteId: ref.siteId,
    auditId: ref.auditId,
    score: value.score,
    reason: value.reason,
    categories: value.categories,
    notEvaluated: [...NOT_EVALUATED_CATEGORIES],
    skippedChecks: [...skipped],
    pagesEvaluated: value.pagesEvaluated,
    pagesCrawled: ref.pagesCrawled,
    uncheckedIssues,
    gscWeighted: value.gscWeighted,
    computedAt: new Date(),
  };
  await tx
    .insert(schema.auditScores)
    .values(row)
    .onConflictDoUpdate({
      target: [schema.auditScores.workspaceId, schema.auditScores.auditId],
      set: {
        score: row.score,
        reason: row.reason,
        categories: row.categories,
        notEvaluated: row.notEvaluated,
        skippedChecks: row.skippedChecks,
        pagesEvaluated: row.pagesEvaluated,
        pagesCrawled: row.pagesCrawled,
        uncheckedIssues: row.uncheckedIssues,
        gscWeighted: row.gscWeighted,
        computedAt: row.computedAt,
      },
    });
}

export function checkAuditHooks(): AuditHooks {
  return {
    async onPage(tx, audit, page) {
      const results = runPageChecks(page);
      await replacePageFindings(
        tx,
        { workspaceId: audit.workspaceId, siteId: audit.siteId, auditId: audit.auditId, sourceKey: page.url },
        pageDrafts(page, results),
      );
    },

    async onFinalize(tx, audit) {
      const [auditRow] = await tx
        .select({
          scope: schema.audits.scope,
          section: schema.audits.section,
          urls: schema.audits.urls,
          pagesCrawled: schema.audits.pagesCrawled,
        })
        .from(schema.audits)
        .where(and(eq(schema.audits.workspaceId, audit.workspaceId), eq(schema.audits.id, audit.auditId)));
      if (!auditRow) return;
      const [siteRow] = await tx
        .select({ primaryDomain: schema.sites.primaryDomain, hosts: schema.sites.hosts })
        .from(schema.sites)
        .where(and(eq(schema.sites.workspaceId, audit.workspaceId), eq(schema.sites.id, audit.siteId)));
      if (!siteRow) return;

      const hosts = siteHostsOf(siteRow);
      const finalize = await runFinalizeChecks(tx, {
        ref: audit,
        coverage: audit.coverage,
        site: audit.site,
        hosts,
        sitemapUrls: audit.site.sitemaps.map((sitemap) => sitemap.url),
      });

      // Site checks are one pure evaluation over the audit's site facts; the origin is their only
      // subject. A check whose `appliesTo` does not hold judged nothing, so it resolves nothing.
      await insertFindings(tx, audit, siteDrafts(audit.site.origin, runSiteChecks(audit.site)));
      const siteCheckIds =
        auditRow.scope === 'site'
          ? checks
              .filter((check): check is SiteCheck => check.evaluator === 'site')
              .filter((check) => check.appliesTo?.(audit.site) ?? true)
              .map((check) => check.id)
          : [];
      await recordSiteCheckEvaluations(tx, audit.site.origin, siteCheckIds);

      const sitemapComplete =
        audit.site.sitemaps.length > 0 &&
        audit.site.sitemapsTruncated !== true &&
        audit.site.sitemaps.every((sitemap) => sitemap.status === 200 && sitemap.errors.length === 0);

      await syncIssues(tx, {
        workspaceId: audit.workspaceId,
        siteId: audit.siteId,
        auditId: audit.auditId,
        pagesEvaluated: finalize.pagesEvaluated,
        scope: auditRow.scope,
        section: auditRow.section,
        urls: auditRow.urls,
        sitemapComplete,
      });

      // The score reads the lifecycle's judged table (`fz_judged`) and its findings (`fz_latest`),
      // both built above, so it counts exactly the issues this audit judged.
      const window = await prepareScoreTables(tx, audit);
      const { result, unchecked } = await scoreOpenIssues(tx, audit, window);
      await storeScore(tx, { ...audit, pagesCrawled: auditRow.pagesCrawled }, result, finalize.skipped, unchecked);
    },
  };
}

let registered: (() => void) | null = null;
let registerCount = 0;

/**
 * Registers the check catalogue's audit hooks. The server calls this once at startup (app.ts), and a
 * test calls it to exercise the crawl end to end; registering twice is a no-op so a test that
 * reuses one module instance cannot run the hooks twice. The returned function unregisters them.
 */
export function registerCheckAuditHooks(): () => void {
  registerCount += 1;
  if (registered === null) registered = registerAuditHooks(checkAuditHooks());
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    registerCount -= 1;
    if (registerCount === 0 && registered) {
      registered();
      registered = null;
    }
  };
}

/** Removes the check hooks even if several registrations are outstanding (tests that reset state). */
export function resetCheckAuditHooksForTests(): void {
  if (registered) registered();
  registered = null;
  registerCount = 0;
}
