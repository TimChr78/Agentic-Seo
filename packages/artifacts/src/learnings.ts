import { type CommandContext, defineCommand } from '@agentic-seo/commands';
import { AppError, newId } from '@agentic-seo/core';
import { type LearningEvidence, schema } from '@agentic-seo/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

// Learnings (agents-and-autonomy §6): a small, inspectable store of conclusions with the evidence
// that backs them. People and agents write them; agents read the active ones as the MCP resource
// learnings://current. This is not a memory dump: a learning needs evidence, and an agent's
// evidence must point at a real artifact in this workspace. Ported from Agentic Marketing 311460e
// packages/artifacts/src/learnings.ts; marketing's audience/purpose scope became SEO's site,
// market and change type.

const LearningId = z
  .string()
  .regex(/^lrn_[0-9a-f]{32}$/, 'A learning id looks like "lrn_…"')
  .describe('Learning id, e.g. "lrn_0192…"');

const EvidenceKind = z.enum(['change_set', 'recommendation', 'report', 'rank_tracker', 'ai_visibility_tracker']);

/** The artifact type each kind of result comes from. */
const EVIDENCE_TYPE = {
  change_set: 'change_set',
  recommendation: 'recommendation',
  report: 'report',
  rank_tracker: 'rank_tracker',
  ai_visibility_tracker: 'ai_visibility_tracker',
} as const satisfies Record<z.infer<typeof EvidenceKind>, string>;

const Evidence = z.object({
  kind: EvidenceKind.describe(
    'change_set: a change set and its verification/outcome; recommendation: an approved recommendation; report: a report; rank_tracker or ai_visibility_tracker: a tracker and its observations',
  ),
  id: z.string().min(1).max(80).describe('Id of the artifact the result came from (chg_…, rcm_…, rpt_…, rkt_…, ait_…)'),
  summary: z.string().min(1).max(1000).describe('What the result showed, in one sentence'),
  numbers: z.record(z.string(), z.number()).default({}).describe('The measured numbers, e.g. {"clicks":240,"control":180}'),
});

const Scope = z.object({
  siteId: z.string().uuid().optional().describe('The site the learning applies to; omitted: the whole workspace'),
  markets: z.array(z.string().max(40)).max(20).optional().describe('Markets (location + language) the learning applies to'),
  changeTypes: z
    .array(z.string().max(64))
    .max(50)
    .optional()
    .describe('Change types the learning applies to, e.g. meta.title or content.patch'),
});

const Learning = z.object({
  id: z.string(),
  siteId: z.string().nullable(),
  statement: z.string(),
  scope: Scope,
  evidence: z.array(Evidence),
  author: z.object({ type: z.enum(['user', 'agent']), id: z.string() }),
  agentId: z.string().nullable().describe('The agent that wrote it, or null for a person'),
  status: z.enum(['active', 'retracted']),
  retractedBy: z.string().nullable(),
  retractedAt: z.string().nullable(),
  retractReason: z.string().nullable(),
  createdAt: z.string(),
});

type LearningRow = typeof schema.learnings.$inferSelect;

function toLearning(row: LearningRow) {
  return {
    id: row.id,
    siteId: row.siteId,
    statement: row.statement,
    scope: row.scope as z.output<typeof Scope>,
    evidence: row.evidence,
    author: { type: row.authorType, id: row.authorId },
    agentId: row.agentId,
    status: row.status,
    retractedBy: row.retractedBy,
    retractedAt: row.retractedAt?.toISOString() ?? null,
    retractReason: row.retractReason,
    createdAt: row.createdAt.toISOString(),
  };
}

/** An agent's evidence must name a result that exists here: no learning from a remembered id. */
async function assertAgentEvidence(ctx: CommandContext, evidence: LearningEvidence[]) {
  if (!evidence.length) return;
  const rows = await ctx.tx
    .select({ id: schema.artifacts.id, type: schema.artifacts.type })
    .from(schema.artifacts)
    .where(
      inArray(
        schema.artifacts.id,
        evidence.map((item) => item.id),
      ),
    );
  for (const [i, item] of evidence.entries()) {
    const row = rows.find((r) => r.id === item.id);
    if (!row)
      throw new AppError(
        'invalid_input',
        `evidence[${i}] (${item.kind}): ${item.id} is not an artifact in this workspace. Reference the change set, recommendation, report or tracker the result came from.`,
      );
    const expected = EVIDENCE_TYPE[item.kind];
    if (row.type !== expected)
      throw new AppError('invalid_input', `evidence[${i}] (${item.kind}) must reference a ${expected}, but ${item.id} is a ${row.type}.`);
  }
}

