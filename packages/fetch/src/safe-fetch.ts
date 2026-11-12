import { lookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import { Readable, type Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Client } from 'undici';
import { isBlockedAddress, isIpAddress, isMetadataAddress, normalizeHostname } from './addresses';
import { SafeFetchError } from './errors';
import { checkUrl, type FetchAllowList, isAllowedPrivateHost } from './policy';

/** A mitm-able bot identity: the user agent the crawler advertises (security-and-privacy.md §2). */
export interface BotIdentity {
  /** Product token. Default `AgenticSEO`. */
  product?: string;
  /** Release version. Default `0.0.0`; production passes the build version. */
  version?: string;
  /** The install's public URL; the user agent then carries `(+<publicUrl>/bot)`. */
  publicUrl?: string;
}

export const DEFAULT_BOT_PRODUCT = 'AgenticSEO';
export const DEFAULT_BOT_VERSION = '0.0.0';

/**
 * The honest user agent: `AgenticSEO/<version> (+<publicUrl>/bot)`. Without a public URL it is
 * just `AgenticSEO/<version>`; production sets one so a site owner can find out what the bot is.
 */
export function buildUserAgent(identity: BotIdentity = {}): string {
  const product = identity.product?.trim() || DEFAULT_BOT_PRODUCT;
  const version = identity.version?.trim() || DEFAULT_BOT_VERSION;
  const publicUrl = identity.publicUrl?.trim().replace(/\/+$/, '');
  return publicUrl ? `${product}/${version} (+${publicUrl}/bot)` : `${product}/${version}`;
}

/** One address a name resolved to, pinned for the connection that follows. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Turn a host name into addresses. The guard calls it once per hop and connects to the address it
 * checked, so there is no second lookup a rebinding answer could exploit. Tests inject a fake.
 */
export type HostResolver = (hostname: string, options: { signal?: AbortSignal }) => Promise<ReadonlyArray<ResolvedAddress>>;

/** The system resolver: every address, in resolver order. */
export const systemResolver: HostResolver = async (hostname) => {
  const rows = await lookup(hostname, { all: true, verbatim: true });
  return rows.map((row) => ({ address: row.address, family: row.family === 6 ? 6 : 4 }));
};

/**
 * Credentials for one site, bound to the exact origins they belong to (security-and-privacy.md §4).
 * Scheme, host and port must all match, so a redirect to another origin — another port, another
 * host, or an https -> http downgrade — never receives them.
 */
export interface FetchCredentials {
  /** Exact origins (`https://example.com`, `https://example.com:8443`) these credentials belong to. */
  origins: ReadonlyArray<string>;
  /** Extra headers, e.g. a verified-bot token. */
  headers?: Record<string, string>;
  basicAuth?: { username: string; password: string };
  /** The `Cookie` header value. */
  cookies?: string;
}

/** One step of a redirect chain, as the crawler reports it (crawler-and-audits.md §2). */
export interface RedirectHop {
  url: string;
  status: number;
  location: string;
}

/** Timings for the last hop, and for the whole request including redirects and body. */
export interface FetchTimings {
  dnsMs: number;
  connectMs: number;
  ttfbMs: number;
  totalMs: number;
}

export interface FetchResult {
  /** The URL as asked for, before redirects. */
  requestUrl: string;
  /** The URL that served the response. */
  url: string;
  status: number;
  headers: Record<string, string>;
  contentType: string | undefined;
  /** The charset the body was decoded with. */
  charset: string;
  body: Buffer;
  text: string;
  /**
   * Whether the body hit its size limit. HTML is returned truncated so the crawler can still read
   * the head; other types fail with a `too_large` error instead.
   */
  truncated: boolean;
  redirects: RedirectHop[];
  timings: FetchTimings;
}

/** The size limits from security-and-privacy.md §1. */
export const MAX_HTML_BYTES = 10 * 1024 * 1024;
export const MAX_OTHER_BYTES = 2 * 1024 * 1024;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_REDIRECTS = 10;

export interface SafeFetchOptions {
  method?: string;
  /** Headers sent on every hop. Credentials belong in {@link SafeFetchOptions.credentials}. */
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Bot identity for the default user agent. */
  bot?: BotIdentity;
  /** Full user-agent override, for verified owned sites only. */
  userAgent?: string;
  allow?: FetchAllowList;
  credentials?: FetchCredentials | ReadonlyArray<FetchCredentials>;
  /** Overrides the per-type limit (10 MB HTML, 2 MB otherwise). */
  maxBytes?: number;
  /**
   * Return the bytes read before the limit instead of failing a non-HTML body with `too_large`.
   * robots.txt uses it to read Google's bounded prefix (the first part of the file) and ignore the
   * rest. {@link FetchResult.truncated} reports whether the limit was reached.
   */
  truncate?: boolean;
  maxRedirects?: number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  resolver?: HostResolver;
  signal?: AbortSignal;
  /**
   * Extra CA certificate(s) to trust for the handshake. Test-only: production uses the system store,
   * and certificate verification is never disabled.
   */
  ca?: string | Buffer | Array<string | Buffer>;
}

const DEFAULT_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const HTML_CONTENT_TYPE = /^(text\/html|application\/xhtml\+xml)\b/i;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const DNS_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA', 'EAI_NONAME', 'ENODATA', 'ESERVFAIL']);
const TIMEOUT_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const TLS_ERROR_MARKERS = ['CERT_', 'ERR_TLS_', 'ERR_SSL_', 'EPROTO', 'UNABLE_TO_'];
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ECONNABORTED',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_ABORTED',
]);

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object') {
    const nested = (cause as { code?: unknown }).code;
    if (typeof nested === 'string') return nested;
  }
  return '';
}

