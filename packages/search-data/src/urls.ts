// Page URLs from Search Console are absolute and may carry a trailing slash, a fragment or an
// upper-case host. Reach and search.pages compare the URL a caller names with the rows Google
// returned, so one function defines the identity and the writer stores its result: both sides agree
// by construction, and no reader re-implements the rule in SQL.
//
// The identity: lower-case scheme and host (what `URL` does), no fragment, no trailing slash except
// on the root ("/a/" and "/a" are the same page; "/" stays "/"), and the query string kept, because
// Google reports "/a?x=1" and "/a?x=2" as separate pages.

export function normalizePageUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    url.hash = '';
    const path = url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
    url.pathname = path || '/';
    return url.toString();
  } catch {
    // Not a URL a browser can parse: compare it exactly, without a trailing slash, but keep "/".
    return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
  }
}

/** The normalised keys a requested URL is matched by (the request itself is one of them). */
export function pageMatchKeys(urls: string[]): string[] {
  return [...new Set(urls.map(normalizePageUrl).filter((url) => url.length > 0))];
}

/** The site's home page, the one critical page Phase 1 knows without site context. */
export function homePageOf(domain: string): string {
  return `https://${domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/`;
}
