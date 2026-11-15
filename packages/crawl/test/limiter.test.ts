import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDatabase } from '../../db/test/disposable';
import { PgHostLimiter } from '../src';
import { type CrawlTestContext, createCrawlTestContext } from './support';

// The Postgres-backed host limiter: the per-host concurrency limit is global across worker
// replicas, leases expire, and a 429/503 pauses the host for everyone.

describe.skipIf(!hasTestDatabase())('PgHostLimiter', () => {
  let ctx: CrawlTestContext;

  beforeAll(async () => {
    ctx = await createCrawlTestContext('crawl_limiter');
  }, 120_000);

  afterAll(async () => {
    await ctx?.db.close();
    await ctx?.disposable.close();
  });

  const countLeases = async (host: string): Promise<number> => {
    const { rows } = await ctx.db.app.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM crawl_host_leases WHERE host = $1 AND expires_at > now()',
      [host],
    );
    return Number(rows[0]?.n ?? 0);
  };

  it('never lets two limiter instances exceed the global per-host limit', async () => {
    const first = new PgHostLimiter(ctx.db, { owner: 'limit-a', maxConcurrencyPerHost: 2, minDelayMs: 0, pollIntervalMs: 5 });
    const second = new PgHostLimiter(ctx.db, { owner: 'limit-b', maxConcurrencyPerHost: 2, minDelayMs: 0, pollIntervalMs: 5 });
    let peak = 0;
    const work = async (limiter: PgHostLimiter) => {
      const lease = await limiter.acquire('shared.test');
      peak = Math.max(peak, await countLeases('shared.test'));
      await new Promise((resolve) => setTimeout(resolve, 60));
      await lease.release();
    };
    await Promise.all(Array.from({ length: 10 }, (_, index) => work(index % 2 === 0 ? first : second)));
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2);
    expect(await countLeases('shared.test')).toBe(0);
  });

  it('reclaims a lease whose holder died', async () => {
    const limiter = new PgHostLimiter(ctx.db, { owner: 'limit-reclaim', maxConcurrencyPerHost: 1, minDelayMs: 0, pollIntervalMs: 5 });
    await ctx.db.app.query(
      "INSERT INTO crawl_host_leases (host, owner, acquired_at, expires_at) VALUES ('dead.test', 'killed-worker', now() - interval '5 minutes', now() - interval '1 minute')",
    );
    const lease = await limiter.acquire('dead.test');
    expect(lease.host).toBe('dead.test');
    await lease.release();
    expect(await countLeases('dead.test')).toBe(0);
  });

  it('pauses the host for everyone after a 429 with Retry-After', async () => {
    const limiter = new PgHostLimiter(ctx.db, { owner: 'limit-pause', maxConcurrencyPerHost: 2, minDelayMs: 0, pollIntervalMs: 5 });
    await limiter.noteResponse('slow.test', { status: 429, retryAfter: '1' });
    const started = Date.now();
    const lease = await limiter.acquire('slow.test');
    const waited = Date.now() - started;
    await lease.release();
    expect(waited).toBeGreaterThanOrEqual(900);

    // A second instance sees the same pause: it lives in Postgres, not in this process.
    const other = new PgHostLimiter(ctx.db, { owner: 'limit-pause-2', maxConcurrencyPerHost: 2, minDelayMs: 0, pollIntervalMs: 5 });
    await other.noteResponse('slow.test', { status: 503, retryAfter: '1' });
    const secondStart = Date.now();
    const second = await other.acquire('slow.test');
    expect(Date.now() - secondStart).toBeGreaterThanOrEqual(900);
    await second.release();
  });
});