function errorName(error: unknown): string {
  return error && typeof error === 'object' ? String((error as { name?: unknown }).name ?? '') : '';
}

/** Maps anything a socket, TLS handshake, resolver or abort can throw onto a typed kind. */
function toFetchError(error: unknown, context: { url: string; timedOut: boolean; aborted: boolean }): SafeFetchError {
  if (error instanceof SafeFetchError) return error;
  const code = errorCode(error);
  const name = errorName(error);
  const message = error instanceof Error ? error.message : String(error);
  if (context.timedOut || TIMEOUT_ERROR_CODES.has(code) || name === 'TimeoutError' || name === 'AbortError') {
    if (context.aborted && !context.timedOut)
      return new SafeFetchError('aborted', 'the request was aborted', { url: context.url, cause: error });
    return new SafeFetchError('timeout', `the request timed out (${message})`, { url: context.url, cause: error });
  }
  if (DNS_ERROR_CODES.has(code))
    return new SafeFetchError('dns', `could not resolve ${context.url} (${code})`, { url: context.url, cause: error });
  if (TLS_ERROR_MARKERS.some((marker) => code.startsWith(marker)) || /certificate|TLS|SSL/i.test(message)) {
    return new SafeFetchError('tls', `the TLS handshake failed (${message})`, { url: context.url, cause: error });
  }
  if (CONNECTION_ERROR_CODES.has(code))
    return new SafeFetchError('connection', `the connection failed (${message})`, { url: context.url, cause: error });
  return new SafeFetchError('connection', `the request failed (${message})`, { url: context.url, cause: error });
}

