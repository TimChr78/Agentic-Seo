import { AppError } from '@agentic-seo/core';
import { egressRequest } from '@agentic-seo/fetch';

// The one outbound HTTP seam for integrations. Every OAuth token exchange and revoke goes through
// packages/fetch's egress guard: https, port 443, a public address, no redirects. Tests pass a
// deterministic implementation instead, so no test reaches the public internet.

export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Bounds one provider exchange; the OAuth flow must not hang a worker on a slow endpoint. */
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export type HttpClient = (url: string, init: HttpRequest) => Promise<HttpResponse>;

const DEFAULT_TIMEOUT_MS = 15_000;

/** The production implementation. A blocked target becomes an actionable AppError, not a fetch error. */
export const guardedHttp: HttpClient = async (url, init) => {
  try {
    const response = await egressRequest(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    return { status: response.status, body: await response.text() };
  } catch (err) {
    if (err instanceof Error && err.name === 'EgressError')
      throw new AppError('precondition_failed', `Cannot reach ${new URL(url).host}: ${err.message}`);
    if (err instanceof Error && err.name === 'TimeoutError')
      throw new AppError('precondition_failed', `${new URL(url).host} did not answer in time. Try again.`);
    throw err;
  }
};
