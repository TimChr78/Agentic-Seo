import { afterEach, describe, expect, it } from 'vitest';
import { SafeFetchError, safeFetch } from '../src';
import { closeSites, loopback, ok, selfSignedCertificate, startTlsSite } from './support';

// The TLS identity is the URL's host name. A caller-supplied Host header must not be able to pick a
// different certificate to validate, and the server name is always the URL host, never the pinned
// address (security-and-privacy.md §1).

afterEach(closeSites);

async function failure(promise: Promise<unknown>): Promise<SafeFetchError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SafeFetchError) return error;
    throw error;
  }
  throw new Error('expected the fetch to fail');
}

function options(port: number, ca: string) {
  return {
    resolver: async () => loopback,
    allow: { privateHosts: ['origin.test'], ports: [port] },
    ca,
  };
}

describe('TLS identity', () => {
  it('refuses caller-supplied Host and :authority headers', async () => {
    const site = await startTlsSite(selfSignedCertificate('origin.test'), (_req, res) => ok(res, 'ok', 'text/plain'));
    const tls = selfSignedCertificate('origin.test');

    const forbiddenHeaders: Array<Record<string, string>> = [
      { Host: 'wrong.test' },
      { host: 'wrong.test' },
      { ':authority': 'wrong.test' },
    ];
    for (const headers of forbiddenHeaders) {
      const error = await failure(safeFetch(`https://origin.test:${site.port}/`, { ...options(site.port, tls.cert), headers }));
      expect(error.kind, JSON.stringify(headers)).toBe('blocked_header');
    }
    expect(site.requests).toHaveLength(0);
  });

  it('validates the certificate for the URL host and sends it as the server name', async () => {
    const identity = selfSignedCertificate('origin.test');
    const site = await startTlsSite(identity, (_req, res) => ok(res, 'secure', 'text/plain'));

    const result = await safeFetch(`https://origin.test:${site.port}/`, options(site.port, identity.cert));

    expect(result.status).toBe(200);
    expect(result.text).toBe('secure');
    // The pinned address is 127.0.0.1; the SNI name must be the URL's host, not the address.
    expect(site.servernames).toEqual(['origin.test']);
  });

  it('fails when the server certificate is valid only for another host', async () => {
    const site = await startTlsSite(selfSignedCertificate('wrong.test'), (_req, res) => ok(res, 'ok', 'text/plain'));

    const error = await failure(
      safeFetch(`https://origin.test:${site.port}/`, options(site.port, selfSignedCertificate('wrong.test').cert)),
    );

    expect(error.kind).toBe('tls');
    expect(site.requests).toHaveLength(0);
  });
});