/** Aborts a promise that a resolver cannot cancel itself (DNS has no abort signal). */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** The addresses a hop may connect to: a literal host is its own, a name is resolved once. */
async function resolveTarget(
  url: URL,
  host: string,
  resolver: HostResolver,
  allow: FetchAllowList,
  signal: AbortSignal,
): Promise<ReadonlyArray<ResolvedAddress>> {
  const allowPrivate = isAllowedPrivateHost(host, allow);
  let addresses: ReadonlyArray<ResolvedAddress>;
  if (isIpAddress(host)) {
    addresses = [{ address: normalizeHostname(host), family: isIP(normalizeHostname(host)) === 6 ? 6 : 4 }];
  } else {
    try {
      addresses = await withAbort(resolver(host, { signal }), signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SafeFetchError('dns', `could not resolve ${host}`, { url: url.href, cause: error });
    }
  }
  if (addresses.length === 0) throw new SafeFetchError('dns', `${host} did not resolve to an address`, { url: url.href });

  // Every address is checked, not just the one we connect to: a mixed public/private answer is a
  // rebinding attempt, not a lucky one.
  for (const { address } of addresses) {
    if (!isIpAddress(address))
      throw new SafeFetchError('dns', `${host} resolved to ${address}, which is not an address`, { url: url.href });
    if (isMetadataAddress(address)) {
      throw new SafeFetchError('blocked_address', `${host} resolves to ${address}, a cloud metadata address`, { url: url.href });
    }
    if (!allowPrivate && isBlockedAddress(address)) {
      throw new SafeFetchError('blocked_address', `${host} resolves to ${address}, a private, loopback or metadata address`, {
        url: url.href,
      });
    }
  }
  return addresses;
}

function flattenHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    flat[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return flat;
}

/**
 * Collects a body up to a byte limit. Once more than the limit arrives it keeps the prefix, flags
 * truncation and destroys itself, which makes `pipeline` tear the source (and its socket) down.
 * Every byte that reached the sink is kept, so a truncated HTML head is exact.
 */
class BodyCollector extends Writable {
  readonly chunks: Buffer[] = [];
  size = 0;
  truncated = false;
  readonly #limit: number;

  constructor(limit: number) {
    super();
    this.#limit = limit;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    const room = this.#limit - this.size;
    if (buffer.length > room) {
      if (room > 0) this.chunks.push(buffer.subarray(0, room));
      this.size = this.#limit;
      this.truncated = true;
      callback();
      this.destroy();
      return;
    }
    this.size += buffer.length;
    this.chunks.push(buffer);
    callback();
  }

  body(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** The decoder for one `Content-Encoding` value. */
function decoderFor(encoding: string, url: string): Transform {
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip();
    case 'deflate':
      return createInflate();
    case 'br':
      return createBrotliDecompress();
    default:
      // We advertise gzip, deflate and br. Returning the encoded bytes as if they were text would
      // hide the failure, so an encoding we cannot undo is a typed error.
      throw new SafeFetchError('unsupported_encoding', `content-encoding "${encoding}" is not supported`, { url });
  }
}

/**
 * The encodings to undo, in order: the last one applied is undone first, so `gzip, deflate` means
 * the body is `deflate(gzip(content))`. `identity` is a no-op; anything else is a typed error.
 */
const SUPPORTED_ENCODINGS = new Set(['gzip', 'x-gzip', 'deflate', 'br']);

function decodePlan(contentEncoding: string, url: string): string[] {
  const encodings = contentEncoding
    .split(',')
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding.length > 0 && encoding !== 'identity');
  for (const encoding of encodings) {
    if (!SUPPORTED_ENCODINGS.has(encoding)) {
      throw new SafeFetchError('unsupported_encoding', `content-encoding "${encoding}" is not supported`, { url });
    }
  }
  return encodings.reverse();
}

/**
 * Runs one decode stage over a bounded input and collects at most `limit` decoded bytes. A stage
 * that crosses the cap (or decodes a prefix already cut short by an earlier cap) still returns what
 * it produced; a corrupt stage that produced nothing is a real failure.
 */
async function runDecodeStage(
  input: Buffer,
  encoding: string,
  limit: number,
  inputTruncated: boolean,
  signal: AbortSignal,
  url: string,
): Promise<{ body: Buffer; truncated: boolean; error?: unknown }> {
  const collector = new BodyCollector(limit);
  const completion = pipeline([Readable.from([input]), decoderFor(encoding, url), collector], { signal });
  let error: unknown;
  try {
    await completion;
  } catch (caught) {
    error = caught;
  }
  if (error !== undefined && !collector.truncated && !inputTruncated) {
    return { body: Buffer.alloc(0), truncated: false, error };
  }
  return { body: collector.body(), truncated: collector.truncated || inputTruncated };
}

/** Whether a URL's origin is one of a credential entry's exact origins. */
function credentialsForOrigin(entry: FetchCredentials, url: URL): boolean {
  for (const origin of entry.origins) {
    try {
      if (new URL(origin).origin === url.origin) return true;
    } catch {
      // An origin that does not parse matches nothing: never fall back to a host-only match.
    }
  }
  return false;
}

/** Rejects a header that would override the request authority (and therefore the TLS identity). */
function assertNoAuthorityHeader(headers: Record<string, string> | undefined, url: string | undefined): void {
  for (const name of Object.keys(headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower === 'host' || lower === ':authority') {
      throw new SafeFetchError('blocked_header', `${name} cannot be set by the caller; the authority comes from the URL`, {
        url,
      });
    }
  }
}

/** The headers for one hop, with the bot identity and the credentials bound to this exact origin. */
function headersFor(
  url: URL,
  options: SafeFetchOptions,
  credentials: ReadonlyArray<FetchCredentials>,
  method: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    // The authority always comes from the URL, never from the caller's headers.
    host: url.host,
    'user-agent': options.userAgent ?? buildUserAgent(options.bot),
    accept: DEFAULT_ACCEPT,
    'accept-encoding': 'gzip, deflate, br',
    ...options.headers,
  };
  for (const entry of credentials) {
    if (!credentialsForOrigin(entry, url)) continue;
    if (entry.cookies) headers.cookie = headers.cookie ? `${headers.cookie}; ${entry.cookies}` : entry.cookies;
    if (entry.basicAuth) {
      const token = Buffer.from(`${entry.basicAuth.username}:${entry.basicAuth.password}`).toString('base64');
      headers.authorization = `Basic ${token}`;
    }
    Object.assign(headers, entry.headers);
  }
  if (method === 'GET' || method === 'HEAD') {
    for (const name of Object.keys(headers)) if (name.toLowerCase() === 'content-length') delete headers[name];
  }
  return headers;
}

