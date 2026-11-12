import { AppError } from '@agentic-seo/core';
import { z } from 'zod';

// Typed ports for every external data source (data-providers.md §2). A feature asks for a port and
// an operation; only an adapter in `providers` talks to the vendor. The schemas are the normalised
// shapes we store and return, not the vendor's payloads. Metrics that a provider may not know are
// nullable, so "not available" is never silently rendered as zero.

export const PORT_NAMES = [
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
] as const;
export type PortName = (typeof PORT_NAMES)[number];

const Market = z.string().min(1).max(32).describe('Market code, e.g. "us"');
const Language = z.string().min(2).max(16).describe('Language code, e.g. "en"');
const Url = z.string().url();
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a calendar day, YYYY-MM-DD');

export const KeywordIntent = z.enum(['informational', 'navigational', 'commercial', 'transactional', 'unknown']);
export type KeywordIntent = z.infer<typeof KeywordIntent>;

export const KeywordMetric = z.object({
  keyword: z.string(),
  searchVolume: z.number().int().nullable(),
  cpcMicros: z.number().int().nullable().describe('Cost per click in millionths of the currency unit; null when unknown'),
  difficulty: z.number().nullable(),
  intent: KeywordIntent.nullable(),
  trend: z.array(z.number().nullable()).length(12).nullable().describe('Twelve monthly values, oldest first'),
  competition: z.number().nullable(),
});
export type KeywordMetric = z.infer<typeof KeywordMetric>;

export const SerpResult = z.object({
  position: z.number().int().positive(),
  url: Url,
  title: z.string(),
  description: z.string().nullable(),
  domain: z.string(),
  isFeaturedSnippet: z.boolean(),
});
export type SerpResult = z.infer<typeof SerpResult>;

export const Citation = z.object({
  url: Url,
  title: z.string().nullable(),
  domain: z.string().nullable(),
});
export type Citation = z.infer<typeof Citation>;

export const AiOverview = z.object({
  present: z.boolean(),
  text: z.string().nullable(),
  citations: z.array(Citation),
});
export type AiOverview = z.infer<typeof AiOverview>;

const Backlink = z.object({
  sourceUrl: Url,
  targetUrl: Url,
  anchor: z.string().nullable(),
  firstSeen: Day.nullable(),
  lastSeen: Day.nullable(),
  isLost: z.boolean(),
  authorityScore: z.number().nullable(),
});
export type Backlink = z.infer<typeof Backlink>;

const Business = z.object({
  id: z.string().nullable(),
  name: z.string(),
  category: z.string().nullable(),
  address: z.string().nullable(),
  rating: z.number().nullable(),
  reviewCount: z.number().int().nullable(),
  url: Url.nullable(),
  phone: z.string().nullable(),
});
export type Business = z.infer<typeof Business>;

const FieldMetrics = z.object({
  lcpMs: z.number().nullable(),
  cls: z.number().nullable(),
  inpMs: z.number().nullable(),
  fidMs: z.number().nullable(),
});
export type FieldMetrics = z.infer<typeof FieldMetrics>;

const LighthouseScores = z.object({
  performance: z.number().nullable(),
  accessibility: z.number().nullable(),
  seo: z.number().nullable(),
  bestPractices: z.number().nullable(),
});
export type LighthouseScores = z.infer<typeof LighthouseScores>;

export const AnalyticsReportKind = z.enum([
  'pagePerformance',
  'landingPages',
  'acquisition',
  'keyEvents',
  'ecommerce',
  'siteSearch',
  'audience',
  'measurementHealth',
]);
export type AnalyticsReportKind = z.infer<typeof AnalyticsReportKind>;

export const SearchConsoleDimension = z.enum(['query', 'page', 'country', 'device', 'date']);
export type SearchConsoleDimension = z.infer<typeof SearchConsoleDimension>;

export interface PortOperation {
  request: z.ZodType;
  response: z.ZodType;
  /** Cache lifetime in seconds. Zero means the operation is never cached (submissions). */
  ttlSeconds: number;
}

export interface PortDefinition {
  name: PortName;
  title: string;
  /** The credential that unlocks this port, named in the "no adapter configured" error. */
  unlock: { key: string; label: string };
  operations: Record<string, PortOperation>;
}

const WEEK = 7 * 24 * 60 * 60;
const DAY = 24 * 60 * 60;
const HOUR = 60 * 60;

