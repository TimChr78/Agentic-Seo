import { defineCheck } from '../check';
import { fail, notApplicable, pass } from '../outcome';

// Crawlability: can Google reach the site at all, and does it know what exists?
// (crawler-and-audits.md §5 "Crawlability", domain-model.md §2.)

const ROBOTS_INTRO = 'https://developers.google.com/search/docs/crawling-indexing/robots/intro';
const ROBOTS_RFC = 'https://www.rfc-editor.org/rfc/rfc9309';
const SITEMAP_OVERVIEW = 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview';
const SITEMAP_BUILD = 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap';
const LINKS_CRAWLABLE = 'https://developers.google.com/search/docs/crawling-indexing/links-crawlable';

export const robotsTxtUnreachable = defineCheck({
  id: 'robots_txt.unreachable',
  title: 'robots.txt is unreachable',
  category: 'crawlability',
  severity: 'high',
  scope: 'site',
  kind: 'deterministic',
  evaluator: 'site',
  explain:
    'The robots.txt request returned a server error or could not be fetched. Google treats an unreachable robots.txt as a full disallow for a while, so every page can drop out of the index. Fix the server or the file so robots.txt returns a 200 response with the intended rules.',
  references: [ROBOTS_INTRO, ROBOTS_RFC],
  run: (site) => {
    const { url, status, fetchError } = site.robotsTxt;
    if (fetchError !== null || status === 0 || status >= 500)
      return fail({
        subject: url,
        value: fetchError ?? `HTTP ${status}`,
        expected: 'a 200 response with the robots.txt rules',
      });
    return pass();
  },
});

export const robotsTxtMissing = defineCheck({
  id: 'robots_txt.missing',
  title: 'robots.txt is missing',
  category: 'crawlability',
  severity: 'info',
  scope: 'site',
  kind: 'deterministic',
  evaluator: 'site',
  explain:
    'The robots.txt request returned 404, so the site has no crawler rules. A missing file is not an error, but it leaves crawl control and sitemap discovery to chance. Add a robots.txt that allows what should be crawled and names the sitemap.',
  references: [ROBOTS_INTRO],
  run: (site) => {
    const { url, status, fetchError } = site.robotsTxt;
    if (fetchError !== null || status === 0 || status >= 500)
      return notApplicable('robots.txt could not be fetched; robots_txt.unreachable covers that.');
    if (status === 404 || status === 410)
      return fail({ subject: url, value: `HTTP ${status}`, expected: 'a robots.txt with the site’s crawl rules' });
    return pass();
  },
});

export const robotsTxtParseErrors = defineCheck({
  id: 'robots_txt.parse_errors',
  title: 'robots.txt has lines that do not parse',
  category: 'crawlability',
  severity: 'low',
  scope: 'site',
  kind: 'deterministic',
  evaluator: 'site',
  explain:
    'robots.txt contains lines the parser could not understand. Crawlers ignore those lines, so a rule meant to block or allow a section may not apply. Fix the syntax on the lines named in the evidence.',
  references: [ROBOTS_INTRO, ROBOTS_RFC],
  run: (site) => {
    const { url, parseErrors } = site.robotsTxt;
    if (!parseErrors.length) return pass();
    return fail(
      parseErrors.map((error) => ({
        subject: `${url}#line-${error.line}`,
        value: error.text,
        expected: 'a directive a parser can read',
        detail: `Line ${error.line} of robots.txt could not be parsed.`,
      })),
    );
  },
});

