import { lookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { isBlockedAddress, isInternalHostname, isIpAddress, normalizeHostname } from './addresses';

// Outbound HTTP for a configured API endpoint (the LLM gateway's BYOK base URL), guarded against
// SSRF (security-and-privacy.md §1). A workspace cannot point a provider at `postgres`, the Docker
// bridge or a cloud metadata address: the URL is checked when it is saved and checked again when
// it is used, after DNS resolution, so a name cannot quietly point inside.
//
// The pure check ({@link checkEgressUrl}) runs inside the command transaction and never does I/O.
// {@link egressFetch} is the `fetch` the AI SDK adapters get: it resolves the name, refuses every
// private address it gets back, refuses redirects, and connects to the address it checked — the
// socket never resolves the name again, so a rebinding answer has no second lookup to win.

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
 * LAN name, plain http); {@link resolveEgressAddresses} is what a name has to pass before it is
 * reached.
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

/** One address a name resolved to, checked and pinned for the connection that follows. */
export interface EgressAddress {
  address: string;
  family: 4 | 6;
}

/** How a host name is turned into addresses; injectable so a test never touches DNS. */
export type EgressResolver = (host: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

const systemResolver: EgressResolver = (host) => lookup(host, { all: true, verbatim: true });

/**
 * Resolves the URL's host and refuses it unless every address it answers with is public: a mixed
 * public/private answer is a rebinding attempt, not a lucky one. An address literal is checked
 * directly. Returns the checked addresses; {@link egressFetch} connects to the first of them and to
 * nothing else. Throws {@link EgressError} on a blocked or unresolvable target.
 */
export async function resolveEgressAddresses(url: URL, resolve: EgressResolver = systemResolver): Promise<ReadonlyArray<EgressAddress>> {
  const host = normalizeHostname(url.hostname);
  if (isIpAddress(host)) {
    if (isBlockedAddress(host)) throw new EgressError(`${host} is a private, loopback or metadata address`);
    return [{ address: host, family: isIP(host) === 6 ? 6 : 4 }];
  }
  let addresses: ReadonlyArray<{ address: string; family: number }>;
  try {
    addresses = await resolve(host);
  } catch (err) {
    throw new EgressError(`could not resolve ${host}`, { cause: err });
  }
  if (!addresses.length) throw new EgressError(`${host} did not resolve to an address`);
  const checked: EgressAddress[] = [];
  for (const { address } of addresses) {
    if (!isIpAddress(address)) throw new EgressError(`${host} resolved to ${address}, which is not an address`);
    if (isBlockedAddress(address)) throw new EgressError(`${host} resolves to ${address}, a private, loopback or metadata address`);
    checked.push({ address, family: isIP(address) === 6 ? 6 : 4 });
  }
  return checked;
}

/**
 * {@link resolveEgressAddresses} as a check: resolves and refuses a blocked target, and returns
 * nothing. Kept for callers that only need the verdict.
 */
export async function resolveEgressHost(url: URL, resolve: EgressResolver = systemResolver): Promise<void> {
  await resolveEgressAddresses(url, resolve);
}

/**
 * The look-up a socket gets: it answers from the addresses that were checked, so the connection
 * cannot resolve the name a second time. A name that answers public for the check and internal for
 * the connection (DNS rebinding) therefore never gets a socket to the internal address. All checked
 * addresses are offered, in the resolver's order, so the socket can fall back from an unreachable
 * one (an IPv6 answer on an IPv4-only network) to the next; that fallback happens while connecting,
 * before any request byte is sent, so a POST is never replayed.
 */
export function pinnedLookup(addresses: EgressAddress | readonly EgressAddress[]): LookupFunction {
  const list = (Array.isArray(addresses) ? addresses : [addresses]).map((a) => ({ address: a.address, family: a.family }));
  if (!list.length) throw new EgressError('No checked address to connect to');
  return ((_hostname: string, lookupOptions: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (lookupOptions?.all) callback(null, list);
    else callback(null, list[0]!.address, list[0]!.family);
  }) as unknown as LookupFunction;
}

export interface PinnedDispatcherOptions {
  /**
   * Extra CA certificate(s) to trust for the handshake. Test-only, as in `safeFetch`: production
   * uses the system store, and certificate verification is never disabled.
   */
  ca?: string | Buffer | Array<string | Buffer>;
}

/** The largest number of pinned agents kept alive; each one is a socket pool for one endpoint. */
const MAX_DISPATCHERS = 32;
const dispatchers = new Map<string, Agent>();

/**
 * An agent whose socket connects to `address` only, while the TLS handshake is still verified
 * against the URL's host name: the certificate must match the name the provider was configured
 * with, never the address the name happened to resolve to. This is the same pinning `safeFetch`
 * uses for crawls (a `connect.lookup` that answers from the checked address plus `servername`).
 */
export function pinnedDispatcher(url: URL, addresses: EgressAddress | readonly EgressAddress[], opts: PinnedDispatcherOptions = {}): Agent {
  const list: readonly EgressAddress[] = Array.isArray(addresses) ? addresses : [addresses as EgressAddress];
  const hostname = normalizeHostname(url.hostname);
  // An address literal has no name to verify the certificate against, so it has no SNI name either.
  const servername = isIpAddress(hostname) ? undefined : hostname;
  const build = () =>
    new Agent({
      connect: {
        lookup: pinnedLookup(list),
        // Try every checked address in turn (Node's connection-level fallback), never a new look-up.
        autoSelectFamily: true,
        rejectUnauthorized: true,
        ...(servername ? { servername } : {}),
        ...(opts.ca ? { ca: opts.ca } : {}),
      },
      keepAliveTimeout: 30_000,
      connections: 4,
    });
  // A test-only trust store is never shared with a production agent for the same endpoint.
  if (opts.ca) return build();
  const key = `${url.origin} ${list.map((a) => `${a.address}/${a.family}`).join(',')}`;
  const cached = dispatchers.get(key);
  if (cached) return cached;
  const agent = build();
  dispatchers.set(key, agent);
  for (const [oldKey, old] of dispatchers) {
    if (dispatchers.size <= MAX_DISPATCHERS) break;
    dispatchers.delete(oldKey);
    void old.close().catch(() => undefined);
  }
  return agent;
}

/** Options for one guarded request; the resolver is a seam so a test never touches DNS. */
export interface EgressRequestOptions extends PinnedDispatcherOptions {
  resolve?: EgressResolver;
}

/**
 * One guarded request: the URL is checked, the name resolved once, every answer checked, and the
 * socket pinned to the checked address. Redirects are refused, so a 302 to an internal address is
 * not followed.
 */
export async function egressRequest(input: RequestInfo | URL, init?: RequestInit, opts: EgressRequestOptions = {}): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const problem = checkEgressUrl(url.href);
  if (problem) throw new EgressError(problem);
  const addresses = await resolveEgressAddresses(url, opts.resolve);
  // An unresolvable or empty answer was refused above; this only satisfies the type.
  if (!addresses.length) throw new EgressError(`${url.hostname} did not resolve to an address`);

  // undici's own fetch is paired with undici's own agent: the platform fetch rejects an agent built
  // by the `undici` package, because each bundle has its own dispatcher class.
  const response = await undiciFetch(url.href, {
    method: request.method,
    headers: [...request.headers],
    // Provider payloads are JSON, so the body is buffered: a streamed body would need `duplex`.
    ...(request.body === null ? {} : { body: await request.text() }),
    signal: request.signal,
    redirect: 'error',
    dispatcher: pinnedDispatcher(url, addresses, opts),
  });
  return response as unknown as Response;
}

/**
 * A `fetch` for calls to a configured API endpoint: the same signature the AI SDK providers take,
 * so a provider is built with `fetch: egressFetch`. Every request is checked again (a provider URL
 * can be reached long after it was saved), the name is resolved once, the socket connects only to
 * the address that was checked, and redirects are refused.
 */
export const egressFetch: typeof fetch = (input, init) => egressRequest(input, init);
