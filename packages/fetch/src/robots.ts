import robotsParser from 'robots-parser';
import { SafeFetchError } from './errors';
import { type BotIdentity, buildUserAgent, DEFAULT_BOT_PRODUCT, type FetchResult, type SafeFetchOptions, safeFetch } from './safe-fetch';

/** One cached robots.txt. The raw file is cached, not a parser object, so Postgres can back it later. */
export interface RobotsRecord {
  /** Scheme, host and port, e.g. `https://example.com`. */
  origin: string;
  /** HTTP status, or 0 when the file could not be fetched at all. */
  status: number;
  /** The raw file, empty when it is unavailable or allows everything. */
  body: string;
  fetchedAt: number;
  expiresAt: number;
  /** Why a fetch failed, for the audit report. */
  error?: string;
}

/**
 * A robots.txt cache keyed by origin. The in-memory implementation is a bounded LRU; the crawler
 * in Phase 1 brings a Postgres-backed one so every replica shares the same rules.
 */
export interface RobotsCache {
  get(origin: string): Promise<RobotsRecord | undefined>;
  set(record: RobotsRecord): Promise<void>;
  /** Optional: forget one origin (a settings change, or a manual re-check). */
  delete?(origin: string): Promise<void>;
  /** Optional: forget everything. */
  clear?(): void | Promise<void>;
}

/** A bounded, insertion-ordered LRU. A hit moves the origin to the young end. */
export class MemoryRobotsCache implements RobotsCache {
  readonly #records = new Map<string, RobotsRecord>();

  constructor(private readonly maxEntries = 1_000) {
    if (maxEntries < 1) throw new RangeError('maxEntries must be at least 1');
  }

  get size(): number {
    return this.#records.size;
  }

  async get(origin: string): Promise<RobotsRecord | undefined> {
    const record = this.#records.get(origin);
    if (!record) return undefined;
    this.#records.delete(origin);
    this.#records.set(origin, record);
    return record;
  }

  async set(record: RobotsRecord): Promise<void> {
    this.#records.delete(record.origin);
    this.#records.set(record.origin, record);
    while (this.#records.size > this.maxEntries) {
      const oldest = this.#records.keys().next().value;
      if (oldest === undefined) break;
      this.#records.delete(oldest);
    }
  }

  clear(): void {
    this.#records.clear();
  }

  async delete(origin: string): Promise<void> {
    this.#records.delete(origin);
  }
}

/** The parsed rules for one origin, as the crawler needs them. */
export interface RobotsPolicy {
  origin: string;
  /** The robots.txt status the rules came from; 0 when it could not be fetched. */
  status: number;
  /** 5xx, 429 or unreachable: the whole host is temporarily disallowed (RFC 9309 §2.3.1.4). */
  unavailable: boolean;
  /** Sitemaps listed in the file, made absolute. */
  sitemaps: string[];
  crawlDelaySeconds: number | undefined;
  isAllowed(url: string, userAgent?: string): boolean;
}

export type RobotsFetch = (url: string, options?: SafeFetchOptions) => Promise<FetchResult>;

export interface RobotsOptions {
  /** Fetch used for robots.txt; defaults to {@link safeFetch}. A test injects its own. */
  fetch?: RobotsFetch;
  bot?: BotIdentity;
  /** The full user-agent string, for the request and for rule matching. */
  userAgent?: string;
  /** TTL of a readable robots.txt. Default six hours. */
  ttlMs?: number;
  /** TTL of an unavailable or failing robots.txt. Default five minutes, so a blip is retried soon. */
  unavailableTtlMs?: number;
  cache?: RobotsCache;
  /** Default 512 KiB; robots.txt is never allowed to cost a full page budget. */
  maxBytes?: number;
  /** Passed to every robots fetch: the site's private hosts, ports, resolver and credentials. */
  fetchOptions?: Omit<SafeFetchOptions, 'bot' | 'userAgent' | 'maxBytes' | 'signal'>;
  signal?: AbortSignal;
  now?: () => number;
}