const keywordMetricFields = (keyword: string): KeywordMetric => ({
  keyword,
  searchVolume: 1_000,
  cpcMicros: 120_000,
  difficulty: 35,
  intent: 'informational',
  trend: Array.from({ length: 12 }, (_, i) => 500 + i * 10),
  competition: 0.4,
});

export const keywordData: PortDefinition = {
  name: 'KeywordData',
  title: 'Keyword data',
  unlock: { key: 'dataforseo.login', label: 'a DataForSEO API key' },
  operations: {
    metrics: {
      request: z.object({ keywords: z.array(z.string().min(1)).min(1).max(1_000), market: Market, language: Language.optional() }),
      response: z.object({ keywords: z.array(KeywordMetric) }),
      ttlSeconds: WEEK,
    },
    suggestions: {
      request: z.object({ keyword: z.string().min(1), market: Market, limit: z.number().int().min(1).max(1_000).default(100) }),
      response: z.object({ keywords: z.array(z.string()) }),
      ttlSeconds: WEEK,
    },
    ideas: {
      request: z.object({
        keyword: z.string().min(1).optional(),
        domain: z.string().min(1).optional(),
        url: Url.optional(),
        market: Market,
        limit: z.number().int().min(1).max(1_000).default(100),
      }),
      response: z.object({ keywords: z.array(KeywordMetric) }),
      ttlSeconds: WEEK,
    },
    related: {
      request: z.object({ keyword: z.string().min(1), market: Market, limit: z.number().int().min(1).max(1_000).default(100) }),
      response: z.object({ keywords: z.array(KeywordMetric) }),
      ttlSeconds: WEEK,
    },
    forDomain: {
      request: z.object({
        domain: z.string().min(1),
        market: Market,
        limit: z.number().int().min(1).max(1_000).default(100),
        sort: z.enum(['traffic', 'volume', 'position']).default('traffic'),
      }),
      response: z.object({ keywords: z.array(KeywordMetric) }),
      ttlSeconds: WEEK,
    },
    forUrl: {
      request: z.object({ url: Url, market: Market, limit: z.number().int().min(1).max(1_000).default(100) }),
      response: z.object({ keywords: z.array(KeywordMetric) }),
      ttlSeconds: WEEK,
    },
  },
};

export const serpData: PortDefinition = {
  name: 'SerpData',
  title: 'Search results',
  unlock: { key: 'dataforseo.login', label: 'a DataForSEO API key' },
  operations: {
    organic: {
      request: z.object({
        query: z.string().min(1),
        market: Market,
        language: Language.optional(),
        location: z.string().min(1).optional(),
        device: z.enum(['desktop', 'mobile']).default('desktop'),
        depth: z.number().int().min(1).max(100).default(10),
      }),
      response: z.object({
        query: z.string(),
        market: z.string(),
        location: z.string().nullable(),
        results: z.array(SerpResult),
        features: z.array(z.string()),
        aiOverview: AiOverview.nullable(),
        competitors: z.array(z.string()),
      }),
      ttlSeconds: DAY,
    },
    locations: {
      request: z.object({ query: z.string().min(1), country: z.string().min(2).max(2).optional() }),
      response: z.object({
        locations: z.array(z.object({ name: z.string(), locationCode: z.number().int(), country: z.string() })),
      }),
      ttlSeconds: 30 * DAY,
    },
    competitors: {
      request: z.object({
        query: z.string().min(1),
        market: Market,
        location: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(10),
      }),
      response: z.object({
        competitors: z.array(z.object({ domain: z.string(), overlap: z.number().nullable(), sharedKeywords: z.number().int().nullable() })),
      }),
      ttlSeconds: 3 * DAY,
    },
  },
};

