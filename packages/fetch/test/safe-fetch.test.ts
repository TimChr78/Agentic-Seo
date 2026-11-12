import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeBody, detectCharset, noneRenderer, SafeFetchError, safeFetch, wasRendered } from '../src';
import { closeSites, loopback, ok, redirectTo, startSite, tableResolver } from './support';

afterEach(closeSites);

function siteOptions(port: number, host = 'site.test') {
  return {
    resolver: tableResolver({ [host]: loopback }),
    allow: { privateHosts: [host], ports: [port] },
  };
}

describe('safeFetch', () => {
  it('fetches an allowed host and reports status, headers, body, charset and timings', async () => {
    const site = await startSite((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1', 'x-test': 'yes' });
      res.end(Buffer.from('<p>caf\xe9</p>', 'latin1'));
    });
    const result = await safeFetch(`http://site.test:${site.port}/page`, siteOptions(site.port));

    expect(result.status).toBe(200);
    expect(result.url).toBe(`http://site.test:${site.port}/page`);
    expect(result.requestUrl).toBe(result.url);
    expect(result.headers['x-test']).toBe('yes');
    expect(result.contentType).toBe('text/html; charset=iso-8859-1');
    expect(result.charset).toBe('windows-1252');
    expect(result.text).toBe('<p>café</p>');
    expect(result.truncated).toBe(false);
    expect(result.redirects).toEqual([]);
    expect(result.timings.dnsMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.connectMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.ttfbMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.totalMs).toBeGreaterThanOrEqual(result.timings.ttfbMs);
  });

  it('advertises an honest user agent built from the bot identity', async () => {
    const site = await startSite((_req, res) => ok(res, 'ok', 'text/plain'));
    await safeFetch(`http://site.test:${site.port}/`, siteOptions(site.port));
    await safeFetch(`http://site.test:${site.port}/`, {
      ...siteOptions(site.port),
      bot: { version: '1.2.3', publicUrl: 'https://seo.example/' },
    });
    expect(site.requests[0]?.headers['user-agent']).toBe('AgenticSEO/0.0.0');
    expect(site.requests[1]?.headers['user-agent']).toBe('AgenticSEO/1.2.3 (+https://seo.example/bot)');
  });

  it('sends per-call headers on every hop', async () => {
    const site = await startSite((req, res) => {
      if (req.url === '/start') return redirectTo(res, '/end');
      ok(res, 'ok', 'text/plain');
    });
    await safeFetch(`http://site.test:${site.port}/start`, {
      ...siteOptions(site.port),
      headers: { 'accept-language': 'de-DE', 'x-trace': '1' },
    });
    expect(site.requests).toHaveLength(2);
    for (const request of site.requests) {
      expect(request.headers['accept-language']).toBe('de-DE');
      expect(request.headers['x-trace']).toBe('1');
    }
  });

  it('reports the redirect chain and decodes a gzip body', async () => {
    const site = await startSite((req, res) => {
      if (req.url === '/old') return redirectTo(res, '/new', 301);
      const body = gzipSync(Buffer.from('<title>Moved</title>', 'utf8'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
      res.end(body);
    });
    const result = await safeFetch(`http://site.test:${site.port}/old`, siteOptions(site.port));

    expect(result.redirects).toEqual([{ url: `http://site.test:${site.port}/old`, status: 301, location: '/new' }]);
    expect(result.url).toBe(`http://site.test:${site.port}/new`);
    expect(result.text).toBe('<title>Moved</title>');
  });

  it('follows a 303 with a GET and drops the body', async () => {
    const site = await startSite((req, res) => {
      if (req.url === '/submit') {
        res.writeHead(303, { location: '/done' });
        res.end();
        return;
      }
      ok(res, `${req.method} ${req.url}`, 'text/plain');
    });
    const result = await safeFetch(`http://site.test:${site.port}/submit`, {
      ...siteOptions(site.port),
      method: 'POST',
      body: 'a=1',
    });
    expect(result.url).toBe(`http://site.test:${site.port}/done`);
    expect(result.text).toBe('GET /done');
    expect(site.requests[1]?.headers['content-length']).toBeUndefined();
  });

  it('truncates HTML at a lower per-call limit', async () => {
    const site = await startSite((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('x'.repeat(2048));
    });
    const result = await safeFetch(`http://site.test:${site.port}/`, { ...siteOptions(site.port), maxBytes: 100 });
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBe(100);
  });

  it('times out after the total deadline', async () => {
    const site = await startSite((_req, res) => {
      // Never answer.
      res.writeHead(200);
    });
    const error = await safeFetch(`http://site.test:${site.port}/`, { ...siteOptions(site.port), totalTimeoutMs: 150 }).catch((e) => e);
    expect(error).toBeInstanceOf(SafeFetchError);
    expect(error.kind).toBe('timeout');
  });

  it('fails with connection when the host refuses the connection', async () => {
    const site = await startSite((_req, res) => ok(res, 'ok'));
    const port = site.port;
    await site.close();
    const error = await safeFetch(`http://site.test:${port}/`, siteOptions(port)).catch((e) => e);
    expect(error).toBeInstanceOf(SafeFetchError);
    expect(error.kind).toBe('connection');
  });
});

describe('charset detection', () => {
  it('prefers a byte-order mark, then the header, then a meta tag, then UTF-8', () => {
    expect(detectCharset('text/html; charset=iso-8859-1', Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toBe('utf-8');
    expect(detectCharset('text/html; charset=iso-8859-1', Buffer.from('a'))).toBe('windows-1252');
    expect(detectCharset('text/html', Buffer.from('<meta charset="shift_jis"><p>x'))).toBe('shift_jis');
    expect(detectCharset(undefined, Buffer.from('<p>plain'))).toBe('utf-8');
  });

  it('decodes with the detected charset and falls back to UTF-8 for an unknown label', () => {
    expect(decodeBody(Buffer.from('<p>caf\xe9</p>', 'latin1'), 'text/html; charset=iso-8859-1').text).toBe('<p>café</p>');
    expect(decodeBody(Buffer.from('ok'), 'text/html; charset=no-such-charset').charset).toBe('utf-8');
  });
});

describe('renderer port', () => {
  it('the none renderer reports not evaluated instead of an empty page', async () => {
    const result = await noneRenderer.render('https://example.test/', { device: 'mobile', timeoutMs: 1000 });
    expect(result.evaluated).toBe(false);
    expect(wasRendered(result)).toBe(false);
    if (!result.evaluated) {
      expect(result.reason).toBe('no_renderer');
      expect(result.message).toContain('Not evaluated');
    }
    expect(noneRenderer.lighthouse).toBeUndefined();
  });
});
