import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ensureAppRole, isNoTransaction, migrate, splitSqlStatements } from '../src/migrate';
import { hasTestDatabase } from './disposable';
import { runScoped } from './run';

// The migrator's no-transaction marker: a file whose first line is `-- aseo:no-transaction` must
// run one statement at a time, outside BEGIN/COMMIT, so CREATE INDEX CONCURRENTLY works. It must
// stay safe to retry and must be recorded only after the whole file succeeds.

const APP_ROLE = { appRole: 'aseo_nt_test_app', appRolePassword: 'aseo_nt_test_password' };

const baseUrl = () => new URL(process.env.TEST_DATABASE_URL ?? '');
/** The server's maintenance database: the one in TEST_DATABASE_URL need not exist (CI creates `aseo`). */
const maintUrl = () => {
  const url = baseUrl();
  url.pathname = '/postgres';
  return url.toString();
};

async function createDatabase(prefix: string): Promise<{ url: URL; name: string }> {
  const name = runScoped(`aseo_${prefix}_${process.pid}_${randomBytes(4).toString('hex')}`);
  const maint = new pg.Client({ connectionString: maintUrl() });
  await maint.connect();
  try {
    await maint.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await maint.query(`CREATE DATABASE ${name}`);
  } finally {
    await maint.end();
  }
  const url = baseUrl();
  url.pathname = `/${name}`;
  return { url, name };
}

async function dropDatabase(name: string) {
  const maint = new pg.Client({ connectionString: maintUrl() });
  await maint.connect();
  try {
    await maint.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await maint.end();
  }
}

async function withDatabase(prefix: string, fn: (url: URL) => Promise<void>) {
  const { url, name } = await createDatabase(prefix);
  try {
    await fn(url);
  } finally {
    await dropDatabase(name);
  }
}

async function tempMigrations(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aseo-migrations-'));
  for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql);
  return dir;
}

// These tests create and migrate real databases; under a full parallel run that takes longer
// than the default timeout.
vi.setConfig({ testTimeout: 90_000 });

describe('splitSqlStatements', () => {
  it('keeps semicolons inside strings, identifiers, dollar quotes and comments', () => {
    const sql = `-- a comment; with a semicolon
CREATE TABLE "odd;name" (value text DEFAULT 'a;b');
CREATE FUNCTION probe() RETURNS void LANGUAGE plpgsql AS $body$
  BEGIN
    PERFORM 'still; inside';
  END
$body$;
/* block; comment */
INSERT INTO t VALUES (E'escaped\\';semicolon');`;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain('CREATE TABLE "odd;name"');
    expect(statements[1]).toContain('$body$');
    expect(statements[2]).toContain("E'escaped");
  });

  it('drops whitespace and comment-only chunks', () => {
    expect(splitSqlStatements('-- only a comment;\n/* and another */\n')).toEqual([]);
  });

  it('recognises the marker only as the first line', () => {
    expect(isNoTransaction('-- aseo:no-transaction\nSELECT 1;')).toBe(true);
    expect(isNoTransaction('\uFEFF\n  -- aseo:no-transaction\nSELECT 1;')).toBe(true);
    expect(isNoTransaction('-- a comment\n-- aseo:no-transaction\nSELECT 1;')).toBe(false);
  });
});

