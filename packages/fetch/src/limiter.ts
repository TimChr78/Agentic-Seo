/** A granted slot on one host. Release it exactly once when the request settles. */
export interface HostLease {
  readonly host: string;
  release(): Promise<void>;
}

export interface AcquireHostOptions {
  /** The delay to leave before the next request starts: the crawl-delay, or the limiter's default. */
  minDelayMs?: number;
  signal?: AbortSignal;
}

export interface HostResponse {
  status: number;
  /** The `Retry-After` header, in seconds or as an HTTP date. */
  retryAfter?: string | null;
}

/**
 * Per-host politeness (security-and-privacy.md §2): concurrency, spacing and backoff.
 *
 * The crawler gets an in-memory limiter per process today and a Postgres-backed one in Phase 1, so
 * per-host concurrency stays a global limit across worker replicas. Both implement this interface;
 * `acquire` is async and returns a lease so a shared implementation can hand out a row id.
 */
export interface HostLimiter {
  acquire(host: string, options?: AcquireHostOptions): Promise<HostLease>;
  release(lease: HostLease): Promise<void>;
  /** Record a response so a 429 or 503 pauses the host, honouring `Retry-After`. */
  noteResponse(host: string, response: HostResponse): Promise<void>;
  /** Pause a host for a given time (an operator action, or a backoff the caller decided on). */
  pause?(host: string, durationMs: number): Promise<void>;
}

/**
 * Parses a `Retry-After` value: delta-seconds (`120`, possibly fractional) or an HTTP date. Returns
 * undefined for anything else, and never a negative delay.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : undefined;
  }
  // Only an HTTP date has letters; Date.parse alone would accept strings like "-1".
  if (!/[a-z]/i.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

export interface MemoryHostLimiterOptions {
  /** Requests in flight to one host. Default 2, as a polite baseline for a single process. */
  maxConcurrencyPerHost?: number;
  /** Spacing between request starts when robots.txt sets no crawl-delay. Default 250 ms. */
  minDelayMs?: number;
  /** Pause after a 429 without `Retry-After`. Default 30 s. */
  pauseOnTooManyRequestsMs?: number;
  /** Pause after a 503 without `Retry-After`. Default 10 s. */
  pauseOnUnavailableMs?: number;
  now?: () => number;
}

interface Waiter {
  minDelayMs: number | undefined;
  resolve: (lease: HostLease) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

interface HostState {
  active: number;
  nextStart: number;
  pausedUntil: number;
  queue: Waiter[];
  timer: NodeJS.Timeout | undefined;
}

/**
 * The in-memory limiter: per-host concurrency, a minimum delay between request starts, and a pause
 * after 429/503. Enough for one process; the crawler's global limiter lives in Postgres.
 */
export class MemoryHostLimiter implements HostLimiter {
  readonly #maxConcurrency: number;
  readonly #minDelayMs: number;
  readonly #pauseOnTooManyRequestsMs: number;
  readonly #pauseOnUnavailableMs: number;
  readonly #now: () => number;
  readonly #hosts = new Map<string, HostState>();

  constructor(options: MemoryHostLimiterOptions = {}) {
    this.#maxConcurrency = Math.max(1, options.maxConcurrencyPerHost ?? 2);
    this.#minDelayMs = Math.max(0, options.minDelayMs ?? 250);
    this.#pauseOnTooManyRequestsMs = Math.max(0, options.pauseOnTooManyRequestsMs ?? 30_000);
    this.#pauseOnUnavailableMs = Math.max(0, options.pauseOnUnavailableMs ?? 10_000);
    this.#now = options.now ?? Date.now;
  }

  /** Requests currently in flight to a host (a diagnostic for the crawler's adaptive window). */
  active(host: string): number {
    return this.#hosts.get(this.#normalize(host))?.active ?? 0;
  }

