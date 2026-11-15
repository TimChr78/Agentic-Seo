import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  doublePrecision,
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
export type ProviderCallerType = 'person' | 'agent' | 'hosted_run' | 'schedule' | 'system';
export type ProviderCallState = 'pending' | 'dispatching' | 'submitted' | 'settled' | 'failed' | 'unknown' | 'released';

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

// Versioned artifacts and their approvals (Phase 0 task C2). See 0004_artifacts.sql.

export type VersionState = 'draft' | 'in_review' | 'published' | 'superseded' | 'rejected';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';
export type LearningStatus = 'active' | 'retracted';

export const artifacts = pgTable(
  'artifacts',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    type: text('type').notNull(),
    name: text('name').notNull(),
    /** The site this artifact belongs to, when it is site-scoped; null is workspace-wide. */
    siteId: uuid('site_id'),
    latestVersion: integer('latest_version').notNull(),
    publishedVersion: integer('published_version'),
    archived: boolean('archived').notNull().default(false),
    /** The agent that owns this artifact; a missing agent counts as retired, never as active. */
    ownerAgentId: text('owner_agent_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    index('artifacts_type').on(t.workspaceId, t.type, t.updatedAt),
    index('artifacts_owner_agent').on(t.workspaceId, t.ownerAgentId),
    index('artifacts_site').on(t.workspaceId, t.siteId),
  ],
);

export const artifactVersions = pgTable(
  'artifact_versions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    artifactId: text('artifact_id').notNull(),
    number: integer('number').notNull(),
    state: text('state').$type<VersionState>().notNull(),
    content: jsonb('content').$type<unknown>().notNull(),
    contentHash: text('content_hash').notNull(),
    basedOn: integer('based_on'),
    authorType: text('author_type').$type<'user' | 'agent'>().notNull(),
    authorId: text('author_id').notNull(),
    authorClient: text('author_client'),
    note: text('note'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.artifactId, t.number] }),
    // Exactly one published version per artifact (#912): `publishVersion` supersedes the old
    // version before it publishes the new one, so the partial unique index never fires on the
    // normal path; a writer that skips the lock gets a 23505 the executor answers as a conflict.
    uniqueIndex('artifact_versions_one_published').on(t.workspaceId, t.artifactId).where(sql`state = 'published'`),
  ],
);

export const approvalRequests = pgTable(
  'approval_requests',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    artifactId: text('artifact_id').notNull(),
    version: integer('version').notNull(),
    status: text('status').$type<ApprovalStatus>().notNull(),
    requestedByType: text('requested_by_type').$type<'user' | 'agent'>().notNull(),
    requestedById: text('requested_by_id').notNull(),
    requestedByClient: text('requested_by_client'),
    note: text('note').notNull(),
    decidedBy: text('decided_by'),
    decidedAt: ts('decided_at'),
    decisionNote: text('decision_note'),
    /** A bundle is reviewed together: one row per artifact, sharing this id. */
    bundleId: text('bundle_id'),
    /** A held agent change runs at this time unless a person vetoes it; holds arrive in Phase 7. */
    holdUntil: ts('hold_until'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    index('approval_requests_pending').on(t.workspaceId, t.createdAt),
    index('approval_requests_bundle').on(t.workspaceId, t.bundleId),
  ],
);

export type LearningEvidence = {
  kind: 'change_set' | 'recommendation' | 'report' | 'rank_tracker' | 'ai_visibility_tracker';
  id: string;
  summary: string;
  numbers: Record<string, number>;
};

