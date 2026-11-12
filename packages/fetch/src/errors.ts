/**
 * Why a guarded fetch failed. Callers branch on the kind rather than on a message, and the
 * crawler stores it with the page so an audit can explain a failure.
 */
export type FetchErrorKind =
  /** A literal address, or a name resolving to one, that is not allowed (loopback, LAN, metadata, …). */
  | 'blocked_address'
  /** A scheme other than http(s). */
  | 'blocked_scheme'
  /** A port other than 80/443 that the site has not allowed. */
  | 'blocked_port'
  /** Userinfo in the URL; credentials come from secrets and scoped headers instead. */
  | 'blocked_credentials'
  /** A caller-supplied `Host` or `:authority` header, which would change the TLS identity. */
  | 'blocked_header'
  /** A `Content-Encoding` we cannot decode, so the body cannot be read as text. */
  | 'unsupported_encoding'
  /** The URL, or the location of a redirect, does not parse. */
  | 'invalid_url'
  /** The name did not resolve, or the resolver returned no usable address. */
  | 'dns'
  /** The connect deadline, the total deadline or the OS gave up on the connection. */
  | 'timeout'
  /** More than ten redirect hops. */
  | 'too_many_redirects'
  /** The TLS handshake or certificate verification failed. */
  | 'tls'
  /** A refused, reset or otherwise failed connection, or a malformed response. */
  | 'connection'
  /** The body crossed its size limit and is not HTML, so there is nothing safe to return. */
  | 'too_large'
  /** The caller aborted the request. */
  | 'aborted';

export interface SafeFetchErrorOptions {
  url?: string;
  cause?: unknown;
}

/** A guarded fetch failure with a machine-readable {@link FetchErrorKind}. */
export class SafeFetchError extends Error {
  readonly kind: FetchErrorKind;
  readonly url: string | undefined;

  constructor(kind: FetchErrorKind, message: string, options: SafeFetchErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SafeFetchError';
    this.kind = kind;
    this.url = options.url;
  }
}

/** Whether an error is a guarded fetch failure (and narrows it). */
export function isSafeFetchError(error: unknown): error is SafeFetchError {
  return error instanceof SafeFetchError;
}
