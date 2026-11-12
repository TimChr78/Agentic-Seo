import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// The foundation tables (Phase 0 task B) and the auth, members, token and agent tables (task C);
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

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id').notNull(),
    userId: text('user_id').notNull(),
    role: text('role').$type<Role>().notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

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

// --- Auth, members, tokens and agents (Phase 0 task C) ------------------------------------------
// Better Auth's own tables (user, session, account, verification, jwks and the OAuth provider's
// tables) are created by migration 0002 and managed by Better Auth itself; they are not modelled
// here because the auth package talks to them with SQL through the owner connection.

export const invitations = pgTable(
  'invitations',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    email: text('email').notNull(),
    role: text('role').$type<Role>().notNull(),
    tokenHash: text('token_hash').notNull(),
    invitedBy: text('invited_by').notNull(),
    status: text('status').$type<'pending' | 'accepted' | 'revoked'>().notNull().default('pending'),
    acceptedBy: text('accepted_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    decidedAt: ts('decided_at'),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    uniqueIndex('invitations_open').on(t.workspaceId, sql`lower(${t.email})`).where(sql`${t.status} = 'pending'`),
  ],
);

export const apiTokens = pgTable(
  'api_tokens',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    tokenHint: text('token_hint').notNull(),
    scopes: text('scopes').array().notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at'),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const apiTokenChanges = pgTable(
  'api_token_changes',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    tokenId: text('token_id').notNull(),
    changedBy: text('changed_by').notNull(),
    changedAt: ts('changed_at').notNull().defaultNow(),
    changes: jsonb('changes').$type<Record<string, unknown>>().notNull(),
    steppedUp: boolean('stepped_up').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

/**
 * The workspace a person picked on the OAuth consent page, while the flow is in progress. The
 * OAuth provider reads it through `consentReferenceId` and stores the workspace on the grant; the
 * rows are keyed by the Better Auth session and never authorise anything by themselves. One row
 * per workspace lets the app role write a re-pick under RLS; the consumer takes the latest.
 */
export const oauthWorkspaceSelections = pgTable(
  'oauth_workspace_selections',
  {
    sessionId: text('session_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.workspaceId] })],
);

export type AgentStatus = 'active' | 'paused' | 'revoked';
export type AgentCredentialKind = 'api_token' | 'oauth_client';

/** Agents as first-class principals (ADR-0006): a sponsor, a status and the credentials they act with. */
export const agents = pgTable(
  'agents',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    sponsorUserId: text('sponsor_user_id').notNull(),
    status: text('status').$type<AgentStatus>().notNull().default('active'),
    statusReason: text('status_reason'),
    statusChangedBy: text('status_changed_by'),
    statusChangedAt: ts('status_changed_at'),
    /** Reserved for multi-workspace; a workspace is the tenant, so nothing uses this column. */
    brand: text('brand'),
    /** The guardian's cap on the agent until a person clears it (Phase 7); null when it has not acted. */
    guard: jsonb('guard').$type<Record<string, unknown>>(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const agentCredentials = pgTable(
  'agent_credentials',
  {
    workspaceId: uuid('workspace_id').notNull(),
    kind: text('kind').$type<AgentCredentialKind>().notNull(),
    credentialId: text('credential_id').notNull(),
    agentId: text('agent_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.kind, t.credentialId] })],
);

/**
 * How to reverse an agent action (ADR-0006 §5.4). Recorded in the ledger when the action runs;
 * `none` says plainly why it cannot be undone.
 */
export type AgentUndo =
  | { kind: 'republish'; artifactId: string; previousVersion: number | null; publishedVersion?: number }
  | { kind: 'group'; items: AgentUndo[] }
  | { kind: 'none'; reason: string };

/** The agent action ledger: every agent write with its policy decision. */
export const agentActions = pgTable(
  'agent_actions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: bigserial('id', { mode: 'number' }).notNull(),
    agentId: text('agent_id').notNull(),
    command: text('command').notNull(),
    actionClass: text('action_class').notNull(),
    decision: text('decision').$type<PolicyDecision>().notNull(),
    reasons: jsonb('reasons').$type<string[]>().notNull().default([]),
    impact: jsonb('impact').$type<Record<string, unknown>>().notNull().default({}),
    ok: boolean('ok').notNull(),
    error: text('error'),
    target: text('target'),
    surface: text('surface').notNull(),
    mandateId: text('mandate_id'),
    mandateVersion: integer('mandate_version'),
    intent: text('intent'),
    /** The level the policy engine decided at; null without a mandate. */
    level: smallint('level'),
    shadow: jsonb('shadow').$type<Record<string, unknown>>(),
    undo: jsonb('undo').$type<AgentUndo | null>(),
    undoneAt: ts('undone_at'),
    undoneBy: text('undone_by'),
    undoResult: text('undo_result'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);
