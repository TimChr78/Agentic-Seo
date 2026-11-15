import { defineCheck } from '../check';
import { declaredCanonical, isIndexablePage, isOkHtml, metaRobotsNoindex, noindexSources, xRobotsNoindex } from '../indexability';
import { fail, pass } from '../outcome';
import { isSameUrl } from '../url';

// Indexability: may this URL appear in results on its own? Canonical and noindex signals are the
// crawler's instructions about duplicate URLs and exclusion (crawler-and-audits.md §5).

const ROBOTS_META = 'https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag';
const CANONICAL = 'https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls';
const SITEMAP_BUILD = 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap';

export const indexabilityNoindex = defineCheck({
  id: 'indexability.noindex',
  title: 'The page carries a noindex robots directive',
  category: 'indexability',
  severity: 'info',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'The page carries noindex in its meta robots tag. Google will not show it in results while the directive is present. Confirm the page is deliberately excluded; if not, remove the directive.',
  references: [ROBOTS_META],
  run: (page) => {
    if (!page.html || !metaRobotsNoindex(page.html.metaRobots)) return pass();
    return fail({
      subject: page.finalUrl,
      selector: 'meta[name="robots"]',
      value: page.html.metaRobots.join(', '),
      expected: 'indexable, with no noindex directive',
    });
  },
});

export const indexabilityXRobotsNoindex = defineCheck({
  id: 'indexability.x_robots_noindex',
  title: 'The X-Robots-Tag header says noindex',
  category: 'indexability',
  severity: 'info',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'The response’s X-Robots-Tag header contains noindex. The HTTP header is as authoritative as the meta tag and is easy to miss because it is not in the HTML. Remove the header for pages that should rank.',
  references: [ROBOTS_META],
  run: (page) => {
    if (!xRobotsNoindex(page.headers.xRobotsTag)) return pass();
    return fail({
      subject: page.finalUrl,
      value: page.headers.xRobotsTag ?? '',
      expected: 'an X-Robots-Tag header without noindex',
    });
  },
});

export const canonicalMissing = defineCheck({
  id: 'canonical.missing',
  title: 'The page declares no canonical URL',
  category: 'indexability',
  severity: 'low',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isIndexablePage,
  explain:
    'An indexable page declares no canonical URL. Without one Google picks a canonical itself, which can split signals between variants. Add a self-referencing canonical link in the head.',
  references: [CANONICAL],
  run: (page) => {
    if (declaredCanonical(page.html) !== null) return pass();
    return fail({
      subject: page.finalUrl,
      expected: 'a self-referencing <link rel="canonical"> in the head',
    });
  },
});

export const canonicalMultiple = defineCheck({
  id: 'canonical.multiple',
  title: 'The page declares more than one canonical URL',
  category: 'indexability',
  severity: 'medium',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'The page declares more than one canonical URL. Google ignores competing canonicals, so its choice is unpredictable. Keep one canonical link and remove the others.',
  references: [CANONICAL],
  run: (page) => {
    const canonicals = page.html?.canonicals ?? [];
    if (canonicals.length <= 1) return pass();
    return fail(
      canonicals.map((href) => ({
        subject: page.finalUrl,
        selector: 'link[rel="canonical"]',
        value: href,
        expected: 'a single canonical link',
      })),
    );
  },
});

export const canonicalOutsideHead = defineCheck({
  id: 'canonical.outside_head',
  title: 'The canonical link is outside the document head',
  category: 'indexability',
  severity: 'medium',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'A canonical link appears outside the document head. Google ignores canonicals it finds in the body. Move the link into the head.',
  references: [CANONICAL],
  run: (page) => {
    if (!page.html?.canonicalOutsideHead) return pass();
    return fail({
      subject: page.finalUrl,
      selector: 'link[rel="canonical"]',
      value: 'outside <head>',
      expected: 'a canonical link inside the document head',
    });
  },
});

export const canonicalConflictNoindex = defineCheck({
  id: 'canonical.conflict_noindex',
  title: 'The page is noindex and canonicalises to another URL',
  category: 'indexability',
  severity: 'medium',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: (page) => isOkHtml(page) && declaredCanonical(page.html) !== null,
  explain:
    'The page is noindex and also declares a canonical pointing elsewhere. The two signals conflict and Google cannot consolidate cleanly. Choose one: the page should either rank, or be excluded without a canonical to another page.',
  references: [ROBOTS_META, CANONICAL],
  run: (page) => {
    const sources = noindexSources(page);
    const canonical = declaredCanonical(page.html);
    if (!sources.length || canonical === null || isSameUrl(canonical, page.finalUrl)) return pass();
    return fail({
      subject: page.finalUrl,
      value: canonical,
      expected: 'one signal: either noindex, or a canonical to an indexable page',
      detail: `noindex comes from ${sources.map((source) => (source.source === 'meta_robots' ? 'the meta robots tag' : 'the X-Robots-Tag header')).join(' and ')}.`,
    });
  },
});

