import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// The foundation tables (Phase 0 task B). Auth, members, artifacts and agents arrive in task C;
// see docs/process/porting.md for what was left out of this port.

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const ts = (name: string) => timestamp(name, { withTimezone: true });

export type ApprovalPolicy = 'none' | 'agent_changes' | 'all_publishes';
export type Role = 'owner' | 'admin' | 'editor' | 'approver' | 'viewer';
export type PolicyDecision = 'allow' | 'hold' | 'ask' | 'deny';
export type InputWarningPrincipal = 'user' | 'token' | 'oauth_client';
export type ProviderCallerType = 'person' | 'agent' | 'hosted_run' | 'schedule' | 'system';
export type ProviderCallState = 'pending' | 'submitted' | 'settled' | 'failed' | 'unknown';

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  approvalPolicy: text('approval_policy').$type<ApprovalPolicy>().notNull(),
  /** IANA time zone used to display dates in the UI. */
  timeZone: text('time_zone').notNull().default('UTC'),
  /** Workspace settings: autonomy ceilings and the agents switch (ADR-0006); empty means the defaults. */
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const auditLog = pgTable('audit_log', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  at: ts('at').notNull().defaultNow(),
  principalType: text('principal_type').notNull(),
  principalId: text('principal_id').notNull(),
  clientId: text('client_id'),
  surface: text('surface').notNull(),
  command: text('command').notNull(),
  effect: text('effect').notNull(),
  target: text('target'),
  inputHash: text('input_hash').notNull(),
  ok: boolean('ok').notNull(),
  error: text('error'),
  prevHash: text('prev_hash'),
  hash: text('hash').notNull(),
  /** The client IP when the entry did not come from a command (password reset, #191 upstream). */
  ip: text('ip'),
});

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    workspaceId: uuid('workspace_id').notNull(),
    key: text('key').notNull(),
    command: text('command').notNull(),
    inputHash: text('input_hash').notNull(),
    response: jsonb('response').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);

export const dataKeys = pgTable(
  'data_keys',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    kekId: text('kek_id').notNull(),
    wrappedKey: bytea('wrapped_key').notNull(),
    active: boolean('active').notNull().default(true),
    purpose: text('purpose').$type<'secrets' | 'identity' | 'matching'>().notNull().default('secrets'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const secrets = pgTable(
  'secrets',
  {
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    dataKeyId: text('data_key_id').notNull(),
    iv: bytea('iv').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    authTag: bytea('auth_tag').notNull(),
    updatedBy: text('updated_by').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.name] })],
);

/** Unknown command-input keys a client sent, so strict input mode can be rolled out on evidence. */
export const inputWarnings = pgTable(
  'input_warnings',
  {
    workspaceId: uuid('workspace_id').notNull(),
    principalType: text('principal_type').$type<InputWarningPrincipal>().notNull(),
    principalId: text('principal_id').notNull(),
    clientLabel: text('client_label').notNull(),
    command: text('command').notNull(),
    keyPath: text('key_path').notNull(),
    firstSeen: ts('first_seen').notNull().defaultNow(),
    lastSeen: ts('last_seen').notNull().defaultNow(),
    count: integer('count').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.principalType, t.principalId, t.command, t.keyPath] }),
    index('input_warnings_last_seen').on(t.workspaceId, t.lastSeen),
  ],
);

// The provider gateway (Phase 0 task E). Amounts are bigint micros; see 0003_providers.sql.

export const providerBudgets = pgTable(
  'provider_budgets',
  {
    workspaceId: uuid('workspace_id').notNull(),
    providerId: text('provider_id').notNull(),
    period: text('period').notNull(),
    currency: text('currency').notNull(),
    budgetMicros: bigint('budget_micros', { mode: 'number' }).notNull(),
    spentMicros: bigint('spent_micros', { mode: 'number' }).notNull().default(0),
    heldMicros: bigint('held_micros', { mode: 'number' }).notNull().default(0),
    notifiedThresholds: integer('notified_thresholds').array().$type<number[]>().notNull().default(sql`'{}'::integer[]`),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.providerId, t.period] })],
);

export const providerCalls = pgTable(
  'provider_calls',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    callerType: text('caller_type').$type<ProviderCallerType>().notNull(),
    callerId: text('caller_id').notNull(),
    purpose: text('purpose').notNull(),
    siteId: uuid('site_id'),
    providerId: text('provider_id').notNull(),
    port: text('port').notNull(),
    operation: text('operation').notNull(),
    requestHash: text('request_hash').notNull(),
    credentialKey: text('credential_key').notNull().default(''),
    propertyKey: text('property_key').notNull().default(''),
    market: text('market').notNull().default(''),
    optionsHash: text('options_hash').notNull().default(''),
    cacheKey: text('cache_key').notNull(),
    maxCostMicros: bigint('max_cost_micros', { mode: 'number' }).notNull(),
    reservedMicros: bigint('reserved_micros', { mode: 'number' }).notNull(),
    actualCostMicros: bigint('actual_cost_micros', { mode: 'number' }),
    currency: text('currency').notNull(),
    providerTaskId: text('provider_task_id'),
    state: text('state').$type<ProviderCallState>().notNull(),
    rawResponse: jsonb('raw_response').$type<unknown>(),
    rawExpiresAt: ts('raw_expires_at'),
    error: text('error'),
    budgetPeriod: text('budget_period').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    submittedAt: ts('submitted_at'),
    settledAt: ts('settled_at'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('provider_calls_workspace_idempotency').on(t.workspaceId, t.idempotencyKey),
    index('provider_calls_workspace_created').on(t.workspaceId, t.createdAt),
    index('provider_calls_state').on(t.workspaceId, t.state, t.updatedAt),
  ],
);

export const providerCache = pgTable(
  'provider_cache',
  {
    workspaceId: uuid('workspace_id').notNull(),
    cacheKey: text('cache_key').notNull(),
    providerId: text('provider_id').notNull(),
    port: text('port').notNull(),
    operation: text('operation').notNull(),
    credentialKey: text('credential_key').notNull().default(''),
    propertyKey: text('property_key').notNull().default(''),
    requestHash: text('request_hash').notNull(),
    market: text('market').notNull().default(''),
    optionsHash: text('options_hash').notNull().default(''),
    response: jsonb('response').notNull(),
    fetchedAt: ts('fetched_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.cacheKey] }), index('provider_cache_expiry').on(t.workspaceId, t.expiresAt)],
);

export const providerRateBuckets = pgTable(
  'provider_rate_buckets',
  {
    workspaceId: uuid('workspace_id').notNull(),
    providerId: text('provider_id').notNull(),
    credentialKey: text('credential_key').notNull().default(''),
    tokens: doublePrecision('tokens').notNull(),
    capacity: doublePrecision('capacity').notNull(),
    refillPerSecond: doublePrecision('refill_per_second').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.providerId, t.credentialKey] })],
);
