import { fetch as undiciFetch } from 'undici';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { checkEgressUrl, egressFetch, egressRequest, pinnedDispatcher, resolveEgressHost } from '../src';
import { closeSites, ok, selfSignedCertificate, startTlsSite } from './support';

// The egress guard for a configured API endpoint (the LLM provider's base URL): a workspace must
// not be able to point a provider at a private, loopback or metadata address.
//
// A name is checked and then *pinned*: the connection goes to the address the guard checked, so a
// hostname that answers public for the check and internal for the connection (DNS rebinding) has no
// second look-up to win.

afterAll(closeSites);

describe('checkEgressUrl', () => {
  it('accepts a public https API origin', () => {
    expect(checkEgressUrl('https://api.openai.com/v1')).toBeNull();
    expect(checkEgressUrl('https://api.anthropic.com/v1')).toBeNull();
    expect(checkEgressUrl('https://api.openai.com:443/v1')).toBeNull();
  });

  it('refuses plain http, embedded credentials, another port and internal targets', () => {
    expect(checkEgressUrl('http://api.openai.com/v1')).toContain('https');
    expect(checkEgressUrl('https://user:pass@api.openai.com/v1')).toContain('credentials');
    expect(checkEgressUrl('https://api.openai.com:8443/v1')).toContain('port');
    expect(checkEgressUrl('https://localhost/v1')).toContain('internal');
    expect(checkEgressUrl('https://llm.internal/v1')).toContain('internal');
    expect(checkEgressUrl('https://10.0.0.5/v1')).toContain('private');
    expect(checkEgressUrl('https://[::1]/v1')).toContain('private');
    expect(checkEgressUrl('https://169.254.169.254/latest/meta-data')).toContain('private');
    expect(checkEgressUrl('not a url')).toBe('not a valid URL');
  });
});

describe('resolveEgressHost', () => {
  it('refuses a name that resolves to a private address', async () => {
    await expect(
      resolveEgressHost(new URL('https://llm.example.com/v1'), async () => [{ address: '10.1.2.3', family: 4 }]),
    ).rejects.toThrow(/private/);
  });

  it('refuses a mixed public/private answer, not just the first address', async () => {
    await expect(
      resolveEgressHost(new URL('https://llm.example.com/v1'), async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '192.168.1.2', family: 4 },
      ]),
    ).rejects.toThrow(/192\.168\.1\.2/);
  });

  it('accepts a public answer', async () => {
    await expect(
      resolveEgressHost(new URL('https://llm.example.com/v1'), async () => [{ address: '93.184.216.34', family: 4 }]),
    ).resolves.toBeUndefined();
  });
});

describe('egressFetch', () => {
  it('refuses a loopback endpoint before any socket is opened', async () => {
    await expect(egressFetch('http://127.0.0.1:1234/v1/chat/completions', { method: 'POST', body: '{}' })).rejects.toThrow(/https/);
    await expect(egressFetch('https://127.0.0.1/v1/chat/completions', { method: 'POST', body: '{}' })).rejects.toThrow(/private/);
  });

  it('pins the connection to the address it checked, so a rebinding answer never gets a socket', async () => {
    const calls: string[] = [];
    // The check sees a public address; a name that rebinds would answer an internal one next.
    const resolve = async (host: string) => {
      calls.push(host);
      return calls.length === 1 ? [{ address: '203.0.113.7', family: 4 }] : [{ address: '10.1.2.3', family: 4 }];
    };
    // The platform fetch is what resolves the name a second time; the guard must never hand it a
    // request. (TEST-NET-3 has no route in a test, so the pinned connection fails on the socket.)
    const platformFetch = vi.spyOn(globalThis, 'fetch');
    let delegated = 0;
    try {
      await expect(
        egressRequest('https://rebind.example/v1/models', { method: 'POST', body: '{}', signal: AbortSignal.timeout(500) }, { resolve }),
      ).rejects.toThrow();
    } finally {
      // Read the count before restoring: mockRestore clears the recorded calls.
      delegated = platformFetch.mock.calls.length;
      platformFetch.mockRestore();
    }
    expect(calls).toEqual(['rebind.example']);
    expect(delegated).toBe(0);
  });
});

describe('the pinned connection', () => {
  it('connects to the checked address and verifies TLS against the name, not the address', async () => {
    const credentials = selfSignedCertificate('llm.example.com');
    const site = await startTlsSite(credentials, (_req, res) => ok(res, '{"data":[]}', 'application/json'));
    const url = new URL(`https://llm.example.com:${site.port}/v1/models`);
    const dispatcher = pinnedDispatcher(url, { address: '127.0.0.1', family: 4 }, { ca: credentials.cert });
    const response = await undiciFetch(url.href, {
      dispatcher,
      method: 'POST',
      headers: [['content-type', 'application/json']],
      body: '{"model":"m"}',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [] });
    // The certificate was checked against the configured name, and the request reached the pinned
    // address with the name as its authority.
    expect(site.servernames).toEqual(['llm.example.com']);
    expect(site.requests).toHaveLength(1);
    expect(site.requests[0]?.headers.host).toBe(`llm.example.com:${site.port}`);
  });

  it('falls back to the next checked address when the first one refuses the connection', async () => {
    const credentials = selfSignedCertificate('llm.example.com');
    const site = await startTlsSite(credentials, (_req, res) => ok(res, '{"data":[]}', 'application/json'));
    const url = new URL(`https://llm.example.com:${site.port}/v1/models`);
    // The site listens on 127.0.0.1 only, so 127.0.0.2 (loopback, nothing bound) refuses the socket.
    const dispatcher = pinnedDispatcher(
      url,
      [
        { address: '127.0.0.2', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      { ca: credentials.cert },
    );
    const response = await undiciFetch(url.href, { dispatcher, method: 'POST', body: '{"model":"m"}' });
    expect(response.status).toBe(200);
    expect(site.requests).toHaveLength(1);
    expect(site.servernames).toEqual(['llm.example.com']);
  });

  it('refuses a certificate that does not match the configured name', async () => {
    const credentials = selfSignedCertificate('other.example.com');
    const site = await startTlsSite(credentials, (_req, res) => ok(res, '{"data":[]}', 'application/json'));
    const url = new URL(`https://llm.example.com:${site.port}/v1/models`);
    const dispatcher = pinnedDispatcher(url, { address: '127.0.0.1', family: 4 }, { ca: credentials.cert });
    await expect(undiciFetch(url.href, { dispatcher })).rejects.toThrow();
    expect(site.requests).toHaveLength(0);
  });
});
