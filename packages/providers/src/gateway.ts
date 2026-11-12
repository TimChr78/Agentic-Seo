import { AppError, hashValue, newUuid } from '@agentic-seo/core';
import type { Db, Tx } from '@agentic-seo/db';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  type AdapterCallContext,
  type AdapterReconcileContext,
  type CostEstimate,
  isUnknownCallError,
  type ProviderAdapter,
} from './adapter';
import { operationDefinition, PORTS, type PortName } from './ports';

// The provider gateway is the only path from a feature to a paid or rate-limited API. It owns the
// estimate, the budget hold, the cache, the durable call lifecycle, rate limiting and metering.
// Adapters never see the database; features never see an adapter.

export type CallerType = 'person' | 'agent' | 'hosted_run' | 'schedule' | 'system';
export type CallState = 'pending' | 'submitted' | 'settled' | 'failed' | 'unknown';

export interface Caller {
  type: CallerType;
  id: string;
}

export interface ProviderCallInput {
  workspaceId: string;
  port: PortName;
  operation: string;
  request: unknown;
  caller: Caller;
  /** Why the call is being made, e.g. "keyword research for the pricing page". */
  purpose: string;
  siteId?: string | null;
  /** A caller-supplied key: the same key never charges twice. One is generated when omitted. */
  idempotencyKey?: string;
  /** The credential or property the call is scoped to; part of the cache key. */
  credentialKey?: string;
  /** A Google property (GSC/GA4) or similar tenant-like key; Google data never crosses it. */
  propertyKey?: string;
  market?: string;
  options?: Record<string, unknown>;
  /** The ceiling the caller (or the agent's mandate) authorises. Defaults to the adapter's estimate. */
  maxCostMicros?: number;
  /** Return the estimate without spending. */
  estimate?: boolean;
  /** Bypass a cache hit (the new response still refreshes the cache). */
  refresh?: boolean;
  /** Force one adapter instead of the workspace's routing. */
  providerId?: string;
  /** Budget period override (YYYY-MM); defaults to the current UTC month. */
  period?: string;
}

export interface ProviderEstimateResult {
  providerId: string;
  maxCostMicros: number;
  currency: string;
  basis: string;
  /** True when the same request is already cached and would be answered for free. */
  cached: boolean;
}

export interface ProviderCallResult<T = unknown> {
  data: T;
  providerId: string;
  callId: string | null;
  cache: 'hit' | 'miss';
  fetchedAt: string;
  actualCostMicros: number;
  currency: string;
  providerTaskId?: string;
}

export interface BudgetView {
  providerId: string;
  period: string;
  currency: string;
  budgetMicros: number;
  spentMicros: number;
  heldMicros: number;
  remainingMicros: number;
}

export interface SpendRow {
  providerId: string;
  period: string;
  callerType: CallerType;
  siteId: string | null;
  calls: number;
  costMicros: number;
  currency: string;
}

export interface BudgetThresholdEvent {
  workspaceId: string;
  providerId: string;
  period: string;
  threshold: 50 | 80 | 100;
  budgetMicros: number;
  spentMicros: number;
  heldMicros: number;
  currency: string;
}

export interface ReconcileResult {
  callId: string;
  state: CallState;
  actualCostMicros: number | null;
  data?: unknown;
}

export interface ReconcileAbandonedResult {
  failed: number;
  settled: number;
  unknown: number;
}

export type ProviderRouting = Partial<Record<PortName, string | readonly string[]>>;
export type RoutingResolver = (request: {
  workspaceId: string;
  port: PortName;
}) => ProviderRouting | null | Promise<ProviderRouting | null>;

export interface ProviderGatewayOptions {
  db: Db;
  adapters: readonly ProviderAdapter[];
  /** A static routing table or a resolver; when absent, the workspace's `settings.providers.routing` is used. */
  routing?: ProviderRouting | RoutingResolver;
  now?: () => Date;
  /** Called after a settlement crosses 50, 80 or 100% of a budget. A throwing hook never fails the call. */
  onBudgetThreshold?: (event: BudgetThresholdEvent) => void | Promise<void>;
}

export interface ProviderGateway {
  call(input: ProviderCallInput & { estimate: true }): Promise<ProviderEstimateResult>;
  call<T = unknown>(input: ProviderCallInput & { estimate?: false }): Promise<ProviderCallResult<T>>;
  estimate(input: Omit<ProviderCallInput, 'estimate'>): Promise<ProviderEstimateResult>;
  reconcileUnknown(callId: string): Promise<ReconcileResult>;
  reconcileAbandoned(options?: { olderThanMinutes?: number; unknownOlderThanMinutes?: number }): Promise<ReconcileAbandonedResult>;
  purgeRawResponses(at?: Date): Promise<number>;
  budgets(input: { workspaceId: string; period?: string; tx?: Tx }): Promise<BudgetView[]>;
  setBudget(input: {
    workspaceId: string;
    providerId: string;
    period?: string;
    currency: string;
    budgetMicros: number;
    tx?: Tx;
  }): Promise<BudgetView>;
  spend(input: {
    workspaceId: string;
    period?: string;
    providerId?: string;
    callerType?: CallerType;
    siteId?: string;
    tx?: Tx;
  }): Promise<SpendRow[]>;
  currentPeriod(): string;
}

interface CallRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  idempotency_key: string;
  caller_type: CallerType;
  caller_id: string;
  purpose: string;
  site_id: string | null;
  provider_id: string;
  port: PortName;
  operation: string;
  request_hash: string;
  credential_key: string;
  property_key: string;
  market: string;
  options_hash: string;
  cache_key: string;
  max_cost_micros: string;
  reserved_micros: string;
  actual_cost_micros: string | null;
  currency: string;
  provider_task_id: string | null;
  state: CallState;
  error: string | null;
  budget_period: string;
  created_at: Date;
  updated_at: Date;
}

interface BudgetRow extends Record<string, unknown> {
  budget_micros: string;
  spent_micros: string;
  held_micros: string;
  currency: string;
  notified_thresholds: number[];
}