export const domainData: PortDefinition = {
  name: 'DomainData',
  title: 'Domain data',
  unlock: { key: 'dataforseo.login', label: 'a DataForSEO API key' },
  operations: {
    overview: {
      request: z.object({
        domain: z.string().min(1),
        market: Market.optional(),
        scope: z.enum(['domain', 'subdomain', 'url']).default('domain'),
      }),
      response: z.object({
        domain: z.string(),
        metrics: z.object({
          organicTraffic: z.number().nullable(),
          organicKeywords: z.number().int().nullable(),
          paidTraffic: z.number().nullable(),
          paidKeywords: z.number().int().nullable(),
          backlinks: z.number().int().nullable(),
          referringDomains: z.number().int().nullable(),
        }),
        updatedAt: z.string().nullable(),
      }),
      ttlSeconds: 3 * DAY,
    },
    rankedKeywords: {
      request: z.object({
        domain: z.string().min(1),
        market: Market,
        limit: z.number().int().min(1).max(1_000).default(100),
        offset: z.number().int().min(0).default(0),
      }),
      response: z.object({
        keywords: z.array(
          z.object({
            keyword: z.string(),
            position: z.number().int().nullable(),
            searchVolume: z.number().int().nullable(),
            cpcMicros: z.number().int().nullable(),
            url: Url.nullable(),
            trafficShare: z.number().nullable(),
          }),
        ),
      }),
      ttlSeconds: 3 * DAY,
    },
    topPages: {
      request: z.object({ domain: z.string().min(1), market: Market, limit: z.number().int().min(1).max(1_000).default(100) }),
      response: z.object({
        pages: z.array(
          z.object({
            url: Url,
            organicTraffic: z.number().nullable(),
            organicKeywords: z.number().int().nullable(),
            position: z.number().nullable(),
          }),
        ),
      }),
      ttlSeconds: 3 * DAY,
    },
    competitors: {
      request: z.object({ domain: z.string().min(1), market: Market, limit: z.number().int().min(1).max(100).default(10) }),
      response: z.object({
        competitors: z.array(
          z.object({ domain: z.string(), commonKeywords: z.number().int().nullable(), organicTraffic: z.number().nullable() }),
        ),
      }),
      ttlSeconds: 3 * DAY,
    },
    intersection: {
      request: z.object({
        domains: z.array(z.string().min(1)).min(2).max(10),
        market: Market,
        limit: z.number().int().min(1).max(1_000).default(100),
      }),
      response: z.object({
        keywords: z.array(
          z.object({
            keyword: z.string(),
            searchVolume: z.number().int().nullable(),
            positions: z.array(z.object({ domain: z.string(), position: z.number().int(), url: Url.nullable() })),
          }),
        ),
      }),
      ttlSeconds: 3 * DAY,
    },
  },
};

export const backlinkData: PortDefinition = {
  name: 'BacklinkData',
  title: 'Backlink data',
  unlock: { key: 'dataforseo.login', label: 'a DataForSEO API key (or a Moz Links key)' },
  operations: {
    summary: {
      request: z.object({ target: z.string().min(1), scope: z.enum(['domain', 'url']).default('domain') }),
      response: z.object({
        target: z.string(),
        backlinks: z.number().int().nullable(),
        referringDomains: z.number().int().nullable(),
        referringPages: z.number().int().nullable(),
        authorityScore: z.number().nullable(),
        newBacklinks: z.number().int().nullable(),
        lostBacklinks: z.number().int().nullable(),
        firstSeen: Day.nullable(),
        lastSeen: Day.nullable(),
      }),
      ttlSeconds: WEEK,
    },
    referringDomains: {
      request: z.object({
        target: z.string().min(1),
        limit: z.number().int().min(1).max(1_000).default(100),
        offset: z.number().int().min(0).default(0),
      }),
      response: z.object({
        domains: z.array(
          z.object({
            domain: z.string(),
            backlinks: z.number().int().nullable(),
            referringPages: z.number().int().nullable(),
            authorityScore: z.number().nullable(),
            firstSeen: Day.nullable(),
          }),
        ),
      }),
      ttlSeconds: WEEK,
    },
    backlinks: {
      request: z.object({
        target: z.string().min(1),
        limit: z.number().int().min(1).max(1_000).default(100),
        offset: z.number().int().min(0).default(0),
      }),
      response: z.object({ backlinks: z.array(Backlink) }),
      ttlSeconds: WEEK,
    },
    anchors: {
      request: z.object({ target: z.string().min(1), limit: z.number().int().min(1).max(1_000).default(100) }),
      response: z.object({
        anchors: z.array(z.object({ anchor: z.string().nullable(), backlinks: z.number().int(), referringDomains: z.number().int() })),
      }),
      ttlSeconds: WEEK,
    },
    newLost: {
      request: z.object({
        target: z.string().min(1),
        since: Day.optional(),
        until: Day.optional(),
        limit: z.number().int().min(1).max(1_000).default(100),
      }),
      response: z.object({ new: z.array(Backlink), lost: z.array(Backlink) }),
      ttlSeconds: DAY,
    },
    intersection: {
      request: z.object({ targets: z.array(z.string().min(1)).min(2).max(10), limit: z.number().int().min(1).max(1_000).default(100) }),
      response: z.object({
        domains: z.array(z.object({ domain: z.string(), backlinks: z.number().int().nullable(), intersects: z.array(z.string()) })),
      }),
      ttlSeconds: WEEK,
    },
  },
};