export const learnings = pgTable(
  'learnings',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    siteId: uuid('site_id'),
    statement: text('statement').notNull(),
    scope: jsonb('scope').$type<Record<string, unknown>>().notNull().default({}),
    evidence: jsonb('evidence').$type<LearningEvidence[]>().notNull().default([]),
    authorType: text('author_type').$type<'user' | 'agent'>().notNull(),
    authorId: text('author_id').notNull(),
    agentId: text('agent_id'),
    status: text('status').$type<LearningStatus>().notNull().default('active'),
    retractedBy: text('retracted_by'),
    retractedAt: ts('retracted_at'),
    retractReason: text('retract_reason'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
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
    /** The provider charged more than the hold; the actual cost is still recorded in full. */
    overrun: boolean('overrun').notNull().default(false),
    rawResponse: jsonb('raw_response').$type<unknown>(),
    rawExpiresAt: ts('raw_expires_at'),
    error: text('error'),
    budgetPeriod: text('budget_period').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    /** When the dispatch intent was committed, before any call to the provider. */
    dispatchedAt: ts('dispatched_at'),
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

// Sites, their markets and their competitors (Phase 0 task I). See 0005_sites.sql. Site ids are
// uuids like workspace ids: artifacts, learnings and provider_calls already store a uuid site_id,
// and their composite foreign keys point at (workspace_id, id) here.

export type BusinessType = 'saas' | 'local' | 'ecommerce' | 'publisher' | 'agency' | 'other';
export type SiteVerificationMethod = 'dns' | 'meta';
export type CompetitorSource = 'manual' | 'detected';

export const sites = pgTable(
  'sites',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: uuid('id').notNull(),
    name: text('name').notNull(),
    /** Lower-case ASCII domain without scheme, path, port or trailing dot (IDNA/punycode). */
    primaryDomain: text('primary_domain').notNull(),
    /** Extra hosts the site answers on, e.g. www.example.com; the primary domain is not repeated. */
    hosts: text('hosts').array().$type<string[]>().notNull().default(sql`'{}'::text[]`),
    /** Confirmed business type; null until a person or agent sets it. */
    businessType: text('business_type').$type<BusinessType>(),
    isLocalBusiness: boolean('is_local_business').notNull().default(false),
    /** Published in a DNS TXT record or a home page meta tag; never rotated silently. */
    verificationToken: text('verification_token').notNull(),
    verificationMethod: text('verification_method').$type<SiteVerificationMethod>(),
    verifiedAt: ts('verified_at'),
    verifiedBy: text('verified_by'),
    lastCheckAt: ts('last_check_at'),
    lastCheckError: text('last_check_error'),
    archived: boolean('archived').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    // One active site per domain; archived sites stay for the rows that point at them.
    uniqueIndex('sites_active_domain').on(t.workspaceId, t.primaryDomain).where(sql`archived = false`),
  ],
);

export const markets = pgTable(
  'markets',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: uuid('id').notNull(),
    siteId: uuid('site_id').notNull(),
    /** DataForSEO location code, e.g. 2840 for the United States. */
    locationCode: integer('location_code').notNull(),
    languageCode: text('language_code').notNull(),
    /** ISO 3166-1 alpha-3 country for Search Console, when it is known. */
    gscCountry: text('gsc_country'),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    uniqueIndex('markets_target').on(t.workspaceId, t.siteId, t.locationCode, t.languageCode),
    // At most one default market per site.
    uniqueIndex('markets_one_default').on(t.workspaceId, t.siteId).where(sql`is_default`),
  ],
);

export const competitors = pgTable(
  'competitors',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: uuid('id').notNull(),
    siteId: uuid('site_id').notNull(),
    /** Normalised like a site domain. */
    domain: text('domain').notNull(),
    name: text('name'),
    source: text('source').$type<CompetitorSource>().notNull().default('manual'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] }), uniqueIndex('competitors_site_domain').on(t.workspaceId, t.siteId, t.domain)],
);

// The LLM gateway (Phase 0 task J). See 0006_ai.sql.

/** The capabilities a provider can serve; each has one provider at a time. */
export type AiUse = 'agents' | 'answer_engines';
export type AiProviderKind = 'openai-compatible' | 'anthropic-compatible';
/** What a logged call was for: a choice, generated text, or a prompt test run. */
export type AiCallKind = 'decide' | 'generate' | 'test';
export type AiCallStatus = 'pending' | 'running' | 'done' | 'fallback' | 'failed';

