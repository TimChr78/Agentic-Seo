import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { ResolvedAddress } from '@agentic-seo/fetch';

// A local fixture site for the crawl tests: HTTPS with a certificate the test generated, ~30 pages,
// a sitemap index with a gzipped sitemap, robots.txt with a disallowed section and a crawl-delay, a
// redirect chain, a 404, a 500, a non-HTML file, a sitemap-only orphan, a `<base href>` page and a
// JSON-LD page. No test reaches the public internet: the crawler's test seams map `fixture.test` to
// 127.0.0.1 and allow its ports.

/** The fixture's one host name; every URL below is on it. */
export const FIXTURE_HOST = 'fixture.test';

export interface SeenFixtureRequest {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  at: number;
}

export interface FixtureSite {
  readonly origin: string;
  readonly port: number;
  readonly httpPort: number;
  readonly httpOrigin: string;
  readonly requests: SeenFixtureRequest[];
  /** The certificate a test trusts through `setCrawlFetchSeams({ ca })`. */
  readonly certificate: string;
  /** The resolver a test installs so `fixture.test` reaches 127.0.0.1. */
  readonly resolver: (hostname: string) => Promise<ReadonlyArray<ResolvedAddress>>;
  /** The allow-list entry (hosts and both ports). */
  readonly allow: { privateHosts: string[]; ports: number[] };
  /** Paths requested, in order. */
  paths(): string[];
  close(): Promise<void>;
}

export const loopback: ReadonlyArray<ResolvedAddress> = [{ address: '127.0.0.1', family: 4 }];

function selfSignedCertificate(hostname: string): { key: string; cert: string } {
  const directory = mkdtempSync(join(tmpdir(), 'aseo-crawl-tls-'));
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
    return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const page = (title: string, body: string, head = ''): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

/** The rich page: its facts are asserted field by field in extract.test.ts and the crawler test. */
export function richPage(): string {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<base href="/deep/">
<title>Rich page</title>
<title>Second title</title>
<meta name="description" content="First description">
<meta name="description" content="Second description">
<meta name="robots" content="index, follow">
<meta name="googlebot" content="noindex">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="child">
<link rel="alternate" hreflang="fr-FR" href="/fr">
<meta property="og:title" content="Rich OG">
<meta property="og:title" content="Ignored OG">
<meta name="twitter:card" content="summary">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"X"},{"@type":"WebSite","potentialAction":{"@type":"SearchAction"}}]}</script>
<script type="application/ld+json">{"@type": broken}</script>
</head>
<body itemscope itemtype="https://schema.org/Article">
<h1>Rich <em>page</em></h1>
<h2>Second</h2>
<p>Some visible words here for the counter. <script>var hidden = "no";</script><style>.hidden{}</style><noscript>noscript text</noscript><template>template text</template></p>
<a href="child">Child link</a>
<a href="/missing" rel="nofollow sponsored">Missing <img src="pic.png" alt="Picture"></a>
<a href="mailto:x@example.com">Mail</a>
<a href="child"><img src="only-alt.png" alt="Alt text"></a>
<img src="one.png" alt="">
<img src="two.png">
<img srcset="three-1.png 1x, three-2.png 2x" alt="Three" width="10" height="20" loading="lazy">
<img src="http://plain.example/pic.png" alt="Insecure">
<script src="http://plain.example/app.js"></script>
<link rel="stylesheet" href="http://plain.example/app.css">
<form action="http://plain.example/submit" method="post"><input name="x"></form>
<link rel="canonical" href="/outside">
</body></html>`;
}

/** Starts the fixture site: an HTTPS listener on 127.0.0.1 and a plain-HTTP probe listener. */
export async function startFixture(): Promise<FixtureSite> {
  const requests: SeenFixtureRequest[] = [];
  let origin = '';
  const credentials = selfSignedCertificate(FIXTURE_HOST);

  const html = (title: string, body: string, head = '') => page(title, body, head);

  const homeBody = [
    '<h1>Home</h1><p>Welcome to the fixture site.</p>',
    '<a href="/a">A</a>',
    '<a href="/b" rel="nofollow">B</a>',
    '<a href="/redirect">Redirect</a>',
    '<a href="/missing">Missing</a>',
    '<a href="/boom">Boom</a>',
    '<a href="/file.pdf">PDF</a>',
    '<a href="/private/secret">Private</a>',
    '<a href="/base">Base</a>',
    '<a href="/rich">Rich</a>',
    '<a href="/sitemap-only">Sitemap only</a>',
    '<a href="https://external.invalid/page">External</a>',
    '<a href="mailto:hi@example.com">Mail</a>',
    ...Array.from({ length: 8 }, (_, index) => `<a href="/p/${index + 1}">P${index + 1}</a>`),
  ].join('\n');

  const pages = new Map<string, { status?: number; type?: string; body?: string; location?: string; headers?: Record<string, string> }>();
  pages.set('/', { body: html('Home', homeBody, '<meta name="description" content="The home page">') });
  pages.set('/a', { body: html('A', '<a href="/a2">A2</a><a href="/b">B</a>') });
  pages.set('/a2', { body: html('A2', '<a href="/a3">A3</a><a href="/dup-in-sitemap">Dup</a>') });
  pages.set('/a3', { body: html('A3', '<p>End of the line.</p>') });
  pages.set('/b', { body: html('B', '<a href="/missing">Missing</a><a href="/boom">Boom</a>') });
  pages.set('/c', { status: 301, location: '/d' });
  pages.set('/d', { body: html('D', '<p>The end of the redirect chain.</p>') });
  pages.set('/redirect', { status: 302, location: '/c' });
  // Two redirects that a crawl must not follow blindly: off the site's hosts, and into a
  // robots-disallowed path. Neither target is fetched.
  pages.set('/offsite', { status: 302, location: 'https://external.invalid/elsewhere' });
  pages.set('/to-private', { status: 302, location: '/private/secret' });
  // A host backoff: the crawler must attribute it to this host and postpone the next chunk.
  pages.set('/throttled', { status: 429, headers: { 'retry-after': '60' } });
  // A redirect loop: the crawler stops at the first repeated URL instead of following it forever.
  pages.set('/loop-a', { status: 302, location: '/loop-b' });
  pages.set('/loop-b', { status: 302, location: '/loop-a' });
  // More links than the extractor keeps, so coverage records a truncated graph.
  pages.set('/many-links', {
    body: html('Many links', `${Array.from({ length: 5_001 }, (_, index) => `<a href="/p/${(index % 8) + 1}">L${index}</a>`).join('')}`),
  });
  pages.set('/missing', { status: 404, body: html('Not found', '<p>Gone.</p>') });
  pages.set('/boom', { status: 500, body: html('Boom', '<p>Server error.</p>') });
  pages.set('/file.pdf', { type: 'application/pdf', body: '%PDF-1.4 fixture' });
  pages.set('/private/secret', { body: html('Private', '<p>robots.txt says no.</p>') });
  pages.set('/base', {
    body: '<!doctype html><html><head><title>Base</title><base href="/deep/"><link rel="canonical" href="child"></head><body><a href="child">Child</a></body></html>',
  });
  pages.set('/deep/child', { body: html('Deep child', '<a href="/">Home</a>') });
  pages.set('/rich', { body: richPage() });
  pages.set('/sitemap-only', { body: html('Sitemap only', '<a href="/not-linked">Next</a>') });
  pages.set('/not-linked', { body: html('Not linked', '<p>Only a sitemap-only page links here.</p>') });
  pages.set('/orphan', { body: html('Orphan', '<p>Nothing links here.</p>') });
  pages.set('/deep/one', { body: html('Deep one', '<p>Listed by a sitemap.</p>') });
  pages.set('/dup-in-sitemap', { body: html('Dup', '<p>Linked and listed.</p>') });
  for (let index = 1; index <= 8; index += 1) pages.set(`/p/${index}`, { body: html(`P${index}`, `<p>Filler ${index}.</p>`) });

  const sitemapOne = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${'ORIGIN'}/sitemap-only</loc></url>
<url><loc>${'ORIGIN'}/orphan</loc></url>
<url><loc>${'ORIGIN'}/a</loc></url>
<url><loc>https://external.invalid/ignored</loc></url>
</urlset>`;
  const sitemapTwo = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${'ORIGIN'}/deep/one</loc></url>
