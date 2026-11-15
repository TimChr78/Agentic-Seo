import { gunzipSync } from 'node:zlib';
import type { FetchResult } from '@agentic-seo/fetch';
import { isSafeFetchError } from '@agentic-seo/fetch';
import { Parser } from 'htmlparser2';
import type { SitemapFacts } from './facts';
import { crawlFetch, httpProbeUrl } from './fetch-options';
import { isInternalUrl, normalizeUrl } from './url';

// Sitemap discovery (crawler-and-audits.md §2): robots.txt and `/sitemap.xml` name the sitemaps, an
// index is followed up to three levels, gzip files are read, and the URL count is capped so one
// hostile sitemap cannot fill the frontier.

/** The most URLs one sitemap file may list (the sitemap protocol's own limit). */
export const SITEMAP_MAX_URLS = 50_000;
/** The most uncompressed bytes a sitemap may be (the protocol's own limit). */
export const SITEMAP_MAX_BYTES = 50 * 1024 * 1024;
/** The most URLs one audit seeds from sitemaps. */
export const SITEMAP_TOTAL_URL_CAP = 100_000;
/** How deep sitemap indexes are followed (a sitemap index naming another index is level 2). */
export const SITEMAP_MAX_INDEX_DEPTH = 3;
/** The most sitemap documents one seed reads (indexes and files together). */
export const SITEMAP_MAX_DOCUMENTS = 200;
/** The most child sitemap URLs one seed may queue from indexes. */
export const SITEMAP_MAX_QUEUED = 1_000;
/** The most decompressed sitemap bytes one seed reads across every document. */
export const SITEMAP_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export interface SitemapDocument {
  url: string;
  status: number;
  fetchError: string | null;
  kind: 'urlset' | 'index' | 'unknown';
  /** Every `<loc>` in the file: page URLs for a urlset, child sitemap URLs for an index. */
  urls: string[];
  errors: string[];
  /** Decompressed bytes read, for the aggregate cap. */
  bytes: number;
}

