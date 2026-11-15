import { defineCheck } from '../check';
import { isValidHreflang } from '../hreflang';
import { isOkHtml } from '../indexability';
import { fail, pass } from '../outcome';
import { isSameUrl } from '../url';

// International: the hreflang annotations that connect language and region variants
// (crawler-and-audits.md §5 "International").

const LOCALIZED = 'https://developers.google.com/search/docs/specialty/international/localized-versions';
const BCP47 = 'https://www.rfc-editor.org/rfc/rfc5646';

export const hreflangInvalidCode = defineCheck({
  id: 'hreflang.invalid_code',
  title: 'An hreflang value is not a valid language code',
  category: 'international',
  severity: 'medium',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: (page) => isOkHtml(page) && (page.html?.hreflang.length ?? 0) > 0,
  explain:
    'An hreflang value is not a valid language or region code. Google ignores entries it cannot parse, so that language version is not connected. Use a BCP 47 tag such as en, en-GB or x-default.',
  references: [LOCALIZED, BCP47],
  run: (page) => {
    const invalid = (page.html?.hreflang ?? []).filter((entry) => !isValidHreflang(entry.lang));
    if (!invalid.length) return pass();
    return fail(
      invalid.map((entry) => ({
        subject: page.finalUrl,
        selector: 'link[rel="alternate"][hreflang]',
        value: entry.lang,
        expected: 'a BCP 47 code such as en, en-GB or x-default',
      })),
    );
  },
});

export const hreflangMissingSelf = defineCheck({
  id: 'hreflang.missing_self',
  title: 'The hreflang set does not include the page itself',
  category: 'international',
  severity: 'low',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: (page) => isOkHtml(page) && (page.html?.hreflang.length ?? 0) > 0,
  explain:
    'The page has hreflang entries but none points at the page itself. Each page in a language cluster must include a self-reference, or Google may not treat the cluster as complete. Add an entry for the page’s own language and URL.',
  references: [LOCALIZED],
  run: (page) => {
    const entries = page.html?.hreflang ?? [];
    if (entries.some((entry) => isSameUrl(entry.href, page.finalUrl))) return pass();
    return fail({
      subject: page.finalUrl,
      value: entries.map((entry) => `${entry.lang} → ${entry.href}`).join(', '),
      expected: 'an hreflang entry whose href is this page',
    });
  },
});

export const hreflangMissingReturn = defineCheck({
  id: 'hreflang.missing_return',
  title: 'An hreflang target does not link back',
  category: 'international',
  severity: 'medium',
  scope: 'cross_page',
  kind: 'deterministic',
  evaluator: 'finalize',
  explain:
    'A page’s hreflang entry points at another page that does not link back. Google requires the relationship to be reciprocal and ignores entries that are not confirmed. Add the matching return entry on the target page.',
  references: [LOCALIZED],
  definition:
    'Fails for each hreflang entry on page A whose target URL B was crawled and is indexable, where B has no hreflang entry that points back to A (matching A’s language code, or an x-default entry pointing at A). Evidence: A, B and the language code whose return link is missing.',
});

export const hreflangToNonCanonical = defineCheck({
  id: 'hreflang.to_non_canonical',
  title: 'An hreflang target is not its own canonical',
  category: 'international',
  severity: 'medium',
  scope: 'cross_page',
  kind: 'deterministic',
  evaluator: 'finalize',
  explain:
    'An hreflang entry points at a URL that is not its own canonical. Google expects hreflang to name canonical URLs, so the language signal is lost. Point the entry at the target’s canonical URL.',
  references: [LOCALIZED],
  definition:
    'Fails for each hreflang entry whose target URL was crawled and is not its own canonical: the target is not indexable (noindex in meta robots or X-Robots-Tag, or a non-2xx status), or the target declares a different canonical. Evidence: the source page, the hreflang code and the target URL with the reason.',
});

export const internationalChecks = [hreflangInvalidCode, hreflangMissingSelf, hreflangMissingReturn, hreflangToNonCanonical] as const;
