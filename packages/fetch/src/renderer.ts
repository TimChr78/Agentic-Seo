/** A device an audit renders for. */
export type RenderDevice = 'mobile' | 'desktop';

export interface RenderOptions {
  device: RenderDevice;
  /** CSS selector or expression to wait for before reading the DOM. */
  waitFor?: string;
  timeoutMs: number;
  screenshot?: boolean;
  /** Drop third-party subresources; an egress proxy still applies (security-and-privacy.md §1). */
  blockThirdParty?: boolean;
}

export interface RenderConsoleMessage {
  type: string;
  text: string;
  url?: string;
}

/** Counts only: the renderer never returns the requests themselves, because they may carry headers. */
export interface RenderNetworkSummary {
  requests: number;
  failed: number;
  thirdParty: number;
  blocked: number;
  /** WebSocket and EventSource connections the page opened. */
  socketConnections: number;
}

/** A screenshot in object storage; the audit stores this reference, not the bytes. */
export interface ScreenshotRef {
  key: string;
  mimeType: string;
  width: number;
  height: number;
}

/** A rendered page: the DOM after scripts ran, plus what the page did. */
export interface RenderedPage {
  evaluated: true;
  /** Which adapter answered: `builtin`, `crawl4ai`, `browserless`, … */
  renderer: string;
  html: string;
  status: number;
  finalUrl: string;
  console: RenderConsoleMessage[];
  network: RenderNetworkSummary;
  screenshot: ScreenshotRef | null;
  timings: { totalMs: number };
}

/**
 * The typed "we did not look" answer. Render-dependent checks stay "Not evaluated" — never passed —
 * whenever the renderer is `none` or an adapter fails (crawler-and-audits.md §3).
 */
export interface NotEvaluated {
  evaluated: false;
  renderer: string;
  reason: 'no_renderer' | 'disabled' | 'failed';
  message: string;
}

export type RenderResult = RenderedPage | NotEvaluated;

export interface LighthouseOptions {
  device: RenderDevice;
}

/** Lighthouse's numbers, per category and for the metrics the checks read. */
export interface LighthouseResult {
  renderer: string;
  finalUrl: string;
  /** 0–1 scores, or null when Lighthouse could not run. */
  scores: { performance: number; accessibility: number; bestPractices: number; seo: number } | null;
  /** Numeric metrics in Lighthouse's own units, keyed by audit id (`largest-contentful-paint`, …). */
  metrics: Record<string, number>;
  fetchedAt: string;
}

/**
 * The renderer port (crawler-and-audits.md §3). Adapters (ADR-0005) implement it: `builtin`
 * (Playwright sidecar), `crawl4ai`, `browserless`. Every adapter routes browser traffic through an
 * egress proxy that applies the same checks as `safeFetch`.
 */
export interface Renderer {
  readonly name: string;
  render(url: string, options: RenderOptions): Promise<RenderResult>;
  lighthouse?(url: string, options: LighthouseOptions): Promise<LighthouseResult>;
}

/** The default renderer: raw HTML only. Render-dependent checks report "Not evaluated: no renderer". */
export const NONE_RENDERER_NAME = 'none';

export const noneRenderer: Renderer = {
  name: NONE_RENDERER_NAME,
  render: async (): Promise<NotEvaluated> => ({
    evaluated: false,
    renderer: NONE_RENDERER_NAME,
    reason: 'no_renderer',
    message: 'Not evaluated: no renderer is configured',
  }),
};

/** Whether a render result is a real page (narrows the union for callers). */
export function wasRendered(result: RenderResult): result is RenderedPage {
  return result.evaluated;
}
