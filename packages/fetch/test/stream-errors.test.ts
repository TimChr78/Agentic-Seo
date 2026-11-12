import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { isSafeFetchError, SafeFetchError, safeFetch } from '../src';
import { closeSites, loopback, startSite } from './support';

// A compressed body that is cut short must settle instead of hanging: a stalled or reset socket
// has to reach the decoder and the waiting caller (security-and-privacy.md §1, the total deadline).

afterEach(closeSites);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function options(port: number) {
  return {
    resolver: async () => loopback,
    allow: { privateHosts: ['site.test'], ports: [port] },
  };
}

/** Waits for `promise` but fails instead of hanging if it does not settle in time. */
async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'hung'> {
  return Promise.race([promise, sleep(ms).then(() => 'hung' as const)]);
}

const PARTIAL_GZIP = gzipSync(Buffer.from('<html><body>compressed but cut short</body></html>')).subarray(0, 14);

describe('safeFetch: broken compressed bodies settle', () => {
  it('rejects with timeout when a partial gzip body stalls past the deadline', async () => {
    const site = await startSite((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
      res.write(PARTIAL_GZIP);
      // The header and part of the body arrive, then the server stops writing.
    });

    const started = performance.now();
    const outcome = await settleWithin(
      safeFetch(`http://site.test:${site.port}/`, { ...options(site.port), totalTimeoutMs: 250 }).catch((error) => error),
      2_000,
    );

    expect(outcome).not.toBe('hung');
    expect(outcome).toBeInstanceOf(SafeFetchError);
    if (!isSafeFetchError(outcome)) throw new Error('expected a SafeFetchError');
    expect(outcome.kind).toBe('timeout');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('rejects promptly when a partial gzip body is cut off by a socket reset', async () => {
    const site = await startSite((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
      res.write(PARTIAL_GZIP);
      setTimeout(() => res.destroy(), 20);
    });

    const started = performance.now();
    const outcome = await settleWithin(
      safeFetch(`http://site.test:${site.port}/`, { ...options(site.port), totalTimeoutMs: 5_000 }).catch((error) => error),
      2_000,
    );

    expect(outcome).not.toBe('hung');
    expect(outcome).toBeInstanceOf(SafeFetchError);
    if (!isSafeFetchError(outcome)) throw new Error('expected a SafeFetchError');
    expect(['connection', 'timeout']).toContain(outcome.kind);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