export const localData: PortDefinition = {
  name: 'LocalData',
  title: 'Local data',
  unlock: { key: 'dataforseo.login', label: 'a DataForSEO API key' },
  operations: {
    businessSearch: {
      request: z.object({ query: z.string().min(1), location: z.string().optional(), market: Market.optional() }),
      response: z.object({ businesses: z.array(Business) }),
      ttlSeconds: DAY,
    },
    businessProfile: {
      request: z.object({ businessId: z.string().optional(), name: z.string().optional(), location: z.string().optional() }),
      response: z.object({
        business: Business.extend({
          hours: z.record(z.string(), z.string()).nullable(),
          categories: z.array(z.string()),
          attributes: z.record(z.string(), z.string()),
        }),
      }),
      ttlSeconds: WEEK,
    },
    reviews: {
      request: z.object({ businessId: z.string().min(1), limit: z.number().int().min(1).max(1_000).default(100) }),
      response: z.object({
        reviews: z.array(
          z.object({
            rating: z.number().nullable(),
            text: z.string().nullable(),
            author: z.string().nullable(),
            publishedAt: z.string().nullable(),
          }),
        ),
      }),
      ttlSeconds: DAY,
    },
    updates: {
      request: z.object({ businessId: z.string().min(1), limit: z.number().int().min(1).max(1_000).default(100) }),
      response: z.object({
        updates: z.array(z.object({ text: z.string(), publishedAt: z.string().nullable(), url: Url.nullable() })),
      }),
      ttlSeconds: DAY,
    },
    questions: {
      request: z.object({ businessId: z.string().min(1), limit: z.number().int().min(1).max(1_000).default(100) }),
      response: z.object({
        questions: z.array(z.object({ question: z.string(), answer: z.string().nullable(), askedAt: z.string().nullable() })),
      }),
      ttlSeconds: DAY,
    },
    categories: {
      request: z.object({ query: z.string().optional(), market: Market.optional() }),
      response: z.object({ categories: z.array(z.object({ id: z.string(), name: z.string(), parent: z.string().nullable() })) }),
      ttlSeconds: 30 * DAY,
    },
    localSerp: {
      request: z.object({ query: z.string().min(1), location: z.string().min(1), market: Market.optional() }),
      response: z.object({ results: z.array(SerpResult) }),
      ttlSeconds: DAY,
    },
    geoGrid: {
      request: z.object({
        query: z.string().min(1),
        location: z.string().min(1),
        gridSize: z.number().int().min(1).max(21).default(5),
        radiusKm: z.number().positive().default(5),
      }),
      response: z.object({
        points: z.array(
          z.object({ lat: z.number(), lng: z.number(), position: z.number().int().nullable(), competitors: z.array(z.string()) }),
        ),
      }),
      ttlSeconds: WEEK,
    },
  },
};

export const AnswerEngine = z.enum(['openai', 'anthropic', 'gemini', 'perplexity', 'dataforseo']);
export type AnswerEngine = z.infer<typeof AnswerEngine>;

export const answerEngines: PortDefinition = {
  name: 'AnswerEngines',
  title: 'Answer engines',
  unlock: { key: 'llm.api_key', label: 'an LLM API key or a DataForSEO API key' },
  operations: {
    ask: {
      request: z.object({
        prompt: z.string().min(1).max(32_000),
        engine: AnswerEngine,
        model: z.string().optional(),
        market: Market.optional(),
        locale: z.string().optional(),
      }),
      response: z.object({
        prompt: z.string(),
        engine: z.string(),
        model: z.string(),
        answer: z.string(),
        citations: z.array(Citation),
        answeredAt: z.string(),
      }),
      ttlSeconds: DAY,
    },
  },
};

