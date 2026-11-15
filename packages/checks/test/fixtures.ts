import type { HtmlFacts, PageFacts, SiteFacts } from '@agentic-seo/crawl';

// Test builders and the fixture registry. Every check must have a passing and a failing fixture;
// `catalogue.test.ts` fails when one is missing, so a new check cannot land untested. Page and site
// fixtures are executable facts. Finalize checks run in SQL later, so their fixtures are written
// scenarios: the pass and fail case the finalize task must reproduce.

export function htmlFacts(overrides: Partial<HtmlFacts> = {}): HtmlFacts {
  return {
    lang: 'en',
    title: 'A useful guide to example topics',
    titleCount: 1,
    metaDescription: 'A practical guide to example topics, with the details and examples a reader needs to choose well.',
    metaDescriptionCount: 1,
    metaRobots: [],
    canonical: null,
    canonicals: [],
    canonicalOutsideHead: false,
    viewport: 'width=device-width, initial-scale=1',
    charset: 'utf-8',
    hreflang: [],
    headings: [
      { level: 1, text: 'A useful guide' },
      { level: 2, text: 'Details' },
    ],
    links: [{ href: 'https://example.com/about', rawHref: '/about', rel: [], text: 'About', internal: true }],
    images: [
      {
        src: 'https://example.com/diagram.png',
        alt: 'A diagram of the process',
        width: '800',
        height: '600',
        loading: 'lazy',
        inLink: false,
      },
    ],
    jsonLd: [
      {
        raw: '{"@context":"https://schema.org","@type":"WebPage","name":"Example"}',
        parsed: { '@context': 'https://schema.org', '@type': 'WebPage', name: 'Example' },
        error: null,
        types: ['WebPage'],
      },
    ],
    microdataTypes: [],
    openGraph: {},
    twitter: {},
    wordCount: 500,
    contentHash: 'a'.repeat(64),
    mixedContent: [],
    insecureForms: [],
    ...overrides,
  };
}

export interface PageFactsOverrides extends Omit<Partial<PageFacts>, 'html' | 'headers'> {
  /** Partial HTML facts, merged over the good default; null makes the page non-HTML. */
  html?: Partial<HtmlFacts> | null;
  headers?: Partial<PageFacts['headers']>;
}

/** A good page by default: 200, HTML, indexable, with a title, description, h1 and schema. */
export function pageFacts(overrides: PageFactsOverrides = {}): PageFacts {
  const { html: htmlOverrides, headers: headerOverrides, ...rest } = overrides;
  const url = rest.url ?? 'https://example.com/';
  const finalUrl = rest.finalUrl ?? url;
  let html: HtmlFacts | null = null;
  if (htmlOverrides !== null) {
    const canonical = htmlOverrides?.canonical === undefined ? finalUrl : htmlOverrides.canonical;
    const canonicals = htmlOverrides?.canonicals ?? (canonical ? [canonical] : []);
    html = htmlFacts({ ...htmlOverrides, canonical, canonicals });
  }
  return {
    url,
    finalUrl,
    status: 200,
    redirects: [],
    fetchError: null,
    contentType: 'text/html; charset=utf-8',
    isHtml: html !== null,
    headers: {
      xRobotsTag: null,
      contentLanguage: 'en',
      strictTransportSecurity: 'max-age=31536000; includeSubDomains',
      link: null,
      ...headerOverrides,
    },
    ttfbMs: 120,
    totalMs: 300,
    bytes: 24_000,
    depth: 0,
    discoveredBy: 'seed',
    inSitemap: true,
    robotsAllowed: true,
    ...rest,
    html,
  };
}

export interface SiteFactsOverrides extends Omit<Partial<SiteFacts>, 'robotsTxt' | 'sitemaps' | 'home'> {
  robotsTxt?: Partial<SiteFacts['robotsTxt']>;
  sitemaps?: SiteFacts['sitemaps'];
  home?: PageFacts | null;
}

