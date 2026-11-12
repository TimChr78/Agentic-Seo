import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@agentic-seo/core';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const LOCK_KEY = 7_340_001; // arbitrary constant: one migrator at a time across pods

const roleName = /^[a-z_][a-z0-9_]{0,62}$/;

/** A migration file whose first line is this marker runs outside BEGIN/COMMIT, statement by statement. */
export const NO_TRANSACTION_MARKER = '-- aseo:no-transaction';

/** Migration files in apply order. Also used by backups to compare their schema head. */
export function migrationFiles(dir = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** The newest migration this build knows; a backup from a newer build names a higher one. */
export function latestMigration(): string | undefined {
  return migrationFiles().at(-1);
}

/** One short-lived admin connection for the read-only helpers below. */
async function withPgClient<T>(databaseUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * The app role's highest applied migration, or null when the database was never migrated.
 * `to_regclass` is checked first so a backup of a fresh database still works.
 */
export function migrationHead(databaseUrl: string): Promise<string | null> {
  return withPgClient(databaseUrl, async (client) => {
    const present = await client.query<{ present: boolean }>("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present");
    if (!present.rows[0]?.present) return null;
    const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
    return rows[0]?.version ?? null;
  });
}

/** Every workspace id, sorted so an export writes its files in a stable order. */
export function listWorkspaceIds(databaseUrl: string): Promise<string[]> {
  return withPgClient(databaseUrl, async (client) => {
    const present = await client.query<{ present: boolean }>("SELECT to_regclass('public.workspaces') IS NOT NULL AS present");
    if (!present.rows[0]?.present) return [];
    const { rows } = await client.query<{ id: string }>('SELECT id::text AS id FROM workspaces ORDER BY id');
    return rows.map((row) => row.id);
  });
}

type RoleClient = Pick<pg.Client, 'query' | 'escapeLiteral'>;

/**
 * Create or update the app role. Migrations and a restore both need it: the GRANTs in the
 * migrations name it, and it must exist before they run.
 */
export async function ensureAppRole(client: RoleClient, opts: { appRolePassword: string; appRole?: string }): Promise<string> {
  const role = opts.appRole ?? 'aseo_app';
  if (!roleName.test(role)) throw new Error(`Invalid app role name ${role}`);
  const pwd = client.escapeLiteral(opts.appRolePassword);
  // Roles are shared by every database on the server, and the migrator's advisory lock is per
  // database: two databases migrating at once (tests, a restore next to a running install) can
  // race on the same role row. Postgres reports that as "tuple concurrently updated" or a
  // duplicate role; both mean another session just wrote the same role, so look again and retry.
  for (let attempt = 1; ; attempt++) {
    const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    try {
      await client.query(
        rowCount ? `ALTER ROLE ${role} WITH LOGIN PASSWORD ${pwd}` : `CREATE ROLE ${role} LOGIN PASSWORD ${pwd} NOSUPERUSER NOBYPASSRLS`,
      );
      return role;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const raced = e.code === '23505' || e.code === '42710' || /tuple concurrently updated/.test(e.message ?? '');
      if (!raced || attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}

/** Ensures the role in the database behind `databaseUrl`; a restore runs this before pg_restore. */
export async function ensureAppRoleInDatabase(
  databaseUrl: string,
  opts: { appRolePassword?: string; appRole?: string },
): Promise<{ role: string; created: boolean; exists: boolean }> {
  const role = opts.appRole ?? 'aseo_app';
  if (!roleName.test(role)) throw new Error(`Invalid app role name ${role}`);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (opts.appRolePassword) {
      await ensureAppRole(client, { appRolePassword: opts.appRolePassword, appRole: role });
      return { role, created: !rowCount, exists: true };
    }
    return { role, created: false, exists: Boolean(rowCount) };
  } finally {
    await client.end();
  }
}

/** True when a file opts out of the per-migration transaction with its first line. */
export function isNoTransaction(sql: string): boolean {
  return sql
    .replace(/^\uFEFF/, '')
    .trimStart()
    .startsWith(NO_TRANSACTION_MARKER);
}

/** True when a chunk is only whitespace and SQL comments, so it has nothing to execute. */
function isCommentOnly(sql: string): boolean {
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c as string)) {
      i++;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      // Postgres block comments nest.
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    return false;
  }
  return true;
}

/** The dollar-quote tag at `i` (`$$` or `$name$`), or null for a positional parameter such as `$1`. */
function dollarTagAt(sql: string, i: number): string | null {
  return /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0] ?? null;
}

/**
 * Split a migration file into statements without being fooled by semicolons inside strings,
 * quoted identifiers, dollar-quoted function bodies or comments. A no-transaction migration runs
 * each statement on its own, because Postgres wraps a multi-statement query string in one implicit
 * transaction — the thing `CREATE INDEX CONCURRENTLY` refuses.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (c === "'") {
      // An E'...' string uses backslash escapes; a plain string does not (standard_conforming_strings).
      const before = i > 0 ? sql[i - 1] : '';
      const backslashEscapes = (before === 'E' || before === 'e') && (i < 2 || !/[A-Za-z0-9_$]/.test(sql[i - 2] as string));
      i++;
      while (i < sql.length) {
        if (backslashEscapes && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '$') {
      const tag = dollarTagAt(sql, i);
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? sql.length : end + tag.length;
        continue;
      }
    }
    if (c === ';') {
      const statement = sql.slice(start, i).trim();
      if (statement && !isCommentOnly(statement)) statements.push(statement);
      start = i + 1;
    }
    i++;
  }
  const tail = sql.slice(start).trim();
  if (tail && !isCommentOnly(tail)) statements.push(tail);
  return statements;
}

const CONCURRENT_INDEX_NAME =
  /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)/gi;

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Names of the indexes a file builds with CREATE INDEX CONCURRENTLY, for invalid-index recovery. */
export function concurrentIndexNames(sql: string): string[] {
  return [...sql.matchAll(CONCURRENT_INDEX_NAME)].map((match) =>
    (match[1] as string).startsWith('"') ? (match[1] as string).slice(1, -1).replace(/""/g, '"') : (match[1] as string),
  );
}

/**
 * Drop only indexes that Postgres marked INVALID. An interrupted CREATE INDEX CONCURRENTLY leaves
 * one behind; `IF NOT EXISTS` would otherwise skip rebuilding it forever.
 */
async function dropInvalidIndexes(client: Pick<pg.Client, 'query'>, names: string[]): Promise<void> {
  if (!names.length) return;
  const { rows } = await client.query<{ name: string }>(
    `SELECT c.relname AS name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT i.indisvalid AND c.relname = ANY($1::text[])`,
    [names],
  );
  for (const { name } of rows) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${quoteIdent(name)}`);
}

/**
 * Run a no-transaction migration one statement at a time, so each commits on its own and
 * `CREATE INDEX CONCURRENTLY` works. The file must be written to survive a retry: every statement
 * is idempotent. Before the build, an index left INVALID by an earlier attempt is dropped; after a
 * failure the same cleanup runs so the next start is not stuck on `IF NOT EXISTS`.
 */
async function applyNoTransaction(client: Pick<pg.Client, 'query'>, sql: string, role: string): Promise<void> {
  const indexes = concurrentIndexNames(sql);
  await dropInvalidIndexes(client, indexes);
  try {
    for (const statement of splitSqlStatements(sql)) {
      await client.query(role === 'aseo_app' ? statement : statement.replace(/\baseo_app\b/g, role));
    }
  } catch (err) {
    await dropInvalidIndexes(client, indexes).catch(() => {});
    throw err;
  }
}

/** How long to wait between attempts at the migration lock, and in total. */
const LOCK_RETRY_MS = 250;
const LOCK_TIMEOUT_MS = 5 * 60_000;

/**
 * Take the session-scoped migration lock without ever leaving a statement waiting.
 *
 * A blocking `SELECT pg_advisory_lock` is a statement with a live snapshot. While it waits, the
 * other instance's `CREATE INDEX CONCURRENTLY` waits for that snapshot to end before it can mark
 * the index valid — and the waiting statement waits for the lock that build holds. The two never
 * resolve. Short `pg_try_advisory_lock` calls, with the wait in Node between them, let the index
 * build finish; each attempt commits before the next one, so no old snapshot is left behind.
 */
async function acquireMigrationLock(client: Pick<pg.Client, 'query'>, log: (msg: string) => void): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let waiting = false;
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
    if (rows[0]?.locked) return;
    if (Date.now() >= deadline)
      throw new Error(
        `Could not acquire the migration lock within ${Math.round(LOCK_TIMEOUT_MS / 1000)} s: another instance is still migrating or an interrupted migration left the lock held. Check the other instance, then restart this one.`,
      );
    if (!waiting) {
      log('waiting for the migration lock held by another instance…');
      waiting = true;
    }
    // The sleep stays in Node, outside any database statement: a waiting statement would hold a
    // snapshot and keep the concurrent index build from finishing.
    await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}

export interface MigrateOptions {
  appRolePassword: string;
  appRole?: string;
  log?: (msg: string) => void;
  /** Directory of SQL files; tests point this at a temporary directory instead of the checkout. */
  dir?: string;
  /** Apply files up to and including this name, for tests that reconstruct an older schema. */
  upTo?: string;
}

/**
 * Apply pending SQL migrations in order. A normal file runs in one transaction; a file whose first
 * line is `-- aseo:no-transaction` runs outside one, statement by statement, for `CREATE INDEX
 * CONCURRENTLY`. Safe to run from several processes at once: the session lock is taken with
 * `pg_try_advisory_lock` in a loop so a waiting instance never holds a snapshot that would stall
 * the other instance's concurrent index build. Refuses to continue if an applied file was edited.
 * A no-transaction file is recorded only after every statement succeeds.
 *
 * The migrations grant privileges to `aseo_app`; `appRole` renames it, because roles are shared by
 * every database on a Postgres server (e.g. tests next to a development database).
 */
export async function migrate(admin: pg.Pool, opts: MigrateOptions) {
  const log = opts.log ?? (() => {});
  const client = await admin.connect();
  try {
    await acquireMigrationLock(client, log);
    // The app role is needed by the GRANTs in the migrations.
    const role = await ensureAppRole(client, opts);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const { rows } = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const file of migrationFiles(opts.dir).filter((name) => !opts.upTo || name <= opts.upTo)) {
      const sql = readFileSync(`${opts.dir ?? MIGRATIONS_DIR}/${file}`, 'utf8');
      const checksum = sha256(sql);
      const done = applied.get(file);
      if (done) {
        if (done !== checksum) throw new Error(`Migration ${file} was changed after it was applied. Add a new migration instead.`);
        continue;
      }
      if (isNoTransaction(sql)) {
        try {
          await applyNoTransaction(client, sql, role);
        } catch (err) {
          throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
        }
        // Recorded only now: a failure above leaves the file pending, and its statements idempotent.
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        log(`applied ${file} (no transaction)`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(role === 'aseo_app' ? sql : sql.replace(/\baseo_app\b/g, role));
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}
