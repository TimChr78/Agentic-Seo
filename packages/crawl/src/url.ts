import { createHash } from 'node:crypto';

// URL normalisation for the crawl (docs/architecture/crawler-and-audits.md §2 and the conventions in
// facts.ts): every URL the crawler stores or compares is absolute and normalised, so two spellings
// of one page are one frontier row and one snapshot.

/** The hash a frontier row and a link edge use as their key: sha256 of the normalised URL. */
export function urlHash(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

/** One URL's deterministic snapshot id: `snp_` + the first 32 hex of sha256(audit_id + url_hash). */
export function snapshotId(auditId: string, hash: string): string {
  return `snp_${createHash('sha256').update(`${auditId}:${hash}`).digest('hex').slice(0, 32)}`;
}

/** One page's stable id: `pag_` + the first 32 hex of sha256(site_id + url). */
export function pageId(siteId: string, url: string): string {
  return `pag_${createHash('sha256').update(`${siteId}:${url}`).digest('hex').slice(0, 32)}`;
}

/**
 * The normalised form of an http(s) URL, or null when it cannot be fetched as a page:
 *
 * - scheme and host are lower-cased and the default port is dropped (both by `URL`);
 * - the fragment is removed, because it never reaches the server;
 * - the path and query are kept byte-exact (percent-encoding is left as `URL` produced it);
 * - IDN hosts become punycode; an URL carrying credentials is refused, since the crawler sends none.
 */
export function normalizeUrl(input: string, base?: string): string | null {
  let url: URL;
  try {
    url = base === undefined ? new URL(input) : new URL(input, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  url.hash = '';
  return url.href;
}

/** A host in the form the site stores it: lower case, without brackets or the DNS root's trailing dot. */
export function normalizedHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

/** The host of a normalised URL. */
export function hostOf(url: string): string {
  return normalizedHost(new URL(url).hostname);
}

/** Whether a URL belongs to one of a site's hosts (the site's primary domain and its extras). */
export function isInternalUrl(url: string, hosts: readonly string[]): boolean {
  const host = hostOf(url);
  return hosts.some((candidate) => normalizedHost(candidate) === host);
}

/**
 * The first path segment of a URL, used for the per-section page quota: `/blog/post` and
 * `/blog/other` are both `/blog`; the root and a bare file are `/`.
 */
export function sectionOf(url: string): string {
  const segment = new URL(url).pathname.split('/')[1];
  return segment ? `/${segment}` : '/';
}

/** A section prefix in the stored form: leading slash, no trailing slash except for the root. */
export function normalizeSection(section: string): string {
  const trimmed = section.trim();
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : '/';
}

/** Whether a URL's path is the section itself or below it. */
export function isUnderSection(url: string, section: string): boolean {
  const prefix = normalizeSection(section);
  if (prefix === '/') return true;
  const path = new URL(url).pathname;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The origin of a URL, e.g. `https://example.com`. */
export function originOf(url: string): string {
  return new URL(url).origin;
}

/**
 * The port a site's URLs carry. Production sites answer on 443, so this is undefined; the crawl
 * tests set it (through `setCrawlFetchSeams({ sitePort })`) because their fixture listens on an
 * ephemeral port.
 */
let siteUrlPort: number | undefined;

/** Test-only: make seeded and stored URLs use a non-default port. */
export function setSiteUrlPort(port: number | undefined): void {
  siteUrlPort = port;
}

/** The seed URL of a site: HTTPS on its primary domain (and the test port, when one is set). */
export function siteOrigin(primaryDomain: string): string {
  return `https://${normalizedHost(primaryDomain)}${siteUrlPort === undefined ? '' : `:${siteUrlPort}`}`;
}

/** The hosts a site answers on: its primary domain first, then the extras it was given. */
export function siteHostsOf(site: { primaryDomain: string; hosts: string[] }): string[] {
  return [site.primaryDomain, ...site.hosts.filter((host) => host !== site.primaryDomain)];
}

/** A site's home URL: HTTPS on its primary domain (the audit's seed and `SiteFacts.home`). */
export function siteHomeUrl(primaryDomain: string): string {
  return `${siteOrigin(primaryDomain)}/`;
}