interface HopOptions {
  url: URL;
  address: ResolvedAddress;
  method: string;
  headers: Record<string, string>;
  body?: string | Buffer;
  maxBytes?: number;
  truncate?: boolean;
  ca?: string | Buffer | Array<string | Buffer>;
  connectTimeoutMs: number;
  signal: AbortSignal;
}

interface HopResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
  connectMs: number;
  ttfbMs: number;
}

/** One request on one pinned connection. No redirect is followed here; the caller re-validates each hop. */
async function requestHop(hop: HopOptions): Promise<HopResult> {
  const pinned = {
    address: hop.address.address,
    family: hop.address.family,
  };
  // A lookup that answers from the checked address only: the socket cannot re-resolve the name.
  const lookupPinned = ((_hostname: string, lookupOptions: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (lookupOptions?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  }) as unknown as LookupFunction;

  // The TLS identity is the URL's host name, never the pinned address and never the Host header.
  // IP literals have no valid SNI name, so only a DNS name is passed as the server name.
  const hostname = normalizeHostname(hop.url.hostname);
  const servername = isIpAddress(hostname) ? undefined : hostname;
  const connect = {
    lookup: lookupPinned,
    rejectUnauthorized: true,
    ...(servername ? { servername } : {}),
    ...(hop.ca ? { ca: hop.ca } : {}),
  };

  const client = new Client(hop.url.origin, {
    connect,
    connectTimeout: hop.connectTimeoutMs,
    headersTimeout: 0,
    bodyTimeout: 0,
    pipelining: 1,
  });

  let connectMs = 0;
  const connectStarted = performance.now();
  client.on('connect', () => {
    if (connectMs === 0) connectMs = performance.now() - connectStarted;
  });

  try {
    const path = `${hop.url.pathname}${hop.url.search}`;
    const sentAt = performance.now();
    const response = await client.request({
      method: hop.method,
      path: path === '' ? '/' : path,
      headers: hop.headers,
      ...(hop.body !== undefined ? { body: hop.body } : {}),
      ...(servername ? { servername } : {}),
      signal: hop.signal,
    });
    const ttfbMs = performance.now() - sentAt;
    const headers = flattenHeaders(response.headers);
    const contentType = headers['content-type'];
    const isHtml = HTML_CONTENT_TYPE.test(contentType ?? '');
    const limit = hop.maxBytes ?? (isHtml ? MAX_HTML_BYTES : MAX_OTHER_BYTES);
    const plan = decodePlan(headers['content-encoding'] ?? '', hop.url.href);

    // 1. Read the wire body through `pipeline`, never `pipe`: an error, a reset or an abort is
    //    carried through the stream instead of leaving the caller waiting forever. Encoded bodies
    //    need a little room for the encoding's own overhead; the decoded stages enforce the limit.
    const wireLimit = plan.length > 0 ? Math.ceil(limit * 1.05) + 1024 : limit;
    const wire = new BodyCollector(wireLimit);
    const wireCompletion = pipeline(response.body, wire, { signal: hop.signal });
    let wireError: unknown;
    try {
      await wireCompletion;
    } catch (caught) {
      wireError = caught;
    }
    if (wireError !== undefined && !wire.truncated) throw wireError;

    // 2. Undo every encoding over a bounded input, keeping the prefix when a stage hits the cap.
    let body = wire.body();
    let truncated = wire.truncated;
    let inputTruncated = wire.truncated;
    for (const [index, encoding] of plan.entries()) {
      // An intermediate stage is still encoded, so it gets the same bounded overhead as the wire;
      // only the last stage (the decoded body) is held to the caller's limit.
      const stageLimit = index === plan.length - 1 ? limit : wireLimit;
      const stage = await runDecodeStage(body, encoding, stageLimit, inputTruncated, hop.signal, hop.url.href);
      if (stage.error !== undefined) throw stage.error;
      body = stage.body;
      truncated = truncated || stage.truncated;
      inputTruncated = stage.truncated;
    }

    if (truncated && !isHtml && !hop.truncate) {
      throw new SafeFetchError('too_large', `response exceeded ${limit} bytes and is ${contentType ?? 'not HTML'}`, { url: hop.url.href });
    }
    return { status: response.statusCode, headers, body, truncated, connectMs, ttfbMs };
  } finally {
    void client.destroy().catch(() => undefined);
  }
}

const CHARSET_FROM_CONTENT_TYPE = /charset\s*=\s*["']?([^"';\s]+)/i;
const CHARSET_FROM_META = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9._:-]+)/i;

