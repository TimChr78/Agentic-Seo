import { AiUnavailable, modelFor } from '@agentic-seo/ai';
import {
  artifactTypes,
  assertActiveSite,
  author,
  type Recommendation,
  recommendationReachSchema,
  validateContent,
} from '@agentic-seo/artifacts';
import { checkById } from '@agentic-seo/checks';
import type { CommandContext } from '@agentic-seo/commands';
import { defineCommand } from '@agentic-seo/commands';
import { AppError, hashValue, newId } from '@agentic-seo/core';
import { schema, type Tx } from '@agentic-seo/db';
import { estimateReach } from '@agentic-seo/search-data';
import { and, count, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { dependencyProblems } from './dependencies';
import { enqueueRecommendationRun } from './enqueue';
import { type EvidenceItem, pagesOf, problemsText, type ResolvedEvidence, resolveEvidence } from './evidence';
import { specialistOfAgentName } from './specialists';
import { deriveStatus, linkedChangeSets, RECOMMENDATION_STATUSES, type RecommendationStatus, statusCaseSql, statusSql } from './status';

// The recommendation commands (agents-and-autonomy.md §2, domain-model.md §4). A recommendation is
// an artifact, so versioning, drafts, diffs, approval and publishing come from the artifact package;
// these commands are the doors that know what a recommendation means:
//
//   * evidence is resolved against this workspace and site, never taken on trust;
//   * the traffic at stake is computed from the evidence pages with `estimateReach` — the input has
//     no field for it, so a caller cannot supply a number;
//   * dependencies are checked for ids that exist on this site and for cycles;
//   * the status is derived from the artifact's lifecycle and the change sets that name it.

const RecommendationId = z
  .string()
  .regex(/^rcm_[0-9a-f]{32}$/, 'A recommendation id, e.g. from recommendations.list')
  .describe('The recommendation artifact id');
const SiteId = z.string().uuid().describe('The site the recommendation is about, e.g. from sites.list');

const EvidenceInput = z.object({
  kind: z.enum(['issue', 'finding', 'search_fact', 'audit']).describe('What kind of evidence this is'),
  id: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .describe('An issue id, a finding id, an audit id, or the absolute URL of a page with Search Console data'),
  note: z.string().trim().min(1).max(500).describe('What this evidence shows, in one line'),
});

const ProposedChange = z.object({
  type: z
    .enum(['meta.title', 'meta.description', 'schema.jsonld', 'image.alt', 'redirect'])
    .describe('A Phase 1 change type; the catalogue is the limit of what a change set can apply'),
  url: z.string().url().max(2048).describe('The page the change is about'),
  summary: z.string().trim().min(1).max(500).describe('The edit, in one line, for a reviewer'),
});

const VerificationPlan = z.object({
  recheck: z.string().trim().min(1).max(2000).describe('What to re-fetch or re-measure, and what it must show'),
  when: z.string().trim().min(1).max(500).describe('When, e.g. "28 days after the deploy"'),
});

/** The traffic at stake, with the schema the artifact content uses: exactly ReachEstimate. */
const ReachSummary = recommendationReachSchema;

const StatusEnum = z.enum(RECOMMENDATION_STATUSES);

const AuthorView = z.object({
  kind: z.enum(['person', 'agent', 'specialist']),
  specialist: z.enum(['strategist', 'technical']).nullable().describe('Which hosted specialist wrote it, when one did'),
});

const Suggestion = z.object({
  id: z.string(),
  title: z.string(),
  status: StatusEnum,
  author: AuthorView,
  effort: z.enum(['small', 'medium', 'large']),
  confidence: z.enum(['low', 'medium', 'high']),
  trafficAtStake: ReachSummary,
  priority: z.number().int().nullable().describe('A person’s order; lower sorts first, null when nobody set one'),
  dependsOn: z.array(z.string()),
  evidenceCount: z.number().int(),
  updatedAt: z.string(),
});

const DraftFields = {
  title: z.string().trim().min(1).max(200).describe('What to do, in one line'),
  rationale: z.string().trim().min(1).max(4000).describe('Why this, why now, in Markdown; only numbers the evidence carries'),
  evidence: z.array(EvidenceInput).min(1).max(20).describe('What the recommendation rests on; every id must exist for this site'),
  hypothesis: z.string().trim().min(1).max(2000).describe('If we do this, then that, because …'),
  expectedImpact: z.object({
    summary: z.string().trim().min(1).max(1000).describe('An estimate, e.g. "Expected: CTR +10–20% on 34 queries"'),
    confidence: z.enum(['low', 'medium', 'high']).describe('How sure we are, given the evidence'),
  }),
  effort: z.enum(['small', 'medium', 'large']).describe('How much work this is'),
  verificationPlan: VerificationPlan,
  falsificationCheck: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe('How we would know this failed; start with "We will know this failed if…"'),
  leadingIndicator: z.string().trim().min(1).max(500).describe('The earliest signal that it is working or not'),
} as const;

/**
 * The author of a recommendation created through a command: the principal, never a claim. The
 * hosted specialists are agent principals too; their agents rows carry the names the platform
 * created them with, which is what makes their drafts read as "the strategist wrote this".
 */
const authorOf = (ctx: CommandContext): Recommendation['author'] => {
  if (ctx.principal.type === 'user') return { kind: 'person' };
  const specialist = specialistOfAgentName(ctx.principal.agent.name);
  return specialist ? { kind: 'specialist', specialist } : { kind: 'agent' };
};

/** Refuses dependency ids that do not exist on this site, and any cycle the new edges would close. */
async function checkDependencies(
  tx: Tx,
  input: { workspaceId: string; siteId: string; recommendationId?: string; dependsOn: string[] },
): Promise<void> {
  const problems = await dependencyProblems(tx, input);
  if (problems.length) throw new AppError('invalid_input', problems.join(' '));
}

interface BuiltDraft {
  content: Recommendation;
  reach: Awaited<ReturnType<typeof estimateReach>>;
  resolved: ResolvedEvidence[];
}

/** Resolves the evidence, computes the reach and validates the content: the one drafting path. */
async function buildDraft(
  ctx: CommandContext,
  input: {
    siteId: string;
    evidence: EvidenceItem[];
    author: Recommendation['author'];
  } & Omit<Recommendation, 'evidence' | 'expectedImpact' | 'author' | 'dependsOn'> & {
      expectedImpact: Omit<Recommendation['expectedImpact'], 'trafficAtStake'>;
      dependsOn: string[];
    },
): Promise<BuiltDraft> {
  const workspaceId = ctx.principal.workspaceId;
  const resolution = await resolveEvidence(ctx.tx, { workspaceId, siteId: input.siteId, items: input.evidence });
  if (!resolution.ok)
    throw new AppError(
      'invalid_input',
      `The evidence is not valid for this site: ${problemsText(resolution.problems)}. Evidence ids come from audits.issues, audits.findings, audits.list or Search Console page data.`,
      { problems: resolution.problems },
    );
  const reach = await estimateReach(ctx.tx, { workspaceId, siteId: input.siteId, urls: pagesOf(resolution.items) });
  const content = {
    title: input.title,
    rationale: input.rationale,
    evidence: input.evidence.map((item) => ({ kind: item.kind, id: item.id, note: item.note })),
    hypothesis: input.hypothesis,
    expectedImpact: { summary: input.expectedImpact.summary, trafficAtStake: reach, confidence: input.expectedImpact.confidence },
    effort: input.effort,
    dependsOn: input.dependsOn,
    verificationPlan: input.verificationPlan,
    falsificationCheck: input.falsificationCheck,
    leadingIndicator: input.leadingIndicator,
    proposedChanges: input.proposedChanges,
    author: input.author,
  };
  const validated = (await validateContent('recommendation', content, 'draft')) as unknown as Recommendation;
  return { content: validated, reach, resolved: resolution.items };
}

const Row = z.object({
  id: z.string(),
  title: z.string(),
  status: StatusEnum,
  versionState: z.string(),
  latestVersion: z.number().int(),
  publishedVersion: z.number().int().nullable(),
  priority: z.number().int().nullable(),
  siteId: z.string(),
  content: z.unknown(),
  updatedAt: z.string(),
  ownerAgentId: z.string().nullable(),
  archived: z.boolean(),
});

/** One recommendation artifact with its latest version, the shared lookup of get/update/dependencies. */
async function loadRecommendation(ctx: CommandContext, recommendationId: string): Promise<z.output<typeof Row>> {
  const [row] = await ctx.tx
    .select({ artifact: schema.artifacts, version: schema.artifactVersions })
    .from(schema.artifacts)
    .innerJoin(
      schema.artifactVersions,
      and(
        eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
        eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        eq(schema.artifactVersions.number, schema.artifacts.latestVersion),
      ),
    )
    .where(and(eq(schema.artifacts.workspaceId, ctx.principal.workspaceId), eq(schema.artifacts.id, recommendationId)));
  if (!row) throw new AppError('not_found', `Recommendation ${recommendationId} does not exist in this workspace.`);
  if (row.artifact.type !== 'recommendation')
    throw new AppError('invalid_input', `${recommendationId} is a ${row.artifact.type}, not a recommendation.`);
  const parsed = artifactTypes.recommendation.content.safeParse(row.version.content);
  if (!parsed.success)
    throw new AppError(
      'conflict',
      `Recommendation ${recommendationId} has content that is not valid any more; read it with artifacts.get.`,
    );
  const [priority] = await ctx.tx
    .select({ priority: schema.recommendationPriorities.priority })
    .from(schema.recommendationPriorities)
    .where(eq(schema.recommendationPriorities.artifactId, recommendationId));
  return {
    id: row.artifact.id,
    title: row.artifact.name,
    status: 'proposed',
    versionState: row.version.state,
    latestVersion: row.artifact.latestVersion,
    publishedVersion: row.artifact.publishedVersion,
    priority: priority?.priority ?? null,
    siteId: row.artifact.siteId ?? '',
    content: parsed.data,
    updatedAt: row.artifact.updatedAt.toISOString(),
    ownerAgentId: row.artifact.ownerAgentId,
    archived: row.artifact.archived,
  };
}

/** The list query: filters and the count run before the cursor, so `total` is honest across pages. */
const listSql = (input: {
  workspaceId: string;
  siteId: string;
  filters: SQL[];
  cursor?: { priority: number | null; updatedAt: string; id: string };
  limit: number;
}): SQL => {
  const where = input.filters.length ? sql` AND ${sql.join(input.filters, sql` AND `)}` : sql``;
  const cursorWhere = input.cursor
    ? sql` WHERE (coalesce(priority, 2147483647) > ${input.cursor.priority ?? 2147483647}
        OR (coalesce(priority, 2147483647) = ${input.cursor.priority ?? 2147483647}
            AND (updated_at < ${input.cursor.updatedAt}::timestamptz
                 OR (updated_at = ${input.cursor.updatedAt}::timestamptz AND id < ${input.cursor.id}))))`
    : sql``;
  return sql`
    WITH filtered AS (
      SELECT a.id, a.name, a.updated_at, v.content, v.state AS version_state, p.priority,
             ${statusCaseSql} AS status
        FROM artifacts a
        JOIN artifact_versions v
          ON v.workspace_id = a.workspace_id AND v.artifact_id = a.id AND v.number = a.latest_version
        LEFT JOIN recommendation_priorities p
          ON p.workspace_id = a.workspace_id AND p.artifact_id = a.id
       WHERE a.workspace_id = ${input.workspaceId} AND a.site_id = ${input.siteId} AND a.type = 'recommendation'${where}
    ), counted AS (
      SELECT filtered.*, count(*) OVER ()::text AS total FROM filtered
    )
    SELECT * FROM counted${cursorWhere}
    ORDER BY coalesce(priority, 2147483647) ASC, updated_at DESC, id DESC
    LIMIT ${input.limit + 1}`;
};

type ListRow = {
  id: string;
  name: string;
  updated_at: Date | string;
  content: Recommendation;
  version_state: string;
  priority: number | null;
  status: RecommendationStatus;
  total: string;
};

const toSuggestion = (row: ListRow) => ({
  id: row.id,
  title: row.name,
  status: row.status,
  author: { kind: row.content.author?.kind ?? 'person', specialist: row.content.author?.specialist ?? null },
  effort: row.content.effort,
  confidence: row.content.expectedImpact.confidence,
  trafficAtStake: row.content.expectedImpact.trafficAtStake,
  priority: row.priority,
  dependsOn: row.content.dependsOn ?? [],
  evidenceCount: row.content.evidence?.length ?? 0,
  updatedAt: new Date(row.updated_at).toISOString(),
});

const encodeCursor = (row: { priority: number | null; updatedAt: string; id: string }): string =>
  Buffer.from(JSON.stringify({ p: row.priority, u: row.updatedAt, i: row.id }), 'utf8').toString('base64url');

function decodeCursor(cursor: string): { priority: number | null; updatedAt: string; id: string } | null {
  if (cursor.length > 1024) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { p?: unknown; u?: unknown; i?: unknown };
    if (typeof parsed.u !== 'string' || typeof parsed.i !== 'string') return null;
    if (parsed.p !== null && typeof parsed.p !== 'number') return null;
    return { priority: (parsed.p as number | null) ?? null, updatedAt: parsed.u, id: parsed.i };
  } catch {
    return null;
  }
}