/** The active learnings, with the scope filters an agent uses to find the ones that apply. */
export const listLearnings = defineCommand({
  name: 'learnings.list',
  title: 'List learnings',
  description:
    'Conclusions with their evidence, newest first. By default only active ones; filter by status, site, market and change type. People and agents read this; the MCP resource learnings://current serves the active ones.',
  input: z.object({
    status: z.enum(['active', 'retracted', 'all']).default('active').describe('active (default), retracted, or all'),
    siteId: z.string().uuid().optional().describe('Only learnings for this site'),
    market: z.string().optional().describe('Only learnings whose scope names this market'),
    changeType: z.string().optional().describe('Only learnings whose scope names this change type'),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  output: z.object({ learnings: z.array(Learning), count: z.number().int() }),
  permission: 'artifacts:read',
  effect: 'read',
  actionClass: 'read',
  handler: async (input, ctx) => {
    const conditions = [
      input.status === 'all' ? undefined : eq(schema.learnings.status, input.status),
      input.siteId ? eq(schema.learnings.siteId, input.siteId) : undefined,
      input.market ? sql`${schema.learnings.scope}->'markets' @> ${JSON.stringify([input.market])}::jsonb` : undefined,
      input.changeType ? sql`${schema.learnings.scope}->'changeTypes' @> ${JSON.stringify([input.changeType])}::jsonb` : undefined,
    ];
    const rows = await ctx.tx
      .select()
      .from(schema.learnings)
      .where(and(...conditions))
      .orderBy(desc(schema.learnings.createdAt))
      .limit(input.limit);
    return { learnings: rows.map(toLearning), count: rows.length };
  },
});

/** Record a conclusion with the result that backs it. Agents add drafts, never live changes. */
export const addLearning = defineCommand({
  name: 'learnings.add',
  title: 'Add a learning',
  description:
    'Record a conclusion and the change set, recommendation, report or tracker that supports it, with the site and market scope it applies to. People and agents may add one; an agent’s evidence must reference a real artifact in this workspace. Draft-level: it never needs autonomy and a person can retract it.',
  input: z.object({
    statement: z.string().min(1).max(2000).describe('The conclusion, e.g. "Rewriting titles of striking-distance pages raises CTR"'),
    scope: Scope.default({}).describe('Where it applies: site, markets and change types (all optional)'),
    evidence: z
      .array(Evidence)
      .min(1)
      .max(20)
      .describe('The results behind it: a change set outcome, an approved recommendation, a report or a tracker'),
  }),
  output: Learning,
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'draft',
  handler: async (input, ctx) => {
    if (ctx.principal.type === 'agent') await assertAgentEvidence(ctx, input.evidence as LearningEvidence[]);
    const row = {
      workspaceId: ctx.principal.workspaceId,
      id: newId('lrn'),
      siteId: input.scope.siteId ?? null,
      statement: input.statement,
      scope: input.scope,
      evidence: input.evidence,
      authorType: ctx.principal.type,
      authorId: ctx.principal.userId,
      agentId: ctx.principal.agent?.id ?? null,
    };
    const [created] = await ctx.tx.insert(schema.learnings).values(row).returning();
    return toLearning(created);
  },
});

/** People retract a learning that no longer holds; the row and its reason stay for the record. */
export const retractLearning = defineCommand({
  name: 'learnings.retract',
  title: 'Retract a learning',
  description:
    'Retract a learning that no longer holds, with the reason. People only: an agent may add evidence but never withdraw someone else’s conclusion. The learning stays in the record with status retracted and is no longer served as current.',
  input: z.object({
    id: LearningId,
    reason: z.string().min(1).max(1000).describe('Why it no longer holds, e.g. "the effect did not repeat in the next four tests"'),
  }),
  output: Learning,
  permission: 'artifacts:write',
  effect: 'write',
  humansOnly: true,
  target: (input) => input.id,
  handler: async (input, ctx) => {
    const [existing] = await ctx.tx
      .select()
      .from(schema.learnings)
      .where(and(eq(schema.learnings.workspaceId, ctx.principal.workspaceId), eq(schema.learnings.id, input.id)));
    if (!existing) throw new AppError('not_found', `No learning ${input.id} in this workspace.`);
    if (existing.status === 'retracted')
      throw new AppError(
        'conflict',
        `Learning ${input.id} is already retracted${existing.retractReason ? `: ${existing.retractReason}` : '.'}`,
      );
    const [updated] = await ctx.tx
      .update(schema.learnings)
      .set({ status: 'retracted', retractedBy: ctx.principal.userId, retractedAt: new Date(), retractReason: input.reason })
      .where(and(eq(schema.learnings.workspaceId, ctx.principal.workspaceId), eq(schema.learnings.id, input.id)))
      .returning();
    return toLearning(updated);
  },
});

export const learningsCommands = [listLearnings, addLearning, retractLearning] as const;