export const robotsTxtBlocksAll = defineCheck({
  id: 'robots_txt.blocks_all',
  title: 'robots.txt blocks the whole site',
  category: 'crawlability',
  severity: 'critical',
  scope: 'site',
  kind: 'deterministic',
  evaluator: 'site',
  explain:
    'robots.txt disallows the whole site for every crawler or for Googlebot. Google cannot crawl any page while this rule stands, so the site leaves the index. Remove the blanket disallow and scope the rule to paths that must stay out.',
  references: [ROBOTS_INTRO, ROBOTS_RFC],
  run: (site) => {
    const { url, disallowAllFor } = site.robotsTxt;
    // Exact tokens: Googlebot-News, Googlebot-Image and other specialised crawlers have their own
    // groups, and blocking them leaves web search crawling untouched.
    const blocking = disallowAllFor.filter((agent) => agent === '*' || agent.toLowerCase() === 'googlebot');
    if (!blocking.length) return pass();
    return fail(
      blocking.map((agent) => ({
        subject: url,
        value: agent === '*' ? 'User-agent: *' : `User-agent: ${agent}`,
        expected: 'a robots.txt that allows Googlebot to reach the site',
        detail: 'Every path is disallowed for this crawler.',
      })),
    );
  },
});

export const robotsTxtNoSitemap = defineCheck({
  id: 'robots_txt.no_sitemap',
  title: 'robots.txt does not name a sitemap',
  category: 'crawlability',
  severity: 'info',
  scope: 'site',
  kind: 'deterministic',
  evaluator: 'site',
  explain:
    'robots.txt does not contain a Sitemap line. Crawlers can still find a sitemap by convention, but declaring one makes discovery reliable. Add a Sitemap line with the absolute sitemap URL.',
  references: [ROBOTS_INTRO, SITEMAP_OVERVIEW],
  run: (site) => {
    const { url, status, fetchError, sitemaps } = site.robotsTxt;
    if (fetchError !== null || status < 200 || status >= 300)
      return notApplicable('robots.txt was not fetched with a 2xx status, so it cannot declare a sitemap.');
    if (sitemaps.length) return pass();
    return fail({ subject: url, value: 'no Sitemap line', expected: 'a Sitemap line with the absolute sitemap URL' });
  },
});

export const sitemapMissing = defineCheck({
  id: 'sitemap.missing',
  title: 'No sitemap was found',
  category: 'crawlability',
  severity: 'medium',
  scope: 'site',
  kind: 'deterministic',
  evaluator: 'site',
  explain:
    'The audit found no sitemap, neither declared in robots.txt nor at a conventional location. Search engines then have to discover pages through links alone, which is slower and can miss isolated pages. Publish an XML sitemap and declare it in robots.txt.',
  references: [SITEMAP_OVERVIEW, SITEMAP_BUILD],
  run: (site) => {
    const found = site.sitemaps.some((sitemap) => sitemap.fetchError === null && sitemap.status >= 200 && sitemap.status < 300);
    if (found || site.robotsTxt.sitemaps.length > 0) return pass();
    return fail({
      subject: `${site.origin}/sitemap.xml`,
      value: 'no sitemap found',
      expected: 'a sitemap declared in robots.txt or served at /sitemap.xml',
    });
  },
});

export const sitemapErrors = defineCheck({
  id: 'sitemap.errors',
  title: 'A sitemap is invalid or could not be fetched',
  category: 'crawlability',
  severity: 'medium',
  scope: 'site',
  kind: 'deterministic',
  evaluator: 'site',
  explain:
    'At least one sitemap could not be fetched or breaks the sitemap rules. A broken or invalid sitemap is ignored, so the URLs it lists go unseen. Fix the fetch error, the XML or the size and URL limits named in the evidence.',
  references: [SITEMAP_BUILD],
  run: (site) => {
    const items = site.sitemaps.flatMap((sitemap) => {
      if (sitemap.fetchError !== null) return [{ subject: sitemap.url, value: sitemap.fetchError, expected: 'a fetchable XML sitemap' }];
      if (sitemap.status < 200 || sitemap.status >= 300)
        return [{ subject: sitemap.url, value: `HTTP ${sitemap.status}`, expected: 'a 200 response' }];
      return sitemap.errors.map((error) => ({
        subject: sitemap.url,
        value: error,
        expected: 'a sitemap that follows the sitemap rules',
      }));
    });
    if (!items.length) return pass();
    return fail(items);
  },
});