export const listRecommendations = defineCommand({
  name: 'recommendations.list',
  title: 'List recommendations',
  description:
    'A site’s recommendations, ordered by a person’s priority and then newest first: title, status (proposed, accepted, implemented or rejected), author, effort, confidence and the traffic at stake. Filter by status, author, or the issue a recommendation addresses. Read-only; no model call.',
  input: z.object({
    siteId: SiteId,
    status: StatusEnum.optional().describe('Only recommendations in this status'),
    author: z
      .enum(['person', 'agent', 'specialist', 'strategist', 'technical'])
      .optional()
      .describe('Only this author: a person, an agent, any specialist, or one named specialist'),
    issueId: z.string().min(1).max(64).optional().describe('Only recommendations whose evidence includes this issue id'),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().max(1024).optional().describe('Opaque `nextCursor` from the previous page; omit for the first page'),
  }),
  output: z.object({
    recommendations: z.array(Suggestion),
    total: z.number().int().describe('All recommendations matching the filters, across every page'),
    nextCursor: z.string().nullable().describe('Pass as `cursor` for the next page; null on the last page'),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  actionClass: 'read',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    if (input.cursor && !cursor) throw new AppError('invalid_input', 'The cursor is not valid. Omit it to start from the first page.');
    const filters: SQL[] = [];
    if (input.status) filters.push(statusSql(input.status));
    if (input.author === 'person') filters.push(sql`v.content -> 'author' ->> 'kind' = 'person'`);
    if (input.author === 'agent') filters.push(sql`v.content -> 'author' ->> 'kind' = 'agent'`);
    if (input.author === 'specialist') filters.push(sql`v.content -> 'author' ->> 'kind' = 'specialist'`);
    if (input.author === 'strategist')
      filters.push(sql`v.content -> 'author' ->> 'kind' = 'specialist' AND v.content -> 'author' ->> 'specialist' = 'strategist'`);
    if (input.author === 'technical')
      filters.push(sql`v.content -> 'author' ->> 'kind' = 'specialist' AND v.content -> 'author' ->> 'specialist' = 'technical'`);
    if (input.issueId) filters.push(sql`v.content -> 'evidence' @> ${JSON.stringify([{ kind: 'issue', id: input.issueId }])}::jsonb`);

    const { rows } = await ctx.tx.execute<ListRow>(
      listSql({
        workspaceId: ctx.principal.workspaceId,
        siteId: input.siteId,
        filters,
        limit: input.limit,
        ...(cursor ? { cursor } : {}),
      }),
    );
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      recommendations: page.map(toSuggestion),
      total: rows[0] ? Number(rows[0].total) : 0,
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ priority: last.priority, updatedAt: new Date(last.updated_at).toISOString(), id: last.id })
          : null,
    };
  },
});

