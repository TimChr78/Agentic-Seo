import { describe, expect, it } from 'vitest';
import { MemoryHostLimiter, parseRetryAfter } from '../src';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('parseRetryAfter', () => {
  it('reads delta-seconds and HTTP dates, and ignores nonsense', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('0.5')).toBe(500);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 7_000)).toBe(3000);
    expect(parseRetryAfter(new Date(1_000).toUTCString(), 5_000)).toBe(0);
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter('-1')).toBeUndefined();
  });
});

describe('MemoryHostLimiter', () => {
  it('caps concurrency per host and lets the next request in when one is released', async () => {
    const limiter = new MemoryHostLimiter({ maxConcurrencyPerHost: 2, minDelayMs: 0 });
    const first = await limiter.acquire('example.test');
    const second = await limiter.acquire('example.test');
    expect(limiter.active('example.test')).toBe(2);

    let thirdGranted = false;
    const third = limiter.acquire('example.test').then((lease) => {
      thirdGranted = true;
      return lease;
    });
    await sleep(20);
    expect(thirdGranted).toBe(false);

    await first.release();
    const thirdLease = await third;
    expect(thirdGranted).toBe(true);
    expect(limiter.active('example.test')).toBe(2);

    await second.release();
    await thirdLease.release();
    expect(limiter.active('example.test')).toBe(0);
  });

  it('keeps hosts independent', async () => {
    const limiter = new MemoryHostLimiter({ maxConcurrencyPerHost: 1, minDelayMs: 0 });
    const a = await limiter.acquire('a.test');
    const b = await limiter.acquire('b.test');
    expect(limiter.active('a.test')).toBe(1);
    expect(limiter.active('b.test')).toBe(1);
    await a.release();
    await b.release();
  });

  it('spaces request starts by the delay', async () => {
    const limiter = new MemoryHostLimiter({ maxConcurrencyPerHost: 4, minDelayMs: 60 });
    const started = performance.now();
    const leases = [await limiter.acquire('slow.test'), await limiter.acquire('slow.test'), await limiter.acquire('slow.test')];
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(110);
    await Promise.all(leases.map((lease) => lease.release()));
  });

  it('keeps the spacing across sequential runs after the last lease is released', async () => {
    const limiter = new MemoryHostLimiter({ maxConcurrencyPerHost: 1, minDelayMs: 300 });
    const starts: number[] = [];
    const run = () =>
      limiter.run('sequential.test', async () => {
        starts.push(performance.now());
      });

    await run();
    await run();

    expect(starts).toHaveLength(2);
    // Releasing the last lease must not forget the next start time: the second run waits its turn.
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(250);
  });

  it('uses the crawl-delay as the spacing when one is given', async () => {
    const limiter = new MemoryHostLimiter({ maxConcurrencyPerHost: 4, minDelayMs: 0 });
    await limiter.acquire('crawl.test', { minDelayMs: 40 });
    const started = performance.now();
    const lease = await limiter.acquire('crawl.test');
    expect(performance.now() - started).toBeGreaterThanOrEqual(30);
    await lease.release();
  });

  it('pauses a host after 429 and honours Retry-After', async () => {
    const limiter = new MemoryHostLimiter({ maxConcurrencyPerHost: 1, minDelayMs: 0 });
    const lease = await limiter.acquire('limited.test');
    await limiter.noteResponse('limited.test', { status: 429, retryAfter: '0.1' });
    await lease.release();

    const started = performance.now();
    const next = await limiter.acquire('limited.test');
    expect(performance.now() - started).toBeGreaterThanOrEqual(80);
    await next.release();
  });

  it('falls back to its own pause when 503 carries no Retry-After', async () => {
    const limiter = new MemoryHostLimiter({ maxConcurrencyPerHost: 1, minDelayMs: 0, pauseOnUnavailableMs: 80 });
    await limiter.noteResponse('unavailable.test', { status: 503, retryAfter: null });
    const started = performance.now();
    const lease = await limiter.acquire('unavailable.test');
    expect(performance.now() - started).toBeGreaterThanOrEqual(60);
    await lease.release();
  });

  it('ignores statuses that are not 429 or 503', async () => {
    const limiter = new MemoryHostLimiter({ maxConcurrencyPerHost: 1, minDelayMs: 0 });
    await limiter.noteResponse('fine.test', { status: 200 });
    const started = performance.now();
    const lease = await limiter.acquire('fine.test');
    expect(performance.now() - started).toBeLessThan(50);
    await lease.release();
  });

  it('rejects a queued acquire that is aborted', async () => {
    const limiter = new MemoryHostLimiter({ maxConcurrencyPerHost: 1, minDelayMs: 0 });
    const held = await limiter.acquire('busy.test');
    const controller = new AbortController();
    const queued = limiter.acquire('busy.test', { signal: controller.signal });
    controller.abort(new Error('stop'));
    await expect(queued).rejects.toThrow('stop');
    await held.release();
  });

  it('runs work under a lease and releases it even when the work throws', async () => {
    const limiter = new MemoryHostLimiter({ maxConcurrencyPerHost: 1, minDelayMs: 0 });
    await expect(
      limiter.run('run.test', async () => {
        expect(limiter.active('run.test')).toBe(1);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(limiter.active('run.test')).toBe(0);
  });
});
