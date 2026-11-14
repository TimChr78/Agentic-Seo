import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { type FetchResult, isSafeFetchError, SafeFetchError, type SafeFetchOptions, safeFetch } from '@agentic-seo/fetch';
import { parse as parseHtml } from 'parse5';

// Ownership verification for a site (docs/architecture/domain-model.md §1): a DNS TXT record or a
// meta tag in the home page's head, both carrying the site's own token. A site is only verified
// when the check succeeds from the public internet, so the meta fetch goes through the SSRF guard
// in `@agentic-seo/fetch`; nothing here calls `fetch` directly.

/** The record name used for both methods. One token, two ways to publish it. */
export const VERIFICATION_NAME = 'aseo-site-verification';

/** The meta tag's content and the TXT value are both `aseo-site-verification=<token>`. */
export const dnsRecordValue = (token: string) => `${VERIFICATION_NAME}=${token}`;

/**
 * A fresh token: 192 bits of randomness, base64url so it survives a copy-paste through DNS consoles
 * and HTML attributes. Created once with the site; `sites.verification` never rotates it silently.
 */
export const newVerificationToken = (): string => randomBytes(24).toString('base64url');

/**
 * How much of the home page the meta check reads. The tag belongs in the head, and a head is far
 * smaller than this; the cap keeps a huge or streaming response from being read to the end. HTML
 * bodies that cross it come back truncated, and truncation never fails the check by itself.
 */
export const VERIFICATION_BODY_BYTES = 256 * 1024;

/** A TXT lookup that returns each record's chunks, as `node:dns` does. Injectable for tests. */
export type TxtResolver = (name: string) => Promise<readonly (readonly string[])[]>;

const systemTxtResolver: TxtResolver = (name) => resolveTxt(name);
let txtResolver: TxtResolver = systemTxtResolver;

/** Replace the TXT resolver in tests; `null` restores the system resolver. */
export function setTxtResolver(resolver: TxtResolver | null): void {
  txtResolver = resolver ?? systemTxtResolver;
}

/** The guarded fetch the meta check uses, narrowed to what it needs. Injectable for tests. */
export type SiteFetcher = (url: string, options: { hosts: readonly string[] }) => Promise<FetchResult>;

/**
 * Test-only overrides for the guarded fetch: a resolver (and, for a local test server, an allow list
 * and CA). Production passes none of them, so the real `safeFetch` guard and redirect policy run.
 */
export type SiteFetchSeams = Pick<SafeFetchOptions, 'resolver' | 'allow' | 'ca'>;

let siteFetchSeams: SiteFetchSeams = {};

/** Replace the guarded fetch's resolver/allow-list in tests; `null` restores production defaults. */
export function setSiteFetchSeams(seams: SiteFetchSeams | null): void {
  siteFetchSeams = seams ?? {};
}

/**
 * The per-hop redirect policy for a site: only HTTPS on one of the site's own hosts. `safeFetch`
 * calls it with each `Location` before resolving or connecting, so an unrelated host is never
 * contacted and an `https -> http` downgrade never leaves the process.
 */
export function siteRedirectPolicy(hosts: readonly string[]): (url: URL) => true | string {
  const allowed = hosts.map((host) => host.toLowerCase());
  return (url) => {
    if (url.protocol !== 'https:') return `${url.href} is not HTTPS. Ownership is checked over HTTPS only.`;
    const host = url.hostname.toLowerCase();
    if (!allowed.includes(host)) return `${url.href} is not one of this site's hosts (${allowed.join(', ')}).`;
    return true;
  };
}

export const safeSiteFetcher: SiteFetcher = (url, { hosts }) => {
  // The first URL is built as https by this package; requiring it here keeps the whole chain on
  // HTTPS even if the caller ever changes that.
  if (new URL(url).protocol !== 'https:')
    return Promise.reject(new SafeFetchError('blocked_scheme', `${url} is not HTTPS. Ownership is checked over HTTPS only.`, { url }));
  return safeFetch(url, {
    ...siteFetchSeams,
    maxBytes: VERIFICATION_BODY_BYTES,
    maxRedirects: 5,
    totalTimeoutMs: 15_000,
    allowRedirect: siteRedirectPolicy(hosts),
  });
};

let fetchSite: SiteFetcher = safeSiteFetcher;

/** Replace the page fetcher in tests; `null` restores the guarded one. */
export function setSiteFetcher(fetcher: SiteFetcher | null): void {
  fetchSite = fetcher ?? safeSiteFetcher;
}

/** The outcome of one method: success, or the reason a person can act on. */
export type CheckResult = { ok: true } | { ok: false; error: string };

const errorCode = (error: unknown): string => {
  for (let e = error as { code?: unknown; cause?: unknown } | undefined, depth = 0; e && depth < 4; e = e.cause as typeof e, depth++)
    if (typeof e.code === 'string') return e.code;
  return '';
};

/**
 * Checks the TXT records of the primary domain. Each record's chunks are joined before comparing:
 * DNS transports a long TXT value as several character strings, and only the joined value is the
 * record a person published.
 */