/** A good site by default: reachable robots.txt, a working sitemap, https home with HSTS. */
export function siteFacts(overrides: SiteFactsOverrides = {}): SiteFacts {
  const { robotsTxt, sitemaps, home, ...rest } = overrides;
  const origin = rest.origin ?? 'https://example.com';
  return {
    origin,
    robotsTxt: {
      url: `${origin}/robots.txt`,
      status: 200,
      fetchError: null,
      parseErrors: [],
      sitemaps: [`${origin}/sitemap.xml`],
      disallowAllFor: [],
      body: 'User-agent: *\nAllow: /',
      ...robotsTxt,
    },
    sitemaps: sitemaps ?? [{ url: `${origin}/sitemap.xml`, status: 200, fetchError: null, kind: 'urlset', urlCount: 3, errors: [] }],
    home: home === undefined ? pageFacts({ url: `${origin}/`, finalUrl: `${origin}/` }) : home,
    httpRedirectsToHttps: true,
    ...rest,
  };
}

/** Executable pass and fail cases for page checks, keyed by check id. */
export const pageFixtures: Record<string, { pass: PageFacts; fail: PageFacts }> = {
  'indexability.noindex': {
    pass: pageFacts(),
    fail: pageFacts({ html: { metaRobots: ['noindex'] } }),
  },
  'indexability.x_robots_noindex': {
    pass: pageFacts(),
    fail: pageFacts({ headers: { xRobotsTag: 'googlebot: noindex' } }),
  },
  'canonical.missing': {
    pass: pageFacts(),
    fail: pageFacts({ html: { canonical: null } }),
  },
  'canonical.multiple': {
    pass: pageFacts(),
    fail: pageFacts({ html: { canonicals: ['https://example.com/', 'https://example.com/home'] } }),
  },
  'canonical.outside_head': {
    pass: pageFacts(),
    fail: pageFacts({ html: { canonicalOutsideHead: true } }),
  },
  'canonical.conflict_noindex': {
    pass: pageFacts(),
    fail: pageFacts({
      html: { metaRobots: ['noindex'], canonical: 'https://example.com/other', canonicals: ['https://example.com/other'] },
    }),
  },
  'status.client_error': {
    pass: pageFacts(),
    fail: pageFacts({ status: 404, discoveredBy: 'link' }),
  },
  'status.server_error': {
    pass: pageFacts(),
    fail: pageFacts({ status: 503 }),
  },
  'status.fetch_failed': {
    pass: pageFacts(),
    fail: pageFacts({ status: 0, fetchError: 'timeout', html: null }),
  },
  'redirect.chain': {
    pass: pageFacts(),
    fail: pageFacts({
      url: 'https://example.com/a',
      finalUrl: 'https://example.com/c',
      redirects: [
        { url: 'https://example.com/a', status: 301, location: 'https://example.com/b' },
        { url: 'https://example.com/b', status: 301, location: 'https://example.com/c' },
      ],
    }),
  },
  'redirect.loop': {
    pass: pageFacts(),
    fail: pageFacts({
      url: 'https://example.com/a',
      finalUrl: 'https://example.com/a',
      status: 0,
      fetchError: 'redirect_loop',
      html: null,
      redirects: [
        { url: 'https://example.com/a', status: 301, location: 'https://example.com/b' },
        { url: 'https://example.com/b', status: 301, location: 'https://example.com/a' },
      ],
    }),
  },
  'redirect.temporary': {
    pass: pageFacts(),
    fail: pageFacts({
      url: 'https://example.com/old',
      finalUrl: 'https://example.com/new',
      redirects: [{ url: 'https://example.com/old', status: 302, location: 'https://example.com/new' }],
    }),
  },
  'links.nofollow_internal': {
    pass: pageFacts(),
    fail: pageFacts({
      html: { links: [{ href: 'https://example.com/about', rawHref: '/about', rel: ['nofollow'], text: 'About', internal: true }] },
    }),
  },
  'links.insecure_internal': {
    pass: pageFacts(),
    fail: pageFacts({
      html: { links: [{ href: 'http://example.com/about', rawHref: 'http://example.com/about', rel: [], text: 'About', internal: true }] },
    }),
  },
  'title.missing': {
    pass: pageFacts(),
    fail: pageFacts({ html: { title: null, titleCount: 0 } }),
  },
  'title.empty': {
    pass: pageFacts(),
    fail: pageFacts({ html: { title: '', titleCount: 1 } }),
  },
  'title.too_long': {
    pass: pageFacts(),
    fail: pageFacts({
      html: {
        title:
          'A very long title that goes on and on about every single detail of the page and then keeps going past the point where Google cuts it off in results',
      },
    }),
  },
  'title.too_short': {
    pass: pageFacts(),
    fail: pageFacts({ html: { title: 'Hi' } }),
  },
  'title.multiple': {
    pass: pageFacts(),
    fail: pageFacts({ html: { title: 'First title for the page', titleCount: 2 } }),
  },
  'description.missing': {
    pass: pageFacts(),
    fail: pageFacts({ html: { metaDescription: null, metaDescriptionCount: 0 } }),
  },
  'description.too_long': {
    pass: pageFacts(),
    fail: pageFacts({ html: { metaDescription: 'A long description. '.repeat(12) } }),
  },
  'description.too_short': {
    pass: pageFacts(),
    fail: pageFacts({ html: { metaDescription: 'Short description.' } }),
  },
  'description.multiple': {
    pass: pageFacts(),
    fail: pageFacts({ html: { metaDescriptionCount: 2 } }),
  },
  'h1.missing': {
    pass: pageFacts(),
    fail: pageFacts({ html: { headings: [{ level: 2, text: 'Section' }] } }),
  },
  'h1.multiple': {
    pass: pageFacts(),
    fail: pageFacts({
      html: {
        headings: [
          { level: 1, text: 'One' },
          { level: 1, text: 'Two' },
          { level: 2, text: 'Details' },
        ],
      },
    }),
  },
  'headings.skipped_level': {
    pass: pageFacts(),
    fail: pageFacts({
      html: {
        headings: [
          { level: 1, text: 'One' },
          { level: 3, text: 'Three' },
        ],
      },
    }),
  },
  'content.thin': {
    pass: pageFacts({ url: 'https://example.com/guide' }),
    fail: pageFacts({ url: 'https://example.com/guide', html: { wordCount: 80 } }),
  },
  'html.lang_missing': {
    pass: pageFacts(),
    fail: pageFacts({ html: { lang: null } }),
  },
  'viewport.missing': {
    pass: pageFacts(),
    fail: pageFacts({ html: { viewport: null } }),
  },
  'schema.parse_error': {
    pass: pageFacts(),
    fail: pageFacts({ html: { jsonLd: [{ raw: '{ bad json', parsed: null, error: 'Unexpected token', types: [] }] } }),
  },
  'schema.missing_type': {
    pass: pageFacts(),
    fail: pageFacts({
      html: {
        jsonLd: [{ raw: '{"@context":"https://schema.org"}', parsed: { '@context': 'https://schema.org' }, error: null, types: [] }],
      },
    }),
  },
  'schema.deprecated_type': {
    pass: pageFacts(),
    fail: pageFacts({ html: { jsonLd: [{ raw: '{"@type":"HowTo"}', parsed: { '@type': 'HowTo' }, error: null, types: ['HowTo'] }] } }),
  },
  'schema.rich_result_restricted': {
    pass: pageFacts(),
    fail: pageFacts({
      html: { jsonLd: [{ raw: '{"@type":"FAQPage"}', parsed: { '@type': 'FAQPage' }, error: null, types: ['FAQPage'] }] },
    }),
  },
  'schema.missing_required': {
    pass: pageFacts(),
    fail: pageFacts({
      html: {
        jsonLd: [
          {
            raw: '{"@type":"Product","name":"Widget"}',
            parsed: { '@type': 'Product', name: 'Widget' },
            error: null,
            types: ['Product'],
          },
        ],
      },
    }),
  },
  'schema.missing_recommended': {
    pass: pageFacts(),
    fail: pageFacts({
      html: { jsonLd: [{ raw: '{"@type":"Organization"}', parsed: { '@type': 'Organization' }, error: null, types: ['Organization'] }] },
    }),
  },
  'image.missing_alt': {
    pass: pageFacts(),
    fail: pageFacts({
      html: {
        images: [{ src: 'https://example.com/a.png', alt: null, width: '800', height: '600', loading: 'lazy', inLink: false }],
      },
    }),
  },
  'image.link_missing_alt': {
    pass: pageFacts(),
    fail: pageFacts({
      html: {
        images: [{ src: 'https://example.com/a.png', alt: null, width: '800', height: '600', loading: 'lazy', inLink: true }],
      },
    }),
  },
  'image.no_dimensions': {
    pass: pageFacts(),
    fail: pageFacts({
      html: {
        images: [{ src: 'https://example.com/a.png', alt: 'A diagram', width: null, height: '600', loading: 'lazy', inLink: false }],
      },
    }),
  },
  'https.not_used': {
    pass: pageFacts(),
    fail: pageFacts({ url: 'http://example.com/', finalUrl: 'http://example.com/' }),
  },
  'https.mixed_content': {
    pass: pageFacts(),
    fail: pageFacts({ html: { mixedContent: ['http://cdn.example.com/app.js'] } }),
  },
  'https.insecure_form': {
    pass: pageFacts(),
    fail: pageFacts({ html: { insecureForms: ['http://example.com/subscribe'] } }),
  },
  'hreflang.invalid_code': {
    pass: pageFacts({ html: { hreflang: [{ lang: 'en', href: 'https://example.com/' }] } }),
    fail: pageFacts({ html: { hreflang: [{ lang: 'en_US', href: 'https://example.com/en/' }] } }),
  },
  'hreflang.missing_self': {
    pass: pageFacts({ html: { hreflang: [{ lang: 'en', href: 'https://example.com/' }] } }),
    fail: pageFacts({ html: { hreflang: [{ lang: 'en', href: 'https://example.com/en/' }] } }),
  },
};