function supportedEncoding(label: string): string | null {
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return null;
  }
}

/**
 * The charset to decode with: a byte-order mark first, then the `Content-Type` charset, then an
 * HTML `<meta charset>` in the first 2 KB, then UTF-8. The label is normalised to the encoding
 * name `TextDecoder` reports (`iso-8859-1` and `windows-1252` are the same encoding).
 */
export function detectCharset(contentType: string | undefined, body: Buffer): string {
  const head = body.subarray(0, 4);
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return 'utf-8';
  if (head[0] === 0xff && head[1] === 0xfe) return 'utf-16le';
  if (head[0] === 0xfe && head[1] === 0xff) return 'utf-16be';

  const fromHeader = contentType ? CHARSET_FROM_CONTENT_TYPE.exec(contentType)?.[1] : undefined;
  if (fromHeader) {
    const encoding = supportedEncoding(fromHeader);
    if (encoding) return encoding;
  }
  const fromMeta = CHARSET_FROM_META.exec(body.subarray(0, 2048).toString('latin1'))?.[1];
  if (fromMeta) {
    const encoding = supportedEncoding(fromMeta);
    if (encoding) return encoding;
  }
  return 'utf-8';
}

/** Decodes a body with its detected charset, replacing invalid sequences rather than throwing. */
export function decodeBody(body: Buffer, contentType: string | undefined): { text: string; charset: string } {
  const charset = detectCharset(contentType, body);
  try {
    return { text: new TextDecoder(charset).decode(body), charset };
  } catch {
    return { text: new TextDecoder('utf-8').decode(body), charset: 'utf-8' };
  }
}