interface CacheRow extends Record<string, unknown> {
  response: unknown;
  fetched_at: Date | string;
}

const THRESHOLDS = [50, 80, 100] as const;

export class ProviderUnavailableError extends AppError {
  constructor(port: PortName, unlock: { key: string; label: string }) {
    super(
      'precondition_failed',
      `${port} is not available: no adapter is configured for it. Add ${unlock.label} in Settings → Connections.`,
      { port, key: unlock.key },
    );
    this.name = 'ProviderUnavailableError';
  }
}

export class ProviderBudgetError extends AppError {
  constructor(message: string, details: Record<string, unknown>) {
    super('precondition_failed', message, details);
    this.name = 'ProviderBudgetError';
  }
}

export class ProviderCostError extends AppError {
  constructor(message: string, details?: unknown) {
    super('precondition_failed', message, details);
    this.name = 'ProviderCostError';
  }
}

export class ProviderRateLimitError extends AppError {
  constructor(providerId: string) {
    super(
      'conflict',
      `The ${providerId} rate limit is exhausted for this credential. Wait a moment, then retry, or use a different credential.`,
      { providerId },
    );
    this.name = 'ProviderRateLimitError';
  }
}

export class ProviderCallUnknownError extends AppError {
  constructor(
    message: string,
    readonly callId: string,
    details?: Record<string, unknown>,
  ) {
    super('conflict', message, { callId, state: 'unknown', ...details });
    this.name = 'ProviderCallUnknownError';
  }
}

const micros = (value: string | number | null | undefined): number => {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number(value);
};

const money = (value: number, currency: string): string => `${currency} ${(value / 1_000_000).toFixed(4)}`;
const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

