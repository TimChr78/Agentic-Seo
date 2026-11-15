import type { Db } from '@agentic-seo/db';
import type { AcquireHostOptions, HostLease, HostLimiter, HostResponse } from '@agentic-seo/fetch';
import { parseRetryAfter } from '@agentic-seo/fetch';

// The Postgres-backed host limiter (crawler-and-audits.md §2): per-host concurrency, spacing and
// backoff that every worker replica shares, so adding workers never multiplies the load on a site.
//
// One row in `crawl_host_leases` per leased slot, one row in `crawl_host_pacing` per host for the
// next start time and a 429/503 pause. Leases expire, so a killed worker cannot hold a host. The
// tables are global on purpose (no workspace_id): politeness is per host, not per tenant.

export interface PgHostLimiterOptions {
  /** Requests in flight to one host, globally. Default 4. */
  maxConcurrencyPerHost?: number;
  /** Spacing between request starts when robots.txt sets no crawl-delay. Default 250 ms. */
  minDelayMs?: number;
  /** Pause after a 429 without `Retry-After`. Default 30 s. */
  pauseOnTooManyRequestsMs?: number;
  /** Pause after a 503 without `Retry-After`. Default 10 s. */
  pauseOnUnavailableMs?: number;
  /** A lease that is not released by then is reclaimed. Default 2 minutes (longer than a fetch). */
  leaseTtlMs?: number;
  /** How long to wait between two attempts to take a slot. Default 40 ms. */
  pollIntervalMs?: number;
  /** Names the holder in `crawl_host_leases.owner`, for diagnostics. */
  owner: string;
  now?: () => number;
}

type Pool = Db['app'];

