import { type CommandContext, defineCommand } from '@agentic-seo/commands';
import { AppError } from '@agentic-seo/core';
import { schema } from '@agentic-seo/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { checkById } from '../catalogue';
import { checkCategories, type Severity, severities } from '../check';
import { ruleById } from '../rules';
import { loadPageClicks, scorePageKey } from './score';

// The issue, finding and score commands (crawler-and-audits.md §5–§6, design/DESIGN.md §4.2). They
// are what the Issues list, the issue detail and the audit overview read, and what an agent reads
// before it proposes a fix. `checks.ignore` and `checks.unignore` are the one pair of writes: an
// ignore is a judgement about the site's work queue, so it is a `settings` change with a required
// reason and it passes the policy engine like every other write.

const IssueId = z.string().min(1).max(64).describe('Issue id, e.g. iss_0192f3c2b4a1');
const SiteId = z.string().uuid().describe('Site id');
const SeveritySchema = z.enum(severities);
const CategorySchema = z.enum(checkCategories);
const StateSchema = z.enum(['open', 'resolved', 'ignored']);

/** Severity rank for sorting: critical first. */
const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

const EvidenceItemSchema = z.object({
  subject: z.string(),
  value: z.string().optional(),
  expected: z.string().optional(),
  selector: z.string().optional(),
  sourceUrl: z.string().optional(),
  detail: z.string().optional(),
});

const IgnoredSchema = z.object({ by: z.string(), reason: z.string(), at: z.string() }).nullable();