/** One evidence item with what it says, for the Evidence tab of the recommendation screen. */
const EvidenceView = z.object({
  kind: z.enum(['issue', 'finding', 'search_fact', 'audit']),
  id: z.string(),
  note: z.string(),
  issue: z
    .object({
      title: z.string(),
      severity: z.string(),
      category: z.string(),
      state: z.string(),
      affectedPages: z.number().int(),
      evaluatedPages: z.number().int(),
      affectedUrls: z.array(z.string()),
      fixChange: z.string().nullable(),
    })
    .optional(),
  finding: z
    .object({ auditId: z.string(), checkId: z.string(), subject: z.string(), severity: z.string(), affectedPages: z.number().int() })
    .optional(),
  searchFact: z
    .object({
      url: z.string(),
      clicks: z.number().int().nullable(),
      impressions: z.number().int().nullable(),
      position: z.number().nullable(),
      dataThrough: z.string().nullable(),
    })
    .optional(),
  audit: z.object({ finishedAt: z.string().nullable(), pagesCrawled: z.number().int(), score: z.number().int().nullable() }).optional(),
});

export const getRecommendation = defineCommand({
  name: 'recommendations.get',
  title: 'Get a recommendation',
  description:
    'One recommendation in full: its content (rationale, hypothesis, expected impact with the computed traffic at stake, effort, verification plan, falsification check, leading indicator, proposed changes), its evidence expanded with what each item says, the person’s priority, the change sets that implement it, and its derived status. Use it before approving, implementing or updating it. Read-only.',
  input: z.object({ recommendationId: RecommendationId }),
  output: z.object({
    id: z.string(),
    siteId: z.string(),
    title: z.string(),
    status: StatusEnum,
    latestVersion: z.number().int(),
    publishedVersion: z.number().int().nullable(),
    versionState: z.string(),
    priority: z.number().int().nullable(),
    ownerAgentId: z.string().nullable(),
    content: z.unknown().describe('The recommendation content; its schema is artifacts.types type=recommendation'),
    evidence: z.array(EvidenceView),
    changeSets: z.array(
      z.object({ id: z.string(), name: z.string(), state: z.string(), prUrl: z.string().nullable(), updatedAt: z.string() }),
    ),
    updatedAt: z.string(),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  actionClass: 'read',
  target: (input) => input.recommendationId,
  handler: async (input, ctx) => {
    const row = await loadRecommendation(ctx, input.recommendationId);
    const content = row.content as Recommendation;
    const changeSets = await linkedChangeSets(ctx.tx, {
      workspaceId: ctx.principal.workspaceId,
      siteId: row.siteId,
      recommendationId: row.id,
    });
    const evidence: z.output<typeof EvidenceView>[] = [];
    for (const item of content.evidence) {
      // One at a time so a finding removed with its audit still shows the item it was evidence for.
      const resolved = await resolveEvidence(ctx.tx, {
        workspaceId: ctx.principal.workspaceId,
        siteId: row.siteId,
        items: [{ kind: item.kind, id: item.id, note: item.note }],
      });
      const found = resolved.ok ? resolved.items[0] : undefined;
      const view: z.output<typeof EvidenceView> = { kind: item.kind, id: item.id, note: item.note };
      if (found?.issue) {
        const check = checkById(found.issue.checkId);
        evidence.push({
          ...view,
          issue: {
            title: check?.title ?? found.issue.checkId,
            severity: found.issue.severity,
            category: found.issue.category,
            state: found.issue.state,
            affectedPages: found.issue.affectedPages,
            evaluatedPages: found.issue.evaluatedPages,
            affectedUrls: found.issue.affectedUrls.slice(0, 20),
            fixChange: check?.fix?.change ?? null,
          },
        });
      } else if (found?.finding) {
        evidence.push({
          ...view,
          finding: {
            auditId: found.finding.auditId,
            checkId: found.finding.checkId,
            subject: found.finding.subject,
            severity: found.finding.severity,
            affectedPages: found.finding.affectedPages,
          },
        });
      } else if (found?.searchFact) {
        evidence.push({
          ...view,
          searchFact: {
            url: found.searchFact.url,
            clicks: found.searchFact.clicks,
            impressions: found.searchFact.impressions,
            position: found.searchFact.position,
            dataThrough: found.searchFact.dataThrough,
          },
        });
      } else if (found?.audit) {
        evidence.push({
          ...view,
          audit: { finishedAt: found.audit.finishedAt, pagesCrawled: found.audit.pagesCrawled, score: found.audit.score },
        });
      } else {
        evidence.push(view);
      }
    }
    return {
      id: row.id,
      siteId: row.siteId,
      title: row.title,
      status: deriveStatus({
        versionState: row.versionState,
        published: row.publishedVersion !== null,
        archived: row.archived,
        linked: changeSets,
      }),
      latestVersion: row.latestVersion,
      publishedVersion: row.publishedVersion,
      versionState: row.versionState,
      priority: row.priority,
      ownerAgentId: row.ownerAgentId,
      content,
      evidence,
      changeSets,
      updatedAt: row.updatedAt,
    };
  },
});

const DraftInput = {
  ...DraftFields,
  dependsOn: z.array(RecommendationId).max(20).default([]).describe('Recommendations that should land first; cycles are refused'),
  proposedChanges: z.array(ProposedChange).max(20).default([]).describe('The changes it implies, as a hint for whoever implements it'),
} as const;

export const createRecommendation = defineCommand({
  name: 'recommendations.create',
  title: 'Create a recommendation',
  description:
    'Creates a recommendation as a draft artifact (version 1): what to do, the evidence it rests on, the hypothesis, the expected impact, the effort, the verification plan, the falsification check and the leading indicator. Every evidence id must exist for this site, and the traffic at stake is computed here from the evidence pages (Search Console, 28 days) — you cannot supply that number. Dependencies must exist on the site and may not form a cycle. People and agents may call it; the author is the caller. Free.',
  input: z.object({
    siteId: SiteId,
    ...DraftInput,
    note: z.string().max(500).optional().describe('Why this draft was made, shown to reviewers'),
  }),
  output: z.object({
    recommendationId: z.string(),
    version: z.number().int(),
    state: z.literal('draft'),
    status: StatusEnum,
    trafficAtStake: ReachSummary,
    warnings: z.array(z.object({ path: z.string(), message: z.string() })),
  }),
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'draft',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const workspaceId = ctx.principal.workspaceId;
    await assertActiveSite(ctx.tx, workspaceId, input.siteId);
    await checkDependencies(ctx.tx, { workspaceId, siteId: input.siteId, dependsOn: input.dependsOn });
    const built = await buildDraft(ctx, {
      siteId: input.siteId,
      title: input.title,
      rationale: input.rationale,
      evidence: input.evidence,
      hypothesis: input.hypothesis,
      expectedImpact: input.expectedImpact,
      effort: input.effort,
      dependsOn: input.dependsOn,
      verificationPlan: input.verificationPlan,
      falsificationCheck: input.falsificationCheck,
      leadingIndicator: input.leadingIndicator,
      proposedChanges: input.proposedChanges,
      author: authorOf(ctx),
    });
    const id = newId(artifactTypes.recommendation.prefix);
    await ctx.tx.insert(schema.artifacts).values({
      workspaceId,
      id,
      type: 'recommendation',
      name: built.content.title,
      siteId: input.siteId,
      latestVersion: 1,
      ownerAgentId: ctx.principal.type === 'agent' ? (ctx.principal.agent?.id ?? null) : null,
    });
    await ctx.tx.insert(schema.artifactVersions).values({
      workspaceId,
      artifactId: id,
      number: 1,
      state: 'draft',
      content: built.content,
      contentHash: hashValue(built.content),
      note: input.note ?? null,
      ...author(ctx),
    });
    return {
      recommendationId: id,
      version: 1,
      state: 'draft' as const,
      status: 'proposed' as const,
      trafficAtStake: built.reach,
      warnings: [],
    };
  },
});

export const updateRecommendation = defineCommand({
  name: 'recommendations.update',
  title: 'Update a recommendation',
  description:
    'Replaces a recommendation’s content with a new draft version, re-validating its evidence, recomputing the traffic at stake and re-checking the dependency graph. Edits the current draft, or starts a new version when the latest one is published, in review or rejected. Pass `expectedContentHash` (from artifacts.get) to avoid overwriting someone else’s concurrent edit. Free.',
  input: z.object({
    recommendationId: RecommendationId,
    ...DraftInput,
    note: z.string().max(500).optional(),
    expectedContentHash: z.string().optional().describe('Content hash of the version you edited; the update fails if the draft changed'),
  }),
  output: z.object({
    recommendationId: z.string(),
    version: z.number().int(),
    state: z.literal('draft'),
    status: StatusEnum,
    trafficAtStake: ReachSummary,
    warnings: z.array(z.object({ path: z.string(), message: z.string() })),
  }),
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'draft',
  target: (input) => input.recommendationId,
  handler: async (input, ctx) => {
    const workspaceId = ctx.principal.workspaceId;
    const row = await loadRecommendation(ctx, input.recommendationId);
    const [locked] = await ctx.tx
      .select()
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.workspaceId, workspaceId), eq(schema.artifacts.id, row.id)))
      .for('update');
    if (!locked) throw new AppError('not_found', `Recommendation ${input.recommendationId} does not exist in this workspace.`);
    if (locked.archived) throw new AppError('conflict', 'This recommendation is archived, so it cannot be updated.');
    const [latest] = await ctx.tx
      .select()
      .from(schema.artifactVersions)
      .where(and(eq(schema.artifactVersions.artifactId, row.id), eq(schema.artifactVersions.number, locked.latestVersion)));
    if (!latest) throw new AppError('not_found', `Version ${locked.latestVersion} of ${row.id} does not exist.`);
    if (input.expectedContentHash && input.expectedContentHash !== latest.contentHash)
      throw new AppError(
        'precondition_failed',
        `Version ${latest.number} changed since you read it. Reload it with recommendations.get and apply your change again.`,
      );
    await checkDependencies(ctx.tx, {
      workspaceId,
      siteId: row.siteId,
      recommendationId: row.id,
      dependsOn: input.dependsOn,
    });
    const built = await buildDraft(ctx, {
      siteId: row.siteId,
      title: input.title,
      rationale: input.rationale,
      evidence: input.evidence,
      hypothesis: input.hypothesis,
      expectedImpact: input.expectedImpact,
      effort: input.effort,
      dependsOn: input.dependsOn,
      verificationPlan: input.verificationPlan,
      falsificationCheck: input.falsificationCheck,
      leadingIndicator: input.leadingIndicator,
      proposedChanges: input.proposedChanges,
      // An edit keeps who wrote the recommendation; only the version records the editor.
      author: (row.content as Recommendation).author,
    });
    const contentHash = hashValue(built.content);
    if (latest.state === 'draft') {
      await ctx.tx
        .update(schema.artifactVersions)
        .set({ content: built.content, contentHash, note: input.note ?? latest.note, updatedAt: new Date(), ...author(ctx) })
        .where(and(eq(schema.artifactVersions.artifactId, row.id), eq(schema.artifactVersions.number, latest.number)));
      await ctx.tx
        .update(schema.artifacts)
        .set({ name: built.content.title, updatedAt: new Date() })
        .where(and(eq(schema.artifacts.workspaceId, workspaceId), eq(schema.artifacts.id, row.id)));
      return {
        recommendationId: row.id,
        version: latest.number,
        state: 'draft' as const,
        status: 'proposed' as const,
        trafficAtStake: built.reach,
        warnings: [],
      };
    }
    const number = latest.number + 1;
    await ctx.tx.insert(schema.artifactVersions).values({
      workspaceId,
      artifactId: row.id,
      number,
      state: 'draft',
      content: built.content,
      contentHash,
      basedOn: latest.number,
      note: input.note ?? null,
      ...author(ctx),
    });
    await ctx.tx
      .update(schema.artifacts)
      .set({ latestVersion: number, name: built.content.title, updatedAt: new Date() })
      .where(and(eq(schema.artifacts.workspaceId, workspaceId), eq(schema.artifacts.id, row.id)));
    return {
      recommendationId: row.id,
      version: number,
      state: 'draft' as const,
      status: 'proposed' as const,
      trafficAtStake: built.reach,
      warnings: [],
    };
  },
});

