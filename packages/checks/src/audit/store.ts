import type { Coverage } from '@agentic-seo/crawl';
import { normalizeSection } from '@agentic-seo/crawl';
import { schema, type Tx } from '@agentic-seo/db';
import { sql } from 'drizzle-orm';
import { PAGE_CHECK_GATES, type PageGate } from './crawl-index';
import { findingId, issueId } from './ids';
import type { FindingDraft } from './types';

// Storage for findings and issues (migration 0009) and the coverage-aware issue lifecycle
// (crawler-and-audits.md §2 "Coverage", §5; design/DESIGN.md §4.2).
//
// A failing finding opens the issue or records that it was seen again. An open issue whose subject
// this audit *evaluated* and that did not fail is resolved; an open issue the audit did not evaluate
// (not crawled: scope, page limit, robots, error; check not applicable; graph truncated) is left
// untouched, which the commands read as "Not re-checked" by comparing last_checked_audit_id with
// the latest audit. Ignored issues stay ignored and still record the sighting.
//
// Evaluation lives in the finalize transaction's `fz_eval` table (crawl-index.ts), one row per
// (check, subject) the finalize checks judged, plus the page and site checks' `appliesTo` gates.
// `buildJudgedSubjects` folds both into `fz_judged`, one row per (check, subject) this audit judged:
// the lifecycle resolves from it and the health score counts its unchecked coverage from the same
// table, so the two can never disagree about whether a subject was evaluated. Resolution is one
// UPDATE ... FROM rather than a loop over every issue. Findings are only ever read in keyset batches
// of BATCH while the issues of an audit are opened; nothing here loads a whole audit into memory.

const BATCH = 500;

/** The site's sitemap-membership checks: resolution also accepts confirmed removal. */
const SITEMAP_CHECKS = ['sitemap.non_indexable_url', 'indexability.noindex_in_sitemap', 'crawl.orphan_page'] as const;

/** Stores the failing results of one page, replacing that snapshot's findings in this audit. */
export async function replacePageFindings(
  tx: Tx,
  ref: { workspaceId: string; siteId: string; auditId: string; sourceKey: string },
  drafts: readonly FindingDraft[],
): Promise<void> {
  // A retried chunk re-crawls the same snapshot. Its previous findings are replaced rather than
  // merged, so a check that now passes does not keep its old evidence, and a redirect whose
  // destination changed does not leave the old destination's findings behind. The key is the
  // snapshot (requested URL), not the final URL two different requests can share.
  await tx.execute(sql`
    DELETE FROM findings
    WHERE workspace_id = ${ref.workspaceId} AND audit_id = ${ref.auditId} AND source_key = ${ref.sourceKey}`);
  await insertFindings(tx, ref, drafts);
}

/** Upserts findings by their deterministic id: a retried hook rewrites the same rows. */
export async function insertFindings(
  tx: Tx,
  ref: { workspaceId: string; siteId: string; auditId: string },
  drafts: readonly FindingDraft[],
): Promise<void> {
  if (!drafts.length) return;
  const rows: (typeof schema.findings.$inferInsert)[] = drafts.map((draft) => ({
    workspaceId: ref.workspaceId,
    id: findingId(ref.auditId, draft.checkId, draft.sourceKey),
    siteId: ref.siteId,
    auditId: ref.auditId,
    checkId: draft.checkId,
    sourceKey: draft.sourceKey,
    subjectKey: draft.subjectKey,
    subject: draft.subject,
    severity: draft.severity,
    category: draft.category,
    evidence: draft.evidence,
    affectedUrls: draft.affectedUrls,
    affectedPages: draft.affectedPages,
  }));
  for (let index = 0; index < rows.length; index += BATCH) {
    const chunk = rows.slice(index, index + BATCH);
    await tx
      .insert(schema.findings)
      .values(chunk)
      .onConflictDoUpdate({
        target: [schema.findings.workspaceId, schema.findings.id],
        set: {
          subject: sql`excluded.subject`,
          severity: sql`excluded.severity`,
          category: sql`excluded.category`,
          evidence: sql`excluded.evidence`,
          affectedUrls: sql`excluded.affected_urls`,
          affectedPages: sql`excluded.affected_pages`,
        },
      });
  }
}

export interface IssueSyncResult {
  opened: number;
  seen: number;
  resolved: number;
}

/**
 * Opens or updates the issues of every finding this audit produced, then resolves the open issues
 * whose subject the audit evaluated and that did not fail.
 */
