import type {
  AdapterCallContext,
  AdapterCallLimits,
  AdapterCallResult,
  AdapterRateLimit,
  AdapterReconcileContext,
  AdapterReconcileRequest,
  AdapterReconcileResult,
  CostEstimate,
  ProviderAdapter,
} from './adapter';
import { ProviderTimeoutError } from './adapter';
import type { PortName } from './ports';

// A deterministic adapter for tests and local development. It never touches the network: costs and
// data are configurable, it can report provider task ids, fail before charging, or time out after
// charging so the gateway's `unknown` path and reconciliation can be exercised.

export type FakeCost = number | ((operation: string, request: unknown) => number);
export type FakeData = (port: PortName, operation: string, request: unknown) => unknown;
export type FakeTaskId = (port: PortName, operation: string, sequence: number) => string | undefined;

export interface FakeAdapterOptions {
  id?: string;
  ports?: readonly PortName[];
  /** The ceiling the estimate reports. Defaults to 1_000 (0.001 of a currency unit). */
  estimateMicros?: FakeCost;
  /** What the call actually reports. Defaults to the estimate. */
  actualMicros?: FakeCost;
  currency?: string;
  /** The currency the call *reports*; differs from `currency` to exercise the gateway's guard. */
  resultCurrency?: string;
  /** How many calls time out after the provider accepted them (the first N). */
  timeoutAfterCharge?: number;
  /** Return an Error to fail a call before it charges. */
  failure?: (operation: string, request: unknown, sequence: number) => Error | null;
  /** Override the deterministic response for an operation. */
  data?: FakeData;
  taskId?: FakeTaskId;
  rateLimit?: AdapterRateLimit;
  /**
   * Awaited before the provider accepts the call. A test holds the call in `dispatching` with it,
   * without the provider having charged anything yet.
   */
  holdBeforeSubmit?: () => Promise<void>;
  /**
   * Awaited after the provider charged but before the submit is recorded or the result returns:
   * the state of a process that died mid-submission. Reconciliation must resolve it from the
   * call's idempotency key.
   */
  holdAfterCharge?: () => Promise<void>;
}

interface ChargedCall {
  data: unknown;
  actualCostMicros: number;
  raw: unknown;
}

export interface FakeInvocation {
  port: PortName;
  operation: string;
  request: unknown;
  sequence: number;
}

export class FakeAdapter implements ProviderAdapter {
  readonly id: string;
  readonly ports: readonly PortName[];
  readonly rateLimit?: AdapterRateLimit;
  readonly invocations: FakeInvocation[] = [];
  /** The ceiling the gateway authorised for each call, in order. */
  readonly ceilings: number[] = [];
  readonly reconcileRequests: AdapterReconcileRequest[] = [];
  reconcileCount = 0;

  private readonly options: FakeAdapterOptions;
  private sequence = 0;
  private timeoutsLeft: number;
  private readonly chargedByTaskId = new Map<string, ChargedCall>();
  private readonly chargedByIdempotencyKey = new Map<string, ChargedCall>();

  constructor(options: FakeAdapterOptions = {}) {
    this.options = options;
    this.id = options.id ?? 'fake';
    this.ports = options.ports ?? [
      'KeywordData',
      'SerpData',
      'DomainData',
      'BacklinkData',
      'LocalData',
      'AnswerEngines',
      'SearchConsole',
      'Analytics',
      'PageExperience',
      'IndexSubmit',
      'WebmasterData',
    ];
    this.rateLimit = options.rateLimit;
    this.timeoutsLeft = options.timeoutAfterCharge ?? 0;
  }

  get callCount(): number {
    return this.invocations.length;
  }

  estimate(operation: string, request: unknown): CostEstimate {
    return {
      maxCostMicros: costOf(this.options.estimateMicros, operation, request, 1_000),
      currency: this.options.currency ?? 'USD',
      basis: `fake ${operation}`,
    };
  }

