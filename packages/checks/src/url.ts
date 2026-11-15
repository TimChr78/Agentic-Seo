// URL comparison and page-shape helpers shared by the checks. The crawler already normalises every
// URL it stores (lowercase scheme and host, default port dropped, fragment removed), so these only
// guard against values a page supplies itself, such as a canonical or an hreflang href.

/** The comparable form of an absolute URL: no fragment, no default port, lowercase scheme and host. */
export function normaliseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  if (url.pathname === '') url.pathname = '/';
  return url.toString();
}

/** Whether two absolute URLs are the same page after normalisation. */
export function isSameUrl(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const left = normaliseUrl(a);
  const right = normaliseUrl(b);
  return left !== null && left === right;
}

/** The path of an absolute URL, or null when it does not parse. */
export function pathOf(value: string): string | null {
  try {
    return new URL(value).pathname;
  } catch {
    return null;
  }
}

/** The origin of an absolute URL, or null when it does not parse. */
export function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** Whether a URL is the site's home page, which content thresholds exclude. */
export function isHomePage(value: string): boolean {
  const path = pathOf(value);
  return path === '/' || path === '/index.html' || path === '/index.htm';
}