/** The origin (`https://example.com:8443`) of a URL, for cache keys and sibling lookups. */
export function originOf(url: string | URL): string {
  return new URL(url instanceof URL ? url.href : url).origin;
}

const ROBOTS_TTL_MS = 6 * 60 * 60 * 1000;
const ROBOTS_UNAVAILABLE_TTL_MS = 5 * 60 * 1000;
const ROBOTS_MAX_BYTES = 512 * 1024;

/** The statuses that mean "the file exists but could not be read": disallow the host, briefly. */
function isUnavailable(status: number): boolean {
  return status === 0 || status === 429 || status === 408 || status >= 500;
}

function allowsEverything(status: number): boolean {
  return status >= 400 && status < 500 && !isUnavailable(status);
}

/**
 * A truncated prefix is only trustworthy up to its last complete line: the cut may fall in the
 * middle of a directive, and a fragment must not become a rule.
 */
function completeLines(text: string, truncated: boolean): string {
  if (!truncated) return text;
  // robots.txt lines may end in LF, CRLF or a bare CR; any of them closes a line.
  const end = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
  return end === -1 ? '' : text.slice(0, end + 1);
}

/**
 * robots.txt for a site (security-and-privacy.md §2). Fetched through the SSRF guard, parsed with
 * Google's precedence rules (via robots-parser), cached per origin.
 *
 * Status semantics: 2xx parses; other 4xx allows everything (a missing file means no rules);
 * 5xx, 429 or an unreachable file disallows everything for a short TTL.
 *
 * A group that names our product replaces the `*` group, as Google documents. A crawl-delay comes
 * from our group, or from `*` when ours has none: ignoring a published delay because we have a
 * group of our own would be surprising to the site owner.
 */
export class Robots {
  readonly #fetch: RobotsFetch;
  readonly #userAgent: string;
  readonly #product: string;
  readonly #cache: RobotsCache;
  readonly #ttlMs: number;
  readonly #unavailableTtlMs: number;
  readonly #maxBytes: number;
  readonly #fetchOptions: Omit<SafeFetchOptions, 'bot' | 'userAgent' | 'maxBytes' | 'signal'>;
  readonly #signal: AbortSignal | undefined;
  readonly #now: () => number;
  /** One fetch per origin at a time, so a burst of URLs does not fetch robots.txt ten times. */
  readonly #inflight = new Map<string, Promise<RobotsRecord>>();

  constructor(options: RobotsOptions = {}) {
    this.#fetch = options.fetch ?? safeFetch;
    this.#userAgent = options.userAgent ?? buildUserAgent(options.bot);
    this.#product = options.bot?.product?.trim() || DEFAULT_BOT_PRODUCT;
    this.#cache = options.cache ?? new MemoryRobotsCache();
    this.#ttlMs = options.ttlMs ?? ROBOTS_TTL_MS;
    this.#unavailableTtlMs = options.unavailableTtlMs ?? ROBOTS_UNAVAILABLE_TTL_MS;
    this.#maxBytes = options.maxBytes ?? ROBOTS_MAX_BYTES;
    this.#fetchOptions = options.fetchOptions ?? {};
    this.#signal = options.signal;
    this.#now = options.now ?? Date.now;
  }

