// Freshness rules: the judgements in this catalogue that depend on a Google or web-platform change,
// kept as data with the date a person last checked them (ADR-0008, crawler-and-audits.md §5).
//
// A rule is not a check. Checks reference a rule when their severity or message depends on it, so a
// stale judgement is visible in `checks.explain` and in the catalogue document instead of silently
// misleading a person. `scripts/stale-rules.mjs` warns about rules older than six months.

export interface FreshnessRule {
  id: string;
  /** What is true now, in one or two sentences, as a claim a person can verify at the source. */
  statement: string;
  /** The official page that states it. */
  source: string;
  /** The date a person last checked the statement, `YYYY-MM-DD`. */
  reviewedAt: string;
}

export const freshnessRules = [
  {
    id: 'faq_rich_results_retired',
    statement:
      'Google retired the FAQ rich result: it no longer appears in Search results from 7 May 2026, and its documentation was removed in June 2026. FAQPage is still valid schema.org markup, but it earns no rich result, so the catalogue reports it as information only.',
    source: 'https://developers.google.com/search/updates#faq-deprecation',
    reviewedAt: '2026-11-15',
  },
  {
    id: 'howto_rich_results_deprecated',
    statement:
      'Google deprecated the HowTo rich result in 2023 and removed its documentation; it is no longer shown on desktop or mobile. HowTo markup is still valid schema.org but earns no rich result.',
    source: 'https://developers.google.com/search/updates#how-to-deprecation',
    reviewedAt: '2026-11-15',
  },
  {
    id: 'inp_replaced_fid',
    statement:
      'INP replaced First Input Delay as the responsiveness Core Web Vital in March 2024. Performance checks use INP, LCP and CLS; FID is never evaluated.',
    source: 'https://web.dev/blog/inp-cwv-march-12',
    reviewedAt: '2026-11-15',
  },
  {
    id: 'article_no_required_properties',
    statement:
      'Google’s Article documentation declares no required properties for Article, NewsArticle or BlogPosting. Headline, image and dates are recommended, so the catalogue reports them as recommended and never as required.',
    source: 'https://developers.google.com/search/docs/appearance/structured-data/article',
    reviewedAt: '2026-11-15',
  },
  {
    id: 'organization_no_required_properties',
    statement:
      'Google’s Organization documentation declares no required properties. Name, url, logo and contact details are recommended, so the catalogue reports them as recommended.',
    source: 'https://developers.google.com/search/docs/appearance/structured-data/organization',
    reviewedAt: '2026-11-15',
  },
] as const satisfies readonly FreshnessRule[];

export type FreshnessRuleId = (typeof freshnessRules)[number]['id'];

export const ruleById = new Map<string, FreshnessRule>(freshnessRules.map((rule) => [rule.id, rule]));