export const searchConsole: PortDefinition = {
  name: 'SearchConsole',
  title: 'Search Console',
  unlock: { key: 'google.oauth', label: 'a Google Search Console connection' },
  operations: {
    sites: {
      request: z.object({}),
      response: z.object({ sites: z.array(z.object({ siteUrl: z.string(), permissionLevel: z.string() })) }),
      ttlSeconds: HOUR,
    },
    searchAnalytics: {
      request: z.object({
        property: z.string().min(1).describe('The GSC property, e.g. "sc-domain:example.com"'),
        startDate: Day,
        endDate: Day,
        dimensions: z.array(SearchConsoleDimension).min(1).max(4).default(['query']),
        rowLimit: z.number().int().min(1).max(25_000).default(1_000),
        searchType: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).default('web'),
        filters: z
          .array(
            z.object({
              dimension: SearchConsoleDimension,
              operator: z.enum(['equals', 'contains', 'notContains', 'includingRegex', 'excludingRegex']),
              expression: z.string(),
            }),
          )
          .optional(),
      }),
      response: z.object({
        rows: z.array(
          z.object({
            keys: z.array(z.string()),
            clicks: z.number(),
            impressions: z.number(),
            ctr: z.number(),
            position: z.number(),
          }),
        ),
        finality: z.enum(['provisional', 'final']).nullable(),
        coverage: z.number().nullable().describe('Share of clicks the query rows cover, when the provider reports it'),
      }),
      ttlSeconds: DAY,
    },
    urlInspection: {
      request: z.object({ property: z.string().min(1), inspectionUrl: Url }),
      response: z.object({
        inspectionUrl: Url,
        verdict: z.string(),
        coverageState: z.string().nullable(),
        indexingState: z.string().nullable(),
        lastCrawlTime: z.string().nullable(),
        pageFetchState: z.string().nullable(),
        robotsTxtState: z.string().nullable(),
        mobileUsability: z.string().nullable(),
      }),
      ttlSeconds: DAY,
    },
    sitemaps: {
      request: z.object({ property: z.string().min(1) }),
      response: z.object({
        sitemaps: z.array(
          z.object({
            path: z.string(),
            type: z.string().nullable(),
            lastSubmitted: z.string().nullable(),
            lastDownloaded: z.string().nullable(),
            warnings: z.number().int(),
            errors: z.number().int(),
            isPending: z.boolean(),
          }),
        ),
      }),
      ttlSeconds: HOUR,
    },
  },
};

export const analytics: PortDefinition = {
  name: 'Analytics',
  title: 'Analytics',
  unlock: { key: 'google.oauth', label: 'a Google Analytics connection' },
  operations: {
    properties: {
      request: z.object({}),
      response: z.object({
        properties: z.array(z.object({ propertyId: z.string(), displayName: z.string(), propertyType: z.string().nullable() })),
      }),
      ttlSeconds: DAY,
    },
    report: {
      request: z.object({
        propertyId: z.string().min(1),
        kind: AnalyticsReportKind,
        startDate: Day,
        endDate: Day,
        limit: z.number().int().min(1).max(100_000).default(1_000),
        dimensions: z.array(z.string()).optional(),
      }),
      response: z.object({
        kind: z.string(),
        rows: z.array(z.object({ dimensions: z.record(z.string(), z.string()), metrics: z.record(z.string(), z.number().nullable()) })),
        finality: z.enum(['provisional', 'final']).nullable(),
      }),
      ttlSeconds: DAY,
    },
  },
};