export const prioritiseRecommendations = defineCommand({
  name: 'recommendations.prioritise',
  title: 'Set the order of recommendations',
  description:
    'Sets a person’s order over a site’s recommendations: the ids in the order they should be worked on, lowest priority first. Only people can; the order is not part of any version, so it does not create a draft. Recommendations left out of the list lose their priority and sort after the ordered ones. Free.',
  input: z.object({
    siteId: SiteId,
    order: z.array(RecommendationId).min(1).max(200).describe('Recommendation ids, most important first'),
  }),
  output: z.object({ siteId: z.string(), order: z.array(z.object({ id: z.string(), priority: z.number().int() })) }),
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'draft',
  humansOnly: true,
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const workspaceId = ctx.principal.workspaceId;
    await assertActiveSite(ctx.tx, workspaceId, input.siteId);
    const ordered = await ctx.tx
      .select({ id: schema.artifacts.id })
      .from(schema.artifacts)
      .where(
        and(
          eq(schema.artifacts.workspaceId, workspaceId),
          eq(schema.artifacts.type, 'recommendation'),
          eq(schema.artifacts.siteId, input.siteId),
        ),
      );
    const known = new Set(ordered.map((row) => row.id));
    const unknown = [...new Set(input.order)].filter((id) => !known.has(id));
    if (unknown.length)
      throw new AppError(
        'invalid_input',
        `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a recommendation' : 'are not recommendations'} on this site. Use recommendations.list for the ids.`,
      );
    if (new Set(input.order).size !== input.order.length)
      throw new AppError('invalid_input', 'The order names the same recommendation twice. List each id once.');
    await ctx.tx
      .delete(schema.recommendationPriorities)
      .where(and(eq(schema.recommendationPriorities.workspaceId, workspaceId), eq(schema.recommendationPriorities.siteId, input.siteId)));
    const rows = input.order.map((id, index) => ({
      workspaceId,
      artifactId: id,
      siteId: input.siteId,
      priority: index,
      updatedBy: ctx.principal.userId,
    }));
    await ctx.tx.insert(schema.recommendationPriorities).values(rows);
    return { siteId: input.siteId, order: rows.map((row) => ({ id: row.artifactId, priority: row.priority })) };
  },
});

