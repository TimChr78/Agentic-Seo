import { randomBytes, randomUUID } from 'node:crypto';
import { type AgentActionEntry, createExecutor, type Services } from '@agentic-seo/commands';
import { createDb, type Db, schema, type Tx } from '@agentic-seo/db';
import { type KeyProvider, localKeyProvider, sealJson } from '@agentic-seo/secrets';
import { sql } from 'drizzle-orm';
import { APP_ROLE, createDisposableDb, type DisposableDb } from '../../db/test/disposable';

// Shared setup for the recommendation integration tests: a disposable migrated database, an
// executor, a verified site with a completed audit and one issue, and the small fixtures a test
// needs (Search Console page data, a linked change set, a scripted provider). No test here reaches
// the internet: the model is packages/ai's fakeLlm over loopback.

/** One key provider for the file: the provider row's sealed key is opened with it. */
export const keyProvider: KeyProvider = localKeyProvider(randomBytes(32).toString('base64'));

/** The workspace the current transaction is scoped to, as the server's ledger hook reads it. */
async function workspaceOf(tx: Tx): Promise<string> {
  const result = await tx.execute<{ id: string }>(sql`SELECT current_setting('app.workspace_id')::uuid AS id`);
  const id = result.rows[0]?.id;
  if (!id) throw new Error('the test ledger was used outside a workspace-scoped transaction');
  return id;
}

/**
 * The two hooks the server wires for the action ledger (`apps/server/src/agents/ledger.ts`). A test
 * that needs the ledger rows a run writes spreads these into its services, exactly as the server does.
 */
export const ledgerServices: Pick<Services, 'agentCounters' | 'onAgentAction'> = {
  agentCounters: async () => ({ changes: 0 }),
  onAgentAction: async (tx: Tx, entry: AgentActionEntry) => {
    await tx.insert(schema.agentActions).values({
      workspaceId: await workspaceOf(tx),
      agentId: entry.agentId,
      command: entry.command,
      actionClass: entry.actionClass,
      decision: entry.decision,
      reasons: entry.reasons,
      impact: entry.impact as Record<string, unknown>,
      ok: entry.ok,
      error: entry.error,
      target: entry.target,
      surface: entry.surface,
      level: entry.level,
      intent: entry.intent,
      undo: entry.undo,
      mandateId: entry.mandateId ?? null,
      mandateVersion: entry.mandateVersion ?? null,
    });
  },
};

export const services: Services = { serverVersion: 'test', strictInputs: false, keyProvider, ...ledgerServices };

const appUrl = (url: URL): string => {
  const copy = new URL(url.toString());
  copy.username = APP_ROLE.appRole;
  copy.password = APP_ROLE.appRolePassword;
  return copy.toString();
};

export interface RecommendationTestContext {
  disposable: DisposableDb;
  db: Db;
  executor: ReturnType<typeof createExecutor>;
}

