import type { PageFacts, SiteFacts } from '@agentic-seo/crawl';
import type { CheckOutcome, Evidence } from './outcome';

// The shape of a check (crawler-and-audits.md §5, ADR-0008): data plus one pure function. A check
// never fetches and never sees raw HTML; it reads `PageFacts` or `SiteFacts` from the crawler.

export const checkCategories = [
  'crawlability',
  'indexability',
  'status_links',
  'on_page',
  'structured_data',
  'images',
  'security',
  'international',
] as const;
export type CheckCategory = (typeof checkCategories)[number];

export const severities = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof severities)[number];

/** Where the finding lives: one page, the site as a whole, or the relationship between pages. */
export const checkScopes = ['page', 'site', 'cross_page'] as const;
export type CheckScope = (typeof checkScopes)[number];

/**
 * How a check is evaluated. `page` and `site` run in this package over the crawler's facts.
 * `finalize` checks are cross-page: their metadata and a precise definition live here, and the
 * SQL that evaluates them against the crawl tables is written by the finalize task.
 */
export const evaluators = ['page', 'site', 'finalize'] as const;
export type Evaluator = (typeof evaluators)[number];

/** Deterministic checks run on every audit; judged checks (LLM) arrive with sampling in Phase 2. */
export type CheckKind = 'deterministic' | 'judged';

/** The change types a change set can make (ADR-0007); a check names the one that can fix it. */
export const fixChanges = ['meta.title', 'meta.description', 'schema.jsonld', 'image.alt', 'redirect'] as const;
export type FixChange = (typeof fixChanges)[number];

export interface CheckFix {
  change: FixChange;
}

interface CheckBase {
  /** Dotted, stable id, e.g. `title.too_long`. Never renamed once findings reference it. */
  id: string;
  /** One line for a table or a tool tip. */
  title: string;
  category: CheckCategory;
  severity: Severity;
  scope: CheckScope;
  kind: CheckKind;
  /** What, why it matters and what to do: two to four plain sentences. */
  explain: string;
  /** The change type that can fix a finding, when one can. */
  fix?: CheckFix;
  /** Official documentation: Google Search Central, schema.org, an RFC or a web standard. */
  references: readonly string[];
  /**
   * Freshness rules this check's judgement depends on (`rules.ts`). A rule records the source and
   * the date a person last checked it, so a stale judgement is visible rather than silent.
   */
  rules?: readonly string[];
  /**
   * Whether the check needs the whole link graph. Graph checks are suppressed on an audit whose
   * coverage is truncated (crawler-and-audits.md §2 "Coverage").
   */
  requiresCompleteGraph?: boolean;
}

export interface PageCheck extends CheckBase {
  evaluator: 'page';
  scope: 'page';
  /** False when the page cannot be judged at all, e.g. a 404 or a non-HTML response. */
  appliesTo?: (page: PageFacts) => boolean;
  run: (page: PageFacts) => CheckOutcome;
}

export interface SiteCheck extends CheckBase {
  evaluator: 'site';
  scope: 'site';
  appliesTo?: (site: SiteFacts) => boolean;
  run: (site: SiteFacts) => CheckOutcome;
}

export interface FinalizeCheck extends CheckBase {
  evaluator: 'finalize';
  scope: 'cross_page';
  /**
   * Exactly what fails and what the evidence must name, precise enough for the finalize task to
   * write the SQL without guessing.
   */
  definition: string;
}

export type Check = PageCheck | SiteCheck | FinalizeCheck;

export function defineCheck<C extends Check>(check: C): C {
  return check;
}

/** A check's outcome attached to the check that produced it. */
export interface CheckResult {
  checkId: string;
  title: string;
  category: CheckCategory;
  severity: Severity;
  scope: CheckScope;
  evaluator: Evaluator;
  outcome: CheckOutcome['outcome'];
  evidence: Evidence[];
  total: number;
  truncated: boolean;
  /** The reason a check did not apply, otherwise null. */
  reason: string | null;
}
