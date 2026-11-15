import type { RobotsTxtFacts } from './facts';

// The evidence about a site's robots.txt that `SiteFacts.robotsTxt` carries (facts.ts). The policy
// itself comes from `@agentic-seo/fetch`'s `Robots`; this reader only records what the file says,
// including the lines a strict parser cannot use, so crawlability checks can explain a blocked page.

/** The most of a robots.txt file kept as evidence (facts.ts `RobotsTxtFacts.body`). */
export const ROBOTS_EVIDENCE_MAX_BYTES = 512 * 1024;

/** Fields a robots.txt line may start with; anything else is recorded as a parse error. */
const KNOWN_FIELDS = new Set(['user-agent', 'allow', 'disallow', 'sitemap', 'crawl-delay', 'host', 'request-rate', 'visit-time']);

interface RobotsGroup {
  agents: string[];
  rules: { allow: boolean; value: string }[];
}

export interface RobotsParseResult {
  groups: RobotsGroup[];
  sitemaps: string[];
  /** 1-based line number and the text that could not be read. */
  parseErrors: { line: number; text: string }[];
}

/** Parses a robots.txt body into groups, sitemaps and the lines a parser could not use. */
export function parseRobotsTxt(body: string): RobotsParseResult {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  const parseErrors: { line: number; text: string }[] = [];
  let current: RobotsGroup | null = null;
  // A user-agent line after a rule starts a new group; consecutive user-agent lines share one.
  let lastWasAgent = false;

  const lines = body.split(/\r\n|\n|\r/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator === -1) {
      parseErrors.push({ line: index + 1, text: raw.trim().slice(0, 200) });
      continue;
    }
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!KNOWN_FIELDS.has(field)) {
      parseErrors.push({ line: index + 1, text: raw.trim().slice(0, 200) });
      continue;
    }
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (!current) {
      // A rule before any user-agent names no group; RFC 9309 ignores it, so it is a parse error.
      parseErrors.push({ line: index + 1, text: raw.trim().slice(0, 200) });
      continue;
    }
    if (field === 'allow' || field === 'disallow') current.rules.push({ allow: field === 'allow', value });
  }

  return { groups, sitemaps, parseErrors };
}

/**
 * Whether a group disallows the site root outright: a `Disallow: /` with no `Allow: /` that would
 * re-open it. That is what "this crawler may not crawl the site" looks like in practice.
 */
function disallowsRoot(group: RobotsGroup): boolean {
  const disallowRoot = group.rules.some((rule) => !rule.allow && rule.value === '/');
  const allowRoot = group.rules.some((rule) => rule.allow && (rule.value === '/' || rule.value === ''));
  return disallowRoot && !allowRoot;
}

/**
 * The `RobotsTxtFacts` for one audit: what the file said, whether it could be read, and the user
 * agents for which the whole site is disallowed.
 */
export function robotsTxtFacts(options: { url: string; status: number; fetchError: string | null; body: string }): RobotsTxtFacts {
  const { groups, sitemaps, parseErrors } = parseRobotsTxt(options.body);
  const origin = new URL(options.url).origin;
  const disallowAllFor: string[] = [];
  for (const group of groups) {
    if (!disallowsRoot(group)) continue;
    for (const agent of group.agents) if (!disallowAllFor.includes(agent)) disallowAllFor.push(agent);
  }
  return {
    url: options.url,
    status: options.status,
    fetchError: options.fetchError,
    parseErrors,
    sitemaps: sitemaps.map((entry) => {
      try {
        return new URL(entry, origin).href;
      } catch {
        return entry;
      }
    }),
    disallowAllFor,
    body: options.body.slice(0, ROBOTS_EVIDENCE_MAX_BYTES),
  };
}
