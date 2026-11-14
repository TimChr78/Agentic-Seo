import {
  effectivePort,
  isAllowedPort,
  isBlockedAddress,
  isInternalHostname,
  isIpAddress,
  isMetadataAddress,
  normalizeHostname,
} from './addresses';
import type { FetchErrorKind } from './errors';

/**
 * What a site may reach beyond the public internet (security-and-privacy.md §1). Set by an admin
 * on the site's settings, never by a crawl itself.
 *
 * The cloud metadata endpoints (`169.254.169.254`, `fd00:ec2::254`) are not covered: they stay
 * blocked even for an allow-listed host, because a metadata page is never somebody's site.
 */
export interface FetchAllowList {
  /**
   * Exact host names that may resolve to a private address: a homelab site, a staging host on the
   * LAN. Case-insensitive; no wildcards and no CIDR ranges, so an entry cannot quietly widen.
   */
  privateHosts?: ReadonlyArray<string>;
  /** Ports reachable in addition to 80 and 443. */
  ports?: ReadonlyArray<number>;
}

export interface UrlBlock {
  kind: FetchErrorKind;
  message: string;
}

/** Whether a host is on the allow-list (exact match after normalising case, brackets and root dot). */
export function isAllowedPrivateHost(host: string, allow: FetchAllowList = {}): boolean {
  const name = normalizeHostname(host);
  if (!name) return false;
  return (allow.privateHosts ?? []).some((entry) => normalizeHostname(entry) === name);
}

/**
 * A check that needs no network access: scheme, embedded credentials, literal private addresses,
 * internal host names and port. Used before the first socket and exported for settings forms,
 * which show the same reason the crawler would fail with.
 *
 * A name is only checked here; {@link safeFetch} also resolves it and checks every address.
 */
export function checkUrl(target: string | URL, allow: FetchAllowList = {}): UrlBlock | null {
  let url: URL;
  if (target instanceof URL) {
    url = target;
  } else {
    try {
      url = new URL(target);
    } catch {
      return { kind: 'invalid_url', message: `${target} is not a valid URL` };
    }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'blocked_scheme', message: `${url.protocol} URLs cannot be fetched; only http and https` };
  }
  if (url.username || url.password) {
    return { kind: 'blocked_credentials', message: 'credentials in the URL are not sent; store them as site credentials or headers' };
  }
  const host = normalizeHostname(url.hostname);
  if (!host) return { kind: 'invalid_url', message: `${url.href} has no host` };

  if (isIpAddress(host) && isMetadataAddress(host)) {
    return { kind: 'blocked_address', message: `${host} is a cloud metadata address and is never fetched` };
  }
  if (!isAllowedPrivateHost(host, allow)) {
    if (isIpAddress(host) && isBlockedAddress(host)) {
      return { kind: 'blocked_address', message: `${host} is a private, loopback or metadata address; allow it for the site first` };
    }
    if (!isIpAddress(host) && isInternalHostname(host)) {
      return { kind: 'blocked_address', message: `${host} is an internal host name; allow it for the site first` };
    }
  }

  const port = effectivePort(url);
  if (!isAllowedPort(port, allow.ports ?? [])) {
    return { kind: 'blocked_port', message: `port ${port} is not allowed; sites may only fetch 80 and 443 unless a port is allowed` };
  }
  return null;
}
