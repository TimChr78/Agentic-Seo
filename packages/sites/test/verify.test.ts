import { type FetchResult, safeFetch } from '@agentic-seo/fetch';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDnsRecord, checkMetaTag, dnsRecordValue, headOf, metaTagPresent, setSiteFetcher, setTxtResolver } from '../src';

// Ownership verification: the token is published in a DNS TXT record or a home page meta tag, and
// both checks have to say why they failed. The page fetch goes through the SSRF guard, so a domain
// that resolves to a private address is refused before a socket opens.

const TOKEN = 'test-token-4f8a2c';
const page = (overrides: Partial<Record<string, unknown>>): FetchResult =>
  ({
    requestUrl: 'https://example.com/',
    url: 'https://example.com/',
    status: 200,
    headers: {},
    contentType: 'text/html; charset=utf-8',
    charset: 'utf-8',
    body: Buffer.alloc(0),
    text: '',
    truncated: false,
    redirects: [],
    timings: { dnsMs: 0, connectMs: 0, ttfbMs: 0, totalMs: 0 },
    ...overrides,
  }) as unknown as FetchResult;

afterEach(() => {
  setTxtResolver(null);
  setSiteFetcher(null);
});

describe('the meta tag scan', () => {
  it('finds the tag in either attribute order and either quoting style', () => {
    for (const tag of [
      `<meta name="aseo-site-verification" content="${TOKEN}">`,
      `<meta content='${TOKEN}' name='aseo-site-verification'>`,
      `<META NAME="ASEO-SITE-VERIFICATION" CONTENT="${TOKEN}" />`,
    ])
      expect(metaTagPresent(`<html><head>${tag}</head><body></body></html>`, TOKEN), tag).toBe(true);
  });

  it('does not match a different token, a different name, or a tag outside the head', () => {
    expect(metaTagPresent(`<head><meta name="aseo-site-verification" content="other"></head>`, TOKEN)).toBe(false);
    expect(metaTagPresent(`<head><meta name="something-else" content="${TOKEN}"></head>`, TOKEN)).toBe(false);
    expect(metaTagPresent(`<head></head><body><meta name="aseo-site-verification" content="${TOKEN}"></body>`, TOKEN)).toBe(false);
  });

  it('takes the head up to the closing tag, or the whole prefix when the body was cut short', () => {
    expect(headOf('<html><head><title>x</title></head><body>')).toBe('<html><head><title>x</title>');
    expect(headOf('<html><head><meta charset="utf-8">')).toBe('<html><head><meta charset="utf-8">');
  });
});

describe('the meta tag check', () => {
  it('accepts the tag served by the primary domain', async () => {
    setSiteFetcher(async () => page({ text: `<html><head><meta name="aseo-site-verification" content="${TOKEN}"></head></html>` }));
    expect(await checkMetaTag('example.com', ['example.com'], TOKEN)).toEqual({ ok: true });
  });

  it('names the tag to add when the head has none', async () => {
    setSiteFetcher(async () => page({ text: '<html><head><title>No tag</title></head></html>' }));
    const result = await checkMetaTag('example.com', ['example.com'], TOKEN);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(`<meta name="aseo-site-verification" content="${TOKEN}">`);
  });

  it('refuses a redirect that ends on another site', async () => {
    setSiteFetcher(async () =>
      page({ url: 'https://parking.example.net/', text: `<meta name="aseo-site-verification" content="${TOKEN}">` }),
    );
    const result = await checkMetaTag('example.com', ['example.com', 'www.example.com'], TOKEN);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('parking.example.net');
  });

  it('fails a non-HTML response and an HTTP error without pretending the tag is missing', async () => {
    setSiteFetcher(async () => page({ contentType: 'application/json', text: '{}' }));
    expect(await checkMetaTag('example.com', ['example.com'], TOKEN)).toMatchObject({
      ok: false,
      error: expect.stringContaining('not HTML'),
    });
    setSiteFetcher(async () => page({ status: 404 }));
    expect(await checkMetaTag('example.com', ['example.com'], TOKEN)).toMatchObject({
      ok: false,
      error: expect.stringContaining('HTTP 404'),
    });
  });

  it('is refused by the fetch guard when the domain resolves to a private address', async () => {
    // The real guarded fetch, with only its resolver seam replaced: the same path production takes.
    setSiteFetcher((url) => safeFetch(url, { resolver: async () => [{ address: '127.0.0.1', family: 4 }] }));
    const result = await checkMetaTag('example.com', ['example.com'], TOKEN);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('private, loopback or metadata');
    expect(!result.ok && result.error).toContain('public internet');
  });
});

describe('the DNS TXT check', () => {
  it('joins a record split into chunks before comparing it', async () => {
    const value = dnsRecordValue(TOKEN);
    setTxtResolver(async () => [['v=spf1 -all'], [value.slice(0, 12), value.slice(12)]]);
    expect(await checkDnsRecord('example.com', TOKEN)).toEqual({ ok: true });
  });

  it('explains the record to add when the zone has other TXT records only', async () => {
    setTxtResolver(async () => [['v=spf1 -all']]);
    const result = await checkDnsRecord('example.com', TOKEN);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(dnsRecordValue(TOKEN));
  });

  it('says the zone has no TXT records when the lookup answers ENODATA', async () => {
    setTxtResolver(async () => {
      throw Object.assign(new Error('queryTxt ENODATA'), { code: 'ENODATA' });
    });
    const result = await checkDnsRecord('example.com', TOKEN);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('No DNS TXT records were found on example.com');
  });
});
