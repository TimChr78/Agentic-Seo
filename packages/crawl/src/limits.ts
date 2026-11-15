/** The limits of one audit, after defaults and the hard cap (crawler-and-audits.md §2). */
export interface CrawlLimits {
  /** Pages to crawl. Default 500; a hard cap of 10,000 per audit. */
  maxPages: number;
  /** Click depth to follow from the seed. Default 10. */
  maxDepth: number;
  /** Wall-clock budget. Default 30 minutes. */
  maxDurationMs: number;
}

export const MAX_PAGES = 10_000;

export const DEFAULT_LIMITS: CrawlLimits = { maxPages: 500, maxDepth: 10, maxDurationMs: 30 * 60 * 1000 };

/** Limits from an audit row (or a command's input), with defaults filled and the cap enforced. */
export function limitsOf(value: { limits?: unknown } | null | undefined): CrawlLimits {
  const stored = (value?.limits ?? {}) as Partial<CrawlLimits>;
  const number = (candidate: unknown, fallback: number) =>
    typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : fallback;
  return {
    maxPages: Math.max(1, Math.min(MAX_PAGES, Math.floor(number(stored.maxPages, DEFAULT_LIMITS.maxPages)))),
    maxDepth: Math.max(0, Math.min(100, Math.floor(number(stored.maxDepth, DEFAULT_LIMITS.maxDepth)))),
    maxDurationMs: Math.max(1_000, Math.min(24 * 60 * 60 * 1000, Math.floor(number(stored.maxDurationMs, DEFAULT_LIMITS.maxDurationMs)))),
  };
}