export async function syncIssues(
  tx: Tx,
  args: {
    workspaceId: string;
    siteId: string;
    auditId: string;
    pagesEvaluated: number;
    scope: Coverage['scope'];
    section: string | null;
    urls: readonly string[] | null;
    /** Whether every sitemap document was read completely (a removed URL is then confirmed). */
    sitemapComplete: boolean;
  },
): Promise<IssueSyncResult> {
  // One row per (check, subject) for this audit, materialised once. Both tables are RLS-protected:
  // a join between them would be re-executed for every outer row (the planner cannot move the
  // policy check out of the inner side), which made the seen-update quadratic in the audit size.
  await tx.execute(sql`
    CREATE TEMP TABLE IF NOT EXISTS fz_latest (
      check_id text NOT NULL,
      subject_key text NOT NULL,
      subject text NOT NULL,
      severity text NOT NULL,
      category text NOT NULL,
      evidence jsonb NOT NULL,
      affected_pages integer NOT NULL,
      affected_urls text[] NOT NULL,
      PRIMARY KEY (check_id, subject_key)
    ) ON COMMIT DROP`);
  await tx.execute(sql`TRUNCATE fz_latest`);
  await tx.execute(sql`
    INSERT INTO fz_latest (check_id, subject_key, subject, severity, category, evidence, affected_pages, affected_urls)
    SELECT DISTINCT ON (check_id, subject_key)
           check_id, subject_key, subject, severity, category, evidence, affected_pages, affected_urls
    FROM findings
    WHERE workspace_id = ${args.workspaceId} AND audit_id = ${args.auditId}
    ORDER BY check_id, subject_key, created_at DESC`);
  await tx.execute(sql`ANALYZE fz_latest`);
  await buildJudgedSubjects(tx, args);
  const opened = await openMissingIssues(tx, args);
  await updateSeenIssues(tx, args);
  await attachFindings(tx, args.workspaceId, args.siteId, args.auditId);
  const resolved = await resolveEvaluatedIssues(tx, args);
  const seen = Number(
    (
      await tx.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM findings WHERE workspace_id = ${args.workspaceId} AND audit_id = ${args.auditId}`)
    ).rows[0]?.n ?? 0,
  );
  return { opened, seen, resolved };
}

type FindingForIssue = {
  check_id: string;
  subject_key: string;
  subject: string;
  severity: FindingDraft['severity'];
  category: FindingDraft['category'];
  evidence: FindingDraft['evidence'];
  affected_pages: number;
  affected_urls: string[] | null;
};

/** Inserts an issue for each subject that does not have one yet; returns how many were created. */
async function openMissingIssues(
  tx: Tx,
  args: { workspaceId: string; siteId: string; auditId: string; pagesEvaluated: number },
): Promise<number> {
  let opened = 0;
  let after: { checkId: string; subjectKey: string } | null = null;
  for (;;) {
    const { rows } = await tx.execute<FindingForIssue>(sql`
      SELECT check_id, subject_key, subject, severity, category, evidence, affected_pages, affected_urls
      FROM fz_latest
      WHERE ${after === null}::boolean
         OR (check_id, subject_key) > (${after?.checkId ?? ''}, ${after?.subjectKey ?? ''})
      ORDER BY check_id, subject_key
      LIMIT ${BATCH}`);
    if (!rows.length) break;
    const values: (typeof schema.issues.$inferInsert)[] = rows.map((finding) => ({
      workspaceId: args.workspaceId,
      id: issueId(args.siteId, finding.check_id, finding.subject_key),
      siteId: args.siteId,
      checkId: finding.check_id,
      subjectKey: finding.subject_key,
      subject: finding.subject,
      state: 'open',
      severity: finding.severity,
      category: finding.category,
      firstSeenAuditId: args.auditId,
      lastSeenAuditId: args.auditId,
      lastCheckedAuditId: args.auditId,
      evidence: finding.evidence,
      affectedPages: Math.max(1, Number(finding.affected_pages ?? 1)),
      affectedUrls: finding.affected_urls ?? [],
      evaluatedPages: args.pagesEvaluated,
    }));
    const inserted = await tx.insert(schema.issues).values(values).onConflictDoNothing().returning({ id: schema.issues.id });
    opened += inserted.length;
    if (rows.length < BATCH) break;
    const last = rows[rows.length - 1] as FindingForIssue;
    after = { checkId: last.check_id, subjectKey: last.subject_key };
  }
  return opened;
}

/**
 * Updates every issue that has a finding in this audit: state open (a resolved issue regresses and
 * counts it; an ignored issue stays ignored), last seen and last checked moved, severity, category,
 * evidence and page identity refreshed from the check. One statement, whatever the number of
 * findings.
 */
async function updateSeenIssues(
  tx: Tx,
  args: { workspaceId: string; siteId: string; auditId: string; pagesEvaluated: number },
): Promise<void> {
  await tx.execute(sql`
    UPDATE issues AS i SET
      state = CASE WHEN i.state = 'ignored' THEN 'ignored' ELSE 'open' END,
      regressed = i.regressed + CASE WHEN i.state = 'resolved' THEN 1 ELSE 0 END,
      last_regressed_at = CASE WHEN i.state = 'resolved' THEN now() ELSE i.last_regressed_at END,
      resolved_audit_id = CASE WHEN i.state = 'resolved' THEN NULL ELSE i.resolved_audit_id END,
      last_seen_audit_id = ${args.auditId},
      last_checked_audit_id = ${args.auditId},
      subject = f.subject,
      severity = f.severity,
      category = f.category,
      evidence = f.evidence,
      affected_pages = GREATEST(1, f.affected_pages),
      affected_urls = f.affected_urls,
      evaluated_pages = ${args.pagesEvaluated},
      updated_at = now()
    FROM fz_latest AS f
    WHERE i.workspace_id = ${args.workspaceId} AND i.site_id = ${args.siteId}
      AND i.check_id = f.check_id AND i.subject_key = f.subject_key`);
}

/** Points every finding of the audit at the issue it groups with. */
async function attachFindings(tx: Tx, workspaceId: string, siteId: string, auditId: string): Promise<void> {
  await tx.execute(sql`
    CREATE TEMP TABLE IF NOT EXISTS fz_issue_keys (
      check_id text NOT NULL,
      subject_key text NOT NULL,
      id text NOT NULL,
      PRIMARY KEY (check_id, subject_key)
    ) ON COMMIT DROP`);
  await tx.execute(sql`TRUNCATE fz_issue_keys`);
  await tx.execute(sql`
    INSERT INTO fz_issue_keys (check_id, subject_key, id)
    SELECT check_id, subject_key, id FROM issues
    WHERE workspace_id = ${workspaceId} AND site_id = ${siteId}`);
  await tx.execute(sql`ANALYZE fz_issue_keys`);
  await tx.execute(sql`
    UPDATE findings AS f SET issue_id = k.id
    FROM fz_issue_keys k
    WHERE f.workspace_id = ${workspaceId} AND f.audit_id = ${auditId} AND f.issue_id IS NULL
      AND f.check_id = k.check_id AND f.subject_key = k.subject_key`);
}

/** The subject scope a section/list/page audit may resolve in; a site audit resolves everywhere. */
function scopePredicate(args: { scope: Coverage['scope']; section: string | null; urls: readonly string[] | null }) {
  if (args.scope === 'site') return sql`TRUE`;
  const path = sql`regexp_replace(i.subject_key, '^[a-z]+://[^/]+', '')`;
  if (args.scope === 'section') {
    const prefix = normalizeSection(args.section ?? '/');
    if (prefix === '/') return sql`TRUE`;
    return sql`(${path} = ${prefix} OR ${path} LIKE ${`${prefix}/%`})`;
  }
  const urls = args.urls ?? [];
  return sql`i.subject_key = ANY(ARRAY[${sql.join(
    urls.map((url) => sql`${url}`),
    sql`, `,
  )}]::text[])`;
}

/** The SQL column predicate for a page check's `appliesTo` gate (see PAGE_CHECK_GATES). */
const GATE_PREDICATES: Record<PageGate, ReturnType<typeof sql>> = {
  none: sql`TRUE`,
  ok_html: sql`p.ok_html`,
  title: sql`p.ok_html AND p.has_title`,
  description: sql`p.ok_html AND p.has_description`,
  hreflang: sql`p.ok_html AND p.has_hreflang`,
  canonical: sql`p.ok_html AND p.has_canonical`,
  indexable: sql`p.indexable`,
  indexable_not_home: sql`p.indexable AND NOT p.home`,
  https: sql`p.ok_html AND p.is_https`,
};

/** One group per (subject column, gate): a page-check gate resolves its checks in one UPDATE. */
function pageGateGroups(): { subject: 'url' | 'final_url'; gate: PageGate; checkIds: string[] }[] {
  const groups = new Map<string, { subject: 'url' | 'final_url'; gate: PageGate; checkIds: string[] }>();
  for (const [checkId, entry] of Object.entries(PAGE_CHECK_GATES)) {
    const key = `${entry.subject}\u0000${entry.gate}`;
    const group = groups.get(key) ?? { subject: entry.subject, gate: entry.gate, checkIds: [] };
    group.checkIds.push(checkId);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Materialises the (check, subject) pairs this audit judged *among the site's open issues* into
 * `fz_judged`: the one source of truth the lifecycle resolves from and the score counts from.
 * Both readers only ever ask about open issues, so the table stays as small as the issue list
 * rather than as large as the crawl times the catalogue.
 *
 * - A finalize or site check recorded the subjects it judged in `fz_eval` (crawl-index.ts), which
 *   already excludes a canonical or hreflang whose target was not readable, an unfetched sitemap
 *   URL, and graph checks on a truncated graph.
 * - A page check judged a subject when the page is in this audit and its `appliesTo` gate still
 *   holds, which is the same gate map the resolution used before: one row group per (subject
 *   column, gate), so the insertion is a handful of set operations whatever the crawl size.
 */
async function buildJudgedSubjects(tx: Tx, args: { workspaceId: string; siteId: string }): Promise<void> {
  await tx.execute(sql`
    CREATE TEMP TABLE IF NOT EXISTS fz_judged (
      check_id text NOT NULL,
      subject_key text NOT NULL,
      PRIMARY KEY (check_id, subject_key)
    ) ON COMMIT DROP`);
  await tx.execute(sql`TRUNCATE fz_judged`);
  await tx.execute(sql`
    INSERT INTO fz_judged (check_id, subject_key)
    SELECT e.check_id, e.subject_key
    FROM fz_eval e
    JOIN issues i ON i.check_id = e.check_id AND i.subject_key = e.subject_key
    WHERE i.workspace_id = ${args.workspaceId} AND i.site_id = ${args.siteId} AND i.state = 'open'
    ON CONFLICT DO NOTHING`);
  for (const group of pageGateGroups()) {
    const subjectColumn = group.subject === 'url' ? sql`p.url` : sql`p.final_url`;
    await tx.execute(sql`
      INSERT INTO fz_judged (check_id, subject_key)
      SELECT i.check_id, i.subject_key
      FROM issues i
      JOIN fz_pages p ON ${subjectColumn} = i.subject_key
      WHERE i.workspace_id = ${args.workspaceId} AND i.site_id = ${args.siteId} AND i.state = 'open'
        AND i.check_id = ANY(ARRAY[${sql.join(
          group.checkIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::text[])
        AND (${GATE_PREDICATES[group.gate]})
      ON CONFLICT DO NOTHING`);
  }
  await tx.execute(sql`ANALYZE fz_judged`);
}

/**
 * Resolves the open issues whose subject this audit evaluated and that did not fail.
 *
 * Evaluation is per check and subject, and `fz_judged` is its single definition (built above): the
 * finalize checks recorded the subjects they could actually judge, and page and site checks appear
 * through their `appliesTo` gate, so the lifecycle never claims a pass for a subject a check could
 * not run on. The health score reads the same table for its unchecked coverage.
 *
 * A sitemap-membership issue additionally resolves on confirmed removal: the audit read every
 * sitemap completely and the URL is no longer listed. A URL that is still listed but was not
 * evaluated (page limit, robots, error) stays open, "Not re-checked".
 *
 * Section, list and page audits only resolve issues inside their own scope, so a section crawl
 * never claims that the rest of the site still passes.
 */
async function resolveEvaluatedIssues(
  tx: Tx,
  args: {
    workspaceId: string;
    siteId: string;
    auditId: string;
    scope: Coverage['scope'];
    section: string | null;
    urls: readonly string[] | null;
    sitemapComplete: boolean;
  },
): Promise<number> {
  let resolved = 0;
  const scope = scopePredicate(args);
  const resolve = async (criterion: ReturnType<typeof sql>): Promise<void> => {
    const statement = sql`
      UPDATE issues AS i SET state = 'resolved', resolved_audit_id = ${args.auditId},
                            last_checked_audit_id = ${args.auditId}, updated_at = now()
      WHERE i.workspace_id = ${args.workspaceId} AND i.site_id = ${args.siteId} AND i.state = 'open'
        AND NOT EXISTS (
          SELECT 1 FROM fz_latest f
          WHERE f.check_id = i.check_id AND f.subject_key = i.subject_key)
        AND (${criterion})
        AND (${scope})`;
    const { rowCount } = await tx.execute(statement);
    resolved += rowCount ?? 0;
  };

  await resolve(sql`EXISTS (SELECT 1 FROM fz_judged j WHERE j.check_id = i.check_id AND j.subject_key = i.subject_key)`);

  // Confirmed removal: the audit read every sitemap completely and the URL is no longer listed.
  if (args.sitemapComplete) {
    const sitemapChecks = sql.join(
      SITEMAP_CHECKS.map((id) => sql`${id}`),
      sql`, `,
    );
    await resolve(sql`i.check_id IN (${sitemapChecks})
        AND NOT EXISTS (SELECT 1 FROM fz_sitemap_urls s WHERE s.url = i.subject_key)`);
  }

  return resolved;
}