  async call(operation: string, request: unknown, ctx: AdapterCallContext, limits: AdapterCallLimits): Promise<AdapterCallResult> {
    const sequence = ++this.sequence;
    this.invocations.push({ port: ctx.port, operation, request, sequence });
    this.ceilings.push(limits.maxCostMicros);

    const failure = this.options.failure?.(operation, request, sequence);
    if (failure) throw failure;

    const data = (this.options.data ?? defaultFakeData)(ctx.port, operation, request);
    const actualCostMicros = costOf(this.options.actualMicros ?? this.options.estimateMicros, operation, request, 1_000);
    const taskId = this.options.taskId ? this.options.taskId(ctx.port, operation, sequence) : `fake-${ctx.port.toLowerCase()}-${sequence}`;

    await this.options.holdBeforeSubmit?.();
    // The provider charges on receipt; the gateway's own record follows `onSubmitted`.
    const charged: ChargedCall = { data, actualCostMicros, raw: { fake: true, port: ctx.port, operation, sequence } };
    if (taskId !== undefined) this.chargedByTaskId.set(taskId, charged);
    this.chargedByIdempotencyKey.set(ctx.idempotencyKey, charged);
    await this.options.holdAfterCharge?.();
    await ctx.onSubmitted(taskId);

    if (this.timeoutsLeft > 0) {
      this.timeoutsLeft -= 1;
      throw new ProviderTimeoutError(`The fake provider accepted ${taskId ?? 'the call'} but did not answer in time.`, taskId);
    }

    return {
      data,
      actualCostMicros,
      ...(taskId === undefined ? {} : { providerTaskId: taskId }),
      raw: { fake: true, port: ctx.port, operation, sequence },
      currency: this.options.resultCurrency ?? this.options.currency ?? 'USD',
    };
  }

  async reconcile(request: AdapterReconcileRequest, _ctx: AdapterReconcileContext): Promise<AdapterReconcileResult> {
    this.reconcileCount += 1;
    this.reconcileRequests.push(request);
    const charged =
      (request.providerTaskId === undefined ? undefined : this.chargedByTaskId.get(request.providerTaskId)) ??
      this.chargedByIdempotencyKey.get(request.idempotencyKey);
    if (!charged) return { state: 'unknown', reason: 'the fake provider has no record of this call' };
    return {
      state: 'settled',
      actualCostMicros: charged.actualCostMicros,
      data: charged.data,
      raw: charged.raw,
      ...(request.providerTaskId === undefined ? {} : { providerTaskId: request.providerTaskId }),
      currency: this.options.resultCurrency ?? this.options.currency ?? 'USD',
    };
  }
}

export function fakeAdapter(options: FakeAdapterOptions = {}): FakeAdapter {
  return new FakeAdapter(options);
}

function costOf(cost: FakeCost | undefined, operation: string, request: unknown, fallback: number): number {
  if (typeof cost === 'number') return cost;
  if (typeof cost === 'function') return cost(operation, request);
  return fallback;
}

interface LooseRequest {
  keywords?: string[];
  keyword?: string;
  domain?: string;
  domains?: string[];
  targets?: string[];
  url?: string;
  urls?: string[];
  origin?: string;
  query?: string;
  target?: string;
  businessId?: string;
  property?: string;
  propertyId?: string;
  siteUrl?: string;
  prompt?: string;
  engine?: string;
  model?: string;
  kind?: string;
  dimensions?: string[];
  inspectionUrl?: string;
  strategy?: string;
  formFactor?: string;
}

const day = '2026-01-01';
const dateTime = '2026-01-01T00:00:00.000Z';

function keywordMetric(keyword: string) {
  return {
    keyword,
    searchVolume: 1_000,
    cpcMicros: 120_000,
    difficulty: 35,
    intent: 'informational',
    trend: Array.from({ length: 12 }, (_, i) => 500 + i * 10),
    competition: 0.4,
  };
}

