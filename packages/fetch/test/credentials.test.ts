import { afterEach, describe, expect, it } from 'vitest';
import { safeFetch } from '../src';
import {
  closeSites,
  loopback,
  ok,
  redirectTo,
  type SeenRequest,
  selfSignedCertificate,
  startSite,
  startTlsSite,
  tableResolver,
} from './support';

// Credentials belong to one exact origin: scheme + host + port. A redirect to another origin (a
// different port, an https -> http downgrade, another host) must never carry them
// (security-and-privacy.md §4, §1).

afterEach(closeSites);

const credentials = {
  origins: ['http://site.test:1'],
  basicAuth: { username: 'crawler', password: 'hunter2' },
  cookies: 'session=abc',
  headers: { 'x-verified-bot': 'token' },
};

function assertNoCredentials(request: SeenRequest | undefined): void {
  expect(request?.headers.authorization).toBeUndefined();
  expect(request?.headers.cookie).toBeUndefined();
  expect(request?.headers['x-verified-bot']).toBeUndefined();
}

function assertCredentials(request: SeenRequest | undefined): void {
  expect(request?.headers.authorization).toMatch(/^Basic /);
  expect(request?.headers.cookie).toBe('session=abc');
  expect(request?.headers['x-verified-bot']).toBe('token');
}

describe('credential scoping', () => {
  it('does not send credentials to the same host on another port', async () => {
    let target: { port: number } | undefined;
    const first = await startSite((req, res) => {
      if (req.url === '/moved') return redirectTo(res, `http://site.test:${target?.port ?? req.port}/landing`);
      ok(res, 'landed', 'text/plain');
    });
    const second = await startSite((_req, res) => ok(res, 'landed', 'text/plain'));
    target = second;

    const result = await safeFetch(`http://site.test:${first.port}/moved`, {
      resolver: tableResolver({ 'site.test': loopback }),
      allow: { privateHosts: ['site.test'], ports: [first.port, second.port] },
      credentials: { ...credentials, origins: [`http://site.test:${first.port}`] },
    });

    expect(result.url).toBe(`http://site.test:${second.port}/landing`);
    assertCredentials(first.requests[0]);
    assertNoCredentials(second.requests[0]);
  });

  it('does not send https-bound credentials after a downgrade to http', async () => {
    let target: { port: number } | undefined;
    const identity = selfSignedCertificate('secure.test');
    const secure = await startTlsSite(identity, (_req, res) => {
      redirectTo(res, `http://secure.test:${target?.port ?? 0}/landing`);
    });
    const plain = await startSite((_req, res) => ok(res, 'landed', 'text/plain'));
    target = plain;

    const result = await safeFetch(`https://secure.test:${secure.port}/moved`, {
      resolver: tableResolver({ 'secure.test': loopback }),
      allow: { privateHosts: ['secure.test'], ports: [secure.port, plain.port] },
      ca: identity.cert,
      credentials: { ...credentials, origins: [`https://secure.test:${secure.port}`] },
    });

    expect(result.url).toBe(`http://secure.test:${plain.port}/landing`);
    assertCredentials(secure.requests[0]);
    assertNoCredentials(plain.requests[0]);
  });

  it('does not send credentials to another host', async () => {
    const site = await startSite((req, res) => {
      if (req.url === '/moved') return redirectTo(res, `http://other.test:${req.port}/echo`);
      ok(res, 'landed', 'text/plain');
    });

    const result = await safeFetch(`http://site.test:${site.port}/moved`, {
      resolver: tableResolver({ 'site.test': loopback, 'other.test': loopback }),
      allow: { privateHosts: ['site.test', 'other.test'], ports: [site.port] },
      credentials: { ...credentials, origins: [`http://site.test:${site.port}`] },
    });

    expect(result.url).toBe(`http://other.test:${site.port}/echo`);
    assertCredentials(site.requests[0]);
    assertNoCredentials(site.requests[1]);
  });
});
