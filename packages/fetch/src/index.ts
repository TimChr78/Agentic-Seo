/**
 * `@agentic-seo/fetch`: the only package that touches arbitrary URLs.
 *
 * - {@link safeFetch} resolves, checks every resolved address, pins the connection and re-checks
 *   each redirect hop (security-and-privacy.md §1).
 * - {@link Robots} reads robots.txt through that guard and caches it per origin.
 * - {@link MemoryHostLimiter} enforces per-host concurrency, crawl-delay and `Retry-After`.
 * - {@link Renderer} is the port for rendered crawls; the default {@link noneRenderer} says
 *   "not evaluated" instead of pretending.
 */
export * from './addresses';
export * from './errors';
export * from './limiter';
export * from './policy';
export * from './renderer';
export * from './robots';
export * from './safe-fetch';