export const recommendationDependencies = defineCommand({
  name: 'recommendations.dependencies',
  title: 'Recommendation dependency graph',
  description:
    'The dependencies of one recommendation, walked upstream (what must land first) and downstream (what waits on it), with each node’s status and priority, plus any dependency that no longer resolves and any cycle found. Read-only.',
  input: z.object({ recommendationId: RecommendationId }),
  output: z.object({
    recommendationId: z.string(),
    nodes: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        status: StatusEnum,
        priority: z.number().int().nullable(),
        dependsOn: z.array(z.string()),
      }),
    ),
    blocks: z.array(z.object({ id: z.string(), title: z.string(), status: StatusEnum })),
    missing: z.array(z.string()).describe('Dependency ids that are not recommendations on this site any more'),
    cycle: z.array(z.string()).nullable().describe('The ids that form a cycle, when one exists'),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  actionClass: 'read',
  target: (input) => input.recommendationId,
  handler: async (input, ctx) => {
    const workspaceId = ctx.principal.workspaceId;
    const start = await loadRecommendation(ctx, input.recommendationId);
    const { rows } = await ctx.tx.execute<{
      id: string;
      name: string;
      content: Recommendation;
      version_state: string;
      published: boolean;
      priority: number | null;
    }>(sql`
      SELECT a.id, a.name, v.content, v.state AS version_state, a.published_version IS NOT NULL AS published, p.priority
        FROM artifacts a
        JOIN artifact_versions v ON v.workspace_id = a.workspace_id AND v.artifact_id = a.id AND v.number = a.latest_version
        LEFT JOIN recommendation_priorities p ON p.workspace_id = a.workspace_id AND p.artifact_id = a.id
       WHERE a.workspace_id = ${workspaceId} AND a.site_id = ${start.siteId} AND a.type = 'recommendation'`);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const nodes: { id: string; title: string; status: RecommendationStatus; priority: number | null; dependsOn: string[] }[] = [];
    const missing: string[] = [];
    let cycle: string[] | null = null;
    const seen = new Set<string>();
    const stack = [start.id];
    while (stack.length) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const row = byId.get(id);
      if (!row) {
        if (id !== start.id) missing.push(id);
        continue;
      }
      nodes.push({
        id: row.id,
        title: row.name,
        status: deriveStatus({ versionState: row.version_state, published: row.published, archived: false, linked: [] }),
        priority: row.priority,
        dependsOn: row.content.dependsOn ?? [],
      });
      for (const dependency of row.content.dependsOn ?? []) {
        if (dependency === id && cycle === null) cycle = [id];
        stack.push(dependency);
      }
    }
    if (cycle === null) {
      // A cycle not through the start: walk each node's edges and look for a repeat on the path.
      const visiting = new Set<string>();
      const walk = (id: string, path: string[]): string[] | null => {
        if (path.includes(id)) return [...path.slice(path.indexOf(id)), id];
        if (visiting.has(id)) return null;
        visiting.add(id);
        for (const dependency of byId.get(id)?.content.dependsOn ?? []) {
          const found = walk(dependency, [...path, id]);
          if (found) return found;
        }
        return null;
      };
      cycle = walk(start.id, []);
    }
    const blocks = rows
      .filter((row) => row.id !== start.id && (row.content.dependsOn ?? []).includes(start.id))
      .map((row) => ({
        id: row.id,
        title: row.name,
        status: deriveStatus({ versionState: row.version_state, published: row.published, archived: false, linked: [] }),
      }));
    return { recommendationId: start.id, nodes, blocks, missing, cycle };
  },
});