export const indexabilityNoindexInSitemap = defineCheck({
  id: 'indexability.noindex_in_sitemap',
  title: 'A sitemap lists a URL that is noindex',
  category: 'indexability',
  severity: 'medium',
  scope: 'cross_page',
  kind: 'deterministic',
  evaluator: 'finalize',
  explain:
    'A sitemap lists a URL that returns noindex. The two instructions contradict each other, and Google follows the noindex. Either remove the URL from the sitemap or drop the noindex.',
  references: [SITEMAP_BUILD, ROBOTS_META],
  definition:
    'Fails for each URL listed in a sitemap that was fetched as a 200 HTML page whose meta robots or applicable X-Robots-Tag contains noindex (or none). Evidence: the URL, the directive and whether it came from the meta tag or the header, and the sitemap documents the audit read.',
});

export const canonicalToNon200 = defineCheck({
  id: 'canonical.to_non_200',
  title: 'The canonical points at a URL that is not 200',
  category: 'indexability',
  severity: 'high',
  scope: 'cross_page',
  kind: 'deterministic',
  evaluator: 'finalize',
  explain:
    'The declared canonical points at a URL that does not return 200. A canonical to a missing or failing URL gives Google no valid version to consolidate on. Point the canonical at a live 200 URL, normally the page itself.',
  references: [CANONICAL],
  definition:
    'Fails for each crawled 200 HTML page whose declared canonical points at another URL on the same site that was fetched and did not return 200 (4xx, 5xx, or a fetch failure with status 0). Evidence: the page URL, its canonical target, and the target’s status or fetch error.',
});

export const canonicalToRedirect = defineCheck({
  id: 'canonical.to_redirect',
  title: 'The canonical points at a redirecting URL',
  category: 'indexability',
  severity: 'medium',
  scope: 'cross_page',
  kind: 'deterministic',
  evaluator: 'finalize',
  explain:
    'The declared canonical points at a URL that redirects. Google has to follow the redirect to find the canonical, which weakens the signal. Point the canonical at the final URL after the redirect.',
  references: [CANONICAL],
  definition:
    'Fails for each crawled 200 HTML page whose declared canonical points at another URL whose snapshot, looked up by the requested URL (`url`, not `final_url`), has a non-empty `redirects` chain: the canonical target redirects, whatever the final status is. Evidence: the page URL, the canonical target, the first hop’s status and `location`, and the final URL.',
});

export const canonicalToNoindex = defineCheck({
  id: 'canonical.to_noindex',
  title: 'The canonical points at a noindex page',
  category: 'indexability',
  severity: 'high',
  scope: 'cross_page',
  kind: 'deterministic',
  evaluator: 'finalize',
  explain:
    'The declared canonical points at a page that is noindex. Consolidating into a noindex page removes both versions from results. Point the canonical at an indexable page, or remove the noindex from the target.',
  references: [CANONICAL, ROBOTS_META],
  definition:
    'Fails for each crawled 200 HTML page whose declared canonical points at another crawled URL that is noindex through meta robots or an applicable X-Robots-Tag header. Evidence: the page URL, the canonical target and the directive that makes the target noindex.',
});

export const canonicalChainOrCycle = defineCheck({
  id: 'canonical.chain_or_cycle',
  title: 'Canonicals form a chain or a cycle',
  category: 'indexability',
  severity: 'medium',
  scope: 'cross_page',
  kind: 'deterministic',
  evaluator: 'finalize',
  explain:
    'Canonical declarations form a chain or a cycle instead of pointing straight at one URL. Google follows chains inconsistently, and a cycle leaves no canonical version at all. Point every page’s canonical directly at the final URL.',
  references: [CANONICAL],
  definition:
    'Follow canonical edges from each crawled 200 HTML page whose declared canonical points at another URL (compare normalised URLs). An edge is a page’s declared canonical when it differs from the page’s own URL; a page that declares itself canonical, or declares none, or was not crawled, or is off-site, ends the walk. Fails when the walk takes two or more edges before it ends (a chain), or reaches a URL already visited through a non-self edge (a cycle, e.g. /a → /b → /a). /a → /b where /b is self-canonical passes. Evidence: the ordered list of URLs walked, ending at the terminal URL or at the first repeated URL.',
});

export const indexabilityChecks = [
  indexabilityNoindex,
  indexabilityXRobotsNoindex,
  canonicalMissing,
  canonicalMultiple,
  canonicalOutsideHead,
  canonicalConflictNoindex,
  indexabilityNoindexInSitemap,
  canonicalToNon200,
  canonicalToRedirect,
  canonicalToNoindex,
  canonicalChainOrCycle,
] as const;
