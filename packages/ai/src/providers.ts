import { defineCommand } from '@agentic-seo/commands';
import { AppError, newId } from '@agentic-seo/core';
import { type AiUse, type Db, schema, type Tx } from '@agentic-seo/db';
import { checkEgressUrl, egressFetch } from '@agentic-seo/fetch';
import { type KeyProvider, openJson, sealJson } from '@agentic-seo/secrets';
import { logger } from '@agentic-seo/telemetry';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

// LLM providers with the workspace's own keys. Two wire formats cover most of the market:
// OpenAI-compatible (OpenAI, Mistral, vLLM, LiteLLM, OpenRouter…) and Anthropic-compatible. Keys
// are sealed with the workspace's secrets key and never returned; each use (the agents, answer
// engines later) has one provider at a time.
//
// The base URL is the one outbound address a workspace configures, so it goes through
// packages/fetch's egress guard: the command refuses a private, loopback or metadata target, and
// the adapter's fetch refuses one again at use (see egressFetch).

type ProviderRow = typeof schema.aiProviders.$inferSelect;

// The SDK's compatibility warnings would end up in the logs for every call.
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const Kind = z.enum(['openai-compatible', 'anthropic-compatible']);
/** The provider kinds this package speaks, so a test can check every one has a redaction qualifier. */
export const aiProviderKinds = Kind.options;
const Use = z.enum(['agents', 'answer_engines']);
const Models = z.object({
  default: z.string().min(1).max(200).describe('Model id for most calls, e.g. "claude-sonnet-4-5" or "gpt-4o-mini"'),
  fast: z.string().min(1).max(200).optional().describe('A cheaper, faster model for prompts that ask for it'),
});
const ProviderId = z.string().regex(/^aip_[0-9a-f]{32}$/);

const Provider = z.object({
  id: z.string(),
  name: z.string(),
  kind: Kind,
  baseUrl: z.string(),
  models: Models,
  structuredOutputs: z.boolean(),
  useFor: z.array(Use),
  monthlyTokenBudget: z.number().nullable(),
  region: z.string(),
  enabled: z.boolean(),
  hasApiKey: z.boolean(),
  usedThisMonth: z.number().describe('Input and output tokens since the start of the month (UTC)'),
});

