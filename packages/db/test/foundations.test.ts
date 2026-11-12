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
  workspace_members: {
    insert: `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, 'seed-user', 'viewer')`,
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