<url><loc>${'ORIGIN'}/dup-in-sitemap</loc></url>
</urlset>`;

  const server = createHttpsServer({ key: credentials.key, cert: credentials.cert }, (req, res) => {
    const url = req.url ?? '/';
    requests.push({ url, headers: req.headers, at: Date.now() });
    const path = new URL(url, 'https://placeholder').pathname;
    if (path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`User-agent: *\nDisallow: /private\nCrawl-delay: 0\nSitemap: ${origin}/sitemap-index.xml\n`);
      return;
    }
    if (path === '/sitemap-index.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${origin}/sitemap.xml.gz</loc></sitemap><sitemap><loc>${origin}/sitemap-2.xml</loc></sitemap></sitemapindex>`,
      );
      return;
    }
    if (path === '/sitemap.xml.gz') {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(gzipSync(sitemapOne.replaceAll('ORIGIN', origin)));
      return;
    }
    if (path === '/sitemap-2.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(sitemapTwo.replaceAll('ORIGIN', origin));
      return;
    }
    const found = pages.get(path);
    if (!found) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end(html('Not found', '<p>No such fixture page.</p>'));
      return;
    }
    if (found.status && found.location) {
      res.writeHead(found.status, { location: found.location, ...(found.headers ?? {}) });
      res.end();
      return;
    }
    res.writeHead(found.status ?? 200, { 'content-type': found.type ?? 'text/html; charset=utf-8', ...(found.headers ?? {}) });
    res.end(found.body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  origin = `https://${FIXTURE_HOST}:${port}`;

  const httpServer = createHttpServer((req, res) => {
    const path = req.url ?? '/';
    requests.push({ url: `http://probe${path}`, headers: req.headers, at: Date.now() });
    res.writeHead(301, { location: `${origin}${path}` });
    res.end();
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const httpPort = (httpServer.address() as AddressInfo).port;

  return {
    origin,
    port,
    httpPort,
    httpOrigin: `http://${FIXTURE_HOST}:${httpPort}`,
    requests,
    certificate: credentials.cert,
    resolver: async (hostname: string) => {
      if (hostname === FIXTURE_HOST) return loopback;
      const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
      error.code = 'ENOTFOUND';
      throw error;
    },
    allow: { privateHosts: [FIXTURE_HOST], ports: [port, httpPort] },
    paths: () => requests.map((request) => new URL(request.url, origin).pathname),
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        httpServer.closeAllConnections?.();
        httpServer.close(() => resolve());
      });
    },
  };
}