describe.skipIf(!hasTestDatabase())('no-transaction migrations', () => {
  const leftovers: string[] = [];
  afterAll(async () => {
    for (const dir of leftovers) await rm(dir, { recursive: true, force: true });
  });

  it('runs a marked file outside a transaction: each statement gets its own transaction id', async () => {
    await withDatabase('nt_marker', async (url) => {
      const dir = await tempMigrations({
        '001_split.sql': `-- aseo:no-transaction
CREATE TABLE aseo_nt_xid (n integer PRIMARY KEY, xid xid8);
INSERT INTO aseo_nt_xid VALUES (1, pg_current_xact_id());
INSERT INTO aseo_nt_xid VALUES (2, pg_current_xact_id());
`,
      });
      leftovers.push(dir);
      const pool = new pg.Pool({ connectionString: url.toString() });
      try {
        await migrate(pool, { ...APP_ROLE, dir });
        // Two statements in one transaction share an xid; autocommit gives each its own.
        const { rows } = await pool.query<{ distinct: number }>('SELECT count(DISTINCT xid)::int AS distinct FROM aseo_nt_xid');
        expect(rows[0]?.distinct).toBe(2);
        const applied = await pool.query<{ version: string }>('SELECT version FROM schema_migrations');
        expect(applied.rows.map((row) => row.version)).toEqual(['001_split.sql']);
      } finally {
        await pool.end();
      }
    });
  });

  it('still wraps a normal file in one transaction: every statement shares one transaction id', async () => {
    await withDatabase('nt_normal', async (url) => {
      const dir = await tempMigrations({
        '001_single.sql': `CREATE TABLE aseo_nt_xid (n integer PRIMARY KEY, xid xid8);
INSERT INTO aseo_nt_xid VALUES (1, pg_current_xact_id());
INSERT INTO aseo_nt_xid VALUES (2, pg_current_xact_id());
`,
      });
      leftovers.push(dir);
      const pool = new pg.Pool({ connectionString: url.toString() });
      try {
        await migrate(pool, { ...APP_ROLE, dir });
        const { rows } = await pool.query<{ distinct: number }>('SELECT count(DISTINCT xid)::int AS distinct FROM aseo_nt_xid');
        expect(rows[0]?.distinct).toBe(1);
      } finally {
        await pool.end();
      }
    });
  });

  it('is idempotent when re-run: the marker file is applied once and its index stays valid', async () => {
    await withDatabase('nt_rerun', async (url) => {
      const dir = await tempMigrations({
        '001_probe.sql': `-- aseo:no-transaction
CREATE TABLE IF NOT EXISTS aseo_nt_probe (id integer PRIMARY KEY);
INSERT INTO aseo_nt_probe VALUES (1) ON CONFLICT DO NOTHING;
CREATE INDEX CONCURRENTLY IF NOT EXISTS aseo_nt_probe_idx ON aseo_nt_probe (id);
`,
      });
      leftovers.push(dir);
      const pool = new pg.Pool({ connectionString: url.toString() });
      try {
        const first: string[] = [];
        await migrate(pool, { ...APP_ROLE, dir, log: (m) => first.push(m) });
        const second: string[] = [];
        await migrate(pool, { ...APP_ROLE, dir, log: (m) => second.push(m) });
        expect(first).toEqual(['applied 001_probe.sql (no transaction)']);
        expect(second).toEqual([]);
        const { rows } = await pool.query<{ version: string }>('SELECT version FROM schema_migrations');
        expect(rows).toHaveLength(1);
        const valid = await pool.query<{ valid: boolean }>(
          `SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = 'aseo_nt_probe_idx'::regclass`,
        );
        expect(valid.rows[0]?.valid).toBe(true);
      } finally {
        await pool.end();
      }
    });
  });

  it('leaves earlier statements committed after a failure, records nothing, and resumes on the next run', async () => {
    await withDatabase('nt_failure', async (url) => {
      const good = `-- aseo:no-transaction
CREATE TABLE IF NOT EXISTS aseo_nt_probe (id integer PRIMARY KEY);
INSERT INTO aseo_nt_probe VALUES (1) ON CONFLICT DO NOTHING;
`;
      const dir = await tempMigrations({ '001_probe.sql': `${good}SELECT * FROM aseo_nt_missing_table;\n` });
      leftovers.push(dir);
      const pool = new pg.Pool({ connectionString: url.toString() });
      try {
        await expect(migrate(pool, { ...APP_ROLE, dir })).rejects.toThrow(/aseo_nt_missing_table/);
        const before = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM aseo_nt_probe');
        expect(Number(before.rows[0]?.count)).toBe(1);
        const recorded = await pool.query('SELECT version FROM schema_migrations');
        expect(recorded.rows).toHaveLength(0);

        // Fix the file: the first two statements were committed, so they must be harmless again.
        await writeFile(join(dir, '001_probe.sql'), good);
        await migrate(pool, { ...APP_ROLE, dir });
        const after = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM aseo_nt_probe');
        expect(Number(after.rows[0]?.count)).toBe(1);
        const applied = await pool.query('SELECT version FROM schema_migrations');
        expect(applied.rows).toHaveLength(1);
      } finally {
        await pool.end();
      }
    });
  });

  it('drops an INVALID index left by an interrupted concurrent build and rebuilds it', async () => {
    await withDatabase('nt_invalid', async (url) => {
      const dir = await tempMigrations({
        '001_index.sql': `-- aseo:no-transaction
CREATE TABLE IF NOT EXISTS aseo_nt_invalid (id integer PRIMARY KEY);
CREATE INDEX CONCURRENTLY IF NOT EXISTS aseo_nt_invalid_idx ON aseo_nt_invalid (id);
`,
      });
      leftovers.push(dir);
      const pool = new pg.Pool({ connectionString: url.toString() });
      try {
        await pool.query('CREATE TABLE aseo_nt_invalid (id integer PRIMARY KEY)');
        await pool.query('CREATE INDEX aseo_nt_invalid_idx ON aseo_nt_invalid (id)');
        // An interrupted CREATE INDEX CONCURRENTLY leaves exactly this catalog state.
        await pool.query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'aseo_nt_invalid_idx'::regclass`);
        await migrate(pool, { ...APP_ROLE, dir });
        const { rows } = await pool.query<{ valid: boolean }>(
          `SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = 'aseo_nt_invalid_idx'::regclass`,
        );
        expect(rows[0]?.valid).toBe(true);
      } finally {
        await pool.end();
      }
    });
  });

  it('a second migrator waits for a concurrent index build without blocking it', async () => {
    // The first instance builds an index CONCURRENTLY whose predicate sleeps once, so the build is
    // still running when the second instance starts. A blocking `pg_advisory_lock` in the second
    // instance would keep a snapshot alive that this build waits for, and the two would hang
    // forever: no one can make progress. `pg_try_advisory_lock` plus a sleep in Node lets the build
    // finish; the second instance then finds every file applied.
    await withDatabase('nt_lock', async (url) => {
      const dir = await tempMigrations({
        '001_items.sql': `CREATE TABLE aseo_nt_lock (id integer PRIMARY KEY);
INSERT INTO aseo_nt_lock SELECT generate_series(1, 5000);
CREATE FUNCTION aseo_nt_slow(integer) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $body$
BEGIN
  IF $1 = 1 THEN PERFORM pg_sleep(3); END IF;
  RETURN true;
END
$body$;
`,
        '002_index.sql': `-- aseo:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS aseo_nt_lock_slow_idx ON aseo_nt_lock (id) WHERE aseo_nt_slow(id);
`,
      });
      leftovers.push(dir);
      const pools = [new pg.Pool({ connectionString: url.toString() }), new pg.Pool({ connectionString: url.toString() })];
      // Terminating a backend on timeout makes its client emit 'error'; the test is ending anyway.
      for (const pool of pools) pool.on('error', () => {});
      let finished = false;
      try {
        const logA: string[] = [];
        const logB: string[] = [];
        const a = migrate(pools[0]!, { ...APP_ROLE, dir, log: (m) => logA.push(m) });
        // Wait until the concurrent build is actually on the server before starting the second.
        for (let i = 0; i < 200; i++) {
          const { rows } = await pools[0]!.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM pg_stat_activity
              WHERE datname = current_database() AND state = 'active'
                AND query ILIKE '%CREATE INDEX CONCURRENTLY%'`,
          );
          if (Number(rows[0]?.n) > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const b = migrate(pools[1]!, { ...APP_ROLE, dir, log: (m) => logB.push(m) });
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('the migrators did not finish; they are waiting on each other')), 30_000),
        );
        await Promise.race([Promise.all([a, b]), timeout]);
        finished = true;
        // The first instance applied both files; the second found them applied and did nothing.
        expect(logA).toEqual(['applied 001_items.sql', 'applied 002_index.sql (no transaction)']);
        expect(logB).toEqual(['waiting for the migration lock held by another instance…']);
        const { rows } = await pools[0]!.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
        expect(rows.map((r) => r.version)).toEqual(['001_items.sql', '002_index.sql']);
        const valid = await pools[0]!.query<{ valid: boolean }>(
          `SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = 'aseo_nt_lock_slow_idx'::regclass`,
        );
        expect(valid.rows[0]?.valid).toBe(true);
      } finally {
        // If the race timed out (the deadlock this test guards against), the pools still hold
        // statements that are waiting on each other. End those backends so the database can be
        // dropped and the suite does not hang.
        if (!finished) {
          const maint = new pg.Client({ connectionString: maintUrl() });
          await maint.connect();
          await maint
            .query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [
              url.pathname.slice(1),
            ])
            .catch(() => {});
          await maint.end();
        }
        await Promise.all(pools.map((p) => p.end().catch(() => {})));
      }
    });
  }, 60_000);
});