export function periodOf(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function createProviderGateway(options: ProviderGatewayOptions): ProviderGateway {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const adapters = new Map<string, ProviderAdapter>();
  for (const adapter of options.adapters) {
    if (adapters.has(adapter.id)) throw new Error(`Two provider adapters share the id "${adapter.id}".`);
    adapters.set(adapter.id, adapter);
  }

  const currentPeriod = () => periodOf(now());

  function routingFromSettings(workspaceId: string, port: PortName): Promise<string | readonly string[] | null> {
    return db.withWorkspace(workspaceId, (tx) => routingFromSettingsIn(tx, port));
  }

  async function routingFromSettingsIn(tx: Tx, port: PortName): Promise<string | readonly string[] | null> {
    const { rows } = await tx.execute<{ settings: unknown }>(sql`SELECT settings FROM workspaces`);
    const settings = (rows[0]?.settings ?? {}) as {
      providers?: { routing?: Partial<Record<PortName, string | string[]>>; overrides?: Partial<Record<PortName, string | string[]>> };
    };
    return settings.providers?.overrides?.[port] ?? settings.providers?.routing?.[port] ?? null;
  }

  async function configuredRouting(workspaceId: string, port: PortName): Promise<string | readonly string[] | null> {
    if (typeof options.routing === 'function') {
      const routing = await options.routing({ workspaceId, port });
      return routing?.[port] ?? null;
    }
    if (options.routing) return options.routing[port] ?? null;
    return routingFromSettings(workspaceId, port);
  }

  function normaliseRouting(value: string | readonly string[] | null): string[] {
    if (value === null) return [];
    if (typeof value === 'string') return [value];
    if (Array.isArray(value) && value.every((id) => typeof id === 'string')) return [...value];
    throw new AppError('precondition_failed', 'Provider routing is malformed. Each port routes to an adapter id or a list of ids.');
  }

  async function resolveChain(workspaceId: string, port: PortName, providerId?: string): Promise<ProviderAdapter[]> {
    if (providerId) {
      const adapter = adapters.get(providerId);
      if (!adapter) throw new AppError('precondition_failed', `The adapter "${providerId}" is not configured on this server.`);
      if (!adapter.ports.includes(port)) throw new AppError('precondition_failed', `The adapter "${providerId}" does not support ${port}.`);
      return [adapter];
    }
    const routed = normaliseRouting(await configuredRouting(workspaceId, port));
    if (routed.length) {
      return routed.map((id) => {
        const adapter = adapters.get(id);
        if (!adapter) throw new AppError('precondition_failed', `Provider routing for ${port} names "${id}", which is not configured.`);
        if (!adapter.ports.includes(port))
          throw new AppError('precondition_failed', `Provider routing for ${port} names "${id}", which does not support it.`);
        return adapter;
      });
    }
    return options.adapters.filter((adapter) => adapter.ports.includes(port));
  }

  function parseRequest(op: { request: z.ZodType }, port: PortName, operation: string, request: unknown): unknown {
    const parsed = op.request.safeParse(request);
    if (!parsed.success)
      throw new AppError('invalid_input', `The request for ${port}.${operation} is invalid.`, z.treeifyError(parsed.error));
    return parsed.data;
  }

  async function chooseAdapter(input: ProviderCallInput): Promise<ProviderAdapter> {
    const chain = await resolveChain(input.workspaceId, input.port, input.providerId);
    const adapter = chain[0];
    if (!adapter) throw new ProviderUnavailableError(input.port, PORTS[input.port].unlock);
    return adapter;
  }

  async function estimateOf(adapter: ProviderAdapter, operation: string, request: unknown): Promise<CostEstimate> {
    const estimate = await adapter.estimate(operation, request);
    if (
      !estimate ||
      !Number.isFinite(estimate.maxCostMicros) ||
      estimate.maxCostMicros < 0 ||
      !/^[A-Z]{3}$/.test(estimate.currency) ||
      typeof estimate.basis !== 'string'
    )
      throw new ProviderCostError(
        `${adapter.id} cannot bound the cost of ${operation}, so the call was refused. Its adapter must return a finite maxCostMicros, a currency and a basis.`,
        { providerId: adapter.id, operation },
      );
    return { ...estimate, maxCostMicros: Math.ceil(estimate.maxCostMicros) };
  }

  interface CacheKeyParts {
    workspaceId: string;
    providerId: string;
    port: PortName;
    operation: string;
    credentialKey: string;
    propertyKey: string;
    market: string;
    requestHash: string;
    optionsHash: string;
    cacheKey: string;
  }

  function cacheParts(input: ProviderCallInput, providerId: string, request: unknown): CacheKeyParts {
    const credentialKey = input.credentialKey ?? '';
    const propertyKey = input.propertyKey ?? '';
    const market = input.market ?? '';
    const requestHash = hashValue(request);
    const optionsHash = hashValue(input.options ?? {});
    const cacheKey = hashValue({
      workspaceId: input.workspaceId,
      providerId,
      port: input.port,
      operation: input.operation,
      credentialKey,
      propertyKey,
      request: requestHash,
      market,
      options: optionsHash,
    });
    return {
      workspaceId: input.workspaceId,
      providerId,
      port: input.port,
      operation: input.operation,
      credentialKey,
      propertyKey,
      market,
      requestHash,
      optionsHash,
      cacheKey,
    };
  }

  async function readCache(tx: Tx, workspaceId: string, cacheKey: string): Promise<CacheRow | null> {
    const { rows } = await tx.execute<CacheRow>(
      sql`SELECT response, fetched_at FROM provider_cache WHERE workspace_id = ${workspaceId} AND cache_key = ${cacheKey} AND expires_at > now()`,
    );
    return rows[0] ?? null;
  }

  async function writeCache(tx: Tx, parts: CacheKeyParts, data: unknown, ttlSeconds: number, fetchedAt: Date): Promise<void> {
    if (ttlSeconds <= 0) return;
    await tx.execute(
      sql`INSERT INTO provider_cache (workspace_id, cache_key, provider_id, port, operation, credential_key, property_key, request_hash, market, options_hash, response, fetched_at, expires_at)
          VALUES (${parts.workspaceId}, ${parts.cacheKey}, ${parts.providerId}, ${parts.port}, ${parts.operation}, ${parts.credentialKey},
                  ${parts.propertyKey}, ${parts.requestHash}, ${parts.market}, ${parts.optionsHash}, ${JSON.stringify(data)}::jsonb,
                  ${fetchedAt}::timestamptz, ${fetchedAt}::timestamptz + ${ttlSeconds} * interval '1 second')
          ON CONFLICT (workspace_id, cache_key) DO UPDATE
            SET response = EXCLUDED.response, fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at`,
    );
  }

  async function readCacheByCall(tx: Tx, call: CallRow): Promise<CacheRow | null> {
    const { rows } = await tx.execute<CacheRow>(
      sql`SELECT response, fetched_at FROM provider_cache WHERE workspace_id = ${call.workspace_id} AND cache_key = ${call.cache_key} AND expires_at > now()`,
    );
    return rows[0] ?? null;
  }

  async function holdBudget(tx: Tx, workspaceId: string, providerId: string, period: string, currency: string, hold: number) {
    if (hold <= 0) return;
    const { rows } = await tx.execute<BudgetRow>(
      sql`UPDATE provider_budgets
             SET held_micros = held_micros + ${hold}, updated_at = now()
           WHERE workspace_id = ${workspaceId} AND provider_id = ${providerId} AND period = ${period}
             AND currency = ${currency}
             AND budget_micros - spent_micros - held_micros >= ${hold}
           RETURNING budget_micros::text, spent_micros::text, held_micros::text, currency, notified_thresholds`,
    );
    if (rows.length) return;

    const existing = await tx.execute<BudgetRow>(
      sql`SELECT budget_micros::text, spent_micros::text, held_micros::text, currency, notified_thresholds
            FROM provider_budgets
           WHERE workspace_id = ${workspaceId} AND provider_id = ${providerId} AND period = ${period}`,
    );
    const budget = existing.rows[0];
    if (!budget)
      throw new ProviderBudgetError(
        `No monthly budget is set for ${providerId} in ${period}. A workspace admin can set one in Settings → Usage → Budgets.`,
        { providerId, period, currency },
      );
    if (budget.currency !== currency)
      throw new ProviderBudgetError(
        `The ${providerId} budget for ${period} is in ${budget.currency}, but this call estimates in ${currency}. Set the budget in ${currency}, or route the port to an adapter that bills in ${budget.currency}.`,
        { providerId, period, currency, budgetCurrency: budget.currency },
      );
    const budgetMicros = micros(budget.budget_micros);
    const spentMicros = micros(budget.spent_micros);
    const heldMicros = micros(budget.held_micros);
    throw new ProviderBudgetError(
      `The ${providerId} monthly budget for ${period} is fully committed: ${money(spentMicros, currency)} spent and ${money(heldMicros, currency)} held of ${money(budgetMicros, currency)}. A workspace admin can raise it in Settings → Usage → Budgets.`,
      { providerId, period, currency, budgetMicros, spentMicros, heldMicros },
    );
  }

  async function releaseBudget(tx: Tx, workspaceId: string, providerId: string, period: string, reserved: number): Promise<void> {
    if (reserved <= 0) return;
    await tx.execute(
      sql`UPDATE provider_budgets
             SET held_micros = GREATEST(0, held_micros - ${reserved}), updated_at = now()
           WHERE workspace_id = ${workspaceId} AND provider_id = ${providerId} AND period = ${period}`,
    );
  }

  async function settleBudget(
    tx: Tx,
    workspaceId: string,
    providerId: string,
    period: string,
    reserved: number,
    actual: number,
  ): Promise<BudgetThresholdEvent[]> {
    if (reserved <= 0 && actual <= 0) return [];
    const { rows } = await tx.execute<BudgetRow>(
      sql`SELECT budget_micros::text, spent_micros::text, held_micros::text, currency, notified_thresholds
            FROM provider_budgets
           WHERE workspace_id = ${workspaceId} AND provider_id = ${providerId} AND period = ${period}
           FOR UPDATE`,
    );
    const budget = rows[0];
    if (!budget) return [];

    const budgetMicros = micros(budget.budget_micros);
    const beforeSpent = micros(budget.spent_micros);
    const beforeHeld = micros(budget.held_micros);
    const afterSpent = beforeSpent + actual;
    const afterHeld = Math.max(0, beforeHeld - reserved);
    const notified = budget.notified_thresholds ?? [];

    const crossed = THRESHOLDS.filter(
      (threshold) =>
        !notified.includes(threshold) &&
        budgetMicros > 0 &&
        afterSpent * 100 >= budgetMicros * threshold &&
        beforeSpent * 100 < budgetMicros * threshold,
    );

    await tx.execute(
      sql`UPDATE provider_budgets
             SET spent_micros = spent_micros + ${actual}, held_micros = GREATEST(0, held_micros - ${reserved}), updated_at = now()
           WHERE workspace_id = ${workspaceId} AND provider_id = ${providerId} AND period = ${period}`,
    );
    for (const threshold of crossed)
      await tx.execute(
        sql`UPDATE provider_budgets
               SET notified_thresholds = array_append(notified_thresholds, ${threshold})
             WHERE workspace_id = ${workspaceId} AND provider_id = ${providerId} AND period = ${period}
               AND NOT (${threshold} = ANY(notified_thresholds))`,
      );

    return crossed.map((threshold) => ({
      workspaceId,
      providerId,
      period,
      threshold,
      budgetMicros,
      spentMicros: afterSpent,
      heldMicros: afterHeld,
      currency: budget.currency,
    }));
  }

  async function consumeRateToken(tx: Tx, workspaceId: string, adapter: ProviderAdapter, credentialKey: string): Promise<void> {
    const limit = adapter.rateLimit;
    if (!limit) return;
    const capacity = limit.capacity;
    const refill = limit.refillPerSecond;
    if (!Number.isFinite(capacity) || capacity < 1 || !Number.isFinite(refill) || refill < 0)
      throw new AppError('precondition_failed', `The ${adapter.id} adapter has an invalid rate limit.`);
    const { rows } = await tx.execute<{ tokens: number }>(
      sql`INSERT INTO provider_rate_buckets (workspace_id, provider_id, credential_key, tokens, capacity, refill_per_second, updated_at)
            VALUES (${workspaceId}, ${adapter.id}, ${credentialKey}, ${capacity - 1}, ${capacity}, ${refill}, now())
          ON CONFLICT (workspace_id, provider_id, credential_key) DO UPDATE
            SET tokens = LEAST(${capacity}, provider_rate_buckets.tokens + EXTRACT(EPOCH FROM (now() - provider_rate_buckets.updated_at)) * ${refill}) - 1,
                capacity = ${capacity}, refill_per_second = ${refill}, updated_at = now()
          WHERE LEAST(${capacity}, provider_rate_buckets.tokens + EXTRACT(EPOCH FROM (now() - provider_rate_buckets.updated_at)) * ${refill}) >= 1
          RETURNING tokens`,
    );
    if (!rows.length) throw new ProviderRateLimitError(adapter.id);
  }

  async function findCallByIdempotency(tx: Tx, workspaceId: string, key: string): Promise<CallRow | null> {
    const { rows } = await tx.execute<CallRow>(
      sql`SELECT * FROM provider_calls WHERE workspace_id = ${workspaceId} AND idempotency_key = ${key}`,
    );
    return rows[0] ?? null;
  }

  async function reserveCall(args: {
    input: ProviderCallInput;
    providerId: string;
    parts: CacheKeyParts;
    maxCostMicros: number;
    currency: string;
    period: string;
    idempotencyKey: string;
  }): Promise<{ callId: string; existing?: CallRow }> {
    const { input, providerId, parts, maxCostMicros, currency, period, idempotencyKey } = args;
    return db.withWorkspace(input.workspaceId, async (tx) => {
      if (input.idempotencyKey) {
        // Serialise retries of one key: the second request waits, then sees the row the first wrote.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`provider:${input.workspaceId}:${idempotencyKey}`}, 0))`);
        const existing = await findCallByIdempotency(tx, input.workspaceId, idempotencyKey);
        if (existing) return { callId: existing.id, existing };
      }
      const adapter = adapters.get(providerId);
      if (!adapter) throw new AppError('precondition_failed', `The adapter "${providerId}" is not configured on this server.`);
      await consumeRateToken(tx, input.workspaceId, adapter, parts.credentialKey);
      await holdBudget(tx, input.workspaceId, providerId, period, currency, maxCostMicros);

      const callId = newUuid();
      await tx.execute(
        sql`INSERT INTO provider_calls (
              id, workspace_id, idempotency_key, caller_type, caller_id, purpose, site_id, provider_id, port, operation,
              request_hash, credential_key, property_key, market, options_hash, cache_key, max_cost_micros, reserved_micros,
              currency, budget_period, state
            ) VALUES (
              ${callId}, ${input.workspaceId}, ${idempotencyKey}, ${input.caller.type}, ${input.caller.id}, ${input.purpose},
              ${input.siteId ?? null}, ${providerId}, ${input.port}, ${input.operation}, ${parts.requestHash}, ${parts.credentialKey},
              ${parts.propertyKey}, ${parts.market}, ${parts.optionsHash}, ${parts.cacheKey}, ${maxCostMicros}, ${maxCostMicros},
              ${currency}, ${period}, 'pending'
            )`,
      );
      return { callId };
    });
  }

  async function updateSubmitted(workspaceId: string, callId: string, providerTaskId?: string): Promise<void> {
    await db.withWorkspace(workspaceId, async (tx) => {
      await tx.execute(
        sql`UPDATE provider_calls
               SET state = 'submitted', provider_task_id = COALESCE(${providerTaskId ?? null}, provider_task_id),
                   submitted_at = COALESCE(submitted_at, now()), updated_at = now()
             WHERE id = ${callId} AND state IN ('pending', 'submitted')`,
      );
    });
  }

  async function markUnknown(workspaceId: string, callId: string, message: string, providerTaskId?: string): Promise<void> {
    await db.withWorkspace(workspaceId, async (tx) => {
      await tx.execute(
        sql`UPDATE provider_calls
               SET state = 'unknown', provider_task_id = COALESCE(${providerTaskId ?? null}, provider_task_id),
                   error = ${message.slice(0, 1_000)}, updated_at = now()
             WHERE id = ${callId} AND state NOT IN ('settled', 'failed')`,
      );
    });
  }

  async function failCall(workspaceId: string, callId: string, message: string, providerTaskId?: string): Promise<void> {
    await db.withWorkspace(workspaceId, async (tx) => {
      const { rows } = await tx.execute<CallRow>(sql`SELECT * FROM provider_calls WHERE id = ${callId} FOR UPDATE`);
      const call = rows[0];
      if (!call || call.state === 'settled' || call.state === 'failed') return;
      await releaseBudget(tx, workspaceId, call.provider_id, call.budget_period, micros(call.reserved_micros));
      await tx.execute(
        sql`UPDATE provider_calls
               SET state = 'failed', actual_cost_micros = 0, provider_task_id = COALESCE(${providerTaskId ?? null}, provider_task_id),
                   error = ${message.slice(0, 1_000)}, settled_at = now(), updated_at = now()
             WHERE id = ${callId}`,
      );
    });
  }

  async function settleCall(
    workspaceId: string,
    callId: string,
    args: { actualCostMicros: number; providerTaskId?: string; raw?: unknown; data?: unknown; ttlSeconds: number },
  ): Promise<{ events: BudgetThresholdEvent[]; fetchedAt: string }> {
    const fetchedAt = now();
    return db.withWorkspace(workspaceId, async (tx) => {
      const { rows } = await tx.execute<CallRow>(sql`SELECT * FROM provider_calls WHERE id = ${callId} FOR UPDATE`);
      const call = rows[0];
      if (!call) throw new AppError('not_found', `Provider call ${callId} does not exist.`);
      if (call.state === 'settled') return { events: [], fetchedAt: fetchedAt.toISOString() };
      const actual = Math.max(0, Math.ceil(args.actualCostMicros));
      const parts: CacheKeyParts = {
        workspaceId,
        providerId: call.provider_id,
        port: call.port,
        operation: call.operation,
        credentialKey: call.credential_key,
        propertyKey: call.property_key,
        market: call.market,
        requestHash: call.request_hash,
        optionsHash: call.options_hash,
        cacheKey: call.cache_key,
      };
      const events = await settleBudget(tx, workspaceId, call.provider_id, call.budget_period, micros(call.reserved_micros), actual);
      await tx.execute(
        sql`UPDATE provider_calls
               SET state = 'settled', actual_cost_micros = ${actual}, provider_task_id = COALESCE(${args.providerTaskId ?? null}, provider_task_id),
                   raw_response = ${args.raw === undefined ? null : JSON.stringify(args.raw)}::jsonb,
                   raw_expires_at = now() + interval '7 days', error = NULL, settled_at = now(), updated_at = now()
             WHERE id = ${callId}`,
      );
      if (args.data !== undefined) await writeCache(tx, parts, args.data, args.ttlSeconds, fetchedAt);
      return { events, fetchedAt: fetchedAt.toISOString() };
    });
  }

  async function fireThresholds(events: BudgetThresholdEvent[]): Promise<void> {
    if (!options.onBudgetThreshold) return;
    for (const event of events) {
      try {
        await options.onBudgetThreshold(event);
      } catch {
        // A notification hook must never change the result of a call that already ran.
      }
    }
  }

  async function estimateInternal(
    adapter: ProviderAdapter,
    input: ProviderCallInput,
    op: { ttlSeconds: number },
    request: unknown,
    estimate: CostEstimate,
  ): Promise<ProviderEstimateResult> {
    const parts = cacheParts(input, adapter.id, request);
    const cached =
      op.ttlSeconds > 0 && !input.refresh
        ? (await db.withWorkspace(input.workspaceId, (tx) => readCache(tx, input.workspaceId, parts.cacheKey))) !== null
        : false;
    return { providerId: adapter.id, maxCostMicros: estimate.maxCostMicros, currency: estimate.currency, basis: estimate.basis, cached };
  }

  async function handleExisting<T>(existing: CallRow, input: ProviderCallInput, parts: CacheKeyParts): Promise<ProviderCallResult<T>> {
    if (
      existing.provider_id !== parts.providerId ||
      existing.port !== parts.port ||
      existing.operation !== parts.operation ||
      existing.request_hash !== parts.requestHash ||
      existing.credential_key !== parts.credentialKey ||
      existing.property_key !== parts.propertyKey ||
      existing.market !== parts.market ||
      existing.options_hash !== parts.optionsHash
    )
      throw new AppError('conflict', 'This idempotency key was already used for a different provider request. Use a new key.');

    if (existing.state === 'unknown') {
      const reconciled = await reconcileCall(existing);
      if (reconciled.state === 'settled' && reconciled.data !== undefined)
        return {
          data: reconciled.data as T,
          providerId: existing.provider_id,
          callId: existing.id,
          cache: 'miss',
          fetchedAt: now().toISOString(),
          actualCostMicros: reconciled.actualCostMicros ?? 0,
          currency: existing.currency,
        };
      throw new ProviderCallUnknownError(
        `Provider call ${existing.id} is still unknown. Reconcile it before retrying; a blind retry could charge twice.`,
        existing.id,
        { providerTaskId: existing.provider_task_id },
      );
    }
    if (existing.state === 'settled') {
      const cached = await db.withWorkspace(input.workspaceId, (tx) => readCacheByCall(tx, existing));
      if (cached)
        return {
          data: cached.response as T,
          providerId: existing.provider_id,
          callId: existing.id,
          cache: 'hit',
          fetchedAt: iso(cached.fetched_at),
          actualCostMicros: 0,
          currency: existing.currency,
        };
      throw new AppError(
        'conflict',
        `This idempotency key already settled a call, and its cached response has expired. Use a new key for a fresh call.`,
        { callId: existing.id },
      );
    }
    if (existing.state === 'failed')
      throw new AppError('conflict', 'This idempotency key belongs to a failed provider call. Use a new key, or fix the cause and retry.', {
        callId: existing.id,
      });
    throw new AppError('conflict', `Provider call ${existing.id} is still ${existing.state}. Wait for it to finish instead of retrying.`, {
      callId: existing.id,
    });
  }

  async function call<T>(input: ProviderCallInput): Promise<ProviderEstimateResult | ProviderCallResult<T>> {
    const op = operationDefinition(input.port, input.operation);
    const request = parseRequest(op, input.port, input.operation, input.request);
    const adapter = await chooseAdapter(input);
    const estimate = await estimateOf(adapter, input.operation, request);
    if (input.estimate) return estimateInternal(adapter, input, op, request, estimate);

    const parts = cacheParts(input, adapter.id, request);
    const period = input.period ?? currentPeriod();
    const maxCostMicros = input.maxCostMicros ?? estimate.maxCostMicros;
    if (!Number.isInteger(maxCostMicros) || maxCostMicros < 0)
      throw new ProviderCostError('The maximum authorised cost must be a whole, non-negative number of micros.', { maxCostMicros });

    if (op.ttlSeconds > 0 && !input.refresh) {
      const cached = await db.withWorkspace(input.workspaceId, (tx) => readCache(tx, input.workspaceId, parts.cacheKey));
      if (cached)
        return {
          data: cached.response as T,
          providerId: adapter.id,
          callId: null,
          cache: 'hit',
          fetchedAt: iso(cached.fetched_at),
          actualCostMicros: 0,
          currency: estimate.currency,
        };
    }

    const idempotencyKey = input.idempotencyKey ?? newUuid();
    const reservation = await reserveCall({
      input,
      providerId: adapter.id,
      parts,
      maxCostMicros,
      currency: estimate.currency,
      period,
      idempotencyKey,
    });
    if (reservation.existing) return handleExisting<T>(reservation.existing, input, parts);
    const { callId } = reservation;

    let submitted = false;
    let submittedTaskId: string | undefined;
    const ctx: AdapterCallContext = {
      workspaceId: input.workspaceId,
      callId,
      port: input.port,
      operation: input.operation,
      credentialKey: parts.credentialKey,
      propertyKey: parts.propertyKey,
      market: parts.market,
      options: input.options ?? {},
      signal: new AbortController().signal,
      async onSubmitted(providerTaskId) {
        submitted = true;
        submittedTaskId = providerTaskId;
        await updateSubmitted(input.workspaceId, callId, providerTaskId);
      },
    };

    let result: { data: unknown; actualCostMicros: number; providerTaskId?: string; raw?: unknown; currency?: string };
    try {
      result = await adapter.call(input.operation, request, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const unknownError = isUnknownCallError(err);
      const taskId = unknownError ? err.providerTaskId : submittedTaskId;
      if (unknownError || submitted) {
        await markUnknown(input.workspaceId, callId, message, taskId);
        throw new ProviderCallUnknownError(
          `${input.port}.${input.operation} may have been charged: the provider did not answer in time. Call ${callId} is recorded as unknown; reconcile it before retrying.`,
          callId,
          { providerTaskId: taskId, cause: message },
        );
      }
      await failCall(input.workspaceId, callId, message, taskId);
      if (err instanceof AppError) throw err;
      throw new AppError('precondition_failed', `The ${adapter.id} adapter failed on ${input.port}.${input.operation}: ${message}`, {
        providerId: adapter.id,
        callId,
      });
    }

    if (!Number.isFinite(result.actualCostMicros) || result.actualCostMicros < 0) {
      const message = `The ${adapter.id} adapter did not report a valid actual cost for ${input.port}.${input.operation}.`;
      await markUnknown(input.workspaceId, callId, message, result.providerTaskId);
      throw new AppError('precondition_failed', message, { providerId: adapter.id, callId });
    }
    const actualCostMicros = Math.max(0, Math.ceil(result.actualCostMicros));
    let data: unknown;
    try {
      data = op.response.parse(result.data);
    } catch (err) {
      const message = `The ${adapter.id} adapter returned data that does not match ${input.port}.${input.operation}.`;
      await markUnknown(input.workspaceId, callId, message, result.providerTaskId);
      throw new AppError('precondition_failed', message, {
        providerId: adapter.id,
        callId,
        issues: err instanceof Error ? err.message : String(err),
      });
    }

    const settled = await settleCall(input.workspaceId, callId, {
      actualCostMicros,
      providerTaskId: result.providerTaskId,
      raw: result.raw,
      data,
      ttlSeconds: op.ttlSeconds,
    });
    await fireThresholds(settled.events);

    return {
      data: data as T,
      providerId: adapter.id,
      callId,
      cache: 'miss',
      fetchedAt: settled.fetchedAt,
      actualCostMicros,
      currency: result.currency ?? estimate.currency,
      ...(result.providerTaskId === undefined ? {} : { providerTaskId: result.providerTaskId }),
    };
  }

  async function loadCall(callId: string): Promise<CallRow | null> {
    const { rows } = await db.admin.query<CallRow>('SELECT * FROM provider_calls WHERE id = $1', [callId]);
    return rows[0] ?? null;
  }

  async function reconcileCall(call: CallRow): Promise<{ state: CallState; actualCostMicros: number | null; data?: unknown }> {
    if (call.state !== 'unknown')
      return { state: call.state, actualCostMicros: call.actual_cost_micros === null ? null : micros(call.actual_cost_micros) };
    const adapter = adapters.get(call.provider_id);
    if (!adapter)
      throw new AppError('precondition_failed', `Provider call ${call.id} uses adapter "${call.provider_id}", which is not configured.`);
    if (!adapter.reconcile)
      throw new AppError(
        'precondition_failed',
        `Provider call ${call.id} is unknown, and the ${adapter.id} adapter cannot reconcile it. Add a reconcile implementation before retrying.`,
        { callId: call.id },
      );
    if (!call.provider_task_id)
      throw new AppError(
        'precondition_failed',
        `Provider call ${call.id} is unknown and has no provider task id, so it cannot be reconciled.`,
        {
          callId: call.id,
        },
      );

    const ctx: AdapterReconcileContext = {
      workspaceId: call.workspace_id,
      callId: call.id,
      port: call.port,
      operation: call.operation,
      credentialKey: call.credential_key,
      propertyKey: call.property_key,
      market: call.market,
    };
    const result = await adapter.reconcile(call.provider_task_id, ctx);

    if (result.state === 'settled') {
      const actual = result.actualCostMicros ?? micros(call.max_cost_micros);
      let data: unknown;
      if (result.data !== undefined) {
        const op = operationDefinition(call.port, call.operation);
        data = op.response.parse(result.data);
      }
      const settled = await settleCall(call.workspace_id, call.id, {
        actualCostMicros: actual,
        providerTaskId: result.providerTaskId ?? call.provider_task_id,
        raw: result.raw,
        data,
        ttlSeconds: operationDefinition(call.port, call.operation).ttlSeconds,
      });
      await fireThresholds(settled.events);
      return { state: 'settled', actualCostMicros: actual, ...(data === undefined ? {} : { data }) };
    }
    if (result.state === 'failed') {
      await failCall(call.workspace_id, call.id, result.error ?? 'The provider reported that the call failed.', result.providerTaskId);
      return { state: 'failed', actualCostMicros: 0 };
    }

    await db.withWorkspace(call.workspace_id, (tx) =>
      tx.execute(sql`UPDATE provider_calls SET updated_at = now() WHERE id = ${call.id} AND state = 'unknown'`),
    );
    return { state: 'unknown', actualCostMicros: null };
  }

  async function reconcileUnknown(callId: string): Promise<ReconcileResult> {
    const call = await loadCall(callId);
    if (!call) throw new AppError('not_found', `Provider call ${callId} does not exist.`);
    if (call.state !== 'unknown')
      return { callId, state: call.state, actualCostMicros: call.actual_cost_micros === null ? null : micros(call.actual_cost_micros) };
    const result = await reconcileCall(call);
    return { callId, ...result };
  }

  // Reconciliation is a maintenance path, like the scheduler: it discovers calls across workspaces
  // with the owner connection, then performs every write scoped by db.withWorkspace under RLS.
  async function reconcileAbandoned(
    opts: { olderThanMinutes?: number; unknownOlderThanMinutes?: number } = {},
  ): Promise<ReconcileAbandonedResult> {
    const olderThanMinutes = opts.olderThanMinutes ?? 60;
    const unknownOlderThanMinutes = opts.unknownOlderThanMinutes ?? 24 * 60;
    const at = now();
    const cutoff = new Date(at.getTime() - olderThanMinutes * 60_000);
    const unknownCutoff = new Date(at.getTime() - unknownOlderThanMinutes * 60_000);
    const counts: ReconcileAbandonedResult = { failed: 0, settled: 0, unknown: 0 };

    const pending = await db.admin.query<CallRow>(
      `SELECT * FROM provider_calls WHERE state = 'pending' AND updated_at <= $1 ORDER BY created_at`,
      [cutoff],
    );
    for (const call of pending.rows) {
      const released = await db.withWorkspace(call.workspace_id, async (tx) => {
        const { rowCount } = await tx.execute(
          sql`UPDATE provider_calls
                 SET state = 'failed', actual_cost_micros = 0, error = 'The call was abandoned before it was submitted.', settled_at = now(), updated_at = now()
               WHERE id = ${call.id} AND state = 'pending' AND updated_at <= ${cutoff}`,
        );
        if (!rowCount) return false;
        await releaseBudget(tx, call.workspace_id, call.provider_id, call.budget_period, micros(call.reserved_micros));
        return true;
      });
      if (released) counts.failed += 1;
    }

    const submitted = await db.admin.query<CallRow>(
      `SELECT * FROM provider_calls WHERE state = 'submitted' AND updated_at <= $1 ORDER BY created_at`,
      [cutoff],
    );
    for (const call of submitted.rows) {
      await db.withWorkspace(call.workspace_id, (tx) =>
        tx.execute(
          sql`UPDATE provider_calls
                 SET state = 'unknown', error = 'The call was submitted but its result was never recorded.', updated_at = now()
               WHERE id = ${call.id} AND state = 'submitted' AND updated_at <= ${cutoff}`,
        ),
      );
      const refreshed = await loadCall(call.id);
      if (refreshed?.state === 'unknown' && refreshed.provider_task_id && adapters.get(refreshed.provider_id)?.reconcile) {
        try {
          const result = await reconcileCall(refreshed);
          if (result.state === 'settled') counts.settled += 1;
          else counts.unknown += 1;
        } catch {
          // A provider outage must not stop the other calls from being reconciled; keep this hold.
          counts.unknown += 1;
        }
      } else counts.unknown += 1;
    }

    const unknown = await db.admin.query<CallRow>(
      `SELECT * FROM provider_calls WHERE state = 'unknown' AND updated_at <= $1 ORDER BY created_at`,
      [unknownCutoff],
    );
    for (const call of unknown.rows) {
      try {
        const result = await reconcileCall(call);
        if (result.state === 'settled') counts.settled += 1;
        else counts.unknown += 1;
      } catch {
        counts.unknown += 1;
      }
    }

    return counts;
  }

  async function purgeRawResponses(at: Date = now()): Promise<number> {
    const result = await db.admin.query(
      `UPDATE provider_calls SET raw_response = NULL, updated_at = now() WHERE raw_expires_at IS NOT NULL AND raw_expires_at <= $1`,
      [at],
    );
    return result.rowCount ?? 0;
  }

  async function budgets(input: { workspaceId: string; period?: string; tx?: Tx }): Promise<BudgetView[]> {
    const period = input.period ?? currentPeriod();
    const run = async (tx: Tx) => {
      const { rows } = await tx.execute<{
        provider_id: string;
        period: string;
        currency: string;
        budget_micros: string;
        spent_micros: string;
        held_micros: string;
      }>(
        sql`SELECT provider_id, period, currency, budget_micros::text AS budget_micros, spent_micros::text AS spent_micros, held_micros::text AS held_micros
              FROM provider_budgets
             WHERE workspace_id = ${input.workspaceId} AND period = ${period}
             ORDER BY provider_id`,
      );
      return rows.map((row) => {
        const budgetMicros = micros(row.budget_micros);
        const spentMicros = micros(row.spent_micros);
        const heldMicros = micros(row.held_micros);
        return {
          providerId: row.provider_id,
          period: row.period,
          currency: row.currency,
          budgetMicros,
          spentMicros,
          heldMicros,
          remainingMicros: budgetMicros - spentMicros - heldMicros,
        };
      });
    };
    return input.tx ? run(input.tx) : db.withWorkspace(input.workspaceId, run);
  }

  async function setBudget(input: {
    workspaceId: string;
    providerId: string;
    period?: string;
    currency: string;
    budgetMicros: number;
    tx?: Tx;
  }): Promise<BudgetView> {
    const period = input.period ?? currentPeriod();
    if (!Number.isInteger(input.budgetMicros) || input.budgetMicros < 0)
      throw new AppError('invalid_input', 'A budget must be a whole, non-negative number of micros.');
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new AppError('invalid_input', 'A budget currency must be a three-letter uppercase code.');
    const run = async (tx: Tx) => {
      await tx.execute(
        sql`INSERT INTO provider_budgets (workspace_id, provider_id, period, currency, budget_micros)
              VALUES (${input.workspaceId}, ${input.providerId}, ${period}, ${input.currency}, ${input.budgetMicros})
            ON CONFLICT (workspace_id, provider_id, period) DO UPDATE
              SET currency = EXCLUDED.currency, budget_micros = EXCLUDED.budget_micros, updated_at = now()`,
      );
      const { rows } = await tx.execute<{
        provider_id: string;
        period: string;
        currency: string;
        budget_micros: string;
        spent_micros: string;
        held_micros: string;
      }>(
        sql`SELECT provider_id, period, currency, budget_micros::text AS budget_micros, spent_micros::text AS spent_micros, held_micros::text AS held_micros
              FROM provider_budgets WHERE workspace_id = ${input.workspaceId} AND provider_id = ${input.providerId} AND period = ${period}`,
      );
      const row = rows[0];
      if (!row) throw new AppError('precondition_failed', 'The budget was written but could not be read back.');
      const budgetMicros = micros(row.budget_micros);
      const spentMicros = micros(row.spent_micros);
      const heldMicros = micros(row.held_micros);
      return {
        providerId: row.provider_id,
        period: row.period,
        currency: row.currency,
        budgetMicros,
        spentMicros,
        heldMicros,
        remainingMicros: budgetMicros - spentMicros - heldMicros,
      };
    };
    return input.tx ? run(input.tx) : db.withWorkspace(input.workspaceId, run);
  }

  async function spend(input: {
    workspaceId: string;
    period?: string;
    providerId?: string;
    callerType?: CallerType;
    siteId?: string;
    tx?: Tx;
  }): Promise<SpendRow[]> {
    const filters = [sql`workspace_id = ${input.workspaceId}`, sql`state = 'settled'`];
    if (input.period) filters.push(sql`budget_period = ${input.period}`);
    if (input.providerId) filters.push(sql`provider_id = ${input.providerId}`);
    if (input.callerType) filters.push(sql`caller_type = ${input.callerType}`);
    if (input.siteId) filters.push(sql`site_id = ${input.siteId}`);
    const query = sql`SELECT provider_id, budget_period AS period, caller_type, site_id::text AS site_id,
                             count(*)::int AS calls, COALESCE(sum(actual_cost_micros), 0)::text AS cost_micros, min(currency) AS currency
                        FROM provider_calls
                       WHERE ${sql.join(filters, sql` AND `)}
                       GROUP BY provider_id, budget_period, caller_type, site_id
                       ORDER BY provider_id, caller_type, site_id`;
    const run = async (tx: Tx) => {
      const { rows } = await tx.execute<{
        provider_id: string;
        period: string;
        caller_type: CallerType;
        site_id: string | null;
        calls: number;
        cost_micros: string;
        currency: string;
      }>(query);
      return rows.map((row) => ({
        providerId: row.provider_id,
        period: row.period,
        callerType: row.caller_type,
        siteId: row.site_id,
        calls: row.calls,
        costMicros: micros(row.cost_micros),
        currency: row.currency,
      }));
    };
    return input.tx ? run(input.tx) : db.withWorkspace(input.workspaceId, run);
  }

  async function estimateOnly(input: Omit<ProviderCallInput, 'estimate'>): Promise<ProviderEstimateResult> {
    const op = operationDefinition(input.port, input.operation);
    const request = parseRequest(op, input.port, input.operation, input.request);
    const adapter = await chooseAdapter(input as ProviderCallInput);
    const estimate = await estimateOf(adapter, input.operation, request);
    return estimateInternal(adapter, input as ProviderCallInput, op, request, estimate);
  }

  return {
    call: call as ProviderGateway['call'],
    estimate: estimateOnly,
    reconcileUnknown,
    reconcileAbandoned,
    purgeRawResponses,
    budgets,
    setBudget,
    spend,
    currentPeriod,
  };
}

/** Exposed for tests: the string form the UI and errors use for an amount of micros. */
export function formatMicros(value: number, currency: string): string {
  return money(value, currency);
}
