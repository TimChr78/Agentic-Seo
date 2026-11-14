import { defineCommand } from '@agentic-seo/commands';
import { isoDateTime } from '@agentic-seo/core';
import { schema } from '@agentic-seo/db';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { listTestRuns, testPrompt, testRunResults } from './prompts';
import { createAiProvider, deleteAiProvider, listAiProviders, updateAiProvider } from './providers';

// The decision log and usage: every AI call (a prompt test now, an agent step or an answer engine
// run later) with what the model saw, what it answered, why a fallback was taken, tokens and
// latency. Ported from Agentic Marketing 9a7a5721 (packages/ai/src/commands.ts) without the
// journey, profile, copilot, classify, score and calibration surfaces.

const Call = z.object({
  id: z.string(),
  kind: z.enum(['decide', 'generate', 'test']),
  status: z.enum(['pending', 'running', 'done', 'fallback', 'failed']),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  promptId: z.string().nullable(),
  promptVersion: z.number().nullable(),
  input: z.record(z.string(), z.unknown()).describe('The data the model saw'),
  output: z.unknown(),
  rationale: z.string().nullable(),
  error: z.string().nullable().describe('Why the call failed or a fallback was taken'),
  inputTokens: z.number(),
  outputTokens: z.number(),
  latencyMs: z.number().nullable(),
  createdAt: z.string(),
});

export const listAiCalls = defineCommand({
  name: 'ai.calls',
  title: 'AI decision log',
  description:
    'Recent AI calls, newest first: what each model was asked, its rationale or fallback reason, tokens, latency and the prompt version it used. Filter by prompt or kind.',
  input: z.object({
    promptId: z.string().optional(),
    kind: z.enum(['decide', 'generate', 'test']).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    before: isoDateTime('before').optional(),
  }),
  output: z.object({ calls: z.array(Call) }),
  permission: 'audit:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const c = schema.aiCalls;
    const rows = await ctx.tx
      .select()
      .from(c)
      .where(
        and(
          input.promptId ? eq(c.promptId, input.promptId) : undefined,
          input.kind ? eq(c.kind, input.kind) : undefined,
          input.before ? lt(c.createdAt, new Date(input.before)) : undefined,
        ),
      )
      .orderBy(desc(c.createdAt), desc(c.id))
      .limit(input.limit);
    return {
      calls: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        providerId: r.providerId,
        model: r.model,
        promptId: r.promptId,
        promptVersion: r.promptVersion,
        input: r.input,
        output: r.output,
        rationale: r.rationale,
        error: r.error,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        latencyMs: r.latencyMs,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  },
});

// Estimated list prices in USD per million tokens (input, output) by model id. Estimates only:
// providers change prices and negotiated rates differ. A model not in the table has no cost.
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};

/** An estimated cost in USD, or null when the model is not in the table. */
export function estimatedCost(model: string | null, inputTokens: number, outputTokens: number): number | null {
  const price = model ? MODEL_PRICES[model] : undefined;
  if (!price) return null;
  return Math.round(((inputTokens * price.input + outputTokens * price.output) / 1_000_000) * 1e6) / 1e6;
}

export const aiUsage = defineCommand({
  name: 'ai.usage',
  title: 'AI usage',
  description: 'Tokens, calls, fallbacks and estimated cost per day, kind and model over the last days.',
  input: z.object({ days: z.number().int().min(1).max(90).default(30) }),
  output: z.object({
    days: z.array(
      z.object({
        day: z.string(),
        kind: z.string(),
        model: z.string().nullable().describe('The model id the calls used; null when none was recorded'),
        calls: z.number(),
        fallbacks: z.number(),
        inputTokens: z.number(),
        outputTokens: z.number(),
        cost: z.number().nullable().describe('Estimated USD from a price table in code; null for an unknown model'),
      }),
    ),
  }),
  permission: 'audit:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const c = schema.aiCalls;
    const day = sql<string>`to_char(date_trunc('day', ${c.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
    const rows = await ctx.tx
      .select({
        day,
        kind: c.kind,
        model: c.model,
        calls: sql<number>`count(*)::int`,
        fallbacks: sql<number>`count(*) FILTER (WHERE ${c.status} IN ('fallback', 'failed'))::int`,
        inputTokens: sql<number>`coalesce(sum(${c.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${c.outputTokens}), 0)::int`,
      })
      .from(c)
      .where(gte(c.createdAt, new Date(Date.now() - input.days * 86_400_000)))
      .groupBy(day, c.kind, c.model)
      .orderBy(day, c.kind);
    return { days: rows.map((r) => ({ ...r, cost: estimatedCost(r.model, r.inputTokens, r.outputTokens) })) };
  },
});

export const aiCommands = [
  listAiProviders,
  createAiProvider,
  updateAiProvider,
  deleteAiProvider,
  testPrompt,
  testRunResults,
  listTestRuns,
  listAiCalls,
  aiUsage,
] as const;