export const aiProviders = pgTable(
  'ai_providers',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    kind: text('kind').$type<AiProviderKind>().notNull(),
    /** An https origin whose host resolves to a public address; packages/fetch's guard enforces it. */
    baseUrl: text('base_url').notNull(),
    models: jsonb('models').$type<{ default: string; fast?: string }>().notNull(),
    structuredOutputs: boolean('structured_outputs').notNull().default(true),
    useFor: text('use_for').array().$type<AiUse[]>().notNull().default([]),
    monthlyTokenBudget: bigint('monthly_token_budget', { mode: 'number' }),
    region: text('region').notNull().default(''),
    /** The sealed API key; a command never returns it, only whether one is set. */
    secrets: bytea('secrets'),
    secretsKeyId: text('secrets_key_id'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

/** A call's estimated tokens, held against the provider's monthly budget while the model runs. */
export const aiTokenReservations = pgTable(
  'ai_token_reservations',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    providerId: text('provider_id').notNull(),
    /** The ai_calls attempt this hold covers; a recovered stale attempt keeps its hold counted. */
    callId: text('call_id'),
    tokens: integer('tokens').notNull(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

/** Every model call, with what it was asked, what it answered, its tokens and latency. */
// Connections and Search Console facts (Phase 1 task B). See 0008_connections_gsc.sql.

export type ConnectionState = 'pending' | 'active' | 'error' | 'revoked';

/**
 * A connector installed for one site: settings, sealed OAuth tokens and the authorization in
 * progress. `oauthPending` is read and written by the OAuth flow only; no command returns it.
 */
export const connections = pgTable(
  'connections',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    siteId: uuid('site_id').notNull(),
    connector: text('connector').notNull(),
    label: text('label').notNull().default(''),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    /** Sealed JSON (iv + auth tag + ciphertext); opened only by the credential seam and the worker. */
    secrets: bytea('secrets'),
    secretsKeyId: text('secrets_key_id'),
    state: text('state').$type<ConnectionState>().notNull().default('pending'),
    /** Bumped when the property changes or the connection is revoked; fences an in-flight sync. */
    generation: integer('generation').notNull().default(0),
    lastError: text('last_error'),
    oauthPending: jsonb('oauth_pending').$type<Record<string, unknown>>(),
    tokenExpiresAt: ts('token_expires_at'),
    refreshLeaseUntil: ts('refresh_lease_until'),
    refreshLeaseToken: text('refresh_lease_token'),
    lastSyncRequestedAt: ts('last_sync_requested_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    uniqueIndex('connections_site_connector_live').on(t.workspaceId, t.siteId, t.connector).where(sql`state <> 'revoked'`),
    index('connections_site').on(t.workspaceId, t.siteId, t.connector),
    index('connections_refresh_due').on(t.tokenExpiresAt).where(sql`state = 'active'`),
  ],
);

/** One day of a property's totals per search type (aggregationType `byProperty`). */
export const gscPropertyTotals = pgTable(
  'gsc_property_totals',
  {
    workspaceId: uuid('workspace_id').notNull(),
    siteId: uuid('site_id').notNull(),
    property: text('property').notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    searchType: text('search_type').notNull().default('web'),
    clicks: doublePrecision('clicks').notNull(),
    impressions: doublePrecision('impressions').notNull(),
    ctr: doublePrecision('ctr').notNull(),
    position: doublePrecision('position').notNull(),
    isFinal: boolean('is_final').notNull().default(false),
    fetchedAt: ts('fetched_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.siteId, t.property, t.date, t.searchType] }),
    index('gsc_property_totals_range').on(t.workspaceId, t.siteId, t.date),
  ],
);

/** One day of page-level search data per page, country and device (aggregationType `byPage`). */
export const gscPageAggregates = pgTable(
  'gsc_page_aggregates',
  {
    workspaceId: uuid('workspace_id').notNull(),
    siteId: uuid('site_id').notNull(),
    property: text('property').notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    /** The search surface ("web" in Phase 1); in the key so Phase 2 adds types without a rewrite. */
    searchType: text('search_type').notNull().default('web'),
    page: text('page').notNull(),
    /** `page` through `normalizePageUrl`: reach and search.pages match on it, never on `page`. */
    pageKey: text('page_key').notNull(),
    /** ISO 3166-1 alpha-3, or empty when Google returned no country for the row. */
    country: text('country').notNull().default(''),
    device: text('device').notNull().default(''),
    clicks: doublePrecision('clicks').notNull(),
    impressions: doublePrecision('impressions').notNull(),
    ctr: doublePrecision('ctr').notNull(),
    position: doublePrecision('position').notNull(),
    isFinal: boolean('is_final').notNull().default(false),
    fetchedAt: ts('fetched_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.siteId, t.property, t.date, t.searchType, t.page, t.country, t.device] }),
    index('gsc_page_aggregates_range').on(t.workspaceId, t.siteId, t.date),
    index('gsc_page_aggregates_page').on(t.workspaceId, t.siteId, t.property, t.pageKey, t.date),
  ],
);

export type GscDataset = 'property_totals' | 'page_aggregates';

/** The sync watermark per site, dataset, search type and property. */
export const gscSyncState = pgTable(
  'gsc_sync_state',
  {
    workspaceId: uuid('workspace_id').notNull(),
    siteId: uuid('site_id').notNull(),
    dataset: text('dataset').$type<GscDataset>().notNull(),
    searchType: text('search_type').notNull().default('web'),
    property: text('property').notNull(),
    lastFinalDate: date('last_final_date', { mode: 'string' }),
    lastFetchedAt: ts('last_fetched_at'),
    backfillComplete: boolean('backfill_complete').notNull().default(false),
    backfillThrough: date('backfill_through', { mode: 'string' }),
    /** The newest day every day before which has been fetched; the next incremental run resumes here. */
    coverageThrough: date('coverage_through', { mode: 'string' }),
    lastError: text('last_error'),
    /** A non-fatal warning: a truncated window, or data still incomplete past the finality cap. */
    lastWarning: text('last_warning'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.siteId, t.dataset, t.searchType, t.property] })],
);

export const aiCalls = pgTable(
  'ai_calls',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    kind: text('kind').$type<AiCallKind>().notNull(),
    status: text('status').$type<AiCallStatus>().notNull(),
    /** Set while a worker runs a queued call; an expired lease makes it claimable again. */
    leaseUntil: ts('lease_until'),
    attempts: integer('attempts').notNull().default(0),
    idempotencyKey: text('idempotency_key'),
    providerId: text('provider_id'),
    model: text('model'),
    promptId: text('prompt_id'),
    promptVersion: integer('prompt_version'),
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
    output: jsonb('output').$type<unknown>(),
    rationale: text('rationale'),
    error: text('error'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    latencyMs: integer('latency_ms'),
    principalId: text('principal_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
    /**
     * When the call settled (billed, or given up). Usage is charged to this month, not to the month
     * of `createdAt`; falls back to `createdAt` until the call is settled.
     */
    billedAt: ts('billed_at'),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    uniqueIndex('ai_calls_workspace_idempotency').on(t.workspaceId, t.idempotencyKey),
    index('ai_calls_recent').on(t.workspaceId, t.createdAt),
    index('ai_calls_usage').on(t.workspaceId, t.providerId, sql`coalesce(${t.billedAt}, ${t.createdAt})`),
  ],
);

// The crawl engine (Phase 1 task A). See 0007_crawl.sql and docs/architecture/crawler-and-audits.md
// §2. An audit is one crawl; its frontier, snapshots and link edges are per-audit working state,
// and `pages` is the stable per-site list of URLs that survives across audits.

/** How much of a site one audit covers. */
export type AuditScope = 'site' | 'section' | 'list' | 'page';
/** `cancelled` is terminal: finalize still records coverage, site facts and counters for it. */
export type AuditState = 'queued' | 'running' | 'finalizing' | 'completed' | 'partial' | 'failed' | 'cancelled';
/** Only `never` is accepted in Phase 1; there is no renderer yet. */
export type AuditRenderMode = 'never' | 'auto' | 'always';
/** A frontier row's place in the crawl. */
export type FrontierState = 'pending' | 'leased' | 'crawled' | 'skipped';
/** How the crawler came to know a URL (packages/crawl/src/facts.ts `DiscoverySource`). */
export type CrawlDiscoverySource = 'seed' | 'link' | 'sitemap' | 'redirect' | 'list';

/** The limits an audit runs with, after defaults and hard caps. */
export interface CrawlLimits {
  maxPages: number;
  maxDepth: number;
  maxDurationMs: number;
}

/** The defaults packages/crawl applies; duplicated here so the column has a static default. */
const DEFAULT_CRAWL_LIMITS: CrawlLimits = { maxPages: 500, maxDepth: 10, maxDurationMs: 30 * 60 * 1000 };

export const audits = pgTable(
  'audits',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    siteId: uuid('site_id').notNull(),
    scope: text('scope').$type<AuditScope>().notNull(),
    /** The path prefix for `section` scope. */
    section: text('section'),
    /** The exact URLs for `list`/`page` scope. */
    urls: text('urls').array().$type<string[]>(),
    limits: jsonb('limits').$type<CrawlLimits>().notNull().default(DEFAULT_CRAWL_LIMITS),
    renderMode: text('render_mode').$type<AuditRenderMode>().notNull().default('never'),
    state: text('state').$type<AuditState>().notNull(),
    stateReason: text('state_reason'),
    /** The `Coverage` contract (packages/crawl/src/hooks.ts). */
    coverage: jsonb('coverage').$type<unknown>(),
    /** The `SiteFacts` contract (packages/crawl/src/facts.ts). */
    siteFacts: jsonb('site_facts').$type<unknown>(),
    pagesCrawled: integer('pages_crawled').notNull().default(0),
    pagesDiscovered: integer('pages_discovered').notNull().default(0),
    pagesFailed: integer('pages_failed').notNull().default(0),
    requestedByType: text('requested_by_type').$type<'user' | 'agent'>().notNull(),
    requestedById: text('requested_by_id').notNull(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    /** When the current chunk last stored a page or took a lease; the reconciler reads it. */
    lastProgressAt: ts('last_progress_at').notNull().defaultNow(),
    /** When the reconciler last re-enqueued a chunk for a stalled audit. */
    reconciledAt: ts('reconciled_at'),
    /** When the worker's crawl_seed step read robots.txt, sitemaps and the HTTP probe. */
    seededAt: ts('seeded_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    index('audits_site').on(t.workspaceId, t.siteId, t.createdAt),
    // At most one live audit per site; `cancelled` is terminal.
    uniqueIndex('audits_one_live').on(t.workspaceId, t.siteId).where(sql`state IN ('queued', 'running', 'finalizing')`),
  ],
);

export const crawlFrontier = pgTable(
  'crawl_frontier',
  {
    workspaceId: uuid('workspace_id').notNull(),
    auditId: text('audit_id').notNull(),
    /** sha256 of the normalised URL. */
    urlHash: text('url_hash').notNull(),
    url: text('url').notNull(),
    state: text('state').$type<FrontierState>().notNull().default('pending'),
    skipReason: text('skip_reason'),
    /** Click depth from the seed; null for sitemap-only and listed URLs. */
    depth: integer('depth'),
    discoveredBy: text('discovered_by').$type<CrawlDiscoverySource>().notNull(),
    discoveredFrom: text('discovered_from'),
    inSitemap: boolean('in_sitemap').notNull().default(false),
    /** The first path segment, for the per-section page quota. */
    section: text('section').notNull().default('/'),
    leaseChunk: integer('lease_chunk'),
    leaseExpiresAt: ts('lease_expires_at'),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.auditId, t.urlHash] }),
    index('crawl_frontier_pending').on(t.workspaceId, t.auditId, t.state, t.depth, t.inSitemap),
  ],
);

export const pageSnapshots = pgTable(
  'page_snapshots',
  {
    workspaceId: uuid('workspace_id').notNull(),
    /** `snp_` + the first 32 hex characters of sha256(audit_id + url_hash). */
    id: text('id').notNull(),
    siteId: uuid('site_id').notNull(),
    auditId: text('audit_id').notNull(),
    url: text('url').notNull(),
    finalUrl: text('final_url').notNull(),
    status: integer('status').notNull(),
    /** The full `PageFacts`. */
    facts: jsonb('facts').$type<Record<string, unknown>>().notNull(),
    contentHash: text('content_hash'),
    fetchedAt: ts('fetched_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] }), index('page_snapshots_audit').on(t.workspaceId, t.auditId, t.url)],
);

export const pages = pgTable(
  'pages',
  {
    workspaceId: uuid('workspace_id').notNull(),
    /** `pag_` + the first 32 hex characters of sha256(site_id + url). */
    id: text('id').notNull(),
    siteId: uuid('site_id').notNull(),
    url: text('url').notNull(),
    lastAuditId: text('last_audit_id'),
    lastStatus: integer('last_status'),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] }), uniqueIndex('pages_site_url').on(t.workspaceId, t.siteId, t.url)],
);

export const linkEdges = pgTable(
  'link_edges',
  {
    workspaceId: uuid('workspace_id').notNull(),
    auditId: text('audit_id').notNull(),
    fromUrlHash: text('from_url_hash').notNull(),
    toUrlHash: text('to_url_hash').notNull(),
    toUrl: text('to_url').notNull(),
    rel: text('rel').array().$type<string[]>().notNull().default(sql`'{}'::text[]`),
    anchor: text('anchor').notNull().default(''),
    internal: boolean('internal').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.auditId, t.fromUrlHash, t.toUrlHash] }),
    index('link_edges_inlinks').on(t.workspaceId, t.auditId, t.toUrlHash),
  ],
);

