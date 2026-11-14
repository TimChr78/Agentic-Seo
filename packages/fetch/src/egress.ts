import { lookup } from 'node:dns/promises';
import { isBlockedAddress, isInternalHostname, isIpAddress, normalizeHostname } from './addresses';

// Outbound HTTP for a configured API endpoint (the LLM gateway's BYOK base URL), guarded against
// SSRF (security-and-privacy.md §1). A workspace cannot point a provider at `postgres`, the Docker
// bridge or a cloud metadata address: the URL is checked when it is saved and checked again when
// it is used, after DNS resolution, so a name cannot quietly point inside.
//
// The pure check ({@link checkEgressUrl}) runs inside the command transaction and never does I/O.
// {@link egressFetch} is the `fetch` the AI SDK adapters get: it resolves the name, refuses every
// private address it gets back, refuses redirects, and then hands the request to the normal fetch.

/** The only port an API endpoint may use: https, so a key never travels in clear text. */
export const EGRESS_PORT = 443;

/** A blocked target, with a message written for a person configuring a provider. */
export class EgressError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EgressError';
  }
}

/**
 * Whether a configured endpoint URL is acceptable, or why it is not. Pure: no DNS, no socket, so a
 * command may call it inside its transaction. It catches the obvious mistake (a literal address, a
 * LAN name, plain http); {@link resolveEgressHost} is what a name has to pass before it is reached.
 */
export function checkEgressUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a valid URL';
  }
  if (url.protocol !== 'https:') return 'only https URLs are allowed';
  if (url.username || url.password) return 'credentials in the URL are not allowed; the API key is stored separately';
  if (url.port !== '' && Number(url.port) !== EGRESS_PORT) return `port ${url.port} is not allowed; an API endpoint uses ${EGRESS_PORT}`;
  const host = normalizeHostname(url.hostname);
  if (!host) return 'the URL has no host';
  if (isInternalHostname(host)) return `${host} is an internal host name`;
  if (isIpAddress(host) && isBlockedAddress(host)) return `${host} is a private, loopback or metadata address`;
  return null;
}

/** {@link checkEgressUrl} as a value: the URL, or a thrown {@link EgressError}. */
export function assertEgressUrl(raw: string): URL {
  const problem = checkEgressUrl(raw);
  if (problem) throw new EgressError(problem);
  return new URL(raw);
}

/** How a host name is turned into addresses; injectable so a test never touches DNS. */
export type EgressResolver = (host: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

const systemResolver: EgressResolver = (host) => lookup(host, { all: true, verbatim: true });

/**
 * Resolves the URL's host and refuses it unless every address it answers with is public: a mixed
 * public/private answer is a rebinding attempt, not a lucky one. An address literal is checked
 * directly. Throws {@link EgressError} on a blocked or unresolvable target.
 */
export async function resolveEgressHost(url: URL, resolve: EgressResolver = systemResolver): Promise<void> {
  const host = normalizeHostname(url.hostname);
  if (isIpAddress(host)) {
    if (isBlockedAddress(host)) throw new EgressError(`${host} is a private, loopback or metadata address`);
    return;
  }
  let addresses: ReadonlyArray<{ address: string; family: number }>;
  try {
    addresses = await resolve(host);
  } catch (err) {
    throw new EgressError(`could not resolve ${host}`, { cause: err });
  }
  if (!addresses.length) throw new EgressError(`${host} did not resolve to an address`);
  for (const { address } of addresses) {
    if (!isIpAddress(address)) throw new EgressError(`${host} resolved to ${address}, which is not an address`);
    if (isBlockedAddress(address)) throw new EgressError(`${host} resolves to ${address}, a private, loopback or metadata address`);
  }
}

/**
 * A `fetch` for calls to a configured API endpoint: the same signature the AI SDK providers take,
 * so a provider can be built with `fetch: egressFetch`. Every request is checked again (a provider
 * URL can be reached long after it was saved) and redirects are refused, so a 302 to an internal
 * address is not followed.
 *
 * It does not pin the socket to the address it checked: the platform `fetch` resolves the name a
 * second time, which theoretically leaves a rebinding window between the two lookups. The command
 * layer refuses a private target up front, and this guard refuses one at use; socket pinning (what
 * `safeFetch` does for crawls) is a follow-up if a workspace-managed provider ever needs it.
 */
export const egressFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const problem = checkEgressUrl(url.href);
  if (problem) throw new EgressError(problem);
  await resolveEgressHost(url);
  return fetch(new Request(request, { redirect: 'error' }));
};
