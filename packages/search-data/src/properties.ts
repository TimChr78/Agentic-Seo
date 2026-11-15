// Which Search Console property belongs to a site? Google lists properties as either a domain
// property (`sc-domain:example.com`, which covers every subdomain and both schemes) or a URL-prefix
// property (`https://example.com/blog/`, which is exact about scheme, host and path). The site has a
// primary domain and extra hosts, so a property matches when its host is one of them; a URL prefix
// that is deeper than the site is still usable and is reported as a narrower match.

export type PropertyKind = 'domain' | 'urlPrefix' | 'unknown';

export interface ParsedProperty {
  kind: PropertyKind;
  /** The domain for a domain property, the host for a URL prefix. Lower-case. */
  host: string;
  /** The path of a URL-prefix property, always ending in "/" ("" for a domain property). */
  path: string;
}

export interface SiteHosts {
  domain: string;
  hosts?: string[];
}

export function parseProperty(property: string): ParsedProperty {
  if (property.startsWith('sc-domain:')) {
    return { kind: 'domain', host: property.slice('sc-domain:'.length).trim().toLowerCase(), path: '' };
  }
  try {
    const url = new URL(property);
    return { kind: 'urlPrefix', host: url.host.toLowerCase(), path: url.pathname || '/' };
  } catch {
    return { kind: 'unknown', host: property.trim().toLowerCase(), path: '' };
  }
}

const siteHosts = (site: SiteHosts): string[] => [...new Set([site.domain, ...(site.hosts ?? [])].map((h) => h.toLowerCase()))];

/** Whether the property covers, or lies under, one of the site's hosts. */
export function propertyMatchesSite(property: string, site: SiteHosts): boolean {
  const parsed = parseProperty(property);
  if (parsed.kind === 'unknown' || !parsed.host) return false;
  const hosts = siteHosts(site);
  if (parsed.kind === 'urlPrefix') return hosts.includes(parsed.host);
  // A domain property covers its own domain and every subdomain.
  return hosts.some((host) => host === parsed.host || host.endsWith(`.${parsed.host}`));
}

/** The property the site would use by default, or null when none of them names its host. */
export function suggestProperty(properties: string[], site: SiteHosts): string | null {
  const matches = properties.filter((property) => propertyMatchesSite(property, site));
  if (!matches.length) return null;
  const parsed = matches.map((property) => ({ property, ...parseProperty(property) }));
  const primary = site.domain.toLowerCase();
  const hosts = siteHosts(site);
  // 1. The primary domain as a domain property, 2. any of the site's hosts as a domain property,
  // 3. the primary domain at the root as a URL prefix, 4. any other matching property.
  const order = [
    (p: (typeof parsed)[number]) => p.kind === 'domain' && p.host === primary,
    (p: (typeof parsed)[number]) => p.kind === 'domain' && hosts.includes(p.host),
    (p: (typeof parsed)[number]) => p.kind === 'urlPrefix' && p.host === primary && p.path === '/',
    () => true,
  ];
  for (const rule of order) {
    const found = parsed.find(rule);
    if (found) return found.property;
  }
  return null;
}
