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
// `dataState: 'all'` asks for fresh, not-yet-final data too; the sync marks those days provisional.
// The aggregation is the caller's choice (`ctx.options.aggregationType`): `byProperty` for the
// daily totals and `byPage` for the page aggregates. Reads paginate with `startRow`, whose documented
// ceiling is 25,000; the adapter stops there rather than sending a request the API refuses.
//
// Search Console is free, so the estimate and the settled cost are zero (the gateway still records
// the call, its cache entry and its rate-limit token). Adapters have no database access: the access
// token comes from the credential seam the server wires to the connection's sealed tokens.

const API_BASE = 'https://www.googleapis.com';
/** Search Analytics refuses `startRow` at or above this value; pagination stops there. */
const MAX_START_ROW = 25_000;
/** Days after which Google's numbers for a day are final. */
export const GSC_FINALITY_DAYS = 3;

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
  /** Conservative default: Google's Search Analytics quota is 1,200 queries/minute per site. */
  rateLimit?: AdapterRateLimit;
  now?: () => Date;
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

const dayBefore = (day: string, days: number): string => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};

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
  const now = options.now ?? (() => new Date());
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
        const rows: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[] = [];
        let startRow = 0;
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
                rowLimit: request.rowLimit,
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
          for (const row of page)
            rows.push({
              keys: Array.isArray(row.keys) ? row.keys : [],
              clicks: Number(row.clicks ?? 0),
              impressions: Number(row.impressions ?? 0),
              ctr: Number(row.ctr ?? 0),
              position: Number(row.position ?? 0),
            });
          // A short page is the last one; `startRow` at the API ceiling is the documented stop.
          if (page.length < request.rowLimit) break;
          startRow += request.rowLimit;
          if (startRow >= MAX_START_ROW) break;
        }
        const today = now().toISOString().slice(0, 10);
        return {
          data: {
            rows,
            // The same rule the sync applies: newer than three days is provisional.
            finality: request.endDate <= dayBefore(today, GSC_FINALITY_DAYS) ? 'final' : 'provisional',
            coverage: null,
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
