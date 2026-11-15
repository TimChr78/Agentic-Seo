import type { HtmlFacts, PageFacts } from '@agentic-seo/crawl';
import { isSameUrl } from './url';

// Whether a URL can appear in Google's index on its own (crawler-and-audits.md §5 "Indexability").
//
// A URL is indexable when it answered 2xx with an HTML body, robots.txt allows it, neither the meta
// robots tag nor an applicable X-Robots-Tag header says noindex, and its canonical is absent or
// points at itself. Checks use this as a gate, and the site audit uses the reasons to explain why a
// sitemap URL is not indexable.

export interface Indexability {
  indexable: boolean;
  /** Every signal that keeps the page out of the index, in the order they were found. */
  reasons: string[];
}

/** One directive from an X-Robots-Tag header, with the user agent it is scoped to (null: all). */
export interface ScopedRobotDirective {
  userAgent: string | null;
  directive: string;
}

const AGENT_PATTERN = /^(?:\*|[a-z][a-z0-9_-]*)$/;
const NOINDEX = new Set(['noindex', 'none']);

function looksLikeUserAgent(value: string): boolean {
  const agent = value.toLowerCase();
  return (
    AGENT_PATTERN.test(agent) &&
    (agent === '*' || agent.includes('bot') || agent.includes('google') || agent.includes('agenticseo') || agent.includes('spider'))
  );
}

/**
 * Parses `X-Robots-Tag` into directives, including the user-agent-scoped form Google documents
 * (`googlebot: noindex`). A directive without a scope applies to every crawler.
 */
export function xRobotsDirectives(header: string | null): ScopedRobotDirective[] {
  if (!header) return [];
  const out: ScopedRobotDirective[] = [];
  let currentAgent: string | null = null;
  for (const raw of header.split(',')) {
    const segment = raw.trim();
    if (!segment) continue;
    const colon = segment.indexOf(':');
    let rest = segment;
    if (colon > 0) {
      const prefix = segment.slice(0, colon).trim();
      if (looksLikeUserAgent(prefix)) {
        currentAgent = prefix.toLowerCase();
        rest = segment.slice(colon + 1).trim();
      } else {
        currentAgent = null;
      }
    }
    for (const token of rest.split(/[\s;]+/)) {
      const directive = token.trim().toLowerCase();
      if (directive) out.push({ userAgent: currentAgent, directive });
    }
  }
  return out;
}

/** Whether an X-Robots-Tag header contains an effective noindex for Googlebot or every crawler. */
export function xRobotsNoindex(header: string | null): boolean {
  return xRobotsDirectives(header).some(
    ({ userAgent, directive }) =>
      NOINDEX.has(directive) &&
      (userAgent === null || userAgent === '*' || userAgent.includes('googlebot') || userAgent.includes('agenticseo')),
  );
}

/** Whether the meta robots tokens contain noindex (or `none`, which means noindex, nofollow). */
export function metaRobotsNoindex(tokens: readonly string[]): boolean {
  return tokens.some((token) => NOINDEX.has(token.trim().toLowerCase()));
}

/** Every robots signal that says noindex, for evidence. */
export function noindexSources(page: PageFacts): { source: 'meta_robots' | 'x_robots_tag'; value: string }[] {
  const sources: { source: 'meta_robots' | 'x_robots_tag'; value: string }[] = [];
  if (page.html && metaRobotsNoindex(page.html.metaRobots)) sources.push({ source: 'meta_robots', value: page.html.metaRobots.join(', ') });
  if (xRobotsNoindex(page.headers.xRobotsTag)) sources.push({ source: 'x_robots_tag', value: page.headers.xRobotsTag ?? '' });
  return sources;
}

/** The canonical the page declares for itself, or null when it declares none. */
export function declaredCanonical(html: HtmlFacts | null): string | null {
  return html?.canonical ?? null;
}

/** The reasons this page is not indexable; empty means it is. */
export function indexability(page: PageFacts): Indexability {
  const reasons: string[] = [];
  if (!page.robotsAllowed) reasons.push('robots.txt disallows this URL for the crawler.');
  if (page.fetchError) reasons.push(`The fetch failed (${page.fetchError}).`);
  if (page.status < 200 || page.status >= 300)
    reasons.push(`The response status is ${page.status === 0 ? 'not available' : page.status}, not 2xx.`);
  if (!page.isHtml || !page.html) {
    reasons.push('The response is not an HTML document.');
    return { indexable: false, reasons };
  }
  if (metaRobotsNoindex(page.html.metaRobots)) reasons.push('The meta robots tag contains noindex.');
  if (xRobotsNoindex(page.headers.xRobotsTag)) reasons.push('The X-Robots-Tag header contains noindex.');
  const canonical = declaredCanonical(page.html);
  if (canonical !== null && !isSameUrl(canonical, page.finalUrl)) reasons.push(`The canonical points at ${canonical}, not at this URL.`);
  return { indexable: reasons.length === 0, reasons };
}

/** A cheap gate for checks that only make sense on a 2xx HTML response. */
export function isOkHtml(page: PageFacts): boolean {
  return page.isHtml && page.html !== null && page.status >= 200 && page.status < 300;
}

/** A cheap gate for checks that only make sense on an indexable page. */
export function isIndexablePage(page: PageFacts): boolean {
  return indexability(page).indexable;
}
