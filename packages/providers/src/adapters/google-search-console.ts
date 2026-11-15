import { egressRequest } from '@agentic-seo/fetch';
import {
  type AdapterCallContext,
  type AdapterCallLimits,
  type AdapterCallResult,
  type AdapterRateLimit,
  defineAdapter,
  ProviderCallError,
} from '../adapter';

// Google Search Console as a provider adapter (data-providers.md §2, §5). Two operations of the
// SearchConsole port are answered by the Search Analytics API:
//
//   sites            GET  /webmasters/v3/sites                          (properties the grant can see)
//   searchAnalytics  POST /webmasters/v3/sites/{property}/searchAnalytics/query
//
// `dataState: 'all'` asks for fresh, not-yet-final data too, and the response's `metadata` says from
// which date the numbers are still being collected (`first_incomplete_date`, in America/Los_Angeles).
// The sync marks days before it final and the rest provisional, instead of guessing from age.
// The aggregation is the caller's choice (`ctx.options.aggregationType`): `byProperty` for the daily
// totals and `byPage` for the page aggregates.
//
// Pagination: `rowLimit` is capped at 25,000 per request by the API, so a larger window is read with
// successive `startRow` offsets until a page comes back shorter than asked for (or empty). A
// configurable `maxRows` bounds the whole read; when it stops the read, the result says `truncated`
// so the caller can record that the window is incomplete instead of silently dropping rows.
//
// Search Console is free, so the estimate and the settled cost are zero (the gateway still records
// the call, its cache entry and its rate-limit token). Adapters have no database access: the access
// token comes from the credential seam the server wires to the connection's sealed tokens.

const API_BASE = 'https://www.googleapis.com';
/** The API's per-request row limit: "Valid range is 1–25,000". */
export const GSC_MAX_ROW_LIMIT = 25_000;
/**
 * A day Google still reports incomplete after this many days is taken as final (with a warning):
 * an outage in Google's pipeline must not keep one day provisional forever.
 */
export const GSC_FINALITY_CAP_DAYS = 10;
/** Rows one adapter call reads before it stops and reports the window truncated. */
const DEFAULT_MAX_ROWS = 1_000_000;

export interface GoogleSearchConsoleCredential {
  workspaceId: string;
  credentialKey: string;
}

export interface GoogleSearchConsoleAdapterOptions {
  /** A current access token for the connection named by `credentialKey`, refreshed when needed. */
  accessToken(ctx: GoogleSearchConsoleCredential): Promise<string>;
  /** Test seam: a scripted Google instead of the guarded network request. */
  request?: (url: string, init: RequestInit) => Promise<Response>;
  apiBase?: string;
  /** Rows one read may return before it stops and reports the window truncated. */
  maxRows?: number;
  /** Conservative default: Google's Search Analytics quota is 1,200 queries/minute per site. */
  rateLimit?: AdapterRateLimit;
}

interface SearchAnalyticsRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

interface SearchAnalyticsBody {
  rows?: SearchAnalyticsRow[];
  responseAggregationType?: string;
  /** Present when `dataState` is `all`: from which day the numbers are still incomplete. */
  metadata?: { first_incomplete_date?: string; first_incomplete_hour?: string };
}

interface SitesBody {
  siteEntry?: { siteUrl?: string; permissionLevel?: string }[];
}

interface SearchAnalyticsRequest {
  property: string;
  startDate: string;
  endDate: string;
  dimensions: string[];
  rowLimit: number;
  searchType: string;
  filters?: { dimension: string; operator: string; expression: string }[];
}

/** Google's provider text, bounded and without the token: a person or an agent reads it. */
function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300);
  } catch {
    // HTML or empty bodies are described by the status alone.
  }
  return '';
}

function failure(status: number, body: string): ProviderCallError {
  const reason = errorText(body);
  if (status === 401 || status === 403)
    return new ProviderCallError(
      `Google Search Console refused the request (${status})${reason ? `: ${reason}` : ''}. The connection may have been revoked; reconnect it with search.gsc.connect.`,
      { status },
    );
  if (status === 429) return new ProviderCallError('Google Search Console rate limit reached. The sync retries shortly.', { status });
  return new ProviderCallError(`Google Search Console answered ${status}${reason ? `: ${reason}` : ''}.`, { status });
}

/**
 * The adapter. The gateway gives it the connection id as `credentialKey` and the property as
 * `propertyKey`, so a cache entry can never cross a property; both are part of the gateway's key.
 */
