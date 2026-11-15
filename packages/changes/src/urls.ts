// URL comparisons shared by the editors (which see a file's relative src) and the verifier (which
// sees the crawler's absolute src). Both sides resolve a value the way a browser does and compare
// complete URLs: the same path on another host is a different image, and a relative src means what
// the page's base makes it mean. A comparison that looked only at the path could edit an image that
// the page never shows, or miss the one it does.

/**
 * A URL as the crawler records it (`packages/crawl/src/facts.ts`): resolved against `base`, with the
 * scheme and host lowercased, the default port dropped and the fragment removed. `null` when the
 * value is not a URL — a caller then falls back to an exact string comparison.
 */
export function normaliseUrl(value: string, base?: string): string | null {
  try {
    const url = new URL(value, base);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/** The first candidate of a `srcset` value: the URL before its width/density descriptor. */
export function firstSrcsetSource(srcset: string | undefined): string | null {
  const first = srcset?.split(',')[0]?.trim().split(/\s+/)[0];
  return first ? first : null;
}

/**
 * The absolute URL an `<img>` loads: its `src`, or the first `srcset` candidate when `src` is
 * absent or empty. This mirrors the crawler (`PageImage.src` in `packages/crawl/src/facts.ts`), so
 * the URL the editor matches is the URL the verifier later sees.
 */
export function imageSourceUrl(src: string | undefined, srcset: string | undefined, base: string): string | null {
  const direct = src?.trim();
  if (direct) return normaliseUrl(direct, base);
  const candidate = firstSrcsetSource(srcset);
  return candidate === null ? null : normaliseUrl(candidate, base);
}

/** Whether two image srcs name the same image once both are resolved and normalised. */
export function sameImageSource(left: string, right: string, base?: string): boolean {
  const a = normaliseUrl(left, base);
  const b = normaliseUrl(right, base);
  if (a === null || b === null) return left === right;
  return a === b;
}

/** Whether two URLs are the same after resolving a relative one against a base. */
export function sameUrl(left: string, right: string, base?: string): boolean {
  try {
    return new URL(left, base).href === new URL(right, base).href;
  } catch {
    return left === right;
  }
}
