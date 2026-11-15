import type { HtmlFacts, PageFacts, RedirectHop } from '@agentic-seo/crawl';
import { crawlFetch, extractHtml, normalizeUrl } from '@agentic-seo/crawl';

// Verification re-fetches the affected URLs with the crawler's guarded fetch and extractor, never a
// raw fetch: the SSRF guard, the redirect policy and the body cap are the same ones an audit uses,
// and the facts are the same shape the checks read. One page in, one PageFacts out; a failure is a
// record with `fetchError` set, because "could not fetch" is a distinct outcome from "the page did
// not change" and the verification result must say which.

/** The empty header block a fetched page carries when the response had none of the four we keep. */
const NO_HEADERS: PageFacts['headers'] = {
  xRobotsTag: null,
  contentLanguage: null,
  strictTransportSecurity: null,
  link: null,
};

function failure(url: string, fetchError: string, redirects: RedirectHop[] = []): PageFacts {
  return {
    url,
    finalUrl: url,
    status: 0,
    redirects,
    fetchError,
    contentType: null,
    isHtml: false,
    headers: NO_HEADERS,
    ttfbMs: null,
    totalMs: null,
    bytes: 0,
    depth: null,
    discoveredBy: 'seed',
    inSitemap: false,
    robotsAllowed: true,
    html: null,
  };
}

export interface FetchPageOptions {
  /** The site's hosts, so internal links and images resolve the way an audit's would. */
  hosts: string[];
  userAgent?: string;
  timeoutMs?: number;
}

/** One URL's page facts through the crawler's fetch and extractor, redirects included. */
export async function fetchPageFacts(url: string, options: FetchPageOptions): Promise<PageFacts> {
  const redirects: RedirectHop[] = [];
  let result: Awaited<ReturnType<typeof crawlFetch>>;
  try {
    result = await crawlFetch(url, {
      totalTimeoutMs: options.timeoutMs ?? 30_000,
      ...(options.userAgent ? { userAgent: options.userAgent } : {}),
    });
  } catch (error) {
    const kind = (error as { kind?: unknown } | null)?.kind;
    return failure(url, typeof kind === 'string' ? kind : 'connection');
  }

  for (const hop of result.redirects)
    redirects.push({ url: hop.url, status: hop.status, location: normalizeUrl(hop.location, hop.url) ?? hop.location });

  const isHtml = result.status >= 200 && result.status < 300 && /^(text\/html|application\/xhtml\+xml)\b/i.test(result.contentType ?? '');
  let html: HtmlFacts | null = null;
  if (isHtml) {
    try {
      html = extractHtml(result.text, { baseUrl: result.url, hosts: options.hosts });
    } catch {
      // A document the extractor cannot parse is not a fetch failure: the page answered, its facts
      // are simply unreadable, and the per-change check will say the value is missing.
      html = null;
    }
  }
  return {
    url,
    finalUrl: result.url,
    status: result.status,
    redirects,
    fetchError: null,
    contentType: result.contentType ?? null,
    isHtml,
    headers: {
      xRobotsTag: result.headers['x-robots-tag'] ?? null,
      contentLanguage: result.headers['content-language'] ?? null,
      strictTransportSecurity: result.headers['strict-transport-security'] ?? null,
      link: result.headers.link ?? null,
    },
    ttfbMs: Math.round(result.timings.ttfbMs),
    totalMs: Math.round(result.timings.totalMs),
    bytes: result.body.length,
    depth: null,
    discoveredBy: 'seed',
    inSitemap: false,
    robotsAllowed: true,
    html,
  };
}