export const pageExperience: PortDefinition = {
  name: 'PageExperience',
  title: 'Page experience',
  unlock: { key: 'google.pagespeed.api_key', label: 'a PageSpeed Insights API key' },
  operations: {
    psi: {
      request: z.object({ url: Url, strategy: z.enum(['mobile', 'desktop']).default('mobile') }),
      response: z.object({
        url: Url,
        strategy: z.string(),
        lighthouse: LighthouseScores,
        field: FieldMetrics.nullable(),
        fetchedAt: z.string(),
      }),
      ttlSeconds: DAY,
    },
    crux: {
      request: z.object({
        urls: z.array(Url).min(1).max(10).optional(),
        origin: z.string().optional(),
        formFactor: z.enum(['PHONE', 'DESKTOP', 'TABLET']).default('PHONE'),
      }),
      response: z.object({
        records: z.array(
          z.object({
            url: z.string(),
            metrics: z.object({ lcpP75Ms: z.number().nullable(), clsP75: z.number().nullable(), inpP75Ms: z.number().nullable() }),
            collectionPeriod: z.string().nullable(),
          }),
        ),
      }),
      ttlSeconds: DAY,
    },
    cruxHistory: {
      request: z.object({
        url: z.string().optional(),
        origin: z.string().optional(),
        formFactor: z.enum(['PHONE', 'DESKTOP', 'TABLET']).default('PHONE'),
        months: z.number().int().min(1).max(25).default(12),
      }),
      response: z.object({
        series: z.array(
          z.object({
            date: Day,
            metrics: z.object({ lcpP75Ms: z.number().nullable(), clsP75: z.number().nullable(), inpP75Ms: z.number().nullable() }),
          }),
        ),
      }),
      ttlSeconds: DAY,
    },
  },
};

export const indexSubmit: PortDefinition = {
  name: 'IndexSubmit',
  title: 'Index submission',
  unlock: { key: 'indexnow.key', label: 'an IndexNow key or a Bing Webmaster API key' },
  operations: {
    indexNow: {
      request: z.object({ urls: z.array(Url).min(1).max(10_000), host: z.string().optional() }),
      response: z.object({ submitted: z.number().int(), rejected: z.array(Url) }),
      ttlSeconds: 0,
    },
    bingUrl: {
      request: z.object({ urls: z.array(Url).min(1).max(10_000), siteUrl: z.string().optional() }),
      response: z.object({ submitted: z.number().int(), rejected: z.array(Url) }),
      ttlSeconds: 0,
    },
    gscSitemap: {
      request: z.object({ property: z.string().min(1), sitemapUrl: Url }),
      response: z.object({ submitted: z.boolean(), lastSubmitted: z.string().nullable() }),
      ttlSeconds: 0,
    },
  },
};

export const webmasterData: PortDefinition = {
  name: 'WebmasterData',
  title: 'Webmaster data',
  unlock: { key: 'bing.api_key', label: 'a Bing Webmaster API key' },
  operations: {
    queries: {
      request: z.object({
        siteUrl: z.string().min(1),
        startDate: Day.optional(),
        endDate: Day.optional(),
        limit: z.number().int().min(1).max(25_000).default(1_000),
      }),
      response: z.object({
        rows: z.array(
          z.object({
            query: z.string(),
            clicks: z.number(),
            impressions: z.number(),
            ctr: z.number(),
            position: z.number(),
          }),
        ),
      }),
      ttlSeconds: DAY,
    },
    backlinks: {
      request: z.object({ siteUrl: z.string().min(1), limit: z.number().int().min(1).max(1_000).default(100) }),
      response: z.object({ backlinks: z.array(Backlink) }),
      ttlSeconds: WEEK,
    },
    crawlIssues: {
      request: z.object({ siteUrl: z.string().min(1), limit: z.number().int().min(1).max(1_000).default(100) }),
      response: z.object({
        issues: z.array(
          z.object({
            url: Url,
            severity: z.enum(['error', 'warning', 'info']),
            issue: z.string(),
            detectedAt: z.string().nullable(),
          }),
        ),
      }),
      ttlSeconds: DAY,
    },
  },
};

export const PORTS: Record<PortName, PortDefinition> = {
  KeywordData: keywordData,
  SerpData: serpData,
  DomainData: domainData,
  BacklinkData: backlinkData,
  LocalData: localData,
  AnswerEngines: answerEngines,
  SearchConsole: searchConsole,
  Analytics: analytics,
  PageExperience: pageExperience,
  IndexSubmit: indexSubmit,
  WebmasterData: webmasterData,
};

export function operationDefinition(port: PortName, operation: string): PortOperation {
  const definition = PORTS[port];
  const op = definition?.operations[operation];
  if (!op) {
    const known = definition ? Object.keys(definition.operations).join(', ') : '';
    throw new AppError('invalid_input', `Unknown operation "${operation}" for ${port}. Known operations: ${known}.`);
  }
  return op;
}

/** The fake adapter's deterministic minimal response for an operation, useful in tests and previews. */
export function sampleKeywordMetric(keyword: string): KeywordMetric {
  return keywordMetricFields(keyword);
}
