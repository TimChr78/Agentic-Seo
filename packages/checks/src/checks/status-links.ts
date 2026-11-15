import { defineCheck } from '../check';
import { isOkHtml } from '../indexability';
import { fail, notApplicable, pass } from '../outcome';
import { normaliseUrl } from '../url';

// Status and links: what the site answers, and what its internal links point at
// (crawler-and-audits.md §5 "Status and links").

const HTTP_STATUS = 'https://developers.google.com/search/docs/crawling-indexing/http-network-errors';
const REDIRECTS = 'https://developers.google.com/search/docs/crawling-indexing/301-redirects';
const LINKS_CRAWLABLE = 'https://developers.google.com/search/docs/crawling-indexing/links-crawlable';
const NOFOLLOW = 'https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links';
const HTTPS = 'https://developers.google.com/search/docs/crawling-indexing/https';

export const statusClientError = defineCheck({
  id: 'status.client_error',
  title: 'An internal URL returns a 4xx status',
  category: 'status_links',
  severity: 'high',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  explain:
    'A URL that the site links to or lists in a sitemap returns a 4xx status. Visitors and crawlers reach a dead end, and internal links to it waste crawl budget. Fix the link target, restore the page, or redirect the URL.',
  references: [HTTP_STATUS],
  run: (page) => {
    if (page.status < 400 || page.status >= 500) return pass();
    if (!page.inSitemap && page.discoveredBy === 'redirect')
      return notApplicable('The URL was only reached through a redirect, so it is not linked internally.');
    return fail({ subject: page.finalUrl, value: `HTTP ${page.status}`, expected: 'a 200 response' });
  },
});

export const statusServerError = defineCheck({
  id: 'status.server_error',
  title: 'The URL returns a 5xx status',
  category: 'status_links',
  severity: 'high',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  explain:
    'The URL returns a 5xx status. Google may drop the page and slow its crawling of the site while the errors continue. Check the server logs and fix the fault.',
  references: [HTTP_STATUS],
  run: (page) => {
    if (page.status < 500 || page.status >= 600) return pass();
    return fail({ subject: page.finalUrl, value: `HTTP ${page.status}`, expected: 'a 200 response' });
  },
});

export const statusFetchFailed = defineCheck({
  id: 'status.fetch_failed',
  title: 'The URL could not be fetched',
  category: 'status_links',
  severity: 'high',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  explain:
    'The crawler could not fetch the URL: the request timed out, or DNS or TLS failed. Google sees the same failure and cannot index the page. Fix the server, DNS or certificate problem.',
  references: [HTTP_STATUS],
  run: (page) => {
    if (page.fetchError === null) return pass();
    if (page.fetchError === 'redirect_loop') return notApplicable('The request ended in a redirect loop; redirect.loop covers that.');
    return fail({ subject: page.url, value: page.fetchError, expected: 'a response from the server' });
  },
});

export const redirectChain = defineCheck({
  id: 'redirect.chain',
  title: 'The URL takes more than one redirect',
  category: 'status_links',
  severity: 'low',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  explain:
    'The URL reaches its final destination through more than one redirect. Each extra hop slows visitors and dilutes link signals. Point the redirect straight at the final URL.',
  references: [REDIRECTS],
  fix: { change: 'redirect' },
  run: (page) => {
    if (page.redirects.length <= 1) return pass();
    const hops = [page.url, ...page.redirects.map((hop) => hop.location)];
    return fail({
      subject: page.url,
      value: `${page.redirects.length} redirects`,
      expected: 'one redirect, straight to the final URL',
      detail: hops.join(' → '),
    });
  },
});

export const redirectLoop = defineCheck({
  id: 'redirect.loop',
  title: 'The URL redirects in a loop',
  category: 'status_links',
  severity: 'high',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  explain:
    'The URL redirects in a loop, so it never reaches a page. Visitors and crawlers end at an error. Break the loop by redirecting one URL in the cycle to the real destination.',
  references: [REDIRECTS],
  fix: { change: 'redirect' },
  run: (page) => {
    const seen = new Map<string, number>();
    const chain = [page.url, ...page.redirects.map((hop) => hop.location)];
    for (const [index, url] of chain.entries()) {
      const key = normaliseUrl(url) ?? url;
      const first = seen.get(key);
      if (first !== undefined)
        return fail({
          subject: page.url,
          value: 'redirect loop',
          expected: 'a chain that ends at a 200 response',
          detail: `${chain.slice(first, index + 1).join(' → ')} returns to ${url}.`,
        });
      seen.set(key, index);
    }
    if (page.fetchError === 'redirect_loop')
      return fail({ subject: page.url, value: 'redirect loop', expected: 'a chain that ends at a 200 response' });
    return pass();
  },
});

export const redirectTemporary = defineCheck({
  id: 'redirect.temporary',
  title: 'An internal URL uses a temporary redirect',
  category: 'status_links',
  severity: 'low',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  explain:
    'An internal URL answers with a temporary redirect (302 or 307). Temporary redirects do not pass signals the way permanent ones do. Use a 301 or 308 for moves that should stick.',
  references: [REDIRECTS],
  fix: { change: 'redirect' },
  run: (page) => {
    const temporary = page.redirects.filter((hop) => hop.status === 302 || hop.status === 307);
    if (!temporary.length) return pass();
    return fail(
      temporary.map((hop) => ({
        subject: hop.url,
        value: `HTTP ${hop.status}`,
        expected: 'a 301 or 308 permanent redirect',
        detail: `Redirects to ${hop.location}.`,
      })),
    );
  },
});

