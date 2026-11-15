import type { Change } from '@agentic-seo/changes';
import { normalizedHost, normalizeUrl } from '@agentic-seo/crawl';

// A change belongs to the site it was drafted for (ADR-0007). The source mapping resolves a route by
// its path and deliberately ignores the origin (packages/changes/src/mapping.ts `pathOf`), so a
// change for https://unrelated.example/about/ would resolve through an `about/` rule, edit that
// repository file, apply it to this site's repository and verify a page nobody asked about. Every
// change URL is therefore bound to the site's own hosts before drafting, and the same check runs
// whenever a stored change set is revalidated (approval and the apply worker), so a row written
// around the commands is caught too.
//
// The site answers on HTTPS at its primary domain and its extra hosts, normalised the way the
// crawler stores a host. A redirect target is different: an absolute target on another host is a
// legitimate redirect, so only an on-site absolute target must use the site's own origin.

declare module '@agentic-seo/commands' {
  interface Services {
    /**
     * Test seam for the origin a site's host answers on: a fixture's port cannot be a domain, so a
     * test points this at its local site. Production passes neither and every host is `https://`.
     */
    siteUrlFor?: (host: string) => string;
  }
}

/** The site a change must stay on: its name (for the message), primary domain and extra hosts. */
export interface SiteHosts {
  name: string;
  primaryDomain: string;
  hosts: readonly string[];
}

/** The origin a host answers on; production uses HTTPS, a test seam may point at a fixture. */
export type SiteOriginFor = (host: string) => string;

/** The site's hosts, normalised like the crawler, primary domain first and without duplicates. */
export function siteHostList(site: SiteHosts): string[] {
  return [...new Set([site.primaryDomain, ...site.hosts].map(normalizedHost).filter((host) => host.length > 0))];
}

/** The normalised origins the site's pages may be on. */
function allowedOrigins(site: SiteHosts, originFor?: SiteOriginFor): Set<string> {
  const origins = new Set<string>();
  for (const host of siteHostList(site)) {
    const raw = originFor ? originFor(host) : `https://${host}`;
    const normalised = normalizeUrl(raw);
    if (normalised) origins.add(new URL(normalised).origin);
  }
  return origins;
}

/** The site's primary origin, as the messages name it. */
function primaryOrigin(site: SiteHosts, originFor?: SiteOriginFor): string {
  const host = siteHostList(site)[0] ?? site.primaryDomain;
  const normalised = normalizeUrl(originFor ? originFor(host) : `https://${host}`);
  return normalised ? new URL(normalised).origin : `https://${host}`;
}

/** `example.com`, `example.com and www.example.com`, or `a, b and c`. */
function hostsSentence(site: SiteHosts): string {
  const hosts = siteHostList(site);
  if (hosts.length <= 1) return hosts[0] ?? site.primaryDomain;
  return `${hosts.slice(0, -1).join(', ')} and ${hosts[hosts.length - 1]}`;
}

function offSiteMessage(value: string, site: SiteHosts, originFor?: SiteOriginFor): string {
  return `The change URL ${value} is not on site “${site.name}”, which answers on ${hostsSentence(site)}. Draft the change with the page’s URL on ${primaryOrigin(site, originFor)} instead.`;
}

/**
 * Why an absolute change URL cannot be this site's page, or null when it can. The URL must be an
 * absolute http(s) URL on one of the site's origins (HTTPS in production).
 */
function urlProblem(value: string, site: SiteHosts, originFor?: SiteOriginFor): string | null {
  const normalised = normalizeUrl(value);
  if (!normalised) {
    return `The change URL ${value} is not an absolute http(s) URL. Draft the change with the page’s full URL on ${primaryOrigin(site, originFor)}.`;
  }
  if (allowedOrigins(site, originFor).has(new URL(normalised).origin)) return null;
  return offSiteMessage(value, site, originFor);
}

/**
 * Why an absolute redirect target is wrong, or null. A path is on the site by construction, and an
 * absolute target on another host is a legitimate redirect, so it stays allowed; only a target that
 * names one of the site's hosts must use the site's own origin (HTTPS, not another port or scheme).
 */
function redirectTargetProblem(value: string, site: SiteHosts, originFor?: SiteOriginFor): string | null {
  if (value.startsWith('/')) return null;
  const normalised = normalizeUrl(value);
  if (!normalised) {
    return `The redirect target ${value} is not a path or an absolute http(s) URL. Give a path such as /new-page/ or a full URL.`;
  }
  const parsed = new URL(normalised);
  if (!siteHostList(site).includes(normalizedHost(parsed.hostname))) return null;
  if (allowedOrigins(site, originFor).has(parsed.origin)) return null;
  return `The redirect target ${value} is on this site, so it must use the site’s own origin. Give a path such as /new-page/ or ${primaryOrigin(site, originFor)}/new-page/.`;
}

/**
 * Why a change cannot be drafted for this site, or null when every URL in it is on the site.
 *
 * A non-redirect change names one absolute page URL. A redirect names a path (its source) and a
 * target, which may be a path or an absolute URL; an absolute target on one of the site's hosts must
 * use the site's origin, and an off-site target is left alone.
 */
export function changeHostProblem(change: Change, site: SiteHosts, originFor?: SiteOriginFor): string | null {
  if (change.type === 'redirect') {
    // The schema writes a path, but a stored row is still checked: resolveSource() takes a path.
    if (!change.from.startsWith('/')) {
      const from = urlProblem(change.from, site, originFor);
      if (from) return from;
    }
    if (change.to !== undefined) {
      const to = redirectTargetProblem(change.to, site, originFor);
      if (to) return to;
    }
    if (change.before?.to) {
      const before = redirectTargetProblem(change.before.to, site, originFor);
      if (before) return before;
    }
    return null;
  }
  return urlProblem(change.url, site, originFor);
}