export const sitemapNonIndexableUrl = defineCheck({
  id: 'sitemap.non_indexable_url',
  title: 'A sitemap lists a URL that is not indexable',
  category: 'crawlability',
  severity: 'medium',
  scope: 'cross_page',
  kind: 'deterministic',
  evaluator: 'finalize',
  explain:
    'A sitemap lists a URL that is not indexable. Asking Google to index a page that is noindex, non-200 or canonicalised elsewhere wastes crawl effort and weakens trust in the sitemap. Remove the URL from the sitemap, or make the page indexable if it should rank.',
  references: [SITEMAP_BUILD],
  definition:
    'Fails for each URL listed in any of the audit’s sitemaps whose page was fetched but is not indexable: the final status is not 200, the final response is not HTML, the page has noindex in meta robots or in an applicable X-Robots-Tag header, or its canonical points at a different URL. Exclude URLs that robots.txt disallowed (page.blocked_by_robots covers those). Evidence: the URL, the sitemap documents the audit read and the reason it is not indexable (status, directive or canonical target).',
});

export const pageBlockedByRobots = defineCheck({
  id: 'page.blocked_by_robots',
  title: 'An internal URL is blocked by robots.txt',
  category: 'crawlability',
  severity: 'medium',
  scope: 'cross_page',
  kind: 'deterministic',
  evaluator: 'finalize',
  explain:
    'An internal link or sitemap entry points at a URL that robots.txt blocks for our crawler. Visitors may follow the link but search engines never see the page, so the link and the content are wasted. Allow the URL in robots.txt, or remove the link and the sitemap entry.',
  references: [ROBOTS_INTRO],
  definition:
    'Fails for each URL that the crawl discovered as an internal link or as a sitemap URL but robots.txt disallows for the crawler’s user agent, so the URL was never fetched (status 0 and robots_allowed false). Evidence: the blocked URL and one source page (or the sitemap URL) that references it; one evidence item per blocked URL, with the first source.',
});

export const crawlDeepPage = defineCheck({
  id: 'crawl.deep_page',
  title: 'An indexable page is more than four clicks from the home page',
  category: 'crawlability',
  severity: 'low',
  scope: 'cross_page',
  kind: 'deterministic',
  evaluator: 'finalize',
  requiresCompleteGraph: true,
  explain:
    'An indexable page sits more than four clicks from the home page. Deep pages are crawled less often and receive less internal linking value. Link important pages closer to the home page or add them to hub pages.',
  references: [LINKS_CRAWLABLE],
  definition:
    'On an audit whose coverage graph is complete (no page, depth or time limit truncated it), fails for each indexable 200 HTML page whose click depth from the seed through internal links is greater than 4. Pages with no depth (sitemap-only or listed URLs) are not reported. Evidence: the URL and its depth.',
});

export const crawlOrphanPage = defineCheck({
  id: 'crawl.orphan_page',
  title: 'A sitemap page has no internal links',
  category: 'crawlability',
  severity: 'medium',
  scope: 'cross_page',
  kind: 'deterministic',
  evaluator: 'finalize',
  requiresCompleteGraph: true,
  explain:
    'A page in the sitemap has no internal links pointing to it. Search engines treat it as an orphan: it may be crawled from the sitemap but it gains no authority from the site. Link it from relevant pages, or remove it from the sitemap if it is not meant to rank.',
  references: [SITEMAP_BUILD, LINKS_CRAWLABLE],
  definition:
    'On an audit whose coverage graph is complete, fails for each indexable 200 HTML page that is listed in a sitemap but has zero internal inlinks from other crawled pages. Evidence: the page URL and the sitemap documents the audit read.',
});

export const crawlabilityChecks = [
  robotsTxtUnreachable,
  robotsTxtMissing,
  robotsTxtParseErrors,
  robotsTxtBlocksAll,
  robotsTxtNoSitemap,
  sitemapMissing,
  sitemapErrors,
  sitemapNonIndexableUrl,
  pageBlockedByRobots,
  crawlDeepPage,
  crawlOrphanPage,
] as const;