export const redirectHttpToHttpsMissing = defineCheck({
  id: 'redirect.http_to_https_missing',
  title: 'http:// does not redirect to https://',
  category: 'status_links',
  severity: 'high',
  scope: 'site',
  kind: 'deterministic',
  evaluator: 'site',
  explain:
    'The http:// version of the site does not redirect to https://. Visitors and crawlers can reach an insecure duplicate of every page. Add a permanent redirect from http to https for the whole host.',
  references: [HTTPS, REDIRECTS],
  fix: { change: 'redirect' },
  run: (site) => {
    if (!site.origin.startsWith('https://'))
      return notApplicable('The audit origin is not https, so there is no https version to redirect to.');
    if (site.httpRedirectsToHttps === null) return notApplicable('The http-to-https redirect was not tested for this audit.');
    if (site.httpRedirectsToHttps) return pass();
    return fail({
      subject: site.origin.replace(/^https:/, 'http:'),
      value: 'no redirect to https',
      expected: 'a 301 or 308 redirect to the https URL',
    });
  },
});

export const linksBrokenInternal = defineCheck({
  id: 'links.broken_internal',
  title: 'An internal link points at a broken URL',
  category: 'status_links',
  severity: 'high',
  scope: 'cross_page',
  kind: 'deterministic',
  evaluator: 'finalize',
  explain:
    'An internal link points at a URL that returns 4xx or 5xx, or fails to fetch. Visitors hit a dead end and crawlers spend effort on a dead URL. Update the link or make the target resolve.',
  references: [LINKS_CRAWLABLE, HTTP_STATUS],
  definition:
    'Fails for each internal link edge whose target URL was fetched and returned a 4xx or 5xx status, or failed to fetch (timeout, DNS, TLS). Robots-blocked targets are excluded (page.blocked_by_robots covers them). Evidence: the target URL, its status or failure, the source page that links to it and the anchor text; one evidence item per source page, capped at 50 source pages per target.',
});

export const linksToRedirect = defineCheck({
  id: 'links.to_redirect',
  title: 'An internal link points at a redirect',
  category: 'status_links',
  severity: 'low',
  scope: 'cross_page',
  kind: 'deterministic',
  evaluator: 'finalize',
  explain:
    'An internal link points at a URL that redirects rather than at the final URL. Every click takes an extra hop and the link signal lands on the redirect. Update the link to the destination.',
  references: [LINKS_CRAWLABLE, REDIRECTS],
  definition:
    'Fails for each internal link edge whose target, looked up by the requested URL (`url`, not `final_url`) of its snapshot, has a non-empty `redirects` chain: the link points at a redirecting URL, whatever the final status is. Evidence: the target URL, the first hop’s status and `location`, the final URL, the source page and the anchor text; one evidence item per source page.',
});

export const linksNofollowInternal = defineCheck({
  id: 'links.nofollow_internal',
  title: 'An internal link is nofollowed',
  category: 'status_links',
  severity: 'low',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'An internal link carries rel=nofollow. Nofollow on your own pages discards a link signal you control and can stop discovery. Remove nofollow from internal links that should be followed.',
  references: [NOFOLLOW, LINKS_CRAWLABLE],
  run: (page) => {
    const links = (page.html?.links ?? []).filter((link) => link.internal && link.href !== null && link.rel.includes('nofollow'));
    if (!links.length) return pass();
    return fail(
      links.map((link) => ({
        subject: page.finalUrl,
        selector: 'a[rel~="nofollow"]',
        value: link.href ?? link.rawHref,
        expected: 'an internal link without rel=nofollow',
        detail: link.text ? `Anchor text: “${link.text}”.` : 'The link has no anchor text.',
      })),
    );
  },
});

export const linksInsecureInternal = defineCheck({
  id: 'links.insecure_internal',
  title: 'An https page links to an http URL on the same site',
  category: 'status_links',
  severity: 'low',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: (page) => isOkHtml(page) && page.finalUrl.startsWith('https://'),
  explain:
    'An https page links to an http URL on the same site. The link sends visitors to an insecure version and can trigger mixed-content warnings. Update the link to https.',
  references: [HTTPS, LINKS_CRAWLABLE],
  run: (page) => {
    const links = (page.html?.links ?? []).filter((link) => link.internal && link.href?.startsWith('http://'));
    if (!links.length) return pass();
    return fail(
      links.map((link) => ({
        subject: page.finalUrl,
        selector: 'a[href^="http://"]',
        value: link.href ?? link.rawHref,
        expected: 'an https URL on the same site',
      })),
    );
  },
});

export const statusLinkChecks = [
  statusClientError,
  statusServerError,
  statusFetchFailed,
  redirectChain,
  redirectLoop,
  redirectTemporary,
  redirectHttpToHttpsMissing,
  linksBrokenInternal,
  linksToRedirect,
  linksNofollowInternal,
  linksInsecureInternal,
] as const;
