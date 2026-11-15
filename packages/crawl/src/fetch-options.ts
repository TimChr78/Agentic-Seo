import type { FetchResult, SafeFetchOptions } from '@agentic-seo/fetch';
import { safeFetch } from '@agentic-seo/fetch';
import { setSiteUrlPort } from './url';

/**
 * Test-only overrides for the crawler's guarded fetches: a resolver (a fixture site on 127.0.0.1
 * has no public name), an allow-list entry for the fixture host and port, its CA, and the port its
 * `http://` probe answers on. Production passes none of them, so every fetch is the real SSRF guard.
 *
 * The crawler has no seam that replaces the fetch itself: a test that wants a page to fail makes
 * the fixture answer with a failure, so the guard, redirects and body caps always run.
 */
export interface CrawlFetchSeams {
  resolver?: SafeFetchOptions['resolver'];
  allow?: SafeFetchOptions['allow'];
  ca?: SafeFetchOptions['ca'];
  /** The port a fixture's plain-HTTP listener uses for the `http://` → HTTPS probe. */
  httpPort?: number;
  /** The port the fixture's HTTPS listener uses, so the site's seeded URLs carry it. */
  sitePort?: number;
}

let seams: CrawlFetchSeams = {};

/** Replace the crawler's fetch seams in tests; `null` restores production defaults. */
export function setCrawlFetchSeams(next: CrawlFetchSeams | null): void {
  seams = next ?? {};
  setSiteUrlPort(seams.sitePort);
}

export function crawlFetchSeams(): CrawlFetchSeams {
  return seams;
}

/** The options every crawler fetch starts from. */
export function crawlFetchOptions(): Omit<SafeFetchOptions, 'signal'> {
  return {
    ...(seams.resolver ? { resolver: seams.resolver } : {}),
    ...(seams.allow ? { allow: seams.allow } : {}),
    ...(seams.ca ? { ca: seams.ca } : {}),
  };
}

/** The crawler's one way to touch an arbitrary URL: `safeFetch` plus the test seams. */
export function crawlFetch(url: string, options: SafeFetchOptions = {}): Promise<FetchResult> {
  return safeFetch(url, { ...crawlFetchOptions(), ...options });
}

/** The `http://` probe target for a host, honouring the test-only port override. */
export function httpProbeUrl(host: string): string {
  return seams.httpPort === undefined ? `http://${host}/` : `http://${host}:${seams.httpPort}/`;
}
