import { type FetchResult, SafeFetchError } from '@agentic-seo/fetch';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeSites,
  loopback,
  ok,
  redirectTo,
  selfSignedCertificate,
  startSite,
  startTlsSite,
  tableResolver,
} from '../../fetch/test/support';
import {
  checkDnsRecord,
  checkMetaTag,
  dnsRecordValue,
  metaTagPresent,
  safeSiteFetcher,
  setSiteFetcher,
  setSiteFetchSeams,
  setTxtResolver,
  siteRedirectPolicy,
} from '../src';

// Ownership verification: the token is published in a DNS TXT record or a home page meta tag, and
// both checks have to say why they failed. The page fetch goes through the SSRF guard, so a domain
// that resolves to a private address is refused before a socket opens, and every redirect hop has
// to stay on HTTPS on the site's own hosts.

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

const tag = `<meta name="aseo-site-verification" content="${TOKEN}">`;
const head = (html: string) => `<html><head>${html}</head><body></body></html>`;
const failure = async (promise: Promise<unknown>): Promise<SafeFetchError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SafeFetchError) return error;
    throw error;
  }
  throw new Error('expected the fetch to fail');
};

afterEach(async () => {
  await closeSites();
  setTxtResolver(null);
  setSiteFetcher(null);
  setSiteFetchSeams(null);
});

describe('the meta tag scan', () => {
  it('finds the tag in either attribute order, either quoting style and any ASCII case', () => {
    for (const markup of [
      `<meta name="aseo-site-verification" content="${TOKEN}">`,
      `<meta content='${TOKEN}' name='aseo-site-verification'>`,
      `<META NAME="ASEO-SITE-VERIFICATION" CONTENT="${TOKEN}" />`,
    ])
      expect(metaTagPresent(head(markup), TOKEN), markup).toBe(true);
  });

  it('trims ASCII whitespace around the content value', () => {
    expect(metaTagPresent(head(`<meta name="aseo-site-verification" content="\n ${TOKEN}\t">`), TOKEN)).toBe(true);
  });

  it('does not match a different token, a different name, or a tag outside the head', () => {
    expect(metaTagPresent(head(`<meta name="aseo-site-verification" content="other">`), TOKEN)).toBe(false);
    expect(metaTagPresent(head(`<meta name="something-else" content="${TOKEN}">`), TOKEN)).toBe(false);
    expect(metaTagPresent(`<head></head><body>${tag}</body>`, TOKEN)).toBe(false);
  });

  it('ignores a tag inside an HTML comment', () => {
    expect(metaTagPresent(head(`<!-- ${tag} -->`), TOKEN)).toBe(false);
  });

  it('ignores a tag inside another element’s quoted attribute value', () => {
    expect(metaTagPresent(head(`<meta name="description" content='${tag}'>`), TOKEN)).toBe(false);
    expect(metaTagPresent(head(`<link rel="canonical" href="${tag}">`), TOKEN)).toBe(false);
  });

  it('ignores a tag the parser places in the body, including when </head> is missing', () => {
    expect(metaTagPresent(`<html><head><title>x</title><body>${tag}</body></html>`, TOKEN)).toBe(false);
    expect(metaTagPresent(`<html><body>${tag}</body></html>`, TOKEN)).toBe(false);
  });

  it('ignores the tag as raw text in script, noscript and template', () => {
    expect(metaTagPresent(head(`<script>var markup = '${tag}';</script>`), TOKEN)).toBe(false);
    expect(metaTagPresent(head(`<noscript>${tag}</noscript>`), TOKEN)).toBe(false);
    expect(metaTagPresent(head(`<template>${tag}</template>`), TOKEN)).toBe(false);
  });
});

describe('the meta tag check', () => {
  it('accepts the tag served by the primary domain', async () => {
    setSiteFetcher(async () => page({ text: head(tag) }));
    expect(await checkMetaTag('example.com', ['example.com'], TOKEN)).toEqual({ ok: true });
  });

  it('names the tag to add when the head has none', async () => {
    setSiteFetcher(async () => page({ text: '<html><head><title>No tag</title></head></html>' }));
    const result = await checkMetaTag('example.com', ['example.com'], TOKEN);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(`<meta name="aseo-site-verification" content="${TOKEN}">`);
  });

  it('accepts the page when the site’s own host is served with the DNS root dot', async () => {
    setSiteFetcher(async () => page({ url: 'https://example.com./', text: head(tag) }));
    expect(await checkMetaTag('example.com', ['example.com'], TOKEN)).toEqual({ ok: true });
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
    // The production adapter, with only its resolver seam replaced: the same path production takes.
    setSiteFetchSeams({ resolver: async () => [{ address: '127.0.0.1', family: 4 }] });
    const result = await checkMetaTag('example.com', ['example.com'], TOKEN);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('private, loopback or metadata');
    expect(!result.ok && result.error).toContain('public internet');
  });
});