/** Executable pass and fail cases for site checks, keyed by check id. */
export const siteFixtures: Record<string, { pass: SiteFacts; fail: SiteFacts }> = {
  'robots_txt.unreachable': {
    pass: siteFacts(),
    fail: siteFacts({ robotsTxt: { status: 503 } }),
  },
  'robots_txt.missing': {
    pass: siteFacts(),
    fail: siteFacts({ robotsTxt: { status: 404, sitemaps: [] } }),
  },
  'robots_txt.parse_errors': {
    pass: siteFacts(),
    fail: siteFacts({ robotsTxt: { parseErrors: [{ line: 3, text: 'Disallow /secret' }] } }),
  },
  'robots_txt.blocks_all': {
    pass: siteFacts(),
    fail: siteFacts({ robotsTxt: { disallowAllFor: ['*'] } }),
  },
  'robots_txt.no_sitemap': {
    pass: siteFacts(),
    fail: siteFacts({ robotsTxt: { sitemaps: [] } }),
  },
  'sitemap.missing': {
    pass: siteFacts(),
    fail: siteFacts({ robotsTxt: { sitemaps: [] }, sitemaps: [] }),
  },
  'sitemap.errors': {
    pass: siteFacts(),
    fail: siteFacts({
      sitemaps: [{ url: 'https://example.com/sitemap.xml', status: 500, fetchError: null, kind: 'unknown', urlCount: 0, errors: [] }],
    }),
  },
  'redirect.http_to_https_missing': {
    pass: siteFacts(),
    fail: siteFacts({ httpRedirectsToHttps: false }),
  },
  'https.no_hsts': {
    pass: siteFacts(),
    fail: siteFacts({
      home: pageFacts({ url: 'https://example.com/', finalUrl: 'https://example.com/', headers: { strictTransportSecurity: null } }),
    }),
  },
};