  /** Whether a URL may be crawled. A URL on another origin is not this origin's decision. */
  async isAllowed(url: string, userAgent?: string): Promise<boolean> {
    const policy = await this.policy(url);
    return policy.isAllowed(url, userAgent ?? this.#userAgent);
  }

  /** The crawl delay for a target, in milliseconds, when the file sets one. */
  async crawlDelayMs(urlOrOrigin: string): Promise<number | undefined> {
    const policy = await this.policy(urlOrOrigin);
    return policy.crawlDelaySeconds === undefined ? undefined : policy.crawlDelaySeconds * 1000;
  }

  /** Sitemaps listed for a target's origin. */
  async sitemaps(urlOrOrigin: string): Promise<string[]> {
    return (await this.policy(urlOrOrigin)).sitemaps;
  }

  /** The parsed rules for a target's origin, from the cache or a fresh fetch. */
  async policy(urlOrOrigin: string): Promise<RobotsPolicy> {
    let origin: string;
    try {
      origin = originOf(urlOrOrigin);
    } catch (error) {
      throw new SafeFetchError('invalid_url', `${urlOrOrigin} is not a valid URL`, { cause: error });
    }
    return this.#policyFor(await this.#record(origin));
  }

  /** Forgets one origin, or everything. */
  async invalidate(urlOrOrigin?: string): Promise<void> {
    if (urlOrOrigin) await this.#cache.delete?.(originOf(urlOrOrigin));
    else await this.#cache.clear?.();
  }

  async #record(origin: string): Promise<RobotsRecord> {
    const cached = await this.#cache.get(origin);
    if (cached && cached.expiresAt > this.#now()) return cached;

    const inflight = this.#inflight.get(origin);
    if (inflight) return inflight;
    const fetching = this.#fetchRecord(origin).finally(() => this.#inflight.delete(origin));
    this.#inflight.set(origin, fetching);
    return fetching;
  }

  async #fetchRecord(origin: string): Promise<RobotsRecord> {
    const url = new URL('/robots.txt', origin).href;
    const fetchedAt = this.#now();
    let record: RobotsRecord;
    try {
      const result = await this.#fetch(url, {
        ...this.#fetchOptions,
        bot: { product: this.#product },
        userAgent: this.#userAgent,
        maxBytes: this.#maxBytes,
        // Google reads the first 500 KiB of a robots.txt and ignores the rest
        // (https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec). Read a bounded
        // prefix instead of turning an oversized but valid file into "disallow everything".
        truncate: true,
        ...(this.#signal ? { signal: this.#signal } : {}),
      });
      const status = result.status;
      const ttl = isUnavailable(status) ? this.#unavailableTtlMs : this.#ttlMs;
      record = {
        origin,
        status,
        body: status >= 200 && status < 300 ? completeLines(result.text, result.truncated) : '',
        fetchedAt,
        expiresAt: fetchedAt + ttl,
      };
    } catch (error) {
      // Unreachable robots.txt: treat the host as disallowed, and retry after the short TTL.
      record = {
        origin,
        status: 0,
        body: '',
        fetchedAt,
        expiresAt: fetchedAt + this.#unavailableTtlMs,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await this.#cache.set(record);
    return record;
  }

  #policyFor(record: RobotsRecord): RobotsPolicy {
    const base = { origin: record.origin, status: record.status, sitemaps: [] as string[], crawlDelaySeconds: undefined };

    if (isUnavailable(record.status)) {
      return { ...base, unavailable: true, isAllowed: () => false };
    }
    if (allowsEverything(record.status)) {
      return { ...base, unavailable: false, isAllowed: () => true };
    }

    const robotsUrl = new URL('/robots.txt', record.origin).href;
    const parser = robotsParser(robotsUrl, record.body);
    const sitemaps = parser
      .getSitemaps()
      .map((sitemap) => {
        try {
          return new URL(sitemap, record.origin).href;
        } catch {
          return sitemap;
        }
      })
      .filter((sitemap): sitemap is string => typeof sitemap === 'string');
    return {
      ...base,
      unavailable: false,
      sitemaps,
      crawlDelaySeconds: parser.getCrawlDelay(this.#product) ?? parser.getCrawlDelay('*'),
      isAllowed: (url, userAgent) => {
        const target = new URL(url, record.origin);
        // Rules for one origin say nothing about another; the caller asks each origin separately.
        if (target.origin !== record.origin) return true;
        return parser.isAllowed(target.href, userAgent ?? this.#userAgent) ?? true;
      },
    };
  }
}