function serpResult(position = 1) {
  return {
    position,
    url: `https://example.com/page-${position}`,
    title: 'Example result',
    description: 'A deterministic result from the fake adapter.',
    domain: 'example.com',
    isFeaturedSnippet: false,
  };
}

function backlink() {
  return {
    sourceUrl: 'https://source.example/',
    targetUrl: 'https://example.com/',
    anchor: 'example',
    firstSeen: day,
    lastSeen: day,
    isLost: false,
    authorityScore: 10,
  };
}

function business(id: string | null = 'fake-business') {
  return {
    id,
    name: 'Fake business',
    category: 'SEO agency',
    address: '1 Example Street',
    rating: 4.5,
    reviewCount: 10,
    url: 'https://example.com/',
    phone: '+1 555 0100',
  };
}

function fieldMetrics() {
  return { lcpMs: 2_000, cls: 0.1, inpMs: 100, fidMs: 20 };
}

function cruxMetrics() {
  return { lcpP75Ms: 2_000, clsP75: 0.1, inpP75Ms: 100 };
}

export function defaultFakeData(port: PortName, operation: string, request: unknown): unknown {
  const req = (request ?? {}) as LooseRequest;
  switch (port) {
    case 'KeywordData':
      if (operation === 'metrics') return { keywords: (req.keywords ?? ['example']).map(keywordMetric) };
      if (operation === 'suggestions') return { keywords: [`${req.keyword ?? 'example'} suggestion`] };
      return { keywords: [keywordMetric(req.keyword ?? req.domain ?? 'example')] };
    case 'SerpData':
      if (operation === 'locations') return { locations: [{ name: 'Fake location', locationCode: 1, country: 'US' }] };
      if (operation === 'competitors') return { competitors: [{ domain: 'example.org', overlap: 0.5, sharedKeywords: 10 }] };
      return {
        query: req.query ?? 'example',
        market: 'us',
        location: null,
        results: [serpResult()],
        features: [],
        aiOverview: null,
        competitors: [],
      };
    case 'DomainData':
      if (operation === 'overview')
        return {
          domain: req.domain ?? 'example.com',
          metrics: {
            organicTraffic: 100,
            organicKeywords: 10,
            paidTraffic: 0,
            paidKeywords: 0,
            backlinks: 5,
            referringDomains: 3,
          },
          updatedAt: null,
        };
      if (operation === 'rankedKeywords')
        return {
          keywords: [
            { keyword: 'example', position: 1, searchVolume: 1_000, cpcMicros: 120_000, url: 'https://example.com/', trafficShare: 0.5 },
          ],
        };
      if (operation === 'topPages')
        return { pages: [{ url: 'https://example.com/', organicTraffic: 100, organicKeywords: 10, position: 1 }] };
      if (operation === 'competitors') return { competitors: [{ domain: 'example.org', commonKeywords: 5, organicTraffic: 100 }] };
      return {
        keywords: [
          {
            keyword: 'example',
            searchVolume: 1_000,
            positions: (req.domains ?? ['example.com', 'example.org']).map((domain, i) => ({
              domain,
              position: i + 1,
              url: `https://${domain}/`,
            })),
          },
        ],
      };
    case 'BacklinkData':
      if (operation === 'summary')
        return {
          target: req.target ?? 'example.com',
          backlinks: 5,
          referringDomains: 3,
          referringPages: 4,
          authorityScore: 20,
          newBacklinks: 1,
          lostBacklinks: 0,
          firstSeen: day,
          lastSeen: day,
        };
      if (operation === 'referringDomains')
        return { domains: [{ domain: 'example.org', backlinks: 5, referringPages: 3, authorityScore: 10, firstSeen: day }] };
      if (operation === 'anchors') return { anchors: [{ anchor: 'example', backlinks: 5, referringDomains: 3 }] };
      if (operation === 'newLost') return { new: [backlink()], lost: [] };
      if (operation === 'intersection') return { domains: [{ domain: 'example.org', backlinks: 5, intersects: req.targets ?? [] }] };
      return { backlinks: [backlink()] };
    case 'LocalData':
      if (operation === 'businessSearch') return { businesses: [business()] };
      if (operation === 'businessProfile') return { business: { ...business(), hours: null, categories: ['SEO agency'], attributes: {} } };
      if (operation === 'reviews') return { reviews: [{ rating: 5, text: 'Great', author: 'A person', publishedAt: dateTime }] };
      if (operation === 'updates') return { updates: [{ text: 'An update', publishedAt: dateTime, url: 'https://example.com/' }] };
      if (operation === 'questions') return { questions: [{ question: 'Do you work locally?', answer: 'Yes', askedAt: dateTime }] };
      if (operation === 'categories') return { categories: [{ id: '1', name: 'SEO agency', parent: null }] };
      if (operation === 'localSerp') return { results: [serpResult()] };
      return { points: [{ lat: 1, lng: 2, position: 1, competitors: [] }] };
    case 'AnswerEngines':
      return {
        prompt: req.prompt ?? 'example prompt',
        engine: req.engine ?? 'dataforseo',
        model: req.model ?? 'fake-model',
        answer: 'A deterministic answer.',
        citations: [{ url: 'https://example.com/source', title: 'Source', domain: 'example.com' }],
        answeredAt: dateTime,
      };
    case 'SearchConsole':
      if (operation === 'sites') return { sites: [{ siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' }] };
      if (operation === 'urlInspection')
        return {
          inspectionUrl: req.inspectionUrl ?? 'https://example.com/',
          verdict: 'PASS',
          coverageState: 'Submitted and indexed',
          indexingState: 'INDEXING_ALLOWED',
          lastCrawlTime: null,
          pageFetchState: 'SUCCESSFUL',
          robotsTxtState: 'ALLOWED',
          mobileUsability: 'PASS',
        };
      if (operation === 'sitemaps')
        return {
          sitemaps: [
            {
              path: 'https://example.com/sitemap.xml',
              type: 'sitemap',
              lastSubmitted: null,
              lastDownloaded: null,
              warnings: 0,
              errors: 0,
              isPending: false,
            },
          ],
        };
      return {
        rows: [
          {
            keys: (req.dimensions ?? ['query']).map((d) => (d === 'date' ? day : 'example')),
            clicks: 1,
            impressions: 10,
            ctr: 0.1,
            position: 3,
          },
        ],
        finality: 'provisional',
        coverage: null,
      };
    case 'Analytics':
      if (operation === 'properties') return { properties: [{ propertyId: '1', displayName: 'Fake property', propertyType: 'GA4' }] };
      return {
        kind: req.kind ?? 'pagePerformance',
        rows: [{ dimensions: { page: '/' }, metrics: { sessions: 1 } }],
        finality: 'provisional',
      };
    case 'PageExperience':
      if (operation === 'psi')
        return {
          url: req.url ?? 'https://example.com/',
          strategy: req.strategy ?? 'mobile',
          lighthouse: { performance: 90, accessibility: 90, seo: 90, bestPractices: 90 },
          field: fieldMetrics(),
          fetchedAt: dateTime,
        };
      if (operation === 'cruxHistory') return { series: [{ date: day, metrics: cruxMetrics() }] };
      return {
        records: [{ url: req.urls?.[0] ?? req.origin ?? 'https://example.com/', metrics: cruxMetrics(), collectionPeriod: day }],
      };
    case 'IndexSubmit':
      if (operation === 'gscSitemap') return { submitted: true, lastSubmitted: null };
      return { submitted: req.urls?.length ?? 0, rejected: [] };
    case 'WebmasterData':
      if (operation === 'backlinks') return { backlinks: [backlink()] };
      if (operation === 'crawlIssues')
        return { issues: [{ url: 'https://example.com/', severity: 'warning', issue: 'A test issue', detectedAt: null }] };
      return { rows: [{ query: 'example', clicks: 1, impressions: 10, ctr: 0.1, position: 3 }] };
  }
}
