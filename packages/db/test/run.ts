import { createHash } from 'node:crypto';

/**
 * The namespace for one test run, shared by every database that run creates. It is lower-case
 * letters and digits only, because the names become unquoted Postgres identifiers.
 *
 * `vitest.config.mts` can set AS_TEST_RUN once for the whole run; outside Vitest it is derived
 * from the checkout path and this process. CI keeps it empty, so its service container sees the
 * same fixed names as before.
 */

/** PostgreSQL truncates identifiers at NAMEDATALEN - 1 bytes; a longer name is a silent bug. */
export const MAX_IDENTIFIER_BYTES = 63;

/** Short enough that `aseo_<run>_` plus any test database name stays inside the limit. */
export const MAX_RUN_ID_LENGTH = 16;

/**
 * Lower-cases a run id, removes everything that is not a letter or digit, and hashes anything over
 * [MAX_RUN_ID_LENGTH] to 10 hex characters. Hashing keeps two different long ids distinct instead
 * of truncating them to the same prefix.
 */
export function sanitiseRunId(raw: string): string {
  const clean = raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (clean.length <= MAX_RUN_ID_LENGTH) return clean;
  return createHash('sha256').update(clean).digest('hex').slice(0, 10);
}

const explicitRun = sanitiseRunId(process.env.AS_TEST_RUN ?? '');
export const runId =
  explicitRun ||
  (process.env.CI
    ? ''
    : sanitiseRunId(`r${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 6)}${process.pid.toString(36)}`));

/**
 * `aseo_test_p1` becomes `aseo_<run>_test_p1`; unchanged when there is no run namespace (CI).
 * Throws when the final name would exceed PostgreSQL's 63-byte identifier limit, because the
 * server would otherwise truncate it and two namespaces could collide.
 */
export function runScopedFor(run: string, name: string): string {
  const scoped = !run ? name : name.startsWith('aseo_') ? `aseo_${run}_${name.slice(5)}` : `aseo_${run}_${name}`;
  const bytes = Buffer.byteLength(scoped, 'utf8');
  if (bytes > MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `Scoped identifier is ${bytes} bytes, over PostgreSQL's ${MAX_IDENTIFIER_BYTES}-byte identifier limit: ${scoped}. ` +
        'Shorten the database name or AS_TEST_RUN.',
    );
  }
  return scoped;
}

/**
 * The one authoritative database name for a run: the harness and `test:clean` use this. `run`
 * defaults to this process's run namespace.
 */
export function scopedDbName(name: string, run: string = runId): string {
  return runScopedFor(run, name);
}

/** Backwards-compatible alias used throughout the tests. */
export const runScoped = (name: string) => scopedDbName(name);
