import { gzipSync } from 'node:zlib';
import type { FetchResult } from '@agentic-seo/fetch';
import { describe, expect, it } from 'vitest';
import { fetchSitemap, parseSitemap, probeHttpRedirect, readSitemaps } from '../src';

const hosts = ['example.com'];

const response = (url: string, body: string | Buffer, overrides: Partial<FetchResult> = {}): FetchResult => {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  return {
    requestUrl: url,
    url,
    status: 200,
    headers: { 'content-type': 'application/xml' },
    contentType: 'application/xml',
    charset: 'utf-8',
    body: buffer,
    text: buffer.toString('utf8'),
    truncated: false,
    redirects: [],
    timings: { dnsMs: 0, connectMs: 0, ttfbMs: 1, totalMs: 1 },
    ...overrides,
  };
};

describe('parseSitemap', () => {
  it('reads a urlset and decodes entities', () => {
    const parsed = parseSitemap(
      '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/a?x=1&amp;y=2</loc></url><url><loc> https://example.com/b </loc></url></urlset>',
    );
    expect(parsed.kind).toBe('urlset');
    expect(parsed.urls).toEqual(['https://example.com/a?x=1&y=2', 'https://example.com/b']);
    expect(parsed.errors).toEqual([]);
  });

  it('reads a sitemap index as child sitemap URLs', () => {
    const parsed = parseSitemap(
      '<sitemapindex><sitemap><loc>https://example.com/one.xml</loc></sitemap><sitemap><loc>https://example.com/two.xml</loc></sitemap></sitemapindex>',
    );
    expect(parsed.kind).toBe('index');
    expect(parsed.urls).toEqual(['https://example.com/one.xml', 'https://example.com/two.xml']);
  });

  it('reports a document that is not a sitemap', () => {
    const parsed = parseSitemap('<html><body>not a sitemap</body></html>');
    expect(parsed.kind).toBe('unknown');
    expect(parsed.errors[0]).toMatch(/not a sitemap/);
  });
});