/** A lease's row id, so release deletes exactly the row this caller took. */
interface RowLease extends HostLease {
  readonly id: number;
}

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export class PgHostLimiter implements HostLimiter {
  readonly #pool: Pool;
  readonly #maxConcurrency: number;
  readonly #minDelayMs: number;
  readonly #pauseOnTooManyRequestsMs: number;
  readonly #pauseOnUnavailableMs: number;
  readonly #leaseTtlMs: number;
  readonly #pollIntervalMs: number;
  readonly #owner: string;
  readonly #now: () => number;

  constructor(db: Db, options: PgHostLimiterOptions) {
    this.#pool = db.app;
    this.#maxConcurrency = Math.max(1, options.maxConcurrencyPerHost ?? 4);
    this.#minDelayMs = Math.max(0, options.minDelayMs ?? 250);
    this.#pauseOnTooManyRequestsMs = Math.max(0, options.pauseOnTooManyRequestsMs ?? 30_000);
    this.#pauseOnUnavailableMs = Math.max(0, options.pauseOnUnavailableMs ?? 10_000);
    this.#leaseTtlMs = Math.max(1_000, options.leaseTtlMs ?? 120_000);
    this.#pollIntervalMs = Math.max(5, options.pollIntervalMs ?? 40);
    this.#owner = options.owner;
    this.#now = options.now ?? Date.now;
  }

  /** Requests currently leased to the host (a diagnostic for the adaptive window). */
  async active(host: string): Promise<number> {
    const { rows } = await this.#pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM crawl_host_leases WHERE host = $1 AND expires_at > now()',
      [host.toLowerCase()],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async acquire(host: string, options: AcquireHostOptions = {}): Promise<HostLease> {
    const key = host.trim().toLowerCase();
    for (;;) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted');
      const attempt = await this.#tryAcquire(key, options.minDelayMs ?? this.#minDelayMs);
      if ('lease' in attempt) return attempt.lease;
      await delay(Math.min(this.#pollIntervalMs, Math.max(1, attempt.retryInMs)), options.signal);
    }
  }

  async release(lease: HostLease): Promise<void> {
    const id = (lease as RowLease).id;
    if (typeof id !== 'number') return;
    await this.#pool.query('DELETE FROM crawl_host_leases WHERE id = $1', [id]).catch(() => undefined);
  }

  async noteResponse(host: string, response: HostResponse): Promise<void> {
    if (response.status !== 429 && response.status !== 503) return;
    const fallback = response.status === 429 ? this.#pauseOnTooManyRequestsMs : this.#pauseOnUnavailableMs;
    await this.pause(host, parseRetryAfter(response.retryAfter, this.#now()) ?? fallback);
  }

  async pause(host: string, durationMs: number): Promise<void> {
    if (durationMs <= 0) return;
    const key = host.trim().toLowerCase();
    await this.#pool.query(
      `INSERT INTO crawl_host_pacing (host, paused_until) VALUES ($1, now() + $2::bigint * interval '1 millisecond')
       ON CONFLICT (host) DO UPDATE SET paused_until = GREATEST(COALESCE(crawl_host_pacing.paused_until, to_timestamp(0)), excluded.paused_until)`,
      [key, Math.round(durationMs)],
    );
  }

  /**
   * When this replica may next start a request to `host`: the later of the shared pacing table's
   * spacing and pause deadlines, as epoch milliseconds. Null when the host has no pacing row. A
   * chunk that stops while waiting uses it so its successor is not scheduled before another
   * replica's backoff ends.
   */
  async nextEligibleAt(host: string): Promise<number | null> {
    const { rows } = await this.#pool.query<{ at_ms: string | null }>(
      `SELECT GREATEST(
                EXTRACT(EPOCH FROM next_start_at) * 1000,
                EXTRACT(EPOCH FROM COALESCE(paused_until, to_timestamp(0))) * 1000
              )::text AS at_ms
       FROM crawl_host_pacing WHERE host = $1`,
      [host.trim().toLowerCase()],
    );
    const value = rows[0]?.at_ms;
    return value === null || value === undefined ? null : Math.round(Number(value));
  }

  /** Acquire a slot, run the work, and always release. */
  async run<T>(host: string, work: () => Promise<T>, options: AcquireHostOptions = {}): Promise<T> {
    const lease = await this.acquire(host, options);
    try {
      return await work();
    } finally {
      await this.release(lease);
    }
  }

  /**
   * One attempt to take a slot. The advisory lock makes "count the active leases, then insert"
   * atomic across replicas; expired leases are dropped under the same lock, so a killed worker's
   * slots come back without a separate sweeper.
   */
  async #tryAcquire(host: string, minDelayMs: number): Promise<{ lease: HostLease } | { retryInMs: number }> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`crawl-host:${host}`]);
      await client.query('DELETE FROM crawl_host_leases WHERE expires_at <= now()');

      const { rows: activeRows } = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM crawl_host_leases WHERE host = $1',
        [host],
      );
      if (Number(activeRows[0]?.count ?? 0) >= this.#maxConcurrency) {
        await client.query('COMMIT');
        return { retryInMs: this.#pollIntervalMs };
      }

      const { rows: pacingRows } = await client.query<{ wait_ms: string }>(
        `SELECT GREATEST(
                  EXTRACT(EPOCH FROM (next_start_at - now())) * 1000,
                  EXTRACT(EPOCH FROM (COALESCE(paused_until, to_timestamp(0)) - now())) * 1000,
                  0
                )::text AS wait_ms
         FROM crawl_host_pacing WHERE host = $1`,
        [host],
      );
      const waitMs = Math.ceil(Number(pacingRows[0]?.wait_ms ?? 0));
      if (waitMs > 0) {
        await client.query('COMMIT');
        return { retryInMs: Math.min(waitMs, 1_000) };
      }

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO crawl_host_leases (host, owner, expires_at)
         VALUES ($1, $2, now() + $3::bigint * interval '1 millisecond') RETURNING id::text AS id`,
        [host, this.#owner, this.#leaseTtlMs],
      );
      await client.query(
        `INSERT INTO crawl_host_pacing (host, next_start_at) VALUES ($1, now() + $2::bigint * interval '1 millisecond')
         ON CONFLICT (host) DO UPDATE SET next_start_at = excluded.next_start_at`,
        [host, Math.max(0, Math.round(minDelayMs))],
      );
      await client.query('COMMIT');
      const id = Number(rows[0]?.id);
      let released = false;
      const lease: RowLease = {
        host,
        id,
        release: async () => {
          if (released) return;
          released = true;
          await this.release(lease);
        },
      };
      return { lease };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
