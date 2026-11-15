import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, createDisposableDb, type DisposableDb, hasTestDatabase } from './disposable';

// The three security-definer enqueue functions are the only way packages/crawl, packages/change-sets
// and packages/recommendations queue a worker job. Each already checks `app.workspace_id` and the row
// it names, but a function is executable by PUBLIC by default: without an explicit REVOKE, any role
// that can reach the schema may call it. 0007's crawl_enqueue carries the revoke; 0010's and 0011's
// did not, and 0012 fixes that. This test holds all three to the same privilege, so a new enqueue
// function cannot arrive with the default grant.

/** The functions, spelled as a regprocedure so `has_function_privilege` resolves exactly one. */
const ENQUEUE_FUNCTIONS = [
  'crawl_enqueue(text, jsonb, timestamptz)',
  'change_set_enqueue(text, jsonb, timestamptz)',
  'recommendation_enqueue(text, jsonb, timestamptz)',
] as const;

interface AclRow {
  name: string;
  /** `pg_proc.proacl` as text; an entry is `grantee=privileges/grantor`, PUBLIC has an empty grantee. */
  acl: string;
}

describe.skipIf(!hasTestDatabase())('enqueue function privileges', () => {
  let disposable: DisposableDb;

  beforeAll(async () => {
    disposable = await createDisposableDb('db_function_grants');
  });

  afterAll(async () => {
    await disposable?.close();
  });

  it('grants the enqueue functions to the app role and revokes the default PUBLIC grant', async () => {
    const { rows } = await disposable.db.admin.query<AclRow>(
      `SELECT p.proname AS name, coalesce(array_to_string(p.proacl, ','), '') AS acl
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
        ORDER BY p.proname`,
      [ENQUEUE_FUNCTIONS.map((fn) => fn.slice(0, fn.indexOf('(')))],
    );
    expect(rows.map((row) => row.name).sort()).toEqual(['change_set_enqueue', 'crawl_enqueue', 'recommendation_enqueue']);

    for (const row of rows) {
      const entries = row.acl.split(',').filter(Boolean);
      expect({ name: row.name, entries: entries.length > 0 }).toEqual({ name: row.name, entries: true });
      // PUBLIC is written with an empty grantee (`=X/postgres`), so an entry with no grantee is the
      // default grant this migration exists to remove.
      for (const entry of entries) {
        expect({ name: row.name, grantee: entry.slice(0, entry.indexOf('=')) }).not.toEqual({ name: row.name, grantee: '' });
      }
      expect({ name: row.name, appRole: entries.some((entry) => entry.startsWith(`${APP_ROLE.appRole}=`)) }).toEqual({
        name: row.name,
        appRole: true,
      });
    }
  });

  it('refuses a role without the grant, while the app role may call them', async () => {
    const outsider = `aseo_nogrant_${randomBytes(4).toString('hex')}`;
    const client = new pg.Client({ connectionString: disposable.url.toString() });
    await client.connect();
    try {
      await client.query(`CREATE ROLE ${outsider} NOLOGIN`);

      for (const fn of ENQUEUE_FUNCTIONS) {
        const { rows: app } = await client.query<{ allowed: boolean }>('SELECT has_function_privilege($1, $2, $3) AS allowed', [
          APP_ROLE.appRole,
          fn,
          'EXECUTE',
        ]);
        const { rows: role } = await client.query<{ allowed: boolean }>('SELECT has_function_privilege($1, $2, $3) AS allowed', [
          outsider,
          fn,
          'EXECUTE',
        ]);
        expect({ fn, appRole: app[0]?.allowed, outsider: role[0]?.allowed }).toEqual({ fn, appRole: true, outsider: false });
      }

      // Not only the catalogue's answer: Postgres refuses the call itself, before the function runs.
      await client.query(`SET ROLE ${outsider}`);
      await expect(client.query(`SELECT change_set_enqueue('changes_apply', '{}'::jsonb, now())`)).rejects.toMatchObject({
        code: '42501',
      });
      await expect(client.query(`SELECT recommendation_enqueue('recommendations_generate', '{}'::jsonb, now())`)).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await client.query('RESET ROLE').catch(() => undefined);
      await client.query(`DROP ROLE IF EXISTS ${outsider}`).catch(() => undefined);
      await client.end();
    }
  });
});