const IssueSchema = z.object({
  id: z.string(),
  checkId: z.string(),
  title: z.string(),
  category: CategorySchema,
  severity: SeveritySchema,
  /** What the issue is about: the page URL, or the site's origin for a site-level check. */
  subject: z.string(),
  state: StateSchema,
  /** Times the issue came back after an audit resolved it. */
  regressed: z.number().int(),
  lastRegressedAt: z.string().nullable(),
  /** Pages this issue covers, and the denominator of the audit that last checked it. */
  affectedPages: z.number().int(),
  evaluatedPages: z.number().int(),
  /** The true number of failing items in the latest evidence, before the evidence cap. */
  evidenceTotal: z.number().int(),
  evidenceTruncated: z.boolean(),
  /** GSC clicks over 28 days on the pages the evidence names; null when Search Console is not connected. */
  clicks28d: z.number().nullable(),
  firstSeenAuditId: z.string(),
  lastSeenAuditId: z.string(),
  lastCheckedAuditId: z.string(),
  resolvedAuditId: z.string().nullable(),
  ignored: IgnoredSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

const IssueDetailSchema = IssueSchema.extend({
  /** Up to 50 evidence items from the latest finding, the material a fix or a recommendation cites. */
  evidence: z.array(EvidenceItemSchema),
});

type IssueRow = typeof schema.issues.$inferSelect;

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

/** A raw issue row plus the page click map, mapped to the command's view. */
function issueView(row: IssueRow, clicks: ReadonlyMap<string, number> | null): z.output<typeof IssueSchema> {
  const evidence = row.evidence as { items?: z.input<typeof EvidenceItemSchema>[]; total?: number; truncated?: boolean };
  const urls = new Set<string>();
  // The issue's own pages, not its capped evidence: a group issue carries the whole group's
  // evidence, but the clicks shown are the ones its subject page earns.
  for (const candidate of row.affectedUrls) urls.add(scorePageKey(candidate));
  let clicks28d: number | null = null;
  if (clicks !== null) {
    clicks28d = 0;
    for (const url of urls) clicks28d += clicks.get(url) ?? 0;
  }
  return {
    id: row.id,
    checkId: row.checkId,
    title: checkById(row.checkId)?.title ?? row.checkId,
    category: row.category,
    severity: row.severity,
    subject: row.subject,
    state: row.state,
    regressed: row.regressed,
    lastRegressedAt: iso(row.lastRegressedAt),
    affectedPages: row.affectedPages,
    evaluatedPages: row.evaluatedPages,
    evidenceTotal: Number(evidence.total ?? 0),
    evidenceTruncated: evidence.truncated === true,
    clicks28d,
    firstSeenAuditId: row.firstSeenAuditId,
    lastSeenAuditId: row.lastSeenAuditId,
    lastCheckedAuditId: row.lastCheckedAuditId,
    resolvedAuditId: row.resolvedAuditId,
    ignored:
      row.state === 'ignored' && row.ignoredBy !== null && row.ignoredReason !== null && row.ignoredAt !== null
        ? { by: row.ignoredBy, reason: row.ignoredReason, at: row.ignoredAt.toISOString() }
        : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function evidenceItems(row: IssueRow): z.output<typeof EvidenceItemSchema>[] {
  const evidence = row.evidence as { items?: z.output<typeof EvidenceItemSchema>[] };
  return evidence.items ?? [];
}

/** A cursor over (severity rank, affected pages desc, id) for the site's issues. */
function encodeIssueCursor(row: IssueRow): string {
  return Buffer.from(JSON.stringify({ r: SEVERITY_ORDER[row.severity], a: row.affectedPages, i: row.id }), 'utf8').toString('base64url');
}

function decodeIssueCursor(cursor: string): { rank: number; affected: number; id: string } | null {
  if (cursor.length > 2_048) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { r?: unknown; a?: unknown; i?: unknown };
    if (typeof parsed.r !== 'number' || typeof parsed.a !== 'number' || typeof parsed.i !== 'string') return null;
    return { rank: parsed.r, affected: parsed.a, id: parsed.i };
  } catch {
    return null;
  }
}

async function loadIssue(ctx: CommandContext, issueId: string): Promise<IssueRow> {
  const [row] = await ctx.tx
    .select()
    .from(schema.issues)
    .where(and(eq(schema.issues.workspaceId, ctx.principal.workspaceId), eq(schema.issues.id, issueId)));
  if (!row)
    throw new AppError('not_found', `No issue has the id ${issueId} in this workspace. Run audits.issues to list the site's issues.`);
  return row;
}

const SEVERITY_RANK_SQL = sql`CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;

export const auditIssues = defineCommand({
  name: 'audits.issues',
  title: 'List site issues',
  description:
    'List a site’s issues, worst first: severity, then how many pages are affected. Each issue groups the findings of one check on one subject across audits, and carries its state (open, resolved, ignored), the pages affected over the pages the last audit evaluated, and the clicks over the last 28 days that its pages earn in Search Console (null without a connection). Filter by state, severity, category or check. Use audits.issue for one issue’s evidence, explanation and history. Read-only; no crawl, no provider call.',
  input: z.object({
    siteId: SiteId,
    state: StateSchema.optional().describe('Only issues in this state'),
    severity: SeveritySchema.optional().describe('Only issues with this severity'),
    category: CategorySchema.optional().describe('Only issues in this category'),
    checkId: z.string().min(1).max(100).optional().describe('Only issues of this check, e.g. title.missing'),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().max(2_048).optional().describe('Opaque `nextCursor` from the previous page; omit for the first page'),
  }),
  output: z.object({
    issues: z.array(IssueSchema),
    nextCursor: z.string().nullable().describe('Pass as `cursor` for the next page; null on the last page'),
    /** Honest counts for the site, whatever the filters: the list header the design asks for. */
    summary: z.object({ open: z.number().int(), resolved: z.number().int(), ignored: z.number().int(), total: z.number().int() }),
    hasGsc: z.boolean().describe('Whether a Search Console connection supplied the click weights'),
  }),
  permission: 'sites:read',
  effect: 'read',
  actionClass: 'read',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const cursor = input.cursor ? decodeIssueCursor(input.cursor) : undefined;
    if (input.cursor && !cursor) throw new AppError('invalid_input', 'The cursor is not valid. Omit it to start from the first page.');
    const filters = and(
      eq(schema.issues.workspaceId, ctx.principal.workspaceId),
      eq(schema.issues.siteId, input.siteId),
      input.state ? eq(schema.issues.state, input.state) : undefined,
      input.severity ? eq(schema.issues.severity, input.severity) : undefined,
      input.category ? eq(schema.issues.category, input.category) : undefined,
      input.checkId ? eq(schema.issues.checkId, input.checkId) : undefined,
      cursor
        ? sql`(${SEVERITY_RANK_SQL}, -issues.affected_pages, issues.id) > (${cursor.rank}, ${-cursor.affected}, ${cursor.id})`
        : undefined,
    );
    const rows = await ctx.tx
      .select()
      .from(schema.issues)
      .where(filters)
      .orderBy(SEVERITY_RANK_SQL, sql`${schema.issues.affectedPages} DESC`, schema.issues.id)
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const clicks = await loadPageClicks(ctx.tx, { workspaceId: ctx.principal.workspaceId, siteId: input.siteId });
    const { rows: summaryRows } = await ctx.tx.execute<{ state: string; n: string }>(sql`
      SELECT state, count(*)::text AS n FROM issues
      WHERE workspace_id = ${ctx.principal.workspaceId} AND site_id = ${input.siteId}
      GROUP BY state`);
    const summary = { open: 0, resolved: 0, ignored: 0, total: 0 };
    for (const row of summaryRows) {
      const count = Number(row.n);
      summary.total += count;
      if (row.state === 'open') summary.open = count;
      if (row.state === 'resolved') summary.resolved = count;
      if (row.state === 'ignored') summary.ignored = count;
    }
    const last = page.at(-1);
    return {
      issues: page.map((row) => issueView(row, clicks)),
      nextCursor: rows.length > input.limit && last ? encodeIssueCursor(last) : null,
      summary,
      hasGsc: clicks !== null,
    };
  },
});

export const auditIssue = defineCommand({
  name: 'audits.issue',
  title: 'Issue detail',
  description:
    'One issue in full: its definition (the catalogue check, why it matters, the fix type, official references and, for a cross-page check, the exact definition), the latest evidence item by item, the affected pages with what was found versus what was expected, its history across audits, and its ignore metadata. Use it before proposing a fix or writing a recommendation. Read-only; no crawl, no provider call.',
  input: z.object({ issueId: IssueId }),
  output: z.object({
    issue: IssueDetailSchema,
    check: z.object({
      id: z.string(),
      title: z.string(),
      category: CategorySchema,
      severity: SeveritySchema,
      scope: z.enum(['page', 'site', 'cross_page']),
      evaluator: z.enum(['page', 'site', 'finalize']),
      explain: z.string(),
      fix: z.object({ change: z.string() }).nullable(),
      references: z.array(z.string()),
      definition: z.string().nullable(),
      rules: z.array(z.object({ id: z.string(), statement: z.string(), source: z.string(), reviewedAt: z.string() })),
    }),
    /** Every audit that produced a finding for this issue, newest first. */
    history: z.array(
      z.object({
        auditId: z.string(),
        at: z.string(),
        evidenceTotal: z.number().int(),
        evidenceItems: z.number().int(),
      }),
    ),
    /** The pages the latest evidence names, the list the Pages tab shows. */
    pages: z.array(
      z.object({ url: z.string(), value: z.string().nullable(), expected: z.string().nullable(), detail: z.string().nullable() }),
    ),
  }),
  permission: 'sites:read',
  effect: 'read',
  actionClass: 'read',
  target: (input) => input.issueId,
  handler: async (input, ctx) => {
    const row = await loadIssue(ctx, input.issueId);
    const check = checkById(row.checkId);
    const clicks = await loadPageClicks(ctx.tx, { workspaceId: ctx.principal.workspaceId, siteId: row.siteId });
    const { rows: historyRows } = await ctx.tx.execute<{
      audit_id: string;
      created_at: Date | string;
      evidence: { total?: number; items?: unknown[] } | null;
    }>(sql`
      SELECT audit_id, created_at, evidence FROM findings
      WHERE workspace_id = ${ctx.principal.workspaceId} AND issue_id = ${row.id}
      ORDER BY created_at DESC
      LIMIT 50`);
    const items = evidenceItems(row);
    return {
      issue: { ...issueView(row, clicks), evidence: items },
      check: {
        id: row.checkId,
        title: check?.title ?? row.checkId,
        category: row.category,
        severity: row.severity,
        scope: check?.scope ?? 'page',
        evaluator: check?.evaluator ?? 'page',
        explain: check?.explain ?? 'This check is not in the catalogue any more, so its explanation is unavailable.',
        fix: check?.fix ? { change: check.fix.change } : null,
        references: [...(check?.references ?? [])],
        definition: check?.evaluator === 'finalize' ? check.definition : null,
        rules: (check?.rules ?? []).flatMap((id) => {
          const rule = ruleById.get(id);
          return rule ? [{ id: rule.id, statement: rule.statement, source: rule.source, reviewedAt: rule.reviewedAt }] : [];
        }),
      },
      history: historyRows.map((entry) => ({
        auditId: entry.audit_id,
        at: new Date(entry.created_at).toISOString(),
        evidenceTotal: Number(entry.evidence?.total ?? 0),
        evidenceItems: entry.evidence?.items?.length ?? 0,
      })),
      pages: items.map((item) => ({
        url: item.sourceUrl ?? item.subject,
        value: item.value ?? null,
        expected: item.expected ?? null,
        detail: item.detail ?? null,
      })),
    };
  },
});

/** A cursor over (subject, check id, finding id), the finding list's order. */
function encodeFindingCursor(row: typeof schema.findings.$inferSelect): string {
  return Buffer.from(JSON.stringify({ s: row.subject, c: row.checkId, i: row.id }), 'utf8').toString('base64url');
}

function decodeFindingCursor(cursor: string): { subject: string; checkId: string; id: string } | null {
  if (cursor.length > 4_096) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: unknown; c?: unknown; i?: unknown };
    if (typeof parsed.s !== 'string' || typeof parsed.c !== 'string' || typeof parsed.i !== 'string') return null;
    return { subject: parsed.s, checkId: parsed.c, id: parsed.i };
  } catch {
    return null;
  }
}

const FindingSchema = z.object({
  id: z.string(),
  auditId: z.string(),
  checkId: z.string(),
  title: z.string(),
  category: CategorySchema,
  severity: SeveritySchema,
  subject: z.string(),
  issueId: z.string().nullable(),
  evidenceTotal: z.number().int(),
  evidenceTruncated: z.boolean(),
  evidence: z.array(EvidenceItemSchema),
  createdAt: z.string(),
});

export const auditFindings = defineCommand({
  name: 'audits.findings',
  title: 'Audit findings',
  description:
    'The findings one audit produced, in subject order: one row per check failing on one subject, with its severity, category, capped evidence and the issue it belongs to. Filter by check, category or severity to see one problem’s evidence across pages. Findings are evidence and are never edited; the issue they group is what changes. Read-only; no crawl, no provider call.',
  input: z.object({
    auditId: z.string().min(1).max(64).describe('Audit id, e.g. adt_0192f3c2b4'),
    checkId: z.string().min(1).max(100).optional().describe('Only findings of this check'),
    category: CategorySchema.optional(),
    severity: SeveritySchema.optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().max(4_096).optional().describe('Opaque `nextCursor` from the previous page; omit for the first page'),
  }),
  output: z.object({
    findings: z.array(FindingSchema),
    nextCursor: z.string().nullable(),
  }),
  permission: 'sites:read',
  effect: 'read',
  actionClass: 'read',
  target: (input) => input.auditId,
  handler: async (input, ctx) => {
    const [audit] = await ctx.tx
      .select({ id: schema.audits.id })
      .from(schema.audits)
      .where(and(eq(schema.audits.workspaceId, ctx.principal.workspaceId), eq(schema.audits.id, input.auditId)));
    if (!audit) throw new AppError('not_found', `Audit ${input.auditId} does not exist in this workspace.`);
    const cursor = input.cursor ? decodeFindingCursor(input.cursor) : undefined;
    if (input.cursor && !cursor) throw new AppError('invalid_input', 'The cursor is not valid. Omit it to start from the first page.');
    const rows = await ctx.tx
      .select()
      .from(schema.findings)
      .where(
        and(
          eq(schema.findings.workspaceId, ctx.principal.workspaceId),
          eq(schema.findings.auditId, input.auditId),
          input.checkId ? eq(schema.findings.checkId, input.checkId) : undefined,
          input.category ? eq(schema.findings.category, input.category) : undefined,
          input.severity ? eq(schema.findings.severity, input.severity) : undefined,
          cursor
            ? sql`(${schema.findings.subject}, ${schema.findings.checkId}, ${schema.findings.id}) > (${cursor.subject}, ${cursor.checkId}, ${cursor.id})`
            : undefined,
        ),
      )
      .orderBy(schema.findings.subject, schema.findings.checkId, schema.findings.id)
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      findings: page.map((row) => {
        const evidence = row.evidence as { items?: z.output<typeof EvidenceItemSchema>[]; total?: number; truncated?: boolean };
        return {
          id: row.id,
          auditId: row.auditId,
          checkId: row.checkId,
          title: checkById(row.checkId)?.title ?? row.checkId,
          category: row.category,
          severity: row.severity,
          subject: row.subject,
          issueId: row.issueId,
          evidenceTotal: Number(evidence.total ?? 0),
          evidenceTruncated: evidence.truncated === true,
          evidence: evidence.items ?? [],
          createdAt: row.createdAt.toISOString(),
        };
      }),
      nextCursor: rows.length > input.limit && last ? encodeFindingCursor(last) : null,
    };
  },
});

export const auditScore = defineCommand({
  name: 'audits.score',
  title: 'Audit health score',
  description:
    'The health score of one audit, or of the site’s latest scored audit: 0–100, the per-category weights, penalties and contributions, the pages evaluated (the denominator), the open issues the audit could not judge (excluded from the score and reported as unchecked coverage), and the categories and checks that were not evaluated, with the reason each one was skipped. A null score with a reason means nothing could be evaluated. Use it for the audit overview and to compare audits; audits.issues says what to fix. Read-only; no crawl, no provider call.',
  input: z.object({
    siteId: SiteId,
    auditId: z.string().min(1).max(64).optional().describe('The audit to read; omit for the site’s latest scored audit'),
  }),
  output: z.object({
    auditId: z.string(),
    siteId: z.string(),
    state: z.enum(['queued', 'running', 'finalizing', 'completed', 'partial', 'failed', 'cancelled']),
    score: z.number().int().nullable().describe('0–100, or null when no page could be evaluated (see `reason`)'),
    reason: z.string().nullable(),
    categories: z.array(
      z.object({
        category: z.string(),
        weight: z.number(),
        penalty: z.number(),
        contribution: z.number(),
        issues: z.number().int(),
        affectedPages: z.number().int(),
      }),
    ),
    notEvaluated: z.array(z.object({ category: z.string(), reason: z.string() })),
    skippedChecks: z.array(z.object({ checkId: z.string(), reason: z.string() })),
    pagesEvaluated: z.number().int(),
    pagesCrawled: z.number().int(),
    uncheckedIssues: z
      .number()
      .int()
      .describe('Open issues the audit could not judge because their pages were outside it; excluded from the score'),
    gscWeighted: z.boolean().describe('Whether GSC clicks weighted the page shares'),
    computedAt: z.string(),
  }),
  permission: 'sites:read',
  effect: 'read',
  actionClass: 'read',
  target: (input) => input.auditId ?? input.siteId,
  handler: async (input, ctx) => {
    const where = input.auditId
      ? and(
          eq(schema.auditScores.workspaceId, ctx.principal.workspaceId),
          eq(schema.auditScores.siteId, input.siteId),
          eq(schema.auditScores.auditId, input.auditId),
        )
      : and(eq(schema.auditScores.workspaceId, ctx.principal.workspaceId), eq(schema.auditScores.siteId, input.siteId));
    const [row] = await ctx.tx
      .select({ score: schema.auditScores, state: schema.audits.state })
      .from(schema.auditScores)
      .innerJoin(
        schema.audits,
        and(eq(schema.audits.workspaceId, schema.auditScores.workspaceId), eq(schema.audits.id, schema.auditScores.auditId)),
      )
      .where(where)
      .orderBy(sql`${schema.auditScores.computedAt} DESC`)
      .limit(1);
    if (!row) {
      if (input.auditId) {
        const [audit] = await ctx.tx
          .select({ state: schema.audits.state })
          .from(schema.audits)
          .where(and(eq(schema.audits.workspaceId, ctx.principal.workspaceId), eq(schema.audits.id, input.auditId)));
        if (!audit) throw new AppError('not_found', `Audit ${input.auditId} does not exist in this workspace.`);
        throw new AppError(
          'precondition_failed',
          `Audit ${input.auditId} is ${audit.state}, so it has no score yet. The score is computed when the audit finalizes; follow it with audits.status.`,
        );
      }
      throw new AppError(
        'not_found',
        `Site ${input.siteId} has no scored audit yet. Run audits.run, then read the score once the audit has finished.`,
      );
    }
    return {
      auditId: row.score.auditId,
      siteId: row.score.siteId,
      state: row.state,
      score: row.score.score,
      reason: row.score.reason,
      categories: row.score.categories,
      notEvaluated: row.score.notEvaluated,
      skippedChecks: row.score.skippedChecks,
      pagesEvaluated: row.score.pagesEvaluated,
      pagesCrawled: row.score.pagesCrawled,
      uncheckedIssues: row.score.uncheckedIssues,
      gscWeighted: row.score.gscWeighted,
      computedAt: row.score.computedAt.toISOString(),
    };
  },
});

export const checksIgnore = defineCommand({
  name: 'checks.ignore',
  title: 'Ignore an issue',
  description:
    'Mark an issue as ignored, with a required reason of at least 10 characters. Ignored issues stay visible in audits.issues with state “ignored”, keep recording that they were seen, and are never resolved by a later audit: use it for a deliberate exception (a required noindex, a staging host). The reason is what a reviewer and a future agent read, so say why. A person with sites:write can call it; an agent’s call is judged by the policy engine, and a settings change needs a person. Undo with checks.unignore.',
  input: z.object({
    issueId: IssueId,
    reason: z
      .string()
      .trim()
      .min(10)
      .max(1_000)
      .describe('Why this issue is accepted rather than fixed, e.g. “The staging host is noindex on purpose”'),
  }),
  output: z.object({ issue: IssueSchema }),
  permission: 'sites:write',
  effect: 'write',
  actionClass: 'settings',
  target: (input) => input.issueId,
  handler: async (input, ctx) => {
    const existing = await loadIssue(ctx, input.issueId);
    const actor = ctx.principal.type === 'agent' ? ctx.principal.agent.id : ctx.principal.userId;
    const [updated] = await ctx.tx
      .update(schema.issues)
      .set({ state: 'ignored', ignoredBy: actor, ignoredReason: input.reason, ignoredAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.issues.workspaceId, existing.workspaceId), eq(schema.issues.id, existing.id)))
      .returning();
    if (!updated) throw new AppError('not_found', `No issue has the id ${input.issueId} in this workspace.`);
    const clicks = await loadPageClicks(ctx.tx, { workspaceId: ctx.principal.workspaceId, siteId: updated.siteId });
    return { issue: issueView(updated, clicks) };
  },
});

export const checksUnignore = defineCommand({
  name: 'checks.unignore',
  title: 'Unignore an issue',
  description:
    'Return an ignored issue to the open list, clearing the ignore reason and who set it. A later audit then treats it like any open issue: it can be resolved by a passing audit or regressed by a new failure. Use it when the exception no longer applies. A person with sites:write can call it; an agent’s call is judged by the policy engine.',
  input: z.object({ issueId: IssueId }),
  output: z.object({ issue: IssueSchema }),
  permission: 'sites:write',
  effect: 'write',
  actionClass: 'settings',
  target: (input) => input.issueId,
  handler: async (input, ctx) => {
    const existing = await loadIssue(ctx, input.issueId);
    if (existing.state !== 'ignored')
      throw new AppError('conflict', `Issue ${input.issueId} is ${existing.state}, not ignored, so there is nothing to undo.`);
    const [updated] = await ctx.tx
      .update(schema.issues)
      .set({ state: 'open', ignoredBy: null, ignoredReason: null, ignoredAt: null, updatedAt: new Date() })
      .where(and(eq(schema.issues.workspaceId, existing.workspaceId), eq(schema.issues.id, existing.id)))
      .returning();
    if (!updated) throw new AppError('not_found', `No issue has the id ${input.issueId} in this workspace.`);
    const clicks = await loadPageClicks(ctx.tx, { workspaceId: ctx.principal.workspaceId, siteId: updated.siteId });
    return { issue: issueView(updated, clicks) };
  },
});

export const auditIssueCommands = [auditIssues, auditIssue, auditFindings, auditScore, checksIgnore, checksUnignore] as const;
