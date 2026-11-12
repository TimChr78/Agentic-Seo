import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
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
