// The Phase 1 contract between the crawler and the check catalogue (crawler-and-audits.md §2, §5).
//
// The crawler's streaming extractor produces one `PageFacts` per fetched URL and one `SiteFacts`
// per audit; checks are pure functions over these shapes, so a check never sees raw HTML and never
// fetches. Adding a field is cheap; renaming one breaks the catalogue, so extend rather than change.
//
// Conventions:
// - Every URL here is absolute and normalised by the crawler (lowercase scheme and host, default
//   port dropped, fragment removed, path kept byte-exact). Relative hrefs are resolved against the
//   page's base (`<base href>` when present, else the final URL).
// - `null` means "absent on the page"; an empty string means "present but empty". Checks rely on
//   the difference (a missing `alt` attribute is not an empty `alt=""` decorative image).
// - Text values are trimmed and whitespace-collapsed; entity-decoded.

/** One hop of a redirect chain, in order, ending before the final response. */
export interface RedirectHop {
  url: string;
  status: number;
  /** The `Location` header as sent (resolved to absolute). */
  location: string;
}

export interface PageLink {
  /** Absolute URL; `null` when the href is not a fetchable http(s) URL (mailto:, javascript:, …). */
  href: string | null;
  /** The raw attribute value, for evidence. */
  rawHref: string;
  /** Lowercased rel tokens (`nofollow`, `ugc`, `sponsored`, …). */
  rel: string[];
  /** Anchor text, or the `alt` of a linked image when the anchor has no text. Capped at 200 chars. */
  text: string;
  /** Same site: the host is the site's primary domain or one of its hosts. */
  internal: boolean;
}

export interface PageImage {
  /** Absolute URL of `src` (or the first `srcset` candidate when `src` is absent); null if none. */
  src: string | null;
  /** `null`: the attribute is missing. `''`: present and empty (decorative). */
  alt: string | null;
  width: string | null;
  height: string | null;
  /** The `loading` attribute, lowercased. */
  loading: string | null;
  /** Whether the image is inside `<a href>` (an image link without alt has no anchor text). */
  inLink: boolean;
}

export interface JsonLdBlock {
  /** The script body as found, capped at 64 KiB. */
  raw: string;
  /** Parsed JSON; null when it did not parse. Remote `@context` is never loaded. */
  parsed: unknown;
  /** The JSON parse error, or null. */
  error: string | null;
  /** Every `@type` found in the block, including inside `@graph` and nested nodes. */
  types: string[];
}

export interface Heading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

/** What the extractor read from an HTML document. */
export interface HtmlFacts {
  /** `<html lang>`, lowercased; null when missing. */
  lang: string | null;
  /** The first `<title>` in `<head>`; null when there is none. */
  title: string | null;
  /** Number of `<title>` elements in the document. */
  titleCount: number;
  /** The first `<meta name="description">` content; null when there is none. */
  metaDescription: string | null;
  metaDescriptionCount: number;
  /**
   * Robots directives from `<meta name="robots">` and `<meta name="googlebot">`, lowercased and
   * split on commas (e.g. `['noindex', 'follow']`). Empty when none are present.
   */
  metaRobots: string[];
  /** The first `<link rel="canonical">` href (absolute); null when there is none. */
  canonical: string | null;
  /** All canonical hrefs found (several is itself a finding). */
  canonicals: string[];
  /** A canonical declared outside `<head>` (Google ignores it). */
  canonicalOutsideHead: boolean;
  viewport: string | null;
  /** Declared charset (`<meta charset>` or the http-equiv form), lowercased. */
  charset: string | null;
  hreflang: { lang: string; href: string }[];
  headings: Heading[];
  /** Links in document order, capped at {@link HTML_FACTS_MAX_LINKS}. */
  links: PageLink[];
  /** Images in document order, capped at {@link HTML_FACTS_MAX_IMAGES}. */
  images: PageImage[];
  /**
   * More links were present than the cap kept. Optional and additive (not part of the original
   * contract): checks that count links should treat a truncated list as evidence, not a total.
   */
  linksTruncated?: boolean;
  /** More images were present than the cap kept; see {@link HtmlFacts.linksTruncated}. */
  imagesTruncated?: boolean;
  jsonLd: JsonLdBlock[];
  /** `itemtype` values of microdata items. */
  microdataTypes: string[];
  /** `og:*` properties, first value wins. */
  openGraph: Record<string, string>;
  /** `twitter:*` names, first value wins. */
  twitter: Record<string, string>;
  /** Words in the visible body text (script, style, noscript, template excluded). */
  wordCount: number;
  /** sha256 hex of the normalised visible body text, for duplicate detection. */
  contentHash: string;
  /** `http:` subresources (img, script, link stylesheet, iframe, source) on an https page. */
  mixedContent: string[];
  /** Forms whose action resolves to `http:` (or posts from an http page). */
  insecureForms: string[];
}