/**
 * Fetch a URL through the SSRF guard (security-and-privacy.md §1): resolve the name, check every
 * address, connect to the checked address only, and re-check every redirect hop (at most ten).
 *
 * The body is streamed with a decoded-byte cap. HTML that crosses it comes back `truncated` so the
 * crawler can still read the head; anything else fails with `too_large`.
 */
export async function safeFetch(target: string | URL, options: SafeFetchOptions = {}): Promise<FetchResult> {
  const startedAt = performance.now();
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const resolver = options.resolver ?? systemResolver;
  const allow = options.allow ?? {};
  const credentialList = options.credentials
    ? Array.isArray(options.credentials)
      ? options.credentials
      : [options.credentials as FetchCredentials]
    : [];

  // The authority always comes from the URL. A Host header would change the TLS server name (and
  // therefore which certificate is accepted), so it is refused rather than silently ignored.
  assertNoAuthorityHeader(options.headers, typeof target === 'string' ? target : target.href);
  for (const entry of credentialList) assertNoAuthorityHeader(entry.headers, undefined);

  let requestUrl: string;
  let current: URL;
  try {
    current = new URL(target instanceof URL ? target.href : target);
    requestUrl = current.href;
  } catch (error) {
    throw new SafeFetchError('invalid_url', `${String(target)} is not a valid URL`, { cause: error });
  }

  const controller = new AbortController();
  let timedOut = false;
  let aborted = false;
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const timer =
    totalTimeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          abort(new Error(`timed out after ${totalTimeoutMs} ms`));
        }, totalTimeoutMs)
      : undefined;
  timer?.unref();
  const forwardAbort = () => {
    aborted = true;
    abort(options.signal?.reason);
  };
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener('abort', forwardAbort, { once: true });

  let method = (options.method ?? 'GET').toUpperCase();
  let body = options.body;
  const redirects: RedirectHop[] = [];

  try {
    for (;;) {
      const blocked = checkUrl(current, allow);
      if (blocked) throw new SafeFetchError(blocked.kind, blocked.message, { url: current.href });
      if (controller.signal.aborted) throw toFetchError(controller.signal.reason, { url: current.href, timedOut, aborted });

      const host = normalizeHostname(current.hostname);
      const dnsStarted = performance.now();
      const addresses = await resolveTarget(current, host, resolver, allow, controller.signal);
      const dnsMs = performance.now() - dnsStarted;
      const address = addresses[0]!;

      let hop: HopResult;
      try {
        hop = await requestHop({
          url: current,
          address,
          method,
          headers: headersFor(current, options, credentialList, method),
          body,
          maxBytes: options.maxBytes,
          truncate: options.truncate,
          ca: options.ca,
          connectTimeoutMs,
          signal: controller.signal,
        });
      } catch (error) {
        throw toFetchError(error, { url: current.href, timedOut, aborted });
      }

      const location = hop.headers.location;
      if (location && REDIRECT_STATUS.has(hop.status)) {
        redirects.push({ url: current.href, status: hop.status, location });
        if (redirects.length > maxRedirects) {
          throw new SafeFetchError('too_many_redirects', `more than ${maxRedirects} redirects from ${requestUrl}`, { url: current.href });
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch (error) {
          throw new SafeFetchError('invalid_url', `${location} is not a valid redirect target`, { url: current.href, cause: error });
        }
        if (hop.status === 303 || ((hop.status === 301 || hop.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        current = next;
        continue;
      }

      const contentType = hop.headers['content-type'];
      const { text, charset } = decodeBody(hop.body, contentType);
      return {
        requestUrl,
        url: current.href,
        status: hop.status,
        headers: hop.headers,
        contentType,
        charset,
        body: hop.body,
        text,
        truncated: hop.truncated,
        redirects,
        timings: {
          dnsMs: Math.round(dnsMs * 1000) / 1000,
          connectMs: Math.round(hop.connectMs * 1000) / 1000,
          ttfbMs: Math.round(hop.ttfbMs * 1000) / 1000,
          totalMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
        },
      };
    }
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}
