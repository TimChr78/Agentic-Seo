// Page URLs from Search Console are absolute and may carry a trailing slash, a fragment or an
// upper-case host. Reach compares the URL a command names with the rows Google returns, so both
// sides go through the same normalisation: lower-case scheme and host, no fragment, no trailing
// slash on a path. A query string is kept: it identifies a page that Google reports separately.
//
// The SQL side uses `rtrim(page, '/')`, the same rule for the stored URL, so a slash mismatch on
// either side still matches. A row's URL is otherwise stored exactly as Google returned it.

export function normalizePageUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    url.hash = '';
    const path = url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
    url.pathname = path;
    return url.toString();
  } catch {
    // Not a URL a browser can parse: compare it exactly, without a trailing slash.
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