/** How the crawler came to know a URL. */
export type DiscoverySource = 'seed' | 'link' | 'sitemap' | 'redirect' | 'list';

/** Everything known about one fetched URL in one audit. */
export interface PageFacts {
  /** The URL as requested. */
  url: string;
  /** The URL that answered after redirects (equal to `url` when there were none). */
  finalUrl: string;
  /** Final HTTP status; 0 when the request failed before a response (see `fetchError`). */
  status: number;
  redirects: RedirectHop[];
  /** The fetch failure kind (timeout, dns, tls, blocked, too_large, redirect_loop, …), or null. */
  fetchError: string | null;
  contentType: string | null;
  /** `text/html` or `application/xhtml+xml` with a 2xx status and a parsed body. */
  isHtml: boolean;
  /** Selected response headers (lowercased names), raw values. */
  headers: {
    xRobotsTag: string | null;
    contentLanguage: string | null;
    strictTransportSecurity: string | null;
    link: string | null;
  };
  /** Time to first byte and total time in ms; null when unknown. */
  ttfbMs: number | null;
  totalMs: number | null;
  /** Body size in bytes as received (after decompression). */
  bytes: number;
  /** Click depth from the seed through internal links; null for sitemap-only or listed URLs. */
  depth: number | null;
  discoveredBy: DiscoverySource;
  /** Listed in at least one of the site's sitemaps. */
  inSitemap: boolean;
  /** robots.txt allows our user agent to fetch this URL (a disallowed URL is not fetched: status 0). */
  robotsAllowed: boolean;
  /** Parsed document facts; null for non-HTML, errors and non-2xx responses. */
  html: HtmlFacts | null;
}

export interface RobotsTxtFacts {
  /** `https://host/robots.txt` of the primary host. */
  url: string;
  /** HTTP status; 0 on a fetch failure. */
  status: number;
  fetchError: string | null;
  /** Lines the parser could not understand, with 1-based line numbers. */
  parseErrors: { line: number; text: string }[];
  /** Sitemap URLs declared in robots.txt. */
  sitemaps: string[];
  /** User agents (lowercased) for which `/` is disallowed outright. `*` included when it applies. */
  disallowAllFor: string[];
  /** Raw body, capped at 512 KiB, for evidence. */
  body: string | null;
}

export interface SitemapFacts {
  url: string;
  status: number;
  fetchError: string | null;
  kind: 'urlset' | 'index' | 'unknown';
  /** URLs listed (a sitemap index lists child sitemaps here). */
  urlCount: number;
  /** XML errors, more than 50,000 URLs, more than 50 MB uncompressed, URLs on other hosts, … */
  errors: string[];
}

/** Site-wide facts gathered once per audit. */
export interface SiteFacts {
  /** The origin the audit started from, e.g. `https://example.com`. */
  origin: string;
  robotsTxt: RobotsTxtFacts;
  sitemaps: SitemapFacts[];
  /** The home page's facts, when it was fetched. */
  home: PageFacts | null;
  /** Whether `http://` of the primary host redirects to `https://`; null when not tested. */
  httpRedirectsToHttps: boolean | null;
  /**
   * Whether sitemap seeding stopped at a cap (documents, queued sitemaps, decompressed bytes or
   * wall time). Optional and additive; the reasons are also appended to the last sitemap's
   * `errors`. A truncated sitemap list means coverage is not the whole site.
   */
  sitemapsTruncated?: boolean;
}
