import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HtmlFacts, PageFacts } from '@agentic-seo/crawl';
import type { HostResolver, ResolvedAddress } from '@agentic-seo/fetch';

/** One request a fake server saw. */
export interface FakeCall {
  method: string;
  path: string;
  body: unknown;
  headers: IncomingHttpHeaders;
}

export interface FakeReply {
  status?: number;
  /** A JSON body; ignored when `text` is set. */
  body?: unknown;
  /** A raw body, for a version file or a malformed answer. */
  text?: string;
  headers?: Record<string, string>;
}

export type FakeHandler = (call: FakeCall) => FakeReply | Promise<FakeReply>;

export interface FakeServer {
  readonly origin: string;
  readonly port: number;
  readonly calls: FakeCall[];
  close(): Promise<void>;
}

const servers: FakeServer[] = [];

/** A local HTTP server for a test; no test in this package reaches the internet. */
export async function startFakeServer(handler: FakeHandler): Promise<FakeServer> {
  const calls: FakeCall[] = [];
  const server = createServer((request, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const call: FakeCall = { method: request.method ?? 'GET', path: request.url ?? '/', body, headers: request.headers };
      calls.push(call);
      void Promise.resolve(handler(call)).then((reply) => {
        const headers: Record<string, string> = { ...(reply.headers ?? {}) };
        const payload = reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
        if (reply.text === undefined && reply.body !== undefined) headers['content-type'] = 'application/json';
        response.writeHead(reply.status ?? 200, headers);
        response.end(payload);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const fake: FakeServer = {
    port,
    origin: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
  servers.push(fake);
  return fake;
}

export async function closeFakeServers(): Promise<void> {
  await Promise.all(servers.splice(0).map((server) => server.close()));
}

/** A resolver that answers from a table, so a test name never reaches DNS. */
export function tableResolver(table: Record<string, ResolvedAddress[]>): HostResolver {
  return async (hostname) => {
    const addresses = table[hostname];
    if (!addresses) {
      const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
      error.code = 'ENOTFOUND';
      throw error;
    }
    return addresses;
  };
}

/** Every HtmlFacts field, empty, so a test can state only what it cares about. */
export function htmlFacts(overrides: Partial<HtmlFacts> = {}): HtmlFacts {
  return {
    lang: null,
    title: null,
    titleCount: 0,
    metaDescription: null,
    metaDescriptionCount: 0,
    metaRobots: [],
    canonical: null,
    canonicals: [],
    canonicalOutsideHead: false,
    viewport: null,
    charset: null,
    hreflang: [],
    headings: [],
    links: [],
    images: [],
    jsonLd: [],
    microdataTypes: [],
    openGraph: {},
    twitter: {},
    wordCount: 0,
    contentHash: '',
    mixedContent: [],
    insecureForms: [],
    ...overrides,
  };
}

/** A PageFacts record, so verification tests do not build the crawler's whole contract by hand. */
export function pageFacts(overrides: Omit<Partial<PageFacts>, 'html'> & { html?: Partial<HtmlFacts> | null } = {}): PageFacts {
  const { html, ...rest } = overrides;
  return {
    url: 'https://example.com/about/',
    finalUrl: 'https://example.com/about/',
    status: 200,
    redirects: [],
    fetchError: null,
    contentType: 'text/html',
    isHtml: true,
    headers: { xRobotsTag: null, contentLanguage: null, strictTransportSecurity: null, link: null },
    ttfbMs: 10,
    totalMs: 20,
    bytes: 1_000,
    depth: 0,
    discoveredBy: 'seed',
    inSitemap: false,
    robotsAllowed: true,
    html: html === null ? null : htmlFacts(html ?? {}),
    ...rest,
  };
}
