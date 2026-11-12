import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRobotsCache, Robots, type RobotsFetch, SafeFetchError, type SafeFetchOptions } from '../src';
import { closeSites, loopback, startSite, tableResolver } from './support';

afterEach(closeSites);

const ROBOTS = [
  'User-agent: *',
  'Disallow: /private/',
  'Crawl-delay: 2',
  'Sitemap: https://example.test/sitemap.xml',
  '',
  'User-agent: AgenticSEO',
  'Disallow: /bot-blocked/',
  'Allow: /bot-blocked/ok',
].join('\n');

/** A robots fetch that answers from a table, recording the request. */
function stubFetch(status: number, body = '', calls: Array<{ url: string; userAgent?: string }> = [], truncated = false): RobotsFetch {
  return async (url, options) => {
    calls.push({ url, userAgent: options?.userAgent });
    const headers: Record<string, string> = { 'content-type': 'text/plain' };
    return {
      requestUrl: url,
      url,
      status,
      headers,
      contentType: 'text/plain',
      charset: 'utf-8',
      body: Buffer.from(body),
      text: body,
      truncated,
      redirects: [],
      timings: { dnsMs: 0, connectMs: 0, ttfbMs: 0, totalMs: 0 },
    };
  };
}

describe('robots.txt', () => {
  it('parses rules, crawl-delay and sitemaps with Google precedence', async () => {
    const robots = new Robots({ fetch: stubFetch(200, ROBOTS) });
    const policy = await robots.policy('https://example.test/');

    expect(policy.status).toBe(200);
    expect(policy.unavailable).toBe(false);
    expect(policy.sitemaps).toEqual(['https://example.test/sitemap.xml']);
    expect(policy.crawlDelaySeconds).toBe(2);
    expect(policy.isAllowed('https://example.test/page', 'AgenticSEO')).toBe(true);
    // Google's precedence: a host-specific group replaces `*` for that agent, so `/private/` is
    // not blocked for us — only the rules in our own group apply.
    expect(policy.isAllowed('https://example.test/private/secret', 'AgenticSEO')).toBe(true);
    expect(policy.isAllowed('https://example.test/bot-blocked/page', 'AgenticSEO')).toBe(false);
    expect(policy.isAllowed('https://example.test/bot-blocked/ok', 'AgenticSEO')).toBe(true);
    // Another agent gets the `*` group.
    expect(policy.isAllowed('https://example.test/private/secret', 'Googlebot')).toBe(false);
    expect(policy.isAllowed('https://example.test/bot-blocked/page', 'Googlebot')).toBe(true);
  });

  it('allows everything on 4xx: a missing file is not a block', async () => {
    const robots = new Robots({ fetch: stubFetch(404) });
    expect(await robots.isAllowed('https://example.test/anything')).toBe(true);
    expect((await robots.policy('https://example.test/')).unavailable).toBe(false);
  });

  it('disallows everything temporarily on 5xx, 429 and an unreachable file', async () => {
    for (const status of [500, 503, 429]) {
      const robots = new Robots({ fetch: stubFetch(status) });
      const policy = await robots.policy('https://example.test/');
      expect(policy.unavailable, String(status)).toBe(true);
      expect(policy.isAllowed('https://example.test/page'), String(status)).toBe(false);
    }

    const unreachable: RobotsFetch = async () => {
      throw new SafeFetchError('connection', 'connection refused');
    };
    const robots = new Robots({ fetch: unreachable });
    expect(await robots.isAllowed('https://example.test/page')).toBe(false);
  });

  it('caches per origin for the TTL and refetches after it', async () => {
    const calls: Array<{ url: string }> = [];
    let now = 1_000;
    const robots = new Robots({ fetch: stubFetch(200, ROBOTS, calls), ttlMs: 1000, now: () => now });

    await robots.isAllowed('https://example.test/a');
    await robots.isAllowed('https://example.test/b');
    await robots.crawlDelayMs('https://example.test/');
    expect(calls).toHaveLength(1);

    now += 1001;
    await robots.isAllowed('https://example.test/c');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://example.test/robots.txt');
  });

  it('retries an unavailable robots.txt after the short TTL', async () => {
    let now = 0;
    const calls: Array<{ url: string }> = [];
    const robots = new Robots({ fetch: stubFetch(503, '', calls), unavailableTtlMs: 300, now: () => now });
    await robots.policy('https://example.test/');
    now += 500;
    await robots.policy('https://example.test/');
    expect(calls).toHaveLength(2);
  });

  it('shares one in-flight fetch between concurrent requests', async () => {
    let calls = 0;
    const slow: RobotsFetch = async (url) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return stubFetch(200, ROBOTS)(url);
    };
    const robots = new Robots({ fetch: slow });
    const results = await Promise.all([
      robots.isAllowed('https://example.test/a'),
      robots.isAllowed('https://example.test/b'),
      robots.isAllowed('https://example.test/c'),
    ]);
    expect(results).toEqual([true, true, true]);
    expect(calls).toBe(1);
  });

  it('sends the honest user agent and asks for each origin separately', async () => {
    const calls: Array<{ url: string; userAgent?: string }> = [];
    const robots = new Robots({
      fetch: stubFetch(200, ROBOTS, calls),
      bot: { version: '1.2.3', publicUrl: 'https://seo.example' },
    });
    await robots.isAllowed('https://example.test/a');
    await robots.isAllowed('https://other.test/b');
    expect(calls.map((call) => call.url)).toEqual(['https://example.test/robots.txt', 'https://other.test/robots.txt']);
    expect(calls[0]?.userAgent).toBe('AgenticSEO/1.2.3 (+https://seo.example/bot)');
  });

  it('fetches robots.txt through the SSRF guard with the site allow-list', async () => {
    const site = await startSite((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('User-agent: *\nDisallow: /private/\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>ok</h1>');
    });
    const options: SafeFetchOptions = {
      resolver: tableResolver({ 'site.test': loopback }),
      allow: { privateHosts: ['site.test'], ports: [site.port] },
    };
    const robots = new Robots({ fetchOptions: options });
    expect(await robots.isAllowed(`http://site.test:${site.port}/public`)).toBe(true);
    expect(await robots.isAllowed(`http://site.test:${site.port}/private/x`)).toBe(false);
    expect(site.requests[0]?.url).toBe('/robots.txt');
  });

  it('parses the prefix of an oversized robots.txt instead of disallowing the site', async () => {
    const head = 'User-agent: *\nDisallow: /private/\n';
    const filler = 'Sitemap: https://example.test/sitemap.xml\n'.repeat(50);
    const site = await startSite((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${head}${filler}`);
    });

    const robots = new Robots({
      maxBytes: Buffer.byteLength(head) + 80,
      fetchOptions: {
        resolver: tableResolver({ 'site.test': loopback }),
        allow: { privateHosts: ['site.test'], ports: [site.port] },
      },
    });

    const policy = await robots.policy(`http://site.test:${site.port}/`);

    expect(policy.status).toBe(200);
    expect(policy.unavailable).toBe(false);
    expect(policy.isAllowed(`http://site.test:${site.port}/private/x`)).toBe(false);
    expect(policy.isAllowed(`http://site.test:${site.port}/public`)).toBe(true);
    expect(policy.sitemaps).toEqual(['https://example.test/sitemap.xml']);
  });

  it('keeps only complete lines from a truncated robots.txt', async () => {
    const body = 'User-agent: *\nDisallow: /blocked\nDisallow: /hal';
    const robots = new Robots({ fetch: stubFetch(200, body, [], true) });

    const policy = await robots.policy('https://example.test/');

    expect(policy.isAllowed('https://example.test/blocked')).toBe(false);
    // The last line was cut mid-directive, so it is not a rule at all.
    expect(policy.isAllowed('https://example.test/half')).toBe(true);
  });

  it('rejects a URL it cannot parse', async () => {
    const robots = new Robots({ fetch: stubFetch(200, ROBOTS) });
    await expect(robots.policy('not a url')).rejects.toBeInstanceOf(SafeFetchError);
  });
});

describe('MemoryRobotsCache', () => {
  it('keeps a bounded LRU, evicting the least recently used origin', async () => {
    const cache = new MemoryRobotsCache(2);
    const record = (origin: string) => ({ origin, status: 200, body: '', fetchedAt: 0, expiresAt: 1 });
    await cache.set(record('https://a.test'));
    await cache.set(record('https://b.test'));
    await cache.get('https://a.test');
    await cache.set(record('https://c.test'));

    expect(await cache.get('https://b.test')).toBeUndefined();
    expect(await cache.get('https://a.test')).toBeDefined();
    expect(await cache.get('https://c.test')).toBeDefined();
    expect(cache.size).toBe(2);

    await cache.delete('https://a.test');
    expect(await cache.get('https://a.test')).toBeUndefined();
  });
});