export async function checkDnsRecord(domain: string, token: string): Promise<CheckResult> {
  const expected = dnsRecordValue(token);
  let records: readonly (readonly string[])[];
  try {
    records = await txtResolver(domain);
  } catch (error) {
    const code = errorCode(error);
    const missing = ['ENODATA', 'ENOTFOUND', 'EAI_NONAME', 'EAI_NODATA'].includes(code);
    return {
      ok: false,
      error: missing
        ? `No DNS TXT records were found on ${domain} (${code}). Add a TXT record with the value “${expected}”, wait for its TTL, then check again.`
        : `The DNS lookup for ${domain} failed (${code || 'unknown error'}). Try again in a few minutes, or verify with the meta tag instead.`,
    };
  }
  const values = records.map((chunks) => chunks.join(''));
  if (values.includes(expected)) return { ok: true };
  return {
    ok: false,
    error: `No TXT record on ${domain} has the value “${expected}”. Add it at your DNS host, wait for its TTL, then check again.`,
  };
}

/** The subset of parse5's default tree the meta check reads. */
interface HtmlNode {
  tagName?: string;
  attrs?: ReadonlyArray<{ name: string; value: string }>;
  childNodes?: ReadonlyArray<HtmlNode>;
}

/** ASCII whitespace, the set HTML trims around an attribute value for this check. */
const ASCII_WHITESPACE_EDGES = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;

/** The document's `head` element, as the parser placed it (it applies the spec's implicit head end). */
function headElement(html: string): HtmlNode | undefined {
  const document = parseHtml(html) as unknown as HtmlNode;
  const root = document.childNodes?.find((node) => node.tagName === 'html');
  return root?.childNodes?.find((node) => node.tagName === 'head');
}

/**
 * Whether the parsed head has a direct child `<meta name="aseo-site-verification" content="<token>">`.
 * Parsing, not scanning, is what makes this trustworthy: a comment, another element's attribute
 * value, a `<script>`/`<noscript>`/`<template>` raw-text body and anything the parser moved to the
 * body are not meta elements in the head, so none of them can spoof the tag.
 *
 * The name is matched ASCII case-insensitively; the content is compared exactly after trimming
 * ASCII whitespace, so a token with a stray newline from a template still works.
 */
export function metaTagPresent(html: string, token: string): boolean {
  const head = headElement(html);
  if (!head) return false;
  for (const node of head.childNodes ?? []) {
    if (node.tagName !== 'meta') continue;
    const name = node.attrs?.find((attribute) => attribute.name === 'name')?.value;
    const content = node.attrs?.find((attribute) => attribute.name === 'content')?.value ?? '';
    if (name?.toLowerCase() !== VERIFICATION_NAME) continue;
    if (content.replace(ASCII_WHITESPACE_EDGES, '') === token) return true;
  }
  return false;
}

/** Why a guarded fetch failed, in terms a site owner can act on. */
function fetchFailure(domain: string, error: unknown): string {
  if (!isSafeFetchError(error)) return `https://${domain}/ could not be fetched. Try again in a few minutes.`;
  const advice =
    error.kind === 'blocked_address'
      ? 'A site has to be reachable on the public internet, so private and loopback addresses are refused.'
      : error.kind === 'dns'
        ? 'Check that the domain resolves, or verify with the DNS record instead.'
        : error.kind === 'tls'
          ? 'Check the certificate on the home page, or verify with the DNS record instead.'
          : error.kind === 'blocked_redirect'
            ? 'The home page redirects somewhere this check does not follow: only HTTPS on one of the site’s own hosts counts.'
            : 'Check that the home page loads, then check again.';
  return `https://${domain}/ could not be fetched: ${error.message}. ${advice}`;
}

/**
 * Checks the home page for the meta tag. Redirects are followed by the guarded fetch, and the page
 * that finally served the response must be one of the site's own hosts: a redirect to another site
 * (a parking page, a CDN that rewrites to its own host) cannot vouch for this one.
 */
export async function checkMetaTag(domain: string, hosts: readonly string[], token: string): Promise<CheckResult> {
  const url = `https://${domain}/`;
  const allowed = hosts.length ? hosts : [domain];
  let page: FetchResult;
  try {
    page = await fetchSite(url, { hosts: allowed });
  } catch (error) {
    return { ok: false, error: fetchFailure(domain, error) };
  }

  if (page.status < 200 || page.status >= 300)
    return {
      ok: false,
      error: `https://${domain}/ answered HTTP ${page.status}. The meta tag has to be served by a page that loads (200), not a redirect or an error page.`,
    };
  if (!/html/i.test(page.contentType ?? ''))
    return {
      ok: false,
      error: `https://${domain}/ served ${page.contentType ?? 'no content type'}, not HTML, so it cannot carry the meta tag.`,
    };

  let servedHost: string;
  try {
    servedHost = new URL(page.url).hostname.toLowerCase();
  } catch {
    servedHost = domain;
  }
  if (!allowed.includes(servedHost))
    return {
      ok: false,
      error: `https://${domain}/ redirected to ${servedHost}, which is not one of this site's hosts (${allowed.join(', ')}). Add the host to the site, or serve the tag on the primary domain.`,
    };

  if (metaTagPresent(page.text, token)) return { ok: true };
  return {
    ok: false,
    error: `The head of https://${domain}/ has no <meta name="${VERIFICATION_NAME}" content="${token}">. Add it to the home page's <head>, deploy, then check again.`,
  };
}
