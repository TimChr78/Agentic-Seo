import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { checkUrl, type HostResolver, isBlockedAddress, MAX_HTML_BYTES, SafeFetchError, type SafeFetchOptions, safeFetch } from '../src';
import { closeSites, loopback, ok, redirectTo, startSite, tableResolver } from './support';

// The SSRF regression suite CI runs (security-and-privacy.md §1). Every test either fails before a
// socket is opened or reaches only a server the test started on 127.0.0.1 through the allow-list.

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

describe('SSRF guard: address classes', () => {
  it('refuses loopback, RFC 1918, link-local, metadata, CGNAT and multicast literals', async () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://127.1.2.3/',
      'http://10.1.2.3/',
      'http://172.20.0.1/',
      'http://192.168.1.5/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://0.0.0.0/',
      'http://224.0.0.1/',
      'http://255.255.255.255/',
      'http://[::1]/',
      'http://[::]/',
      'http://[fd00:ec2::254]/',
      'http://[fe80::1]/',
      'http://[fc00::1]/',
      'http://[ff02::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://[::ffff:10.0.0.1]/',
      'http://[::ffff:0:127.0.0.1]/',
      'http://[::ffff:0:10.0.0.1]/',
      'http://[64:ff9b::a00:1]/',
      'http://[64:ff9b::a9fe:a9fe]/',
      'http://[64:ff9b:1:a9fe:a9:fe00::]/',
      'http://[2001::1]/',
      'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/',
      'http://[2002:a00:1::]/',
    ]) {
      const error = await failure(safeFetch(url));
      expect(error.kind, url).toBe('blocked_address');
    }
  });

  it('refuses IPv6 transition ranges, including a local-use NAT64 and Teredo', () => {
    for (const address of [
      '64:ff9b:1:a9fe:a9:fe00::',
      '64:ff9b:1::',
      '2001::1',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2',
      '2002:a9fe:a9fe::',
      '64:ff9b::a9fe:a9fe',
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('refuses decimal, octal and hex IPv4 spellings that the URL parser turns into 127.0.0.1', async () => {
    for (const url of ['http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f000001/', 'http://0x7f.1/', 'http://127.1/']) {
      expect(new URL(url).hostname, url).toBe('127.0.0.1');
      const error = await failure(safeFetch(url));
      expect(error.kind, url).toBe('blocked_address');
    }
  });

  it('refuses internal host names without asking DNS', async () => {
    const calls: string[] = [];
    const resolver = tableResolver({}, calls);
    for (const url of ['http://localhost/', 'http://api.internal/', 'http://printer.local/', 'http://router.home.arpa/']) {
      expect((await failure(safeFetch(url, { resolver }))).kind, url).toBe('blocked_address');
    }
    expect(calls).toEqual([]);
  });

  it('refuses a name that resolves to a private address', async () => {
    const calls: string[] = [];
    const resolver = tableResolver({ 'internal.test': [{ address: '10.0.0.1', family: 4 }] }, calls);
    const error = await failure(safeFetch('http://internal.test/', { resolver }));
    expect(error.kind).toBe('blocked_address');
    expect(error.message).toContain('10.0.0.1');
    expect(calls).toEqual(['internal.test']);
  });

  it('refuses a mixed public/private answer instead of using its public address', async () => {
    const resolver = tableResolver({
      'mixed.test': [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
    });
    const error = await failure(safeFetch('https://mixed.test/', { resolver }));
    expect(error.kind).toBe('blocked_address');
    expect(error.message).toContain('10.0.0.1');
  });

  it('refuses a name that does not resolve, with a dns error kind', async () => {
    const resolver = tableResolver({});
    const error = await failure(safeFetch('https://missing.test/', { resolver }));
    expect(error.kind).toBe('dns');
  });
});

describe('SSRF guard: DNS rebinding', () => {
  it('connects to the checked address and never looks the name up a second time', async () => {
    const site = await startSite((_req, res) => ok(res, '<h1>bound</h1>'));
    let calls = 0;
    const resolver: HostResolver = async () => {
      calls += 1;
      // A rebinding answer: public (here: loopback, which the allow-list names) first, unreachable
      // second. A second lookup would connect to 127.0.0.2 and fail.
      return [{ address: calls === 1 ? '127.0.0.1' : '127.0.0.2', family: 4 }];
    };
    const result = await safeFetch(`http://rebind.test:${site.port}/`, {
      resolver,
      allow: { privateHosts: ['rebind.test'], ports: [site.port] },
    });
    expect(result.status).toBe(200);
    expect(result.text).toContain('bound');
    expect(calls).toBe(1);
  });
});

describe('SSRF guard: redirects', () => {
  it('re-checks every hop and refuses a redirect to the metadata address', async () => {
    const site = await startSite((_req, res) => redirectTo(res, 'http://169.254.169.254/latest/meta-data/'));
    const error = await failure(
      safeFetch(`http://site.test:${site.port}/`, {
        resolver: tableResolver({ 'site.test': loopback }),
        allow: { privateHosts: ['site.test'], ports: [site.port] },
      }),
    );
    expect(error.kind).toBe('blocked_address');
    expect(site.requests).toHaveLength(1);
  });

  it('refuses a redirect to a non-http(s) scheme', async () => {
    for (const location of ['file:///etc/passwd', 'gopher://example.test/1', 'ftp://example.test/secret']) {
      const site = await startSite((_req, res) => redirectTo(res, location));
      const error = await failure(
        safeFetch(`http://site.test:${site.port}/`, {
          resolver: tableResolver({ 'site.test': loopback }),
          allow: { privateHosts: ['site.test'], ports: [site.port] },
        }),
      );
      expect(error.kind, location).toBe('blocked_scheme');
    }
  });

  it('re-resolves and re-checks the host of every hop', async () => {
    const site = await startSite((_req, res) => redirectTo(res, `http://other.test:${site.port}/landing`));
    const calls: string[] = [];
    const resolver = tableResolver(
      {
        'site.test': loopback,
        'other.test': [{ address: '192.168.10.10', family: 4 }],
      },
      calls,
    );
    const error = await failure(
      safeFetch(`http://site.test:${site.port}/`, {
        resolver,
        allow: { privateHosts: ['site.test'], ports: [site.port] },
      }),
    );
    expect(error.kind).toBe('blocked_address');
    expect(calls).toEqual(['site.test', 'other.test']);
    expect(site.requests).toHaveLength(1);
  });

  it('does not forward credentials on a cross-host redirect', async () => {
    const site = await startSite((req, res) => {
      if (req.url === '/moved') return redirectTo(res, `http://other.test:${req.port}/echo`);
      ok(res, 'landed', 'text/plain');
    });
    const result = await safeFetch(`http://site.test:${site.port}/moved`, {
      resolver: tableResolver({ 'site.test': loopback, 'other.test': loopback }),
      allow: { privateHosts: ['site.test', 'other.test'], ports: [site.port] },
      credentials: {
        origins: [`http://site.test:${site.port}`],
        basicAuth: { username: 'crawler', password: 'hunter2' },
        cookies: 'session=abc',
        headers: { 'x-verified-bot': 'token' },
      },
    });

    expect(result.redirects).toEqual([
      { url: `http://site.test:${site.port}/moved`, status: 302, location: `http://other.test:${site.port}/echo` },
    ]);
    expect(result.url).toBe(`http://other.test:${site.port}/echo`);
    const [first, second] = site.requests;
    expect(first?.headers.authorization).toMatch(/^Basic /);
    expect(first?.headers.cookie).toBe('session=abc');
    expect(first?.headers['x-verified-bot']).toBe('token');
    // The redirect target is a different host, so it gets none of the credentials.
    expect(second?.headers.authorization).toBeUndefined();
    expect(second?.headers.cookie).toBeUndefined();
    expect(second?.headers['x-verified-bot']).toBeUndefined();
  });

  it('stops after ten redirects', async () => {
    const site = await startSite((req, res) => redirectTo(res, `http://site.test:${req.port}/again`));
    const error = await failure(
      safeFetch(`http://site.test:${site.port}/`, {
        resolver: tableResolver({ 'site.test': loopback }),
        allow: { privateHosts: ['site.test'], ports: [site.port] },
      }),
    );
    expect(error.kind).toBe('too_many_redirects');
    expect(site.requests).toHaveLength(11);
  });
});

describe('SSRF guard: schemes and ports', () => {
  it('refuses non-http(s) schemes and URLs with userinfo', async () => {
    expect((await failure(safeFetch('file:///etc/passwd'))).kind).toBe('blocked_scheme');
    expect((await failure(safeFetch('gopher://example.test/'))).kind).toBe('blocked_scheme');
    expect((await failure(safeFetch('http://user:pass@example.test/'))).kind).toBe('blocked_credentials');
    expect((await failure(safeFetch('not a url'))).kind).toBe('invalid_url');
  });

  it('refuses a port other than 80 or 443 unless the site allows it', async () => {
    const site = await startSite((_req, res) => ok(res, 'ok'));
    const options: SafeFetchOptions = {
      resolver: tableResolver({ 'site.test': loopback }),
      allow: { privateHosts: ['site.test'] },
    };
    const error = await failure(safeFetch(`http://site.test:${site.port}/`, options));
    expect(error.kind).toBe('blocked_port');
    expect(site.requests).toHaveLength(0);

    const result = await safeFetch(`http://site.test:${site.port}/`, {
      ...options,
      allow: { privateHosts: ['site.test'], ports: [site.port] },
    });
    expect(result.status).toBe(200);
  });
});

describe('SSRF guard: allow-list', () => {
  it('permits exactly one private host, and only that host', async () => {
    const site = await startSite((_req, res) => ok(res, 'lan'));
    const resolver = tableResolver({ 'homelab.test': loopback, 'neighbour.test': loopback });
    const allow = { privateHosts: ['homelab.test'], ports: [site.port] };

    const result = await safeFetch(`http://homelab.test:${site.port}/`, { resolver, allow });
    expect(result.status).toBe(200);
    expect(result.text).toBe('lan');

    const error = await failure(safeFetch(`http://neighbour.test:${site.port}/`, { resolver, allow }));
    expect(error.kind).toBe('blocked_address');
  });

  it('keeps cloud metadata endpoints blocked even for an allow-listed host', async () => {
    const resolver = tableResolver({ 'metadata.test': [{ address: '169.254.169.254', family: 4 }] });
    const error = await failure(safeFetch('http://metadata.test/', { resolver, allow: { privateHosts: ['metadata.test'] } }));
    expect(error.kind).toBe('blocked_address');

    const literal = await failure(safeFetch('http://[fd00:ec2::254]/', { allow: { privateHosts: ['fd00:ec2::254'] } }));
    expect(literal.kind).toBe('blocked_address');
  });
});

describe('SSRF guard: response size and decompression', () => {
  it('stops a gzip bomb on the decoded size and returns the HTML head truncated', async () => {
    const bomb = gzipSync(Buffer.alloc(50 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(100 * 1024);
    const site = await startSite((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip', 'content-length': bomb.length });
      res.end(bomb);
    });

    const result = await safeFetch(`http://site.test:${site.port}/`, {
      resolver: tableResolver({ 'site.test': loopback }),
      allow: { privateHosts: ['site.test'], ports: [site.port] },
    });

    expect(result.truncated).toBe(true);
    expect(result.body.length).toBe(MAX_HTML_BYTES);
    // 50 MB decoded from ~50 KB on the wire: the cap is on decoded bytes, not wire bytes.
    expect(result.text.length).toBe(MAX_HTML_BYTES);
  });

  it('truncates oversized HTML at the limit, keeping the head usable', async () => {
    const site = await startSite((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('a'.repeat(64 * 1024));
    });
    const result = await safeFetch(`http://site.test:${site.port}/`, {
      resolver: tableResolver({ 'site.test': loopback }),
      allow: { privateHosts: ['site.test'], ports: [site.port] },
      maxBytes: 4096,
    });
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBe(4096);
    expect(result.body.every((byte) => byte === 0x61)).toBe(true);
  });

  it('fails a non-HTML body that crosses the limit instead of returning half of it', async () => {
    const site = await startSite((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.alloc(64 * 1024, 7));
    });
    const error = await failure(
      safeFetch(`http://site.test:${site.port}/`, {
        resolver: tableResolver({ 'site.test': loopback }),
        allow: { privateHosts: ['site.test'], ports: [site.port] },
        maxBytes: 4096,
      }),
    );
    expect(error.kind).toBe('too_large');
  });

  it('returns a bounded prefix for any content type when truncation is requested', async () => {
    const site = await startSite((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('a'.repeat(64 * 1024));
    });
    const result = await safeFetch(`http://site.test:${site.port}/`, {
      resolver: tableResolver({ 'site.test': loopback }),
      allow: { privateHosts: ['site.test'], ports: [site.port] },
      maxBytes: 4096,
      truncate: true,
    });
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBe(4096);
    expect(result.text).toBe('a'.repeat(4096));
  });
});

describe('URL checks before a request', () => {
  it('reports the same reason the crawler would fail with', () => {
    expect(checkUrl('http://127.0.0.1/')?.kind).toBe('blocked_address');
    expect(checkUrl('http://[::ffff:127.0.0.1]/')?.kind).toBe('blocked_address');
    expect(checkUrl('http://site.test:8080/')?.kind).toBe('blocked_port');
    expect(checkUrl('http://site.test:8080/', { ports: [8080] })).toBeNull();
    expect(checkUrl('https://example.test/')).toBeNull();
  });
});