describe('the redirect policy', () => {
  it('allows only HTTPS on the site’s hosts', () => {
    const policy = siteRedirectPolicy(['example.com', 'www.example.com']);
    expect(policy(new URL('https://www.example.com/home'))).toBe(true);
    expect(policy(new URL('http://example.com/home'))).toMatch(/not HTTPS/);
    expect(policy(new URL('https://parking.example.net/'))).toMatch(/not one of this site's hosts/);
  });

  it('treats a host with the DNS root dot as the same host', () => {
    const policy = siteRedirectPolicy(['example.com']);
    expect(policy(new URL('https://example.com./'))).toBe(true);
    expect(policy(new URL('https://EXAMPLE.com./home'))).toBe(true);
    expect(policy(new URL('https://example.com.evil.net./'))).toMatch(/not one of this site's hosts/);
  });

  it('refuses plain HTTP for the first URL before any request', async () => {
    const error = await failure(safeSiteFetcher('http://example.com/', { hosts: ['example.com'] }));
    expect(error).toBeInstanceOf(SafeFetchError);
    expect(error.kind).toBe('blocked_scheme');
    expect(error.message).toContain('not HTTPS');
  });

  it('refuses a downgrade to plain HTTP before the HTTP server is contacted', async () => {
    const host = 'downgrade.example';
    const plain = await startSite((_req, res) => ok(res, head(tag)));
    const tls = await startTlsSite(selfSignedCertificate(host), (_req, res) => redirectTo(res, `http://${host}:${plain.port}/`));
    setSiteFetchSeams({
      resolver: tableResolver({ [host]: loopback }),
      // The plain host is allowed, so only the HTTPS rule in the redirect policy can stop the hop.
      allow: { privateHosts: [host], ports: [tls.port, plain.port] },
      ca: selfSignedCertificate(host).cert,
    });

    const error = await failure(safeSiteFetcher(`https://${host}:${tls.port}/`, { hosts: [host] }));
    expect(error.kind).toBe('blocked_redirect');
    expect(error.message).toContain('not HTTPS');
    expect(plain.requests).toHaveLength(0);
  });

  it('never contacts an unrelated host in the middle of a chain', async () => {
    const host = 'origin.example';
    const other = 'parking.example.net';
    const originCertificate = selfSignedCertificate(host);
    const otherCertificate = selfSignedCertificate(other);
    let otherPort = 0;
    // origin -> parking -> origin, so only the per-hop policy stops the chain: the final page would
    // otherwise be the site's own again, and the tag would be accepted.
    const origin = await startTlsSite(originCertificate, (req, res) => {
      if (req.url === '/tag') return ok(res, head(tag));
      redirectTo(res, `https://${other}:${otherPort}/`);
    });
    const parking = await startTlsSite(otherCertificate, (_req, res) => redirectTo(res, `https://${host}:${origin.port}/tag`));
    otherPort = parking.port;
    setSiteFetchSeams({
      resolver: tableResolver({ [host]: loopback, [other]: loopback }),
      allow: { privateHosts: [host, other], ports: [origin.port, parking.port] },
      ca: [originCertificate.cert, otherCertificate.cert],
    });

    const error = await failure(safeSiteFetcher(`https://${host}:${origin.port}/`, { hosts: [host] }));
    expect(error.kind).toBe('blocked_redirect');
    expect(error.message).toContain(other);
    expect(parking.requests).toHaveLength(0);
  });

  it('follows a redirect within the site’s own hosts', async () => {
    const host = 'redirect.example';
    const certificate = selfSignedCertificate(host);
    const site = await startTlsSite(certificate, (req, res) => {
      if (req.url === '/tag') return ok(res, head(tag));
      redirectTo(res, '/tag');
    });
    setSiteFetchSeams({
      resolver: tableResolver({ [host]: loopback }),
      allow: { privateHosts: [host], ports: [site.port] },
      ca: certificate.cert,
    });

    const result = await safeSiteFetcher(`https://${host}:${site.port}/`, { hosts: [host] });
    expect(result.status).toBe(200);
    expect(result.redirects).toHaveLength(1);
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
