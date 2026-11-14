import type { PortName } from './ports';

// The adapter contract. An adapter maps one vendor to one or more ports; it may only be called
// through the gateway, which owns budgets, the cache, holds, idempotency and metering. Adapters are
// deliberately free of database access: the gateway gives them a call context and records what they
// report.

export interface CostEstimate {
  /** The most this call may cost, in millionths of `currency`. The gateway holds this amount. */
  maxCostMicros: number;
  /** ISO 4217 code, e.g. "USD". */
  currency: string;
  /** A short explanation for the estimate, shown in the UI and to agents ("1 SERP request"). */
  basis: string;
}

export interface AdapterCallResult {
  /** Normalised data; the gateway validates it against the port's response schema. */
  data: unknown;
  /** What the provider actually charged, in millionths of the call's currency. */
  actualCostMicros: number;
  providerTaskId?: string;
  /** The raw vendor payload, kept for seven days. */
  raw?: unknown;
  /** The currency the provider billed in; it must equal the reservation's, or the call is `unknown`. */
  currency?: string;
}

/** The money the gateway authorised for this call. The provider must not be asked to exceed it. */
export interface AdapterCallLimits {
  /** The hold the gateway reserved: the larger of the caller's ceiling and the bounded estimate. */
  maxCostMicros: number;
  /** ISO 4217 code of the reservation. */
  currency: string;
}

export interface AdapterCallContext {
  workspaceId: string;
  callId: string;
  /**
   * The durable call identity, persisted before dispatch. Send it to providers that accept an
   * idempotency key, so a lost response can be reconciled without a provider task id.
   */
  idempotencyKey: string;
  port: PortName;
  operation: string;
  credentialKey: string;
  propertyKey: string;
  market: string;
  options: Record<string, unknown>;
  /** Aborted when the gateway gives up waiting; the provider may still have charged. */
  signal?: AbortSignal;
  /**
   * Tell the gateway the provider accepted the task. Call it as soon as the provider returns an id,
   * before waiting for the result: a crash or timeout after this point is recorded as `unknown`,
   * never as a clean failure.
   */
  onSubmitted(providerTaskId?: string): Promise<void>;
}

export interface AdapterReconcileContext {
  workspaceId: string;
  callId: string;
  port: PortName;
  operation: string;
  credentialKey: string;
  propertyKey: string;
  market: string;
}

/**
 * What reconciliation looks up: the durable call identity always, and the provider task id when
 * one was recorded. An adapter that accepts an idempotency key can resolve a call without it.
 */
export interface AdapterReconcileRequest {
  callId: string;
  idempotencyKey: string;
  providerTaskId?: string;
}

export interface AdapterReconcileResult {
  state: 'settled' | 'failed' | 'unknown';
  actualCostMicros?: number;
  data?: unknown;
  raw?: unknown;
  providerTaskId?: string;
  /** ISO 4217 code the provider billed in; a mismatch leaves the call `unknown`. */
  currency?: string;
  error?: string;
  /** Why the call stays `unknown` (a provider outage, or no records yet). */
  reason?: string;
}

export interface AdapterRateLimit {
  /** Bucket size: how many calls may burst. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

export interface ProviderAdapter {
  /** Stable id used in routing, cache keys and metering, e.g. "dataforseo". */
  id: string;
  /** Ports this adapter can answer. */
  ports: readonly PortName[];
  /** Optional token bucket, enforced by the gateway per workspace, provider and credential. */
  rateLimit?: AdapterRateLimit;
  estimate(operation: string, request: unknown): CostEstimate | Promise<CostEstimate>;
  call(operation: string, request: unknown, ctx: AdapterCallContext, limits: AdapterCallLimits): Promise<AdapterCallResult>;
  /**
   * Resolve an `unknown` call from the provider's task status or usage API, before any retry. It
   * receives the persisted call identity as well as the task id, so an adapter that cannot look up
   * a task id can still settle from its own idempotency record.
   */
  reconcile?(request: AdapterReconcileRequest, ctx: AdapterReconcileContext): Promise<AdapterReconcileResult>;
}

/** Define an adapter with its literal id and port list preserved for routing and tests. */
export function defineAdapter<T extends ProviderAdapter>(adapter: T): T {
  return adapter;
}

/**
 * The provider accepted the request but the answer did not arrive. The call may have been charged,
 * so the gateway records it as `unknown` and keeps its budget hold until reconciliation decides.
 */
export class ProviderTimeoutError extends Error {
  readonly unknown = true as const;
  constructor(
    message: string,
    readonly providerTaskId?: string,
    readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}

/** A failure the provider reported before it accepted the request (bad key, quota, invalid input). */
export class ProviderCallError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ProviderCallError';
  }
}

export function isUnknownCallError(err: unknown): err is { unknown: true; providerTaskId?: string; raw?: unknown } {
  return typeof err === 'object' && err !== null && (err as { unknown?: unknown }).unknown === true;
}