describe.skipIf(!hasTestDatabase())('the application role', () => {
  it('strips superuser and bypassrls from an existing role, and refuses a role that inherits them', async () => {
    const role = runScoped(`role_${randomBytes(3).toString('hex')}`);
    const parent = runScoped(`role_parent_${randomBytes(3).toString('hex')}`);
    const client = new pg.Client({ connectionString: maintUrl() });
    await client.connect();
    try {
      for (const name of [role, parent]) await client.query(`DROP ROLE IF EXISTS ${name}`);
      // A role created by hand (or by an older installer) must not keep its bypass privileges.
      await client.query(`CREATE ROLE ${role} LOGIN SUPERUSER BYPASSRLS PASSWORD 'initial'`);
      await ensureAppRole(client, { appRolePassword: 'changed', appRole: role });
      const { rows } = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
        [role],
      );
      expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });

      // Membership in a bypassing role is not an attribute, but it grants the same reach through
      // SET ROLE, so the migrator must refuse rather than quietly accept it.
      await client.query(`CREATE ROLE ${parent} NOLOGIN BYPASSRLS`);
      await client.query(`GRANT ${parent} TO ${role}`);
      await expect(ensureAppRole(client, { appRolePassword: 'changed', appRole: role })).rejects.toThrow(/bypass/i);
    } finally {
      await client.query(`REVOKE ${parent} FROM ${role}`).catch(() => {});
      for (const name of [role, parent]) await client.query(`DROP ROLE IF EXISTS ${name}`).catch(() => {});
      await client.end();
    }
  });
});