describe('fetchSitemap', () => {
  it('decompresses a .gz sitemap and ignores URLs on other hosts', async () => {
    const xml = '<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://other.test/b</loc></url></urlset>';
    const document = await fetchSitemap('https://example.com/sitemap.xml.gz', hosts, async (url) =>
      response(url, gzipSync(Buffer.from(xml))),
    );
    expect(document.kind).toBe('urlset');
    expect(document.urls).toEqual(['https://example.com/a', 'https://other.test/b']);
    expect(document.errors[0]).toMatch(/not on this site's hosts/);
  });

  it('records a non-2xx answer instead of throwing', async () => {
    const document = await fetchSitemap('https://example.com/sitemap.xml', hosts, async (url) => response(url, 'nope', { status: 404 }));
    expect(document.status).toBe(404);
    expect(document.fetchError).toMatch(/HTTP 404/);
  });
});

describe('readSitemaps', () => {
  it('follows an index, deduplicates pages and stops at the URL cap', async () => {
    const documents = new Map<string, string>([
      [
        'https://example.com/sitemap-index.xml',
        '<sitemapindex><sitemap><loc>https://example.com/one.xml</loc></sitemap><sitemap><loc>https://example.com/two.xml</loc></sitemap></sitemapindex>',
      ],
      [
        'https://example.com/one.xml',
        '<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/a</loc></url></urlset>',
      ],
      ['https://example.com/two.xml', '<urlset><url><loc>https://example.com/b</loc></url></urlset>'],
    ]);
    const read = await readSitemaps({
      startUrls: ['https://example.com/sitemap-index.xml'],
      hosts,
      maxUrls: 10,
      fetch: async (url) => response(url, documents.get(url) ?? ''),
    });
    expect(read.documents.map((document) => document.kind)).toEqual(['index', 'urlset', 'urlset']);
    expect(read.urls).toEqual(['https://example.com/a', 'https://example.com/b']);

    const capped = await readSitemaps({
      startUrls: ['https://example.com/sitemap-index.xml'],
      hosts,
      maxUrls: 1,
      fetch: async (url) => response(url, documents.get(url) ?? ''),
    });
    expect(capped.urls).toEqual(['https://example.com/a']);
    // The URL cap left pages unread: discovery is incomplete and the read says so (review round 3).
    expect(capped.truncation.join(' ')).toMatch(/more than 1 pages/);
    expect(read.truncation).toEqual([]);
  });

  it('records truncation when one urlset holds more pages than the cap (review round 3)', async () => {
    const read = await readSitemaps({
      startUrls: ['https://example.com/s.xml'],
      hosts,
      maxUrls: 1,
      fetch: async (url) =>
        response(url, '<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>'),
    });
    expect(read.urls).toEqual(['https://example.com/a']);
    expect(read.truncation.join(' ')).toMatch(/more than 1 pages/);
  });

  it('records truncation for a sitemap file read only in part (review round 3)', async () => {
    const read = await readSitemaps({
      startUrls: ['https://example.com/s.xml'],
      hosts,
      fetch: async (url) => response(url, '<urlset><url><loc>https://example.com/a</loc></url></urlset>', { truncated: true }),
    });
    expect(read.truncation.join(' ')).toMatch(/read only in part/);
  });

  it('stops following an index after three levels', async () => {
    const index = (next: string) => `<sitemapindex><sitemap><loc>https://example.com/${next}</loc></sitemap></sitemapindex>`;
    const read = await readSitemaps({
      startUrls: ['https://example.com/l0.xml'],
      hosts,
      fetch: async (url) => response(url, index(`l${Number(url.match(/l(\d)/)?.[1] ?? 0) + 1}.xml`)),
    });
    expect(read.documents).toHaveLength(4);
    expect(read.documents.at(-1)?.errors.join(' ')).toMatch(/only 3 are followed/);
    // The depth cap drops the deeper sitemaps: that is truncated discovery too (review round 3).
    expect(read.truncation.join(' ')).toMatch(/only 3 are followed/);
  });

  it('bounds the fan-out by documents, queued sitemaps, bytes and time, recording the truncation', async () => {
    const index = (count: number) =>
      `<sitemapindex>${Array.from({ length: count }, (_, i) => `<sitemap><loc>https://example.com/s${i}.xml</loc></sitemap>`).join('')}</sitemapindex>`;
    const urlset = '<urlset><url><loc>https://example.com/a</loc></url></urlset>';

    const documents = await readSitemaps({
      startUrls: ['https://example.com/index.xml'],
      hosts,
      maxDocuments: 3,
      fetch: async (url) => response(url, url.startsWith('https://example.com/index') ? index(10) : urlset),
    });
    expect(documents.documents).toHaveLength(3);
    expect(documents.truncation.join(' ')).toMatch(/after 3 documents/);
    expect(documents.documents.at(-1)?.errors.join(' ')).toMatch(/after 3 documents/);

    const queued = await readSitemaps({
      startUrls: ['https://example.com/index.xml'],
      hosts,
      maxQueuedSitemaps: 2,
      fetch: async (url) => response(url, url.startsWith('https://example.com/index') ? index(10) : urlset),
    });
    expect(queued.truncation.join(' ')).toMatch(/more than 2 sitemaps/);

    const bytes = await readSitemaps({
      startUrls: ['https://example.com/one.xml'],
      hosts,
      maxTotalBytes: 1,
      fetch: async (url) => response(url, urlset),
    });
    expect(bytes.truncation.join(' ')).toMatch(/MB of sitemaps/);

    let clock = 0;
    const timed = await readSitemaps({
      startUrls: ['https://example.com/one.xml'],
      hosts,
      deadlineAt: 1_000,
      now: () => {
        clock += 1_000;
        return clock;
      },
      fetch: async (url) => response(url, urlset),
    });
    expect(timed.truncation.join(' ')).toMatch(/time limit/);
  });

  it('checks the deadline before every document, not once per batch', async () => {
    // A batch is the whole queue: an index naming three sitemaps must not read all three after the
    // deadline passed while the index was being fetched.
    const index = (count: number) =>
      `<sitemapindex>${Array.from({ length: count }, (_, i) => `<sitemap><loc>https://example.com/s${i}.xml</loc></sitemap>`).join('')}</sitemapindex>`;
    const urlset = '<urlset><url><loc>https://example.com/a</loc></url></urlset>';
    let clock = 0;
    const read = await readSitemaps({
      startUrls: ['https://example.com/index.xml'],
      hosts,
      deadlineAt: 2_500,
      now: () => {
        clock += 1_000;
        return clock;
      },
      fetch: async (url) => response(url, url.startsWith('https://example.com/index') ? index(3) : urlset),
    });
    expect(read.documents).toHaveLength(1);
    expect(read.truncation.join(' ')).toMatch(/time limit/);
  });
});

describe('probeHttpRedirect', () => {
  it('reports whether http:// answered on https', async () => {
    expect(await probeHttpRedirect('example.com', async (url) => response(url, '', { url: 'https://example.com/' }))).toBe(true);
    expect(await probeHttpRedirect('example.com', async (url) => response(url, ''))).toBe(false);
    expect(
      await probeHttpRedirect('example.com', async () => {
        throw new Error('no answer');
      }),
    ).toBeNull();
  });
});
