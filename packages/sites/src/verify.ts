import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { type FetchResult, isSafeFetchError, safeFetch } from '@agentic-seo/fetch';

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

export const safeSiteFetcher: SiteFetcher = (url) =>
  safeFetch(url, {
    maxBytes: VERIFICATION_BODY_BYTES,
    maxRedirects: 5,
    totalTimeoutMs: 15_000,
  });

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

/**
 * The head of an HTML document: everything before `</head>`, or the whole prefix when the tag is
 * missing or the body was cut short. A tolerant scan is enough here; a full DOM parse would add a
 * dependency for one attribute check.
 */
export function headOf(html: string): string {
  const end = html.search(/<\/head\s*>/i);
  return end === -1 ? html : html.slice(0, end);
}

const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/** Whether the head contains `<meta name="aseo-site-verification" content="<token>">`. */
export function metaTagPresent(html: string, token: string): boolean {
  for (const tag of headOf(html).match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(ATTRIBUTE)) {
      const value = match[2] ?? match[3] ?? match[4] ?? '';
      attributes.set(match[1]!.toLowerCase(), value);
    }
    if (attributes.get('name')?.toLowerCase() === VERIFICATION_NAME && attributes.get('content') === token) return true;
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
  let page: FetchResult;
  try {
    page = await fetchSite(url, { hosts });
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
  const allowed = hosts.length ? hosts : [domain];
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