export async function usedThisMonth(tx: Tx, providerId: string, at?: Date): Promise<number> {
  // Usage and live holds are one statement on purpose: under READ COMMITTED each statement takes a
  // fresh snapshot, and a settlement commits as an atomic swap (its usage row inserted, its hold
  // deleted). Read as two statements, a settlement landing between them would be in neither sum and
  // the month would look free. One statement sees the hold or the usage, never a gap. Usage is
  // charged to the month it was billed in, which is what a call queued before month end crosses.
  const now = at ? sql`${at}::timestamptz` : sql`now()`;
  const monthStart = sql`date_trunc('month', ${now} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
  const { rows } = await tx.execute<{ used: string }>(sql`
    SELECT
      (SELECT coalesce(sum(c.input_tokens + c.output_tokens), 0)
         FROM ai_calls c
        WHERE c.provider_id = ${providerId}
          AND coalesce(c.billed_at, c.created_at) >= ${monthStart})
      + (SELECT coalesce(sum(r.tokens), 0)
           FROM ai_token_reservations r
          WHERE r.provider_id = ${providerId}
            AND r.expires_at >= ${now}) AS used`);
  return Number(rows[0]?.used ?? 0);
}

/** A rough token count for a request: ~4 characters per token, plus the most the answer may use. */
export const estimateTokens = (input: unknown, maxOutput: number) => Math.ceil(JSON.stringify(input ?? '').length / 4) + maxOutput;

/** The first instant of the next UTC month: a usage write that failed keeps its hold through the month. */
export const nextMonthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

/** Reserve durably before I/O, including the following month for calls crossing UTC month-end.
 * Successful settlement deletes the hold immediately. A crash/outage keeps conservative budget
 * coverage until this deadline instead of freeing billed usage after five minutes. */
export const billingReservationTtlMs = (now = new Date()) => nextMonthStart(nextMonthStart(now)).getTime() - now.getTime();

export interface ReserveOptions {
  /** How long a hold stays counted when nothing settles it. Default: through the next billing month. */
  ttlMs?: number;
  /** The ai_calls attempt this hold covers, so a crashed attempt's hold is traceable. */
  callId?: string;
  /** Injected clock, so a test can stand on the far side of a hold's deadline. */
  now?: Date;
}

/**
 * Reserves tokens for one call before it is made, in its own committed transaction and under a
 * per-provider lock, so concurrent calls see each other. Throws AiUnavailable('budget') when the
 * month's usage plus reservations would pass the budget. Release it when the call has finished.
 *
 * The hold outlives the process by default: a provider bills whether or not the call is settled, so
 * a hold that expired after five minutes would let a retry spend the same budget again.
 */
export async function reserveTokens(
  db: Db,
  workspaceId: string,
  providerId: string,
  tokens: number,
  opts: ReserveOptions = {},
): Promise<string> {
  const now = opts.now ?? new Date();
  const ttlMs = opts.ttlMs ?? billingReservationTtlMs(now);
  return db.withWorkspace(workspaceId, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ai-budget:${providerId}`}))`);
    const [row] = await tx.select().from(schema.aiProviders).where(eq(schema.aiProviders.id, providerId));
    if (
      row?.monthlyTokenBudget !== null &&
      row?.monthlyTokenBudget !== undefined &&
      (await usedThisMonth(tx, providerId, opts.now)) + tokens > row.monthlyTokenBudget
    )
      throw new AiUnavailable('budget');
    const id = newId('rsv');
    await tx
      .insert(schema.aiTokenReservations)
      .values({ workspaceId, id, providerId, tokens, callId: opts.callId ?? null, expiresAt: new Date(now.getTime() + ttlMs) });
    return id;
  });
}

export async function releaseTokens(db: Db, workspaceId: string, id: string) {
  await db.withWorkspace(workspaceId, (tx) => tx.delete(schema.aiTokenReservations).where(eq(schema.aiTokenReservations.id, id)));
}

export type SettleOutcome = 'settled' | 'fallback' | 'held';

/**
 * Keeps a reservation counted when its usage could not be written. The hold is the only remaining
 * record of tokens the provider billed; letting it expire would let later calls spend that budget
 * again. The deadline moves to the start of the next month and is never shortened; a hold already
 * durable beyond that (a reserve made with {@link billingReservationTtlMs}) is left alone. If the
 * database is unavailable, the original deadline remains valid.
 */
export async function holdReservationForMonth(db: Db, workspaceId: string, reservationId: string, now = new Date()): Promise<boolean> {
  try {
    await db.withWorkspace(workspaceId, (tx) =>
      tx
        .update(schema.aiTokenReservations)
        .set({ expiresAt: sql`GREATEST(${schema.aiTokenReservations.expiresAt}, ${nextMonthStart(now)})` })
        .where(eq(schema.aiTokenReservations.id, reservationId)),
    );
    return true;
  } catch (err) {
    logger.error({ err }, 'AI budget reservation extension failed; its pre-call deadline remains in force');
    return false;
  }
}

/**
 * Records what a reservation bought and releases the reservation in one transaction. `usedThisMonth`
 * reads the committed `ai_calls` usage and the live reservations in one statement, so this atomic
 * swap means a concurrent call never sees neither: it sees the hold, or the usage, but not a gap in
 * which the month looks free.
 *
 * `write` must persist the call's tokens. When it fails, `fallback` (if given) writes the same
 * usage in its own transaction before the hold is released. If both fail the reservation is kept on
 * purpose and extended through the billing month: freeing it would let the month spend budget the
 * provider has already billed. The caller sees `'held'` and reports the failure.
 */
export async function settleReservation(
  db: Db,
  workspaceId: string,
  reservationId: string,
  write: (tx: Tx) => Promise<void>,
  opts: { fallback?: () => Promise<void>; label?: string } = {},
): Promise<SettleOutcome> {
  try {
    await db.withWorkspace(workspaceId, async (tx) => {
      await write(tx);
      await tx.delete(schema.aiTokenReservations).where(eq(schema.aiTokenReservations.id, reservationId));
    });
    return 'settled';
  } catch (err) {
    logger.error({ err, label: opts.label }, 'AI usage could not be recorded with its reservation');
  }
  if (!opts.fallback) {
    await holdReservationForMonth(db, workspaceId, reservationId);
    return 'held';
  }
  try {
    await opts.fallback();
  } catch (err) {
    logger.error({ err, label: opts.label }, 'AI usage could not be recorded at all; keeping the reservation');
    await holdReservationForMonth(db, workspaceId, reservationId);
    return 'held';
  }
  try {
    await releaseTokens(db, workspaceId, reservationId);
  } catch (err) {
    // The usage is durable; the hold is only double-counting until it expires, which is the safe
    // direction for a budget.
    logger.error({ err, label: opts.label }, 'AI usage was recorded but its reservation could not be released');
  }
  return 'fallback';
}

/** The fewest tokens worth starting another model step with (the hosted-run pattern). */
export const MIN_STEP_TOKENS = 100;

/** Tokens used by the steps so far (input and output), for a turn or run cap. */
export const tokensOfSteps = (steps: { usage: { inputTokens?: number; outputTokens?: number } }[]) =>
  steps.reduce((n, s) => n + (s.usage.inputTokens ?? 0) + (s.usage.outputTokens ?? 0), 0);

export interface StepBudget {
  /** No further model call: too little of the allowance is left for a useful step. */
  stop: boolean;
  /** The output cap for the next step. */
  maxOutputTokens: number;
}

/**
 * The budget for the next model step of a capped turn: what is left of the allowance after the
 * steps already taken and after an estimate of this step's input (prompt, history, tool results).
 * A turn stops before the call when the room left cannot pay for a useful step, so the cap is
 * checked before the model is asked again rather than after it has overspent. Hosted run loops use
 * it from Phase 1; the arithmetic lives here with the reservations it protects.
 */
export function stepBudget(input: {
  allowance: number;
  used: number;
  maxOutputTokens: number;
  estimatedInput?: number;
  minStepTokens?: number;
}): StepBudget {
  const min = input.minStepTokens ?? MIN_STEP_TOKENS;
  const remaining = input.allowance - input.used;
  if (remaining < min) return { stop: true, maxOutputTokens: 1 };
  const room = remaining - Math.max(0, input.estimatedInput ?? 0);
  if (room < min) return { stop: true, maxOutputTokens: 1 };
  return { stop: false, maxOutputTokens: Math.max(1, Math.min(input.maxOutputTokens, room)) };
}

const providerOut = async (tx: Tx, r: ProviderRow) => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  baseUrl: r.baseUrl,
  models: r.models,
  structuredOutputs: r.structuredOutputs,
  useFor: r.useFor,
  monthlyTokenBudget: r.monthlyTokenBudget,
  region: r.region,
  enabled: r.enabled,
  hasApiKey: !!r.secrets,
  usedThisMonth: await usedThisMonth(tx, r.id),
});

async function sealKey(tx: Tx, workspaceId: string, kp: KeyProvider, apiKey: string | undefined) {
  if (apiKey === undefined) return {};
  const s = await sealJson(tx, workspaceId, kp, { apiKey });
  return { secrets: s.blob, secretsKeyId: s.keyId };
}

/** Each use has one provider; giving it to one takes it from the others. */
async function claimUses(tx: Tx, id: string, uses: AiUse[]) {
  if (!uses.length) return;
  for (const o of await tx.select().from(schema.aiProviders))
    if (o.id !== id && o.useFor.some((u) => uses.includes(u)))
      await tx
        .update(schema.aiProviders)
        .set({ useFor: o.useFor.filter((u) => !uses.includes(u)) })
        .where(and(eq(schema.aiProviders.workspaceId, o.workspaceId), eq(schema.aiProviders.id, o.id)));
}

export interface ReadyModel {
  providerId: string;
  modelId: string;
  model: LanguageModel;
}

/** Why no model can be used; callers take their fallback and log the reason. */
export class AiUnavailable extends Error {
  constructor(readonly reason: 'no_provider' | 'budget' | 'no_key') {
    super(
      {
        no_provider: 'no AI provider is set up for this use',
        budget: "the provider's monthly token budget is used up",
        no_key: 'the AI provider has no API key',
      }[reason],
    );
  }
}

/** Where a model's HTTP goes. Production leaves it unset, so the egress guard applies. */
export interface ModelOptions {
  /** Test-only: the scripted LLM server listens on loopback, which the guard refuses by design. */
  fetch?: typeof fetch;
}

export async function languageModel(
  tx: Tx,
  row: ProviderRow,
  kp: KeyProvider,
  tier: 'default' | 'fast',
  opts: ModelOptions = {},
): Promise<ReadyModel> {
  if (!row.secrets || !row.secretsKeyId) throw new AiUnavailable('no_key');
  const { apiKey } = await openJson<{ apiKey: string }>(tx, row.workspaceId, kp, row.secrets, row.secretsKeyId);
  const modelId = (tier === 'fast' && row.models.fast) || row.models.default;
  // The base URL was checked when it was saved; egressFetch checks it again per request, so a
  // name that starts resolving inside the network is refused rather than called.
  const http = opts.fetch ?? egressFetch;
  const model =
    row.kind === 'anthropic-compatible'
      ? createAnthropic({ baseURL: row.baseUrl, apiKey, fetch: http })(modelId)
      : createOpenAICompatible({
          name: 'byok',
          baseURL: row.baseUrl,
          apiKey,
          supportsStructuredOutputs: row.structuredOutputs,
          includeUsage: true,
          fetch: http,
        })(modelId);
  return { providerId: row.id, modelId, model };
}

/** The model for a use, after checking that the provider is enabled and within its budget. */
export async function modelFor(
  tx: Tx,
  kp: KeyProvider,
  use: AiUse,
  tier: 'default' | 'fast' = 'default',
  opts: ModelOptions = {},
): Promise<ReadyModel> {
  const rows = await tx.select().from(schema.aiProviders).where(eq(schema.aiProviders.enabled, true));
  const row = rows.find((r) => r.useFor.includes(use));
  if (!row) throw new AiUnavailable('no_provider');
  if (row.monthlyTokenBudget !== null && (await usedThisMonth(tx, row.id)) >= row.monthlyTokenBudget) throw new AiUnavailable('budget');
  return languageModel(tx, row, kp, tier, opts);
}

export const listAiProviders = defineCommand({
  name: 'aiProviders.list',
  title: 'List AI providers',
  description:
    'LLM providers set up with the workspace’s own API keys, what they are used for, and tokens used this month. Keys are never returned.',
  input: z.object({}),
  output: z.object({ providers: z.array(Provider) }),
  permission: 'workspace:admin',
  effect: 'read',
  handler: async (_input, ctx) => {
    const rows = await ctx.tx.select().from(schema.aiProviders).orderBy(schema.aiProviders.createdAt);
    return { providers: await Promise.all(rows.map((r) => providerOut(ctx.tx, r))) };
  },
});

const Settings = {
  name: z.string().min(1).max(120),
  kind: Kind,
  baseUrl: z
    .string()
    .max(500)
    .describe('An https origin, e.g. https://api.openai.com/v1 or https://api.anthropic.com/v1; internal addresses are refused'),
  models: Models,
  structuredOutputs: z
    .boolean()
    .default(true)
    .describe('OpenAI-compatible only: whether the server supports JSON-schema response formats (turn off for older local servers)'),
  useFor: z
    .array(Use)
    .max(2)
    .default([])
    .describe('agents: the strategist and specialists from Phase 1; answer_engines: AI visibility runs, later'),
  monthlyTokenBudget: z.number().int().min(0).nullable().default(null).describe('Calls stop once reached'),
  region: z.string().max(120).default('').describe('Where the provider processes data, for the records of processing'),
};

/** The base URL after its trailing slashes are dropped, or AppError('invalid_input') with the reason. */
function egressBaseUrl(raw: string): string {
  const baseUrl = raw.replace(/\/+$/, '');
  const problem = checkEgressUrl(baseUrl);
  if (problem) throw new AppError('invalid_input', `The provider base URL is not usable: ${problem}.`);
  return baseUrl;
}

export const createAiProvider = defineCommand({
  name: 'aiProviders.create',
  title: 'Add an AI provider',
  description: 'Add an OpenAI- or Anthropic-compatible LLM provider with the workspace’s own API key.',
  input: z.object({ ...Settings, apiKey: z.string().min(1).max(4000) }),
  output: Provider,
  permission: 'workspace:admin',
  effect: 'write',
  actionClass: 'settings',
  humansOnly: true,
  sensitive: ['apiKey'],
  handler: async ({ apiKey, ...input }, ctx) => {
    const id = newId('aip');
    const baseUrl = egressBaseUrl(input.baseUrl);
    await claimUses(ctx.tx, id, input.useFor);
    const [row] = await ctx.tx
      .insert(schema.aiProviders)
      .values({
        workspaceId: ctx.principal.workspaceId,
        id,
        ...input,
        baseUrl,
        ...(await sealKey(ctx.tx, ctx.principal.workspaceId, ctx.services.keyProvider, apiKey)),
      })
      .returning();
    return providerOut(ctx.tx, row);
  },
});

export const updateAiProvider = defineCommand({
  name: 'aiProviders.update',
  title: 'Change an AI provider',
  description: 'Change settings, uses, budget or the API key.',
  input: z.object({
    id: ProviderId,
    name: Settings.name.optional(),
    baseUrl: Settings.baseUrl.optional(),
    models: Models.optional(),
    structuredOutputs: z.boolean().optional(),
    useFor: z.array(Use).max(2).optional(),
    monthlyTokenBudget: z.number().int().min(0).nullable().optional(),
    region: z.string().max(120).optional(),
    enabled: z.boolean().optional(),
    apiKey: z.string().min(1).max(4000).optional(),
  }),
  output: Provider,
  permission: 'workspace:admin',
  effect: 'write',
  actionClass: 'settings',
  humansOnly: true,
  sensitive: ['apiKey'],
  target: (i) => i.id,
  handler: async ({ id, apiKey, ...rest }, ctx) => {
    const [cur] = await ctx.tx.select().from(schema.aiProviders).where(eq(schema.aiProviders.id, id));
    if (!cur) throw new AppError('not_found', `No AI provider ${id}. List them with aiProviders.list.`);
    if (rest.useFor) await claimUses(ctx.tx, id, rest.useFor);
    const [row] = await ctx.tx
      .update(schema.aiProviders)
      .set({
        ...rest,
        ...(rest.baseUrl ? { baseUrl: egressBaseUrl(rest.baseUrl) } : {}),
        ...(await sealKey(ctx.tx, ctx.principal.workspaceId, ctx.services.keyProvider, apiKey)),
        updatedAt: new Date(),
      })
      .where(eq(schema.aiProviders.id, id))
      .returning();
    return providerOut(ctx.tx, row);
  },
});

export const deleteAiProvider = defineCommand({
  name: 'aiProviders.delete',
  title: 'Delete an AI provider',
  description: 'Remove a provider and its key. AI calls without a provider fail with the reason.',
  input: z.object({ id: ProviderId }),
  output: z.object({ deleted: z.literal(true) }),
  permission: 'workspace:admin',
  effect: 'destructive',
  humansOnly: true,
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const res = await ctx.tx.delete(schema.aiProviders).where(eq(schema.aiProviders.id, input.id)).returning({ id: schema.aiProviders.id });
    if (!res.length) throw new AppError('not_found', `No AI provider ${input.id}.`);
    return { deleted: true as const };
  },
});

export const providerCommands = [listAiProviders, createAiProvider, updateAiProvider, deleteAiProvider] as const;