  async acquire(host: string, options: AcquireHostOptions = {}): Promise<HostLease> {
    const key = this.#normalize(host);
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted');
    return new Promise<HostLease>((resolve, reject) => {
      const state = this.#state(key);
      const waiter: Waiter = { minDelayMs: options.minDelayMs, resolve, reject, signal: options.signal, onAbort: undefined };
      if (options.signal) {
        waiter.onAbort = () => this.#remove(key, waiter, options.signal?.reason);
        options.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      state.queue.push(waiter);
      this.#pump(key);
    });
  }

  async release(lease: HostLease): Promise<void> {
    this.#releaseHost(this.#normalize(lease.host));
  }

  async noteResponse(host: string, response: HostResponse): Promise<void> {
    if (response.status !== 429 && response.status !== 503) return;
    const fallback = response.status === 429 ? this.#pauseOnTooManyRequestsMs : this.#pauseOnUnavailableMs;
    const retryAfter = parseRetryAfter(response.retryAfter, this.#now());
    await this.pause(host, retryAfter ?? fallback);
  }

  async pause(host: string, durationMs: number): Promise<void> {
    const key = this.#normalize(host);
    if (durationMs <= 0) return;
    const state = this.#state(key);
    state.pausedUntil = Math.max(state.pausedUntil, this.#now() + durationMs);
    this.#pump(key);
  }

  /** Acquire a slot, run the work, and always release — the shape the crawler uses. */
  async run<T>(host: string, work: () => Promise<T>, options: AcquireHostOptions = {}): Promise<T> {
    const lease = await this.acquire(host, options);
    try {
      return await work();
    } finally {
      await lease.release();
    }
  }

  #normalize(host: string): string {
    return host.trim().toLowerCase();
  }

  #state(key: string): HostState {
    let state = this.#hosts.get(key);
    if (!state) {
      state = { active: 0, nextStart: 0, pausedUntil: 0, queue: [], timer: undefined };
      this.#hosts.set(key, state);
    }
    return state;
  }

  #remove(key: string, waiter: Waiter, reason: unknown): void {
    const state = this.#hosts.get(key);
    if (!state) return;
    const index = state.queue.indexOf(waiter);
    if (index === -1) return;
    state.queue.splice(index, 1);
    waiter.signal?.removeEventListener('abort', waiter.onAbort as () => void);
    waiter.reject(reason ?? new Error('aborted'));
    this.#cleanup(key);
  }

  #releaseHost(key: string): void {
    const state = this.#hosts.get(key);
    if (!state) return;
    state.active = Math.max(0, state.active - 1);
    this.#pump(key);
  }

  #pump(key: string): void {
    const state = this.#hosts.get(key);
    if (!state) return;

    while (state.queue.length > 0 && state.active < this.#maxConcurrency) {
      const now = this.#now();
      const readyAt = Math.max(state.nextStart, state.pausedUntil);
      if (readyAt > now) {
        this.#schedule(key, state, readyAt - now);
        return;
      }
      const waiter = state.queue.shift()!;
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason ?? new Error('aborted'));
        continue;
      }
      waiter.signal?.removeEventListener('abort', waiter.onAbort as () => void);
      state.active += 1;
      const delay = waiter.minDelayMs ?? this.#minDelayMs;
      state.nextStart = now + Math.max(0, delay);
      let released = false;
      waiter.resolve({
        host: key,
        release: async () => {
          if (released) return;
          released = true;
          this.#releaseHost(key);
        },
      });
    }
    this.#cleanup(key);
  }

  #schedule(key: string, state: HostState, delayMs: number): void {
    if (!state.timer)
      state.timer = setTimeout(
        () => {
          state.timer = undefined;
          this.#pump(key);
        },
        Math.max(1, delayMs),
      );
    // A timer that serves queued requests keeps the process alive (they would never run otherwise);
    // a cleanup-only timer must not. Re-evaluated on every call, so a reused cleanup timer is
    // referenced again as soon as a waiter queues behind it.
    if (state.queue.length > 0) state.timer.ref?.();
    else state.timer.unref?.();
  }

  /**
   * Drops a host's state once it is idle and both its spacing and pause deadlines have passed, so
   * the map stays small without forgetting when the next request to that host may start.
   */
  #cleanup(key: string): void {
    const state = this.#hosts.get(key);
    if (!state) return;
    if (state.queue.length > 0 || state.active > 0) return;
    const readyAt = Math.max(state.nextStart, state.pausedUntil);
    if (readyAt > this.#now()) {
      // Keep the state (and its next start time) until the deadline, then clean up lazily.
      this.#schedule(key, state, readyAt - this.#now());
      return;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    this.#hosts.delete(key);
  }
}
