// Legacy admin URLs. Agentic SEO starts on canonical paths, so no rule exists yet; the seam is here
// so a renamed destination can keep old bookmarks working without every page knowing. A rule
// replaces history before the page fetches, preserves every other query value and the hash, and
// returns null for an unknown tail (the router renders Not found rather than swallowing it).

/** An id segment, decoded and encoded exactly once. */
function carry(segment: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(segment));
  } catch {
    // Malformed percent escapes: carry the raw segment rather than dropping the destination.
    return encodeURIComponent(segment);
  }
}

interface Rule {
  /** Exactly the list route or exactly one id segment; deeper tails are Not found. */
  pattern: RegExp;
  to: (id: string) => string;
  set?: Record<string, string>;
}

const RULES: Rule[] = [];

/**
 * The canonical destination for an old URL, or null when the URL is not a legacy address. The
 * caller must call this before mounting a page, so a redirect never fetches the old page.
 */
export function redirectTarget(pathname: string, search: URLSearchParams, hash = ''): string | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  for (const rule of RULES) {
    const found = rule.pattern.exec(path);
    if (!found) continue;
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(rule.set ?? {})) next.set(key, value);
    const query = next.toString();
    return `${rule.to(carry(found[1] ?? ''))}${query ? `?${query}` : ''}${hash}`;
  }
  return null;
}