export async function createRecommendationTestContext(prefix: string): Promise<RecommendationTestContext> {
  const disposable = await createDisposableDb(prefix);
  const db = createDb({ adminUrl: disposable.url.toString(), appUrl: appUrl(disposable.url), poolSize: 4 });
  // The person the tests act as is a real member: a run reads the requester's current membership and
  // role when it executes, so a queued run has someone whose authority it can be measured against.
  await db.admin.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, 'user_owner', 'owner')`, [
    disposable.workspace,
  ]);
  return { disposable, db, executor: createExecutor(db, services) };
}

export const of = (d: DisposableDb) => d.workspace;

/** A verified site: ownership verification is required for anything that changes a site. */
export async function addSite(db: Db, workspaceId: string, domain = 'example.com'): Promise<string> {
  const id = randomUUID();
  await db.admin.query(
    `INSERT INTO sites (workspace_id, id, name, primary_domain, hosts, verification_token, verified_at, archived)
     VALUES ($1, $2, $3, $4, '{}', 'test-token', now(), false)`,
    [workspaceId, id, domain, domain],
  );
  return id;
}

let auditSequence = 0;

/** One completed audit, so a run has an audit id to read. */
export async function seedAudit(
  db: Db,
  workspaceId: string,
  siteId: string,
  opts: { state?: 'completed' | 'partial'; pagesCrawled?: number; score?: number | null } = {},
): Promise<string> {
  auditSequence += 1;
  const id = `adt_g${Date.now().toString(36)}${auditSequence.toString(36)}${randomBytes(3).toString('hex')}`;
  await db.admin.query(
    `INSERT INTO audits (workspace_id, id, site_id, scope, limits, state, requested_by_type, requested_by_id, pages_crawled, started_at, finished_at)
     VALUES ($1, $2, $3, 'site', '{"maxPages":500,"maxDepth":10,"maxDurationMs":1800000}'::jsonb, $4, 'user', 'seed-user', $5, now() - interval '1 hour', now())`,
    [workspaceId, id, siteId, opts.state ?? 'completed', opts.pagesCrawled ?? 40],
  );
  if (opts.score !== undefined && opts.score !== null)
    await db.admin.query(
      `INSERT INTO audit_scores (workspace_id, site_id, audit_id, score, pages_evaluated, pages_crawled, not_evaluated)
       VALUES ($1, $2, $3, $4, $5, $5, '[]'::jsonb)`,
      [workspaceId, siteId, id, opts.score, opts.pagesCrawled ?? 40],
    );
  return id;
}

let issueSequence = 0;

export interface SeedIssue {
  checkId?: string;
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category?: string;
  state?: 'open' | 'resolved' | 'ignored';
  affectedPages?: number;
  evaluatedPages?: number;
  urls?: string[];
  evidence?: unknown;
}

/** One open issue, as `finalizeAudit` would have left it. */
export async function seedIssue(db: Db, workspaceId: string, siteId: string, auditId: string, input: SeedIssue = {}): Promise<string> {
  issueSequence += 1;
  const id = `iss_${issueSequence.toString(16).padStart(32, '0')}`;
  const urls = input.urls ?? ['https://example.com/pricing/'];
  await db.admin.query(
    `INSERT INTO issues (workspace_id, id, site_id, check_id, subject_key, subject, state, severity, category,
                         first_seen_audit_id, last_seen_audit_id, last_checked_audit_id,
                         affected_urls, affected_pages, evaluated_pages, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $10, $11, $12, $13, $14::jsonb)`,
    [
      workspaceId,
      id,
      siteId,
      input.checkId ?? 'title.missing',
      urls[0],
      urls[0],
      input.state ?? 'open',
      input.severity ?? 'high',
      input.category ?? 'on_page',
      auditId,
      urls,
      input.affectedPages ?? 12,
      input.evaluatedPages ?? 40,
      JSON.stringify(
        input.evidence ?? { items: [{ subject: urls[0], value: null, expected: 'A title', detail: null }], total: 12, truncated: false },
      ),
    ],
  );
  return id;
}

/** One finding, for the finding evidence kind. */
export async function seedFinding(
  db: Db,
  workspaceId: string,
  siteId: string,
  auditId: string,
  input: { checkId?: string; subject?: string; issueId?: string } = {},
): Promise<string> {
  const id = `fnd_${randomBytes(16).toString('hex')}`;
  const subject = input.subject ?? 'https://example.com/pricing/';
  await db.admin.query(
    `INSERT INTO findings (workspace_id, id, site_id, audit_id, check_id, source_key, subject_key, subject, severity, category, evidence, affected_urls, affected_pages, issue_id)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'high', 'on_page', '{"items":[],"total":1,"truncated":false}'::jsonb, ARRAY[$6], 1, $7)`,
    [workspaceId, id, siteId, auditId, input.checkId ?? 'title.missing', subject, input.issueId ?? null],
  );
  return id;
}

/** A live Search Console connection and fresh page rows, so `estimateReach` answers `known`. */
export async function seedSearchConsole(
  db: Db,
  workspaceId: string,
  siteId: string,
  rows: { url: string; clicks: number; impressions?: number; daysAgo?: number }[],
): Promise<void> {
  const property = `sc-domain:${randomUUID().slice(0, 8)}.example`;
  await db.admin.query(
    `INSERT INTO connections (workspace_id, id, site_id, connector, label, settings, state)
     VALUES ($1, $2, $3, 'google-search-console', 'Search Console', $4::jsonb, 'active')`,
    [workspaceId, `con_${randomBytes(16).toString('hex')}`, siteId, JSON.stringify({ property })],
  );
  for (const row of rows) {
    const date = new Date(Date.now() - (row.daysAgo ?? 1) * 86_400_000).toISOString().slice(0, 10);
    const key = row.url.replace(/\/$/, '') || row.url;
    await db.admin.query(
      `INSERT INTO gsc_page_aggregates
         (workspace_id, site_id, property, date, page, page_key, country, device, clicks, impressions, ctr, position, is_final)
       VALUES ($1, $2, $3, $4, $5, $6, '', '', $7, $8, 0.1, 3, true)`,
      [workspaceId, siteId, property, date, row.url, key, row.clicks, row.impressions ?? row.clicks * 10],
    );
  }
}

/** A change set whose content names the recommendation, in the state a test needs. */
export async function seedChangeSet(
  db: Db,
  workspaceId: string,
  siteId: string,
  recommendationId: string,
  state = 'pr_open',
): Promise<string> {
  const id = `chg_${randomBytes(16).toString('hex')}`;
  await db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, site_id, latest_version, published_version)
     VALUES ($1, $2, 'change_set', 'Linked change set', $3, 1, 1)`,
    [workspaceId, id, siteId],
  );
  await db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1, $2, 1, 'published', $3::jsonb, 'hash-change', 'user', 'seed-user')`,
    [workspaceId, id, JSON.stringify({ recommendationId })],
  );
  await db.admin.query(`INSERT INTO change_set_runs (workspace_id, artifact_id, site_id, state) VALUES ($1, $2, $3, $4)`, [
    workspaceId,
    id,
    siteId,
    state,
  ]);
  return id;
}

/** An OpenAI-compatible provider pointed at a scripted server. */
export async function seedProvider(
  db: Db,
  workspaceId: string,
  kp: KeyProvider,
  opts: { baseUrl: string; monthlyTokenBudget?: number | null },
): Promise<string> {
  const id = `aip_${randomBytes(16).toString('hex')}`;
  const sealed = await db.withWorkspace(workspaceId, (tx) => sealJson(tx, workspaceId, kp, { apiKey: 'test-key' }));
  await db.admin.query(
    `INSERT INTO ai_providers (workspace_id, id, name, kind, base_url, models, use_for, monthly_token_budget, secrets, secrets_key_id)
     VALUES ($1, $2, 'Scripted', 'openai-compatible', $3, $4::jsonb, ARRAY['agents'], $5, $6, $7)`,
    [
      workspaceId,
      id,
      opts.baseUrl,
      JSON.stringify({ default: 'deep-model', fast: 'fast-model' }),
      opts.monthlyTokenBudget ?? null,
      sealed.blob,
      sealed.keyId,
    ],
  );
  return id;
}

export const newKeyProvider = (): KeyProvider => localKeyProvider(randomBytes(32).toString('base64'));

/** A plain fetch for the scripted server: the production guard refuses loopback on purpose. */
export const loopbackFetch: typeof fetch = (input, init) => fetch(input, init);
