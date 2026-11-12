import { bigserial, boolean, customType, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// The foundation tables (Phase 0 task B). Auth, members, artifacts and agents arrive in task C;
// see docs/process/porting.md for what was left out of this port.

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const ts = (name: string) => timestamp(name, { withTimezone: true });

export type ApprovalPolicy = 'none' | 'agent_changes' | 'all_publishes';
export type Role = 'owner' | 'admin' | 'editor' | 'approver' | 'viewer';
export type PolicyDecision = 'allow' | 'hold' | 'ask' | 'deny';
export type InputWarningPrincipal = 'user' | 'token' | 'oauth_client';

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