export function createGoogleSearchConsoleAdapter(options: GoogleSearchConsoleAdapterOptions) {
  const base = options.apiBase ?? API_BASE;
  const send = options.request ?? ((url: string, init: RequestInit) => egressRequest(url, init));

  async function getJson<T>(url: string, init: RequestInit, token: string): Promise<T> {
    const response = await send(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    if (!response.ok) throw failure(response.status, body);
    return JSON.parse(body) as T;
  }

  return defineAdapter({
    id: 'google-search-console',
    ports: ['SearchConsole'] as const,
    rateLimit: options.rateLimit ?? { capacity: 20, refillPerSecond: 20 },

    estimate(_operation: string, _request: unknown) {
      return { maxCostMicros: 0, currency: 'USD', basis: 'Google Search Console is free' };
    },

    async call(operation: string, raw: unknown, ctx: AdapterCallContext, _limits: AdapterCallLimits): Promise<AdapterCallResult> {
      const token = await options.accessToken({ workspaceId: ctx.workspaceId, credentialKey: ctx.credentialKey });

      if (operation === 'sites') {
        const body = await getJson<SitesBody>(`${base}/webmasters/v3/sites`, { method: 'GET' }, token);
        return {
          data: {
            sites: (body.siteEntry ?? [])
              .filter((entry) => typeof entry.siteUrl === 'string')
              .map((entry) => ({ siteUrl: entry.siteUrl as string, permissionLevel: entry.permissionLevel ?? 'unknown' })),
          },
          actualCostMicros: 0,
          raw: body,
        };
      }

      if (operation === 'searchAnalytics') {
        const request = raw as SearchAnalyticsRequest;
        const aggregationType = typeof ctx.options.aggregationType === 'string' ? ctx.options.aggregationType : 'auto';
        // The API's per-request limit is 25,000 rows; a bigger ask is refused, so clamp instead.
        const pageSize = Math.min(request.rowLimit, GSC_MAX_ROW_LIMIT);
        const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
        const rows: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[] = [];
        let startRow = 0;
        let truncated = false;
        let rawResponse: SearchAnalyticsBody | undefined;
        for (;;) {
          const body = await getJson<SearchAnalyticsBody>(
            `${base}/webmasters/v3/sites/${encodeURIComponent(request.property)}/searchAnalytics/query`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                startDate: request.startDate,
                endDate: request.endDate,
                dimensions: request.dimensions,
                type: request.searchType,
                aggregationType,
                // Fresh data is visible and marked provisional by the sync instead of being hidden.
                dataState: 'all',
                rowLimit: pageSize,
                startRow,
                ...(request.filters?.length
                  ? {
                      dimensionFilterGroups: [
                        {
                          filters: request.filters.map((filter) => ({
                            dimension: filter.dimension,
                            operator: filter.operator,
                            expression: filter.expression,
                          })),
                        },
                      ],
                    }
                  : {}),
              }),
            },
            token,
          );
          rawResponse = body;
          const page = body.rows ?? [];
          for (const row of page) {
            if (rows.length >= maxRows) {
              // The cap, not the provider, ended the read: report it rather than dropping rows quietly.
              truncated = true;
              break;
            }
            rows.push({
              keys: Array.isArray(row.keys) ? row.keys : [],
              clicks: Number(row.clicks ?? 0),
              impressions: Number(row.impressions ?? 0),
              ctr: Number(row.ctr ?? 0),
              position: Number(row.position ?? 0),
            });
          }
          if (truncated) break;
          // A short (or empty) page is the last one; keep asking with the next offset otherwise.
          if (page.length < pageSize) break;
          startRow += pageSize;
        }
        const incomplete = rawResponse?.metadata?.first_incomplete_date;
        const firstIncompleteDate = typeof incomplete === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(incomplete) ? incomplete : null;
        const firstIncompleteHour =
          typeof rawResponse?.metadata?.first_incomplete_hour === 'string' ? rawResponse.metadata.first_incomplete_hour : null;
        return {
          data: {
            rows,
            // Google's own statement wins: a window that ends before the first incomplete day is
            // final, anything at or after it is still moving. Without the field the API reported
            // nothing incomplete in this range, so every row is final.
            finality:
              firstIncompleteDate === null
                ? ('final' as const)
                : request.endDate >= firstIncompleteDate
                  ? ('provisional' as const)
                  : ('final' as const),
            coverage: null,
            metadata: firstIncompleteDate === null && firstIncompleteHour === null ? null : { firstIncompleteDate, firstIncompleteHour },
            truncated,
            rowLimitReached: truncated ? maxRows : null,
          },
          actualCostMicros: 0,
          raw: rawResponse,
        };
      }

      throw new ProviderCallError(
        `The Google Search Console adapter does not support "${operation}". It answers sites and searchAnalytics.`,
      );
    },
  });
}
