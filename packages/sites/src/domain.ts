import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { AppError } from '@agentic-seo/core';

// Domain normalisation for sites and competitors. A site is identified by its registrable domain,
// so the stored form is the one every provider and the crawler can use: lower-case ASCII (IDNA /
// punycode), no scheme, path, port, credentials or trailing dot.
//
// Phase 0 takes the domain a person typed instead of guessing it from a full URL: a pasted
// "https://example.com/page" is refused with a message that says what to enter, because silently
// stripping a path would accept a URL for a page as if it named the whole site.

/** Names that never resolve on the public internet, so ownership of them cannot be verified. */
const INTERNAL_NAMES = new Set(['localhost', 'localhost.localdomain', 'broadcasthost', 'local']);

/** Reserved or private suffixes. A public site owner can never publish a verification record here. */
const INTERNAL_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.intranet', '.home.arpa', '.arpa'] as const;

const IP_HINT = 'An IP address cannot be a site: enter the domain name, such as example.com.';
const DOMAIN_ONLY_HINT = 'Enter the domain only, such as example.com, not a full URL or a path.';

function invalid(message: string): AppError {
  return new AppError('invalid_input', message);
}

/** One DNS label: letters, digits and interior hyphens, never starting or ending with a hyphen. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The stored form of a domain. Throws `invalid_input` with an actionable message for anything that
 * is not a public domain name: a URL, a host with a port, an IP literal, or an internal name.
 */
export function normalizeDomain(raw: string): string {
  const text = raw.trim();
  if (!text) throw invalid('Enter the domain, such as example.com.');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) throw invalid(DOMAIN_ONLY_HINT);
  if (/\s/.test(text)) throw invalid('A domain cannot contain spaces.');
  if (/[/?#@]/.test(text)) throw invalid(DOMAIN_ONLY_HINT);
  if (text.includes(':') || text.includes('[') || text.includes(']'))
    throw invalid('Enter the domain without a port; a domain has no port or address brackets.');
  if (isIP(text)) throw invalid(IP_HINT);

  // A single trailing dot is the DNS root and means the same name; anything after it is a typo.
  const withoutRoot = text.replace(/\.+$/, '');
  if (!withoutRoot) throw invalid('Enter the domain, such as example.com.');

  // domainToASCII lower-cases ASCII and converts IDN labels to punycode; it returns an empty
  // string for input it cannot encode.
  const ascii = domainToASCII(withoutRoot.toLowerCase());
  if (!ascii) throw invalid(`${raw.trim()} is not a domain name. Enter the domain, such as example.com.`);
  if (isIP(ascii)) throw invalid(IP_HINT);
  if (ascii.length > 253) throw invalid('That domain is too long to be a host name.');
  if (INTERNAL_NAMES.has(ascii)) throw invalid(`${ascii} is an internal name, not a public site.`);

  const labels = ascii.split('.');
  if (labels.length < 2) throw invalid(`${ascii} is an internal name, not a public domain.`);
  for (const label of labels) {
    if (!LABEL.test(label)) throw invalid(`${ascii} is not a valid domain name: “${label}” is not a valid label.`);
  }
  // A numeric top-level label is an address (or an old-style dotted number), never a domain.
  if (/^\d+$/.test(labels[labels.length - 1]!)) throw invalid(IP_HINT);
  if (INTERNAL_SUFFIXES.some((suffix) => ascii.endsWith(suffix)))
    throw invalid(`${ascii} ends in a reserved or private suffix, so ownership cannot be verified.`);

  return ascii;
}

/** The extra hosts of a site share the normalisation rules; the command checks they belong to it. */
export function normalizeHost(raw: string): string {
  return normalizeDomain(raw);
}

/** Whether `host` is the domain itself or a subdomain of it (never a bare suffix match). */
export function isHostOfDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** The hosts a site answers on: its primary domain first, then the extras it was given. */
export function siteHosts(site: { primaryDomain: string; hosts: string[] }): string[] {
  return [site.primaryDomain, ...site.hosts.filter((host) => host !== site.primaryDomain)];
}