/** Parses a sitemap XML document (urlset or sitemapindex) from its text. */
export function parseSitemap(xml: string): Pick<SitemapDocument, 'kind' | 'urls' | 'errors'> {
  const urls: string[] = [];
  const errors: string[] = [];
  let root: string | null = null;
  // htmlparser2's XML `onclosetag` has no name argument, so the open elements are tracked here.
  const capturing: string[] = [];
  let locParts: string[] = [];
  const collector = new Parser(
    {
      onopentag(name) {
        const local = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
        capturing.push(local.toLowerCase());
        if (capturing.length === 1) root = local.toLowerCase();
        if (local.toLowerCase() === 'loc') locParts = [];
      },
      ontext(text) {
        if (capturing.at(-1) === 'loc') locParts.push(text);
      },
      onclosetag() {
        const local = capturing.pop();
        if (local === 'loc') {
          const value = locParts.join('').trim();
          if (value) urls.push(value);
          locParts = [];
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  collector.write(xml);
  collector.end();

  const kind = root === 'urlset' ? 'urlset' : root === 'sitemapindex' ? 'index' : 'unknown';
  if (kind === 'unknown') errors.push(`The root element is <${root ?? 'missing'}>, not a sitemap <urlset> or <sitemapindex>.`);
  if (kind === 'urlset' && urls.length > SITEMAP_MAX_URLS)
    errors.push(`The sitemap lists ${urls.length} URLs; the limit is ${SITEMAP_MAX_URLS}. The first ${SITEMAP_MAX_URLS} were used.`);
  if (kind === 'index' && urls.length > SITEMAP_MAX_URLS)
    errors.push(`The sitemap index names ${urls.length} sitemaps; the limit is ${SITEMAP_MAX_URLS}.`);
  return { kind, urls, errors };
}

/** Whether a response body is a gzip file (a `.xml.gz` served without `Content-Encoding`). */
export function isGzip(body: Buffer): boolean {
  return body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b;
}

/** The decompressed body, or an error message when it is not readable gzip. */
export function gunzipSitemap(body: Buffer): { text: string } | { error: string } {
  try {
    return { text: gunzipSync(body, { maxOutputLength: SITEMAP_MAX_BYTES }).toString('utf8') };
  } catch (error) {
    return { error: `The gzip sitemap could not be decompressed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The fetch the sitemap reader uses; injectable so a test need not start a server. */
export type SitemapFetch = (url: string, options: Parameters<typeof crawlFetch>[1]) => Promise<FetchResult>;

/**
 * Fetches and parses one sitemap. A `.xml.gz` (or any gzip body) is decompressed before parsing;
 * redirects may only stay on the site's hosts, and a non-2xx answer is recorded, not thrown.
 */
export async function fetchSitemap(
  url: string,
  hosts: readonly string[],
  fetch: SitemapFetch = crawlFetch,
  options: { signal?: AbortSignal } = {},
): Promise<SitemapDocument> {
  const empty = { url, status: 0, fetchError: null, kind: 'unknown' as const, urls: [] as string[], errors: [] as string[], bytes: 0 };
  let result: FetchResult;
  try {
    result = await fetch(url, {
      maxBytes: 10 * 1024 * 1024,
      totalTimeoutMs: 20_000,
      ...(options.signal ? { signal: options.signal } : {}),
      allowRedirect: (target) =>
        isInternalUrl(target.href, hosts) ? true : `${target.href} is not on this site's hosts, so its sitemap is not read.`,
    });
  } catch (error) {
    return {
      ...empty,
      fetchError: isSafeFetchError(error) ? `${error.kind}: ${error.message}` : error instanceof Error ? error.message : String(error),
    };
  }

  const errors: string[] = [];
  if (result.status < 200 || result.status >= 300) {
    return { ...empty, status: result.status, fetchError: `answered HTTP ${result.status}` };
  }
  if (result.truncated) errors.push('The response was larger than 10 MB, so it was read only in part.');

  let text = result.text;
  if (isGzip(result.body)) {
    const unzipped = gunzipSitemap(result.body);
    if ('error' in unzipped) return { ...empty, status: result.status, errors: [unzipped.error] };
    text = unzipped.text;
  }

  const parsed = parseSitemap(text);
  const urls = parsed.urls.slice(0, SITEMAP_MAX_URLS);
  if (parsed.kind === 'urlset') {
    const foreign = urls.filter((entry) => {
      const normalised = normalizeUrl(entry);
      return normalised === null || !isInternalUrl(normalised, hosts);
    });
    if (foreign.length > 0)
      errors.push(`${foreign.length} URL${foreign.length === 1 ? '' : 's'} in the sitemap are not on this site's hosts and were ignored.`);
  }
  return {
    url,
    status: result.status,
    fetchError: null,
    kind: parsed.kind,
    urls,
    errors: [...errors, ...parsed.errors],
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

/** The URL a sitemap file lists, normalised; null for a non-http(s) or malformed entry. */
export const sitemapUrl = (entry: string): string | null => normalizeUrl(entry);

export interface ReadSitemapsOptions {
  /** Sitemap URLs to start from: robots.txt's list plus `/sitemap.xml`. */
  startUrls: readonly string[];
  hosts: readonly string[];
  /** The most page URLs to collect across every file. */
  maxUrls?: number;
  /** The most sitemap documents to read. Default {@link SITEMAP_MAX_DOCUMENTS}. */
  maxDocuments?: number;
  /** The most child sitemap URLs to queue. Default {@link SITEMAP_MAX_QUEUED}. */
  maxQueuedSitemaps?: number;
  /** The most decompressed bytes to read across every document. Default {@link SITEMAP_MAX_TOTAL_BYTES}. */
  maxTotalBytes?: number;
  /** Stop once this wall-clock time (ms since the epoch) passes. */
  deadlineAt?: number;
  /** Aborts the whole read; every fetch receives it. */
  signal?: AbortSignal;
  now?: () => number;
  fetch?: SitemapFetch;
}

export interface ReadSitemapsResult {
  /** Every sitemap that was read, in the order it was read (facts for `SiteFacts.sitemaps`). */
  documents: SitemapFacts[];
  /** The page URLs sitemaps listed, deduplicated and in discovery order. */
  urls: string[];
  /** Why the read stopped before it finished (a cap), or empty. Also on the last document's errors. */
  truncation: string[];
}

/**
 * Reads the sitemaps an audit starts from, following an index up to three levels. Deduplicates
 * sitemap URLs and page URLs, keeps only pages on the site's hosts, and stops at `maxUrls`.
 *
 * The fan-out is bounded: documents read, sitemaps queued, decompressed bytes and wall time all
 * have caps, so one hostile or enormous sitemap tree cannot make an audit's seeding unbounded. A
 * cap that is hit is recorded in `truncation` and on the last document's `errors`, so an audit's
 * `SiteFacts` explains why the sitemap list is not the whole site.
 */
export async function readSitemaps(options: ReadSitemapsOptions): Promise<ReadSitemapsResult> {
  const fetch = options.fetch ?? crawlFetch;
  const now = options.now ?? Date.now;
  const maxUrls = options.maxUrls ?? SITEMAP_TOTAL_URL_CAP;
  const maxDocuments = options.maxDocuments ?? SITEMAP_MAX_DOCUMENTS;
  const maxQueued = options.maxQueuedSitemaps ?? SITEMAP_MAX_QUEUED;
  const maxTotalBytes = options.maxTotalBytes ?? SITEMAP_MAX_TOTAL_BYTES;
  const documents: SitemapFacts[] = [];
  const truncation: string[] = [];
  const pages: string[] = [];
  const seenPages = new Set<string>();
  const seenSitemaps = new Set<string>();
  let queue: { url: string; depth: number }[] = [];
  let totalBytes = 0;
  let stopped = false;

  const stop = (message: string) => {
    if (stopped) return;
    stopped = true;
    truncation.push(message);
    // The last document carries the reason, next to the other sitemap errors a check reads.
    documents.at(-1)?.errors.push(message);
  };

  for (const raw of options.startUrls) {
    if (queue.length >= maxQueued) {
      // Nothing was read yet, so there is no document to attach the message to; the caller still
      // records `truncation` on the site facts.
      truncation.push(`The robots.txt sitemap list has more than ${maxQueued} entries; only the first ${maxQueued} are read.`);
      break;
    }
    const url = normalizeUrl(raw);
    if (!url || !isInternalUrl(url, options.hosts) || seenSitemaps.has(url)) continue;
    seenSitemaps.add(url);
    queue.push({ url, depth: 0 });
  }

  while (queue.length > 0 && pages.length < maxUrls && !stopped) {
    if (documents.length >= maxDocuments) {
      stop(`The sitemap read stopped after ${maxDocuments} documents; the rest are not read.`);
      break;
    }
    if (totalBytes >= maxTotalBytes) {
      stop(
        `The sitemap read stopped after ${Math.max(1, Math.round(maxTotalBytes / (1024 * 1024)))} MB of sitemaps; the rest are not read.`,
      );
      break;
    }
    if (options.deadlineAt !== undefined && now() >= options.deadlineAt) {
      stop('The sitemap read reached its time limit; the rest are not read.');
      break;
    }
    const batch = queue;
    queue = [];
    for (const { url, depth } of batch) {
      if (pages.length >= maxUrls || stopped) break;
      if (documents.length >= maxDocuments) {
        stop(`The sitemap read stopped after ${maxDocuments} documents; the rest are not read.`);
        break;
      }
      // Checked per document, not once per batch: a batch of queued indexes can otherwise read all
      // of its children long after the deadline or the abort, which is the unbounded work the caps
      // exist to prevent.
      if (options.deadlineAt !== undefined && now() >= options.deadlineAt) {
        stop('The sitemap read reached its time limit; the rest are not read.');
        break;
      }
      if (options.signal?.aborted) {
        stop('The sitemap read was stopped by the audit; the rest are not read.');
        break;
      }
      const document = await fetchSitemap(url, options.hosts, fetch, options.signal ? { signal: options.signal } : {});
      totalBytes += document.bytes;
      documents.push({
        url: document.url,
        status: document.status,
        fetchError: document.fetchError,
        kind: document.kind,
        urlCount: document.urls.length,
        errors: document.errors,
      });
      if (totalBytes >= maxTotalBytes) {
        stop(
          `The sitemap read stopped after ${Math.max(1, Math.round(maxTotalBytes / (1024 * 1024)))} MB of sitemaps; the rest are not read.`,
        );
        break;
      }
      if (document.kind === 'index') {
        if (depth >= SITEMAP_MAX_INDEX_DEPTH) {
          documents.at(-1)?.errors.push(`The index is nested ${depth + 1} levels deep; only ${SITEMAP_MAX_INDEX_DEPTH} are followed.`);
          continue;
        }
        for (const child of document.urls) {
          const childUrl = normalizeUrl(child);
          if (!childUrl || !isInternalUrl(childUrl, options.hosts) || seenSitemaps.has(childUrl)) continue;
          if (queue.length >= maxQueued) {
            stop(`The sitemap indexes name more than ${maxQueued} sitemaps; only the first ${maxQueued} are read.`);
            break;
          }
          seenSitemaps.add(childUrl);
          queue.push({ url: childUrl, depth: depth + 1 });
        }
        continue;
      }
      if (document.kind !== 'urlset') continue;
      for (const entry of document.urls) {
        if (pages.length >= maxUrls) break;
        const pageUrl = normalizeUrl(entry);
        if (!pageUrl || !isInternalUrl(pageUrl, options.hosts) || seenPages.has(pageUrl)) continue;
        seenPages.add(pageUrl);
        pages.push(pageUrl);
      }
    }
  }

  return { documents, urls: pages, truncation };
}

/** The `http://` probe for `SiteFacts.httpRedirectsToHttps`; null when it could not be tested. */
export async function probeHttpRedirect(
  host: string,
  fetch: SitemapFetch = crawlFetch,
  options: { signal?: AbortSignal } = {},
): Promise<boolean | null> {
  try {
    const result = await fetch(httpProbeUrl(host), {
      maxBytes: 64 * 1024,
      totalTimeoutMs: 10_000,
      maxRedirects: 5,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return new URL(result.url).protocol === 'https:';
  } catch {
    return null;
  }
}
