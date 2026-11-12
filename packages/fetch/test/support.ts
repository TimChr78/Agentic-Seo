import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostResolver, ResolvedAddress } from '../src';

/** A request the test server saw, for asserting headers and paths. */
export interface SeenRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  /** The local port the server listened on, useful for redirect targets. */
  port: number;
}

export interface TestSite {
  readonly port: number;
  readonly origin: string;
  readonly requests: SeenRequest[];
  close(): Promise<void>;
}

const openSites: TestSite[] = [];

/** A local HTTP server on 127.0.0.1. Every test that reaches it must allow 127.0.0.1 or its host explicitly. */
export async function startSite(handler: (req: SeenRequest, res: ServerResponse) => void): Promise<TestSite> {
  const requests: SeenRequest[] = [];
  const server = createServer((req, res) => {
    const seen: SeenRequest = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers,
      port: req.socket.localPort ?? 0,
    };
    requests.push(seen);
    handler(seen, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const site: TestSite = {
    port,
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
  openSites.push(site);
  return site;
}

/** Closes every server a test started. */
export async function closeSites(): Promise<void> {
  await Promise.all(openSites.splice(0).map((site) => site.close()));
}

/** A key and certificate generated for one test host name. */
export interface TestCertificate {
  key: string;
  cert: string;
}

const certificates = new Map<string, TestCertificate>();

/**
 * A self-signed certificate for `hostname`, generated with OpenSSL for the life of this process.
 * The certificate is its own CA, so a test can trust exactly this one through `safeFetch`'s `ca`
 * option without touching the system store.
 */
export function selfSignedCertificate(hostname: string): TestCertificate {
  const cached = certificates.get(hostname);
  if (cached) return cached;
  const directory = mkdtempSync(join(tmpdir(), 'agentic-seo-tls-'));
  const keyPath = join(directory, 'key.pem');
  const certPath = join(directory, 'cert.pem');
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-sha256',
        '-days',
        '2',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-subj',
        `/CN=${hostname}`,
        '-addext',
        `subjectAltName=DNS:${hostname}`,
        '-addext',
        'basicConstraints=critical,CA:TRUE',
      ],
      { stdio: 'ignore' },
    );
    const generated = { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
    certificates.set(hostname, generated);
    return generated;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export interface TestTlsSite extends TestSite {
  /** The SNI names the TLS server saw, one per handshake. */
  readonly servernames: string[];
}

/** A local HTTPS server on 127.0.0.1 with a certificate a test generated. */
export async function startTlsSite(
  credentials: TestCertificate,
  handler: (req: SeenRequest, res: ServerResponse) => void,
): Promise<TestTlsSite> {
  const requests: SeenRequest[] = [];
  const servernames: string[] = [];
  const server = createHttpsServer({ key: credentials.key, cert: credentials.cert }, (req, res) => {
    const seen: SeenRequest = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers,
      port: req.socket.localPort ?? 0,
    };
    requests.push(seen);
    handler(seen, res);
  });
  server.on('secureConnection', (socket) => {
    if (socket.servername) servernames.push(socket.servername);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const site: TestTlsSite = {
    port,
    origin: `https://127.0.0.1:${port}`,
    requests,
    servernames,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
  openSites.push(site);
  return site;
}

/** A resolver that answers from a table, and records the names it was asked for. */
export function tableResolver(table: Record<string, ReadonlyArray<ResolvedAddress>>, calls: string[] = []): HostResolver {
  return async (hostname) => {
    calls.push(hostname);
    const addresses = table[hostname];
    if (!addresses) {
      const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
      error.code = 'ENOTFOUND';
      throw error;
    }
    return addresses;
  };
}

export const loopback: ReadonlyArray<ResolvedAddress> = [{ address: '127.0.0.1', family: 4 }];

/** A 302 to `location`. */
export function redirectTo(res: ServerResponse, location: string, status = 302): void {
  res.writeHead(status, { location });
  res.end();
}

/** A 200 with a body. */
export function ok(res: ServerResponse, body: string, contentType = 'text/html; charset=utf-8'): void {
  res.writeHead(200, { 'content-type': contentType });
  res.end(body);
}