/**
 * Written pass and fail scenarios for finalize checks, keyed by check id. The finalize task must
 * turn each pair into a SQL test against the crawl tables.
 */
export const finalizeFixtures: Record<string, { pass: string; fail: string }> = {
  'sitemap.non_indexable_url': {
    pass: 'A sitemap lists /a, which returns 200 HTML, has no noindex directive and canonicalises to itself.',
    fail: 'A sitemap lists /a, which returns 200 HTML with meta robots noindex.',
  },
  'page.blocked_by_robots': {
    pass: 'Every internal link and sitemap URL was allowed by robots.txt and fetched.',
    fail: '/private is linked from / but robots.txt disallows it for Googlebot, so the crawl recorded status 0 with robots_allowed false.',
  },
  'crawl.deep_page': {
    pass: 'Every indexable page has a click depth of 4 or less on a complete link graph.',
    fail: '/a/b/c/d/e is indexable at click depth 5 on a complete link graph.',
  },
  'crawl.orphan_page': {
    pass: 'Every sitemap URL has at least one internal inlink from a crawled page.',
    fail: '/orphan is listed in the sitemap, returns 200 HTML and is indexable, but no crawled page links to it.',
  },
  'indexability.noindex_in_sitemap': {
    pass: 'Every sitemap URL is a 200 HTML page without a noindex directive.',
    fail: 'The sitemap lists /old, which returns 200 HTML with X-Robots-Tag: noindex.',
  },
  'canonical.to_non_200': {
    pass: '/a canonicalises to /b, which returns 200.',
    fail: '/a canonicalises to /gone, which returns 404.',
  },
  'canonical.to_redirect': {
    pass: '/a canonicalises to /b, which returns 200.',
    fail: '/a canonicalises to /old, which returns 301 to /new.',
  },
  'canonical.to_noindex': {
    pass: '/a canonicalises to /b, which returns 200 with no noindex directive.',
    fail: '/a canonicalises to /b, which returns 200 with meta robots noindex.',
  },
  'canonical.chain_or_cycle': {
    pass: '/a canonicalises to /b, and /b canonicalises to itself.',
    fail: '/a canonicalises to /b, /b canonicalises to /c, and /c canonicalises to /a.',
  },
  'links.broken_internal': {
    pass: 'Every internal link target returns 200.',
    fail: '/ links to /missing, which returns 404.',
  },
  'links.to_redirect': {
    pass: 'Every internal link target returns 200.',
    fail: '/ links to /old, which returns 301 to /new.',
  },
  'title.duplicate': {
    pass: 'Every indexable page has a unique title.',
    fail: '/a and /b are indexable 200 HTML pages and both have the title "Guide".',
  },
  'description.duplicate': {
    pass: 'Every indexable page has a unique meta description.',
    fail: '/a and /b are indexable 200 HTML pages and both have the description "A guide".',
  },
  'content.duplicate': {
    pass: 'Every indexable page has a different content hash.',
    fail: '/a and /b are indexable 200 HTML pages with the same non-empty content hash.',
  },
  'hreflang.missing_return': {
    pass: '/en links to /fr and /fr links back to /en.',
    fail: '/en links to /fr, but /fr has no hreflang entry pointing at /en.',
  },
  'hreflang.to_non_canonical': {
    pass: 'Every hreflang target is its own canonical.',
    fail: '/en points hreflang at /fr-print, which canonicalises to /fr.',
  },
};
