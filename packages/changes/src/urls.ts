// Small URL comparisons shared by the editor (which sees a file's relative src) and the verifier
// (which sees the crawler's absolute src). They compare the path and query rather than the host,
// because the origin is implied by the site either way.

/** Whether two image srcs name the same image, absolute or relative. */
export function sameImageSource(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    const a = new URL(left, 'https://placeholder.invalid');
    const b = new URL(right, 'https://placeholder.invalid');
    return a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

/** Whether two URLs are the same after resolving a relative one against a base. */
export function sameUrl(left: string, right: string, base?: string): boolean {
  try {
    return new URL(left, base).href === new URL(right, base).href;
  } catch {
    return left === right;
  }
}