export const pageLinkStats = pgTable(
  'page_link_stats',
  {
    workspaceId: uuid('workspace_id').notNull(),
    auditId: text('audit_id').notNull(),
    urlHash: text('url_hash').notNull(),
    inlinks: integer('inlinks').notNull().default(0),
    outlinks: integer('outlinks').notNull().default(0),
    internalInlinks: integer('internal_inlinks').notNull().default(0),
    sampleAnchors: text('sample_anchors').array().$type<string[]>().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.auditId, t.urlHash] })],
);

/** Global per-host concurrency: one row per leased slot, shared by every worker replica. */
export const crawlHostLeases = pgTable(
  'crawl_host_leases',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    host: text('host').notNull(),
    owner: text('owner').notNull(),
    acquiredAt: ts('acquired_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('crawl_host_leases_host').on(t.host), index('crawl_host_leases_expiry').on(t.expiresAt)],
);

/** Global per-host spacing (`next_start_at`) and backoff (`paused_until`). */
export const crawlHostPacing = pgTable('crawl_host_pacing', {
  host: text('host').primaryKey(),
  nextStartAt: ts('next_start_at').notNull().defaultNow(),
  pausedUntil: ts('paused_until'),
});

// ---------------------------------------------------------------------------------------------
// Change sets (Phase 1 task F, ADR-0007). The content is the `change_set` artifact; these tables
// are its lifecycle: where the change is in the world (drafted, approved, in a pull request,
// merged, deployed, verified), the append-only evidence for each transition, and the per-change
// verification rows.
// ---------------------------------------------------------------------------------------------

/** Every state a change-set run can be in (see 0010_change_sets.sql for the meaning of each). */
export type ChangeSetState =
  | 'draft'
  | 'in_review'
  | 'approved'
  | 'applying'
  | 'pr_open'
  | 'merged'
  | 'deploying'
  | 'deployed'
  | 'verified'
  | 'verification_failed'
  | 'deploy_not_detected'
  | 'closed'
  | 'stale'
  | 'rolled_back'
  | 'superseded'
  | 'failed';

export const changeSetRuns = pgTable(
  'change_set_runs',
  {
    workspaceId: uuid('workspace_id').notNull(),
    /** The `chg_…` artifact; one run row per change set. */
    artifactId: text('artifact_id').notNull(),
    siteId: uuid('site_id').notNull(),
    state: text('state').$type<ChangeSetState>().notNull(),
    /** The artifact version approved for application; the apply job refuses a different one. */
    approvedVersion: integer('approved_version'),
    /** The pull-request head SHA the approval covers; a later push returns the set to review. */
    approvedHeadSha: text('approved_head_sha'),
    approvalId: text('approval_id'),
    branch: text('branch'),
    prNumber: integer('pr_number'),
    prUrl: text('pr_url'),
    headSha: text('head_sha'),
    mergeCommitSha: text('merge_commit_sha'),
    deployedSha: text('deployed_sha'),
    /** The change set this row rolls back, when it is a rollback. */
    rollbackOf: text('rollback_of'),
    /** The latest rollback proposal for this change set; the original changes state only when it is verified. */
    rollbackChangeSetId: text('rollback_change_set_id'),
    /** A rollback's changes that could not be inverted, with the reason; empty for everything else. */
    uncoveredChanges: jsonb('uncovered_changes').$type<{ index: number; reason: string }[]>().notNull().default([]),
    /** Verification attempts that ended in a fetch failure; the third gives up with evidence. */
    verificationAttempts: integer('verification_attempts').notNull().default(0),
    lastError: text('last_error'),
    stateChangedAt: ts('state_changed_at').notNull().defaultNow(),
    draftedAt: ts('drafted_at').notNull().defaultNow(),
    submittedAt: ts('submitted_at'),
    approvedAt: ts('approved_at'),
    appliedAt: ts('applied_at'),
    mergedAt: ts('merged_at'),
    deployedAt: ts('deployed_at'),
    verifiedAt: ts('verified_at'),
    closedAt: ts('closed_at'),
    failedAt: ts('failed_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.artifactId] }),
    index('change_set_runs_site').on(t.workspaceId, t.siteId, t.state),
    index('change_set_runs_pr').on(t.workspaceId, t.artifactId),
  ],
);

/** Who caused a transition: a person, an agent, or the worker itself. */
export type ChangeSetActor = 'person' | 'agent' | 'system';

/** One transition, appended and never rewritten. */
export const changeSetEvents = pgTable(
  'change_set_events',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    artifactId: text('artifact_id').notNull(),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    actorType: text('actor_type').$type<ChangeSetActor>().notNull(),
    actorId: text('actor_id'),
    reason: text('reason').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('change_set_events_one').on(t.workspaceId, t.artifactId, t.seq)],
);

/** One change's verification result in one attempt against the deployed commit. */
export const changeSetVerifications = pgTable(
  'change_set_verifications',
  {
    workspaceId: uuid('workspace_id').notNull(),
    artifactId: text('artifact_id').notNull(),
    attempt: integer('attempt').notNull(),
    changeIndex: integer('change_index').notNull(),
    url: text('url').notNull(),
    changeType: text('change_type').notNull(),
    result: text('result').$type<'pass' | 'fail' | 'unknown'>().notNull(),
    detail: text('detail').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
    deployedSha: text('deployed_sha').notNull(),
    fetchedAt: ts('fetched_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.artifactId, t.attempt, t.changeIndex] })],
);

// Findings, issues and the health score (Phase 1 task E). See 0009_issues.sql, ADR-0008,
// crawler-and-audits.md §5–§6 and design/DESIGN.md §4.2.

/** A long-lived, site-level grouping of findings that people triage. */
export type IssueState = 'open' | 'resolved' | 'ignored';
/** The catalogue's severities, copied onto a finding and an issue. */
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
/** The eight categories the Phase 1 catalogue evaluates (packages/checks/src/check.ts). */
export type FindingCategory =
  | 'crawlability'
  | 'indexability'
  | 'status_links'
  | 'on_page'
  | 'structured_data'
  | 'images'
  | 'security'
  | 'international';

/** The capped evidence of one finding: the catalogue's items plus the true total. */
export interface FindingEvidence {
  items: unknown[];
  total: number;
  truncated: boolean;
  /** Pages the finding covers; kept for older rows, the columns are authoritative now. */
  affectedPages?: number;
}

/** One category's part of an audit's health score. */
export interface AuditScoreCategory {
  category: FindingCategory;
  weight: number;
  penalty: number;
  contribution: number;
  issues: number;
  affectedPages: number;
}

export const issues = pgTable(
  'issues',
  {
    workspaceId: uuid('workspace_id').notNull(),
    /** `iss_` + the first 32 hex characters of sha256(site_id + check_id + subject_key). */
    id: text('id').notNull(),
    siteId: uuid('site_id').notNull(),
    checkId: text('check_id').notNull(),
    /** The page URL for page and cross-page checks; the origin for site checks. */
    subjectKey: text('subject_key').notNull(),
    subject: text('subject').notNull(),
    state: text('state').$type<IssueState>().notNull().default('open'),
    severity: text('severity').$type<FindingSeverity>().notNull(),
    category: text('category').$type<FindingCategory>().notNull(),
    regressed: integer('regressed').notNull().default(0),
    lastRegressedAt: ts('last_regressed_at'),
    firstSeenAuditId: text('first_seen_audit_id').notNull(),
    lastSeenAuditId: text('last_seen_audit_id').notNull(),
    /** The last audit that evaluated the subject at all; unchanged when a later audit did not. */
    lastCheckedAuditId: text('last_checked_audit_id').notNull(),
    resolvedAuditId: text('resolved_audit_id'),
    ignoredBy: text('ignored_by'),
    ignoredReason: text('ignored_reason'),
    ignoredAt: ts('ignored_at'),
    evidence: jsonb('evidence').$type<FindingEvidence>().notNull().default({ items: [], total: 0, truncated: false }),
    /** The issue's own subject pages (normalised URLs); the health score's page identity. */
    affectedUrls: text('affected_urls').array().notNull().default([]),
    affectedPages: integer('affected_pages').notNull().default(1),
    evaluatedPages: integer('evaluated_pages').notNull().default(1),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    uniqueIndex('issues_subject_unique').on(t.workspaceId, t.siteId, t.checkId, t.subjectKey),
    index('issues_site_state').on(t.workspaceId, t.siteId, t.state, t.severity),
    index('issues_site_check').on(t.workspaceId, t.siteId, t.checkId),
  ],
);

/** One check failing on one subject in one audit: the evidence an issue groups. */
export const findings = pgTable(
  'findings',
  {
    workspaceId: uuid('workspace_id').notNull(),
    /** `fnd_` + the first 32 hex characters of sha256(audit_id + check_id + source_key). */
    id: text('id').notNull(),
    siteId: uuid('site_id').notNull(),
    auditId: text('audit_id').notNull(),
    checkId: text('check_id').notNull(),
    /** The snapshot (requested URL) that produced the finding; the replacement key. */
    sourceKey: text('source_key').notNull(),
    subjectKey: text('subject_key').notNull(),
    /** The URL, or `url#selector` when the check points at a fragment of a page. */
    subject: text('subject').notNull(),
    severity: text('severity').$type<FindingSeverity>().notNull(),
    category: text('category').$type<FindingCategory>().notNull(),
    evidence: jsonb('evidence').$type<FindingEvidence>().notNull().default({ items: [], total: 0, truncated: false }),
    /** The issue's own subject pages (normalised URLs); never derived from the evidence cap. */
    affectedUrls: text('affected_urls').array().notNull().default([]),
    affectedPages: integer('affected_pages').notNull().default(1),
    issueId: text('issue_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    index('findings_audit_check').on(t.workspaceId, t.auditId, t.checkId),
    index('findings_subject').on(t.workspaceId, t.siteId, t.checkId, t.subjectKey),
    index('findings_source').on(t.workspaceId, t.auditId, t.sourceKey),
    index('findings_issue').on(t.workspaceId, t.issueId).where(sql`issue_id IS NOT NULL`),
  ],
);

/** One audit's health score with its per-category detail and what it could not evaluate. */
export const auditScores = pgTable(
  'audit_scores',
  {
    workspaceId: uuid('workspace_id').notNull(),
    siteId: uuid('site_id').notNull(),
    auditId: text('audit_id').notNull(),
    score: integer('score'),
    reason: text('reason'),
    categories: jsonb('categories').$type<AuditScoreCategory[]>().notNull().default([]),
    notEvaluated: jsonb('not_evaluated').$type<{ category: string; reason: string }[]>().notNull().default([]),
    skippedChecks: jsonb('skipped_checks').$type<{ checkId: string; reason: string }[]>().notNull().default([]),
    pagesEvaluated: integer('pages_evaluated').notNull().default(0),
    pagesCrawled: integer('pages_crawled').notNull().default(0),
    /** Open issues the audit could not judge; excluded from the score and reported as coverage. */
    uncheckedIssues: integer('unchecked_issues').notNull().default(0),
    gscWeighted: boolean('gsc_weighted').notNull().default(false),
    computedAt: ts('computed_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.auditId] }), index('audit_scores_site').on(t.workspaceId, t.siteId, t.computedAt)],
);

// Recommendations and the runs that produce them (Phase 1 task G). See 0011_recommendations.sql.
// The recommendation itself is an artifact (`rcm_…`); these two tables hold what an artifact
// cannot: the record of one synthesis run, and a person's order over a site's recommendations.

export type RecommendationRunState = 'queued' | 'running' | 'completed' | 'failed';

/** One `recommendations.generate` run: what it read, what it created, what it dropped and why. */
export const recommendationRuns = pgTable(
  'recommendation_runs',
  {
    workspaceId: uuid('workspace_id').notNull(),
    /** `rrun_` + 32 hex characters. */
    id: text('id').notNull(),
    siteId: uuid('site_id').notNull(),
    /** The audit whose issues the run read; null when the site has no completed audit. */
    auditId: text('audit_id'),
    state: text('state').$type<RecommendationRunState>().notNull().default('queued'),
    maxRecommendations: integer('max_recommendations').notNull().default(10),
    requestedByType: text('requested_by_type').$type<'user' | 'agent' | 'system'>().notNull(),
    requestedById: text('requested_by_id').notNull(),
    /** Candidates the technical specialist proposed, and recommendations the strategist wrote. */
    candidates: integer('candidates').notNull().default(0),
    derived: integer('derived').notNull().default(0),
    createdCount: integer('created_count').notNull().default(0),
    droppedCount: integer('dropped_count').notNull().default(0),
    /** `[{ title, reason }]` per item that still failed validation after its retry. */
    dropped: jsonb('dropped').$type<{ title: string; reason: string }[]>().notNull().default([]),
    /** The `rcm_…` artifacts this run created, in order. */
    createdIds: text('created_ids').array().notNull().default([]),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    error: text('error'),
    /** A crashed worker's run is reclaimed once the lease expires. */
    leaseUntil: ts('lease_until'),
    attempts: integer('attempts').notNull().default(0),
    /**
     * The fencing token, bumped on every claim. A worker passes its claim's token on every write, so
     * one whose lease expired after another took the run over writes nothing.
     */
    attemptToken: bigint('attempt_token', { mode: 'number' }).notNull().default(0),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    index('recommendation_runs_site').on(t.workspaceId, t.siteId, t.createdAt),
    index('recommendation_runs_open').on(t.state, t.createdAt),
  ],
);

/** A person's order over a site's recommendations; lower sorts first. Never part of the content. */
export const recommendationPriorities = pgTable(
  'recommendation_priorities',
  {
    workspaceId: uuid('workspace_id').notNull(),
    /** The `rcm_…` artifact this order is about. */
    artifactId: text('artifact_id').notNull(),
    siteId: uuid('site_id').notNull(),
    priority: integer('priority').notNull(),
    updatedBy: text('updated_by').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.artifactId] }),
    index('recommendation_priorities_site').on(t.workspaceId, t.siteId, t.priority),
  ],
);
