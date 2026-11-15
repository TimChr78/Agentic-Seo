import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/pool';
import { APP_ROLE, createDisposableDb, hasTestDatabase } from './disposable';

// Tenancy is enforced by Postgres, not by hope: every table that carries `workspace_id` is covered
// by row-level security, the app role only sees the workspace named in `app.workspace_id`, cannot
// write another workspace's rows, sees nothing when no workspace is set, and the audit log is a
// continuous hash chain.

const other = randomUUID();

const appUrl = (url: URL) => {
  const u = new URL(url.toString());
  u.username = APP_ROLE.appRole;
  u.password = APP_ROLE.appRolePassword;
  return u.toString();
};

/** Drizzle wraps a Postgres error, so the policy message is in its cause chain. */
const messagesOf = (err: unknown) => {
  const parts: string[] = [];
  for (let e = err as { message?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) parts.push(e.message ?? '');
  return parts.join(' | ');
};

/**
 * One seed statement per table that has a `workspace_id` column. The test refuses to run when the
 * database has a tenant table this map does not know, so a new table cannot arrive unprotected.
 */
const SEED: Record<string, { insert: string; appendOnly: boolean }> = {
  agent_actions: {
    insert: `INSERT INTO agent_actions (workspace_id, agent_id, command, action_class, decision, ok, surface)
            VALUES ($1, 'agt-seed', 'test.write', 'site.content', 'allow', true, 'internal')`,
    // The table grant is INSERT and SELECT only; undoing is column-level.
    appendOnly: true,
  },
  agents: {
    insert: `INSERT INTO agents (workspace_id, id, name, sponsor_user_id)
            VALUES ($1, 'agt-seed', 'Seed agent', 'seed-user')`,
    appendOnly: false,
  },
  agent_credentials: {
    insert: `INSERT INTO agent_credentials (workspace_id, kind, credential_id, agent_id)
            VALUES ($1, 'api_token', 'tok-seed', 'agt-seed')`,
    // No UPDATE grant: a credential is attached or removed, never rewritten.
    appendOnly: true,
  },
  api_token_changes: {
    insert: `INSERT INTO api_token_changes (workspace_id, id, token_id, changed_by, changes)
            VALUES ($1, 'tch-seed', 'tok-seed', 'seed-user', '{}'::jsonb)`,
    appendOnly: false,
  },
  api_tokens: {
    insert: `INSERT INTO api_tokens (workspace_id, id, user_id, name, token_hash, token_hint, scopes)
            VALUES ($1, 'tok-seed', 'seed-user', 'Seed token', 'token-hash-' || md5(random()::text), 'hint', '{sites:read}')`,
    appendOnly: false,
  },
  artifacts: {
    insert: `INSERT INTO artifacts (workspace_id, id, type, name, latest_version)
            VALUES ($1, 'not_seed', 'note', 'Seed note', 1)`,
    appendOnly: false,
  },
  ai_providers: {
    insert: `INSERT INTO ai_providers (workspace_id, id, name, kind, base_url, models)
            VALUES ($1, 'aip_seed', 'Seed provider', 'openai-compatible', 'https://api.example.com/v1', '{"default":"m"}'::jsonb)`,
    appendOnly: false,
  },
  ai_calls: {
    insert: `INSERT INTO ai_calls (workspace_id, id, kind, status)
            VALUES ($1, 'aic_seed', 'test', 'pending')`,
    appendOnly: false,
  },
  ai_token_reservations: {
    insert: `INSERT INTO ai_token_reservations (workspace_id, id, provider_id, tokens, expires_at)
            VALUES ($1, 'rsv_seed', 'aip_seed', 1000, now() + interval '5 minutes')`,
    appendOnly: false,
  },
  artifact_versions: {
    insert: `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
            VALUES ($1, 'not_seed', 1, 'draft', '{}'::jsonb, 'seed-hash', 'user', 'seed-user')`,
    appendOnly: false,
  },
  approval_requests: {
    insert: `INSERT INTO approval_requests (workspace_id, id, artifact_id, version, status, requested_by_type, requested_by_id, note)
            VALUES ($1, 'apr_seed', 'not_seed', 1, 'pending', 'user', 'seed-user', 'Seed request')`,
    appendOnly: false,
  },
  learnings: {
    insert: `INSERT INTO learnings (workspace_id, id, statement, author_type, author_id)
            VALUES ($1, 'lrn_seed', 'Seed learning', 'user', 'seed-user')`,
    appendOnly: false,
  },
  audit_log: {
    insert: `INSERT INTO audit_log (workspace_id, principal_type, principal_id, surface, command, effect, input_hash, ok, hash)
            VALUES ($1, 'user', 'seed-user', 'rest', 'seed.run', 'write', 'seed-hash', true, 'seed-hash')`,
    appendOnly: true,
  },
  data_keys: {
    insert: `INSERT INTO data_keys (workspace_id, id, kek_id, wrapped_key, purpose)
            VALUES ($1, 'dk-seed', 'kek-seed', '\\x00'::bytea, 'secrets')`,
    appendOnly: false,
  },
  idempotency_keys: {
    insert: `INSERT INTO idempotency_keys (workspace_id, key, command, input_hash, response)
            VALUES ($1, 'seed-key', 'seed.run', 'seed-hash', '{}'::jsonb)`,
    appendOnly: false,
  },
  input_warnings: {
    insert: `INSERT INTO input_warnings (workspace_id, principal_type, principal_id, client_label, command, key_path)
            VALUES ($1, 'user', 'seed-user', 'seed-client', 'seed.run', 'unknown_key')`,
    appendOnly: false,
  },
  invitations: {
    insert: `INSERT INTO invitations (workspace_id, id, email, role, token_hash, invited_by, expires_at)
            VALUES ($1, 'inv-seed', 'seed@example.com', 'viewer', 'invitation-hash-' || md5(random()::text), 'seed-user', now() + interval '7 days')`,
    appendOnly: false,
  },
  oauth_workspace_selections: {
    insert: `INSERT INTO oauth_workspace_selections (session_id, workspace_id) VALUES ('session-' || md5(random()::text), $1)`,
    appendOnly: false,
  },
  provider_budgets: {
    insert: `INSERT INTO provider_budgets (workspace_id, provider_id, period, currency, budget_micros)
            VALUES ($1, 'fake', '2026-11', 'USD', 1000000)`,
    appendOnly: false,
  },
  provider_cache: {
    insert: `INSERT INTO provider_cache (workspace_id, cache_key, provider_id, port, operation, request_hash, response, expires_at)
            VALUES ($1, 'seed-cache', 'fake', 'KeywordData', 'metrics', 'seed-hash', '{}'::jsonb, now() + interval '1 day')`,
    appendOnly: false,
  },
  provider_calls: {
    insert: `INSERT INTO provider_calls (workspace_id, id, idempotency_key, caller_type, caller_id, purpose, provider_id, port, operation,
              request_hash, cache_key, max_cost_micros, reserved_micros, currency, budget_period, state)
            VALUES ($1, gen_random_uuid(), 'seed-key', 'person', 'seed-user', 'seed', 'fake', 'KeywordData', 'metrics',
              'seed-hash', 'seed-cache', 1000, 1000, 'USD', '2026-11', 'pending')`,
    appendOnly: false,
  },
  provider_rate_buckets: {
    insert: `INSERT INTO provider_rate_buckets (workspace_id, provider_id, credential_key, tokens, capacity, refill_per_second)
            VALUES ($1, 'fake', '', 10, 10, 1)`,
    appendOnly: false,
  },
  secrets: {
    insert: `INSERT INTO secrets (workspace_id, name, data_key_id, iv, ciphertext, auth_tag, updated_by)
            VALUES ($1, 'seed-secret', 'dk-seed', '\\x00'::bytea, '\\x01'::bytea, '\\x02'::bytea, 'seed-user')`,
    appendOnly: false,
  },
  // The site id is a literal, not a parameter: the RLS test below replaces only the first `$1`
  // with another workspace, and a second placeholder would be left unbound. (workspace_id, id) is
  // the primary key, so both seeded workspaces can use the same literal id.
  sites: {
    insert: `INSERT INTO sites (workspace_id, id, name, primary_domain, verification_token)
            VALUES ($1, '00000000-0000-4000-8000-000000000001', 'Seed site', 'seed-site.example', 'seed-token')`,
    appendOnly: false,
  },
  markets: {
    insert: `INSERT INTO markets (workspace_id, id, site_id, location_code, language_code, name)
            VALUES ($1, gen_random_uuid(), '00000000-0000-4000-8000-000000000001', 2840, 'en', 'Seed market')`,
    appendOnly: false,
  },
  competitors: {
    insert: `INSERT INTO competitors (workspace_id, id, site_id, domain)
            VALUES ($1, gen_random_uuid(), '00000000-0000-4000-8000-000000000001', 'rival.example')`,
    appendOnly: false,
  },
  connections: {
    insert: `INSERT INTO connections (workspace_id, id, site_id, connector, label, settings, state)
            VALUES ($1, 'con_00000000000000000000000000000001', '00000000-0000-4000-8000-000000000001',
              'google-search-console', 'Search Console', '{"property":"sc-domain:seed-site.example"}'::jsonb, 'active')`,
    appendOnly: false,
  },
  gsc_property_totals: {
    insert: `INSERT INTO gsc_property_totals (workspace_id, site_id, property, date, clicks, impressions, ctr, position)
            VALUES ($1, '00000000-0000-4000-8000-000000000001', 'sc-domain:seed-site.example', '2026-11-01', 10, 100, 0.1, 3)`,
    appendOnly: false,
  },
  gsc_page_aggregates: {
    insert: `INSERT INTO gsc_page_aggregates (workspace_id, site_id, property, date, page, page_key, clicks, impressions, ctr, position)
            VALUES ($1, '00000000-0000-4000-8000-000000000001', 'sc-domain:seed-site.example', '2026-11-01',
              'https://seed-site.example/', 'https://seed-site.example/', 10, 100, 0.1, 3)`,
    appendOnly: false,
  },
  gsc_sync_state: {
    insert: `INSERT INTO gsc_sync_state (workspace_id, site_id, dataset, search_type, property, last_final_date, backfill_through)
            VALUES ($1, '00000000-0000-4000-8000-000000000001', 'property_totals', 'web', 'sc-domain:seed-site.example', '2026-11-01', '2026-11-01')`,
    appendOnly: false,
  },
  workspace_members: {
    insert: `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, 'seed-user', 'viewer')`,
    appendOnly: false,
  },
  // The crawl engine's working state (0007_crawl.sql). Inserted last because these rows point at
  // the seeded site and audit; `crawl_host_leases` and `crawl_host_pacing` carry no workspace_id,
  // so they are not tenant tables.
  audits: {
    insert: `INSERT INTO audits (workspace_id, id, site_id, scope, state, requested_by_type, requested_by_id)
            VALUES ($1, 'adt_seed', '00000000-0000-4000-8000-000000000001', 'site', 'queued', 'user', 'seed-user')`,
    appendOnly: false,
  },
  crawl_frontier: {
    insert: `INSERT INTO crawl_frontier (workspace_id, audit_id, url_hash, url, discovered_by, section)
            VALUES ($1, 'adt_seed', 'hash-seed', 'https://seed-site.example/', 'seed', '/')`,
    appendOnly: false,
  },
  page_snapshots: {
    insert: `INSERT INTO page_snapshots (workspace_id, id, site_id, audit_id, url, final_url, status, facts)
            VALUES ($1, 'snp_seed', '00000000-0000-4000-8000-000000000001', 'adt_seed', 'https://seed-site.example/', 'https://seed-site.example/', 200, '{}'::jsonb)`,
    appendOnly: false,
  },
  pages: {
    insert: `INSERT INTO pages (workspace_id, id, site_id, url, last_audit_id, last_status)
            VALUES ($1, 'pag_seed', '00000000-0000-4000-8000-000000000001', 'https://seed-site.example/', 'adt_seed', 200)`,
    appendOnly: false,
  },
  link_edges: {
    insert: `INSERT INTO link_edges (workspace_id, audit_id, from_url_hash, to_url_hash, to_url, internal)
            VALUES ($1, 'adt_seed', 'hash-seed', 'hash-two', 'https://seed-site.example/two', true)`,
    appendOnly: false,
  },
  page_link_stats: {
    insert: `INSERT INTO page_link_stats (workspace_id, audit_id, url_hash) VALUES ($1, 'adt_seed', 'hash-seed')`,
    appendOnly: false,
  },
  // The change-set lifecycle (Phase 1 task F). The run row points at the seeded site and artifact;
  // the transition log and the verification evidence are append-only by grant.
  change_set_runs: {
    insert: `INSERT INTO change_set_runs (workspace_id, artifact_id, site_id, state)
            VALUES ($1, 'not_seed', '00000000-0000-4000-8000-000000000001', 'draft')`,
    appendOnly: false,
  },
  change_set_events: {
    insert: `INSERT INTO change_set_events (workspace_id, artifact_id, from_state, to_state, actor_type, reason)
            VALUES ($1, 'not_seed', 'draft', 'in_review', 'system', 'Seed transition')`,
    appendOnly: true,
  },
  change_set_verifications: {
    insert: `INSERT INTO change_set_verifications (workspace_id, artifact_id, attempt, change_index, url, change_type, result, detail, deployed_sha)
            VALUES ($1, 'not_seed', 1, 0, 'https://seed-site.example/', 'meta.title', 'pass', 'Seed verification', 'commit-seed')`,
    appendOnly: true,
  },
  // Findings, issues and the score (0009_issues.sql). Inserted last: they point at the seeded site
  // and audit. Findings and issues are history, so the app role gets no DELETE on them.
  issues: {
    insert: `INSERT INTO issues (workspace_id, id, site_id, check_id, subject_key, subject, state, severity, category,
              first_seen_audit_id, last_seen_audit_id, last_checked_audit_id)
            VALUES ($1, 'iss_00000000000000000000000000000001', '00000000-0000-4000-8000-000000000001',
              'title.missing', 'https://seed-site.example/', 'https://seed-site.example/', 'open', 'high', 'on_page',
              'adt_seed', 'adt_seed', 'adt_seed')`,
    appendOnly: false,
  },
  findings: {
    insert: `INSERT INTO findings (workspace_id, id, site_id, audit_id, check_id, source_key, subject_key, subject, severity, category, evidence)
            VALUES ($1, 'fnd_00000000000000000000000000000001', '00000000-0000-4000-8000-000000000001', 'adt_seed',
              'title.missing', 'https://seed-site.example/', 'https://seed-site.example/', 'https://seed-site.example/', 'high', 'on_page',
              '{"items":[],"total":1,"truncated":false}'::jsonb)`,
    appendOnly: false,
  },
  audit_scores: {
    insert: `INSERT INTO audit_scores (workspace_id, site_id, audit_id, score, pages_evaluated, pages_crawled)
            VALUES ($1, '00000000-0000-4000-8000-000000000001', 'adt_seed', 82, 10, 10)`,
    appendOnly: false,
  },
};

describe.skipIf(!hasTestDatabase())('foundation tables', () => {
  let current: Awaited<ReturnType<typeof createDisposableDb>>;
  let db: ReturnType<typeof createDb>;
  let tenantTables: string[];

  beforeAll(async () => {
    current = await createDisposableDb('foundations');
    await current.db.admin.query('INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, $2, $3)', [other, 'Other', 'none']);
    // Seed one row per table for each workspace through the owner connection, which bypasses RLS.
    for (const workspace of [current.workspace, other]) {
      for (const seed of Object.values(SEED)) await current.db.admin.query(seed.insert, [workspace]);
    }
    const { rows } = await current.db.admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'workspace_id'
        ORDER BY table_name`,
    );
    tenantTables = rows.map((row) => row.table_name);
    db = createDb({ adminUrl: current.url.toString(), appUrl: appUrl(current.url), poolSize: 4 });
  });

  afterAll(async () => {
    await db?.close();
    await current?.close();
  });

  it('enumerates exactly the tenant tables this test knows how to seed', () => {
    expect(tenantTables).toEqual(Object.keys(SEED).sort());
  });

  it('gives every tenant table forced row-level security', async () => {
    const { rows } = await current.db.admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
        ORDER BY c.relname`,
      [tenantTables],
    );
    expect(rows.map((row) => row.relname)).toEqual(tenantTables);
    for (const row of rows)
      expect({ table: row.relname, force: row.relforcerowsecurity, enable: row.relrowsecurity }).toEqual({
        table: row.relname,
        force: true,
        enable: true,
      });
  });

  for (const table of Object.keys(SEED).sort()) {
    it(`isolates ${table} to app.workspace_id`, async () => {
      const seed = SEED[table]!;
      // The app role sees the seeded row for the current workspace only.
      const visible = await db.withWorkspace(current.workspace, (tx) =>
        tx.execute<{ workspace_id: string }>(sql.raw(`SELECT workspace_id::text AS workspace_id FROM ${table}`)),
      );
      expect(visible.rows.map((row) => row.workspace_id)).toEqual([current.workspace]);

      // No workspace set at all: nothing is visible, not everything.
      const unscoped = await db.app.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`);
      expect(unscoped.rows[0]?.count).toBe(0);

      // Inserting a row for another workspace breaks the policy's WITH CHECK.
      const insert = await db
        .withWorkspace(current.workspace, (tx) => tx.execute(seed.insert.replace('$1', `'${other}'`)))
        .then(
          () => null,
          (err) => err,
        );
      expect(messagesOf(insert)).toMatch(/row-level security/);

      // Updating another workspace's rows reaches none of them; an append-only table refuses the
      // update outright. Either way the other workspace's row is untouched.
      const update = await db
        .withWorkspace(current.workspace, (tx) =>
          tx.execute(sql.raw(`UPDATE ${table} SET workspace_id = workspace_id WHERE workspace_id = '${other}'`)),
        )
        .then(
          (result) => ({ rowCount: result.rowCount, error: null }),
          (err) => ({ rowCount: null, error: messagesOf(err) }),
        );
      if (seed.appendOnly) expect(update.error).toMatch(/permission denied/);
      else expect(update.rowCount).toBe(0);
      const { rows } = await current.db.admin.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${table} WHERE workspace_id = $1`,
        [other],
      );
      expect(rows[0]?.count).toBe(1);
    });
  }

  it('allows one active data key per workspace and purpose', async () => {
    const { rows } = await current.db.admin.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'data_keys' AND indexname = 'data_keys_one_active'`,
    );
    expect(rows[0]?.indexdef).toMatch(/\(workspace_id, purpose\)/);
    expect(rows[0]?.indexdef).toMatch(/WHERE active/);

    // A second purpose must not collide with the secrets key's uniqueness.
    await current.db.admin.query(
      `INSERT INTO data_keys (workspace_id, id, kek_id, wrapped_key, purpose)
       VALUES ($1, 'dk-identity', 'kek-seed', '\\x00'::bytea, 'identity')`,
      [current.workspace],
    );
    const active = await current.db.admin.query<{ purpose: string }>(
      'SELECT purpose FROM data_keys WHERE workspace_id = $1 ORDER BY purpose',
      [current.workspace],
    );
    expect(active.rows.map((row) => row.purpose).sort()).toEqual(['identity', 'secrets']);
  });

  it('lets the app role insert a workspace for workspace.create (RLS still scopes it)', async () => {
    const created = randomUUID();
    await db.withWorkspace(created, (tx) =>
      tx.execute(
        sql`INSERT INTO workspaces (id, name, approval_policy, settings) VALUES (${created}, 'New', 'agent_changes', '{"switch":"off"}')`,
      ),
    );
    const [row] = (
      await current.db.admin.query<{ settings: Record<string, unknown> }>('SELECT settings FROM workspaces WHERE id = $1', [created])
    ).rows;
    expect(row?.settings).toEqual({ switch: 'off' });
  });
});