const RunState = z.enum(['queued', 'running', 'completed', 'failed']);

const RunView = z.object({
  id: z.string(),
  siteId: z.string(),
  auditId: z.string().nullable(),
  state: RunState,
  maxRecommendations: z.number().int(),
  requestedBy: z.object({ type: z.enum(['user', 'agent', 'system']), id: z.string() }),
  candidates: z.number().int().describe('Candidates the technical specialist proposed'),
  derived: z.number().int().describe('Recommendations the strategist wrote, before validation'),
  created: z.number().int(),
  dropped: z.number().int(),
  droppedItems: z.array(z.object({ title: z.string(), reason: z.string() })),
  createdIds: z.array(z.string()),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
});

const runView = (row: typeof schema.recommendationRuns.$inferSelect): z.output<typeof RunView> => ({
  id: row.id,
  siteId: row.siteId,
  auditId: row.auditId,
  state: row.state,
  maxRecommendations: row.maxRecommendations,
  requestedBy: { type: row.requestedByType, id: row.requestedById },
  candidates: row.candidates,
  derived: row.derived,
  created: row.createdCount,
  dropped: row.droppedCount,
  droppedItems: row.dropped,
  createdIds: row.createdIds,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  error: row.error,
  startedAt: row.startedAt?.toISOString() ?? null,
  finishedAt: row.finishedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

export const listRecommendationRuns = defineCommand({
  name: 'recommendations.runs',
  title: 'List recommendation runs',
  description:
    'A site’s synthesis runs, newest first: when each ran, which audit it read, how many recommendations it created, how many it dropped and why, and the tokens it used. A run that failed says why. Read-only.',
  input: z.object({
    siteId: SiteId,
    limit: z.number().int().min(1).max(50).default(20),
    state: RunState.optional().describe('Only runs in this state'),
  }),
  output: z.object({ runs: z.array(RunView), total: z.number().int() }),
  permission: 'artifacts:read',
  effect: 'read',
  actionClass: 'read',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const rows = await ctx.tx
      .select()
      .from(schema.recommendationRuns)
      .where(
        and(
          eq(schema.recommendationRuns.workspaceId, ctx.principal.workspaceId),
          eq(schema.recommendationRuns.siteId, input.siteId),
          input.state ? eq(schema.recommendationRuns.state, input.state) : undefined,
        ),
      )
      .orderBy(sql`${schema.recommendationRuns.createdAt} DESC`)
      .limit(input.limit);
    const filter = and(
      eq(schema.recommendationRuns.workspaceId, ctx.principal.workspaceId),
      eq(schema.recommendationRuns.siteId, input.siteId),
      input.state ? eq(schema.recommendationRuns.state, input.state) : undefined,
    );
    const [total] = await ctx.tx.select({ n: count() }).from(schema.recommendationRuns).where(filter);
    return { runs: rows.map(runView), total: Number(total?.n ?? 0) };
  },
});

export const getRecommendationRun = defineCommand({
  name: 'recommendations.run',
  title: 'Get a recommendation run',
  description:
    'One synthesis run in full: its state, the audit it read, the candidates and recommendations its specialists produced, the ids it created, every item it dropped with the validation errors that caused it, the tokens it used and its error when it failed. Read-only.',
  input: z.object({ runId: z.string().regex(/^rrun_[0-9a-f]{32}$/, 'A run id, e.g. from recommendations.runs') }),
  output: RunView,
  permission: 'artifacts:read',
  effect: 'read',
  actionClass: 'read',
  target: (input) => input.runId,
  handler: async (input, ctx) => {
    const [row] = await ctx.tx
      .select()
      .from(schema.recommendationRuns)
      .where(and(eq(schema.recommendationRuns.workspaceId, ctx.principal.workspaceId), eq(schema.recommendationRuns.id, input.runId)));
    if (!row) throw new AppError('not_found', `Recommendation run ${input.runId} does not exist in this workspace.`);
    return runView(row);
  },
});

export const generateRecommendations = defineCommand({
  name: 'recommendations.generate',
  title: 'Generate recommendations',
  description:
    'Queues a full-audit synthesis for one site and returns the run id: the technical specialist reads the site’s open issues (weighted by severity, pages and Search Console clicks), the strategist merges them into falsifiable recommendations, and every item is validated — evidence ids that exist, no metric the facts did not supply, no forbidden promise — retried once with its errors, then dropped with a reason. Runs cost tokens against the agents provider’s budget; read the result with recommendations.run. Needs an AI provider for the agents use (aiProviders.create), and an audit of the site to read.',
  input: z.object({
    siteId: SiteId,
    auditId: z.string().min(1).max(64).optional().describe('The audit to read; omit for the site’s latest completed audit'),
    maxRecommendations: z.number().int().min(1).max(20).default(10).describe('The most recommendations to create in this run'),
  }),
  output: z.object({
    runId: z.string(),
    state: RunState,
    next: z.string().describe('What to do next, in one sentence'),
  }),
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'draft',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const workspaceId = ctx.principal.workspaceId;
    await assertActiveSite(ctx.tx, workspaceId, input.siteId);
    if (input.auditId) {
      const [audit] = await ctx.tx
        .select({ state: schema.audits.state })
        .from(schema.audits)
        .where(
          and(eq(schema.audits.workspaceId, workspaceId), eq(schema.audits.siteId, input.siteId), eq(schema.audits.id, input.auditId)),
        );
      if (!audit) throw new AppError('not_found', `Audit ${input.auditId} does not exist for this site. List them with audits.list.`);
      if (audit.state !== 'completed' && audit.state !== 'partial')
        throw new AppError(
          'conflict',
          `Audit ${input.auditId} is ${audit.state}. A run reads a finished audit: wait for it to complete, or name another one.`,
        );
    } else {
      const [latest] = await ctx.tx
        .select({ id: schema.audits.id })
        .from(schema.audits)
        .where(
          and(eq(schema.audits.workspaceId, workspaceId), eq(schema.audits.siteId, input.siteId), eq(schema.audits.state, 'completed')),
        )
        .orderBy(sql`${schema.audits.finishedAt} DESC NULLS LAST`)
        .limit(1);
      if (!latest)
        throw new AppError(
          'precondition_failed',
          'This site has no completed audit yet, so there are no facts to reason over. Run one with audits.run first.',
        );
    }
    // The refusal a missing provider deserves names the setup step, before a run row exists.
    try {
      await modelFor(ctx.tx, ctx.services.keyProvider, 'agents');
    } catch (err) {
      if (err instanceof AiUnavailable)
        throw new AppError(
          'precondition_failed',
          err.reason === 'no_provider'
            ? 'No AI provider is set up for the agents use, so recommendations cannot be generated. Add one with aiProviders.create and useFor ["agents"], then run this again. Deterministic findings stay available meanwhile.'
            : `The agents provider cannot be used: ${err.message}. Fix it with aiProviders.update, then run this again.`,
        );
      throw err;
    }
    const runId = newId('rrun');
    await ctx.tx.insert(schema.recommendationRuns).values({
      workspaceId,
      id: runId,
      siteId: input.siteId,
      auditId: input.auditId ?? null,
      state: 'queued',
      maxRecommendations: input.maxRecommendations,
      requestedByType: ctx.principal.type === 'user' ? 'user' : 'agent',
      requestedById: ctx.principal.userId,
    });
    await enqueueRecommendationRun(ctx.tx, { workspaceId, runId, siteId: input.siteId });
    return {
      runId,
      state: 'queued' as const,
      next: 'Read it with recommendations.run: the run calls two models and takes about a minute, and every item it dropped says why.',
    };
  },
});

export const recommendationsCommands = [
  listRecommendations,
  getRecommendation,
  createRecommendation,
  updateRecommendation,
  prioritiseRecommendations,
  recommendationDependencies,
  listRecommendationRuns,
  getRecommendationRun,
  generateRecommendations,
] as const;
