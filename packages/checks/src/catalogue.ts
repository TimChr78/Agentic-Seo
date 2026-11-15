import type { PageFacts, SiteFacts } from '@agentic-seo/crawl';
import type { Check, CheckResult, FinalizeCheck, PageCheck, SiteCheck } from './check';
import { crawlabilityChecks } from './checks/crawlability';
import { imageChecks } from './checks/images';
import { indexabilityChecks } from './checks/indexability-checks';
import { internationalChecks } from './checks/international';
import { onPageChecks } from './checks/on-page';
import { securityChecks } from './checks/security';
import { statusLinkChecks } from './checks/status-links';
import { structuredDataChecks } from './checks/structured-data';
import { type CheckOutcome, notApplicable } from './outcome';

// The catalogue: every check, in one list, and the two runners a crawl uses. Finalize checks carry
// no runner here; the finalize task implements their definitions against the crawl tables.

export const checks: readonly Check[] = [
  ...crawlabilityChecks,
  ...indexabilityChecks,
  ...statusLinkChecks,
  ...onPageChecks,
  ...structuredDataChecks,
  ...imageChecks,
  ...securityChecks,
  ...internationalChecks,
];

const byId = new Map<string, Check>(checks.map((check) => [check.id, check]));

/** One check by its dotted id, or undefined. */
export function checkById(id: string): Check | undefined {
  return byId.get(id);
}

/** Every cross-page check, for the finalize task and the catalogue document. */
export const finalizeChecks: readonly FinalizeCheck[] = checks.filter((check): check is FinalizeCheck => check.evaluator === 'finalize');

const PAGE_DOES_NOT_APPLY = 'This check does not apply to this page, for example because the response is not a 2xx HTML document.';
const SITE_DOES_NOT_APPLY = 'This check does not apply to this site, because the facts it needs were not gathered.';

function resultOf(check: Check, outcome: CheckOutcome): CheckResult {
  return {
    checkId: check.id,
    title: check.title,
    category: check.category,
    severity: check.severity,
    scope: check.scope,
    evaluator: check.evaluator,
    outcome: outcome.outcome,
    evidence: outcome.outcome === 'fail' ? outcome.evidence : [],
    total: outcome.outcome === 'fail' ? outcome.total : 0,
    truncated: outcome.outcome === 'fail' ? outcome.truncated : false,
    reason: outcome.outcome === 'not_applicable' ? outcome.reason : null,
  };
}

/**
 * Runs every page check over one page's facts. Results include `not_applicable` outcomes with their
 * reason, so a caller can tell "passed" from "could not judge"; filter with {@link failedResults}.
 */
export function runPageChecks(page: PageFacts): CheckResult[] {
  return checks.flatMap((check) => {
    if (check.evaluator !== 'page') return [];
    const pageCheck = check as PageCheck;
    const applies = pageCheck.appliesTo?.(page) ?? true;
    return [resultOf(check, applies ? pageCheck.run(page) : notApplicable(PAGE_DOES_NOT_APPLY))];
  });
}

/** Runs every site check over one audit's site facts, with the same not-applicable handling. */
export function runSiteChecks(site: SiteFacts): CheckResult[] {
  return checks.flatMap((check) => {
    if (check.evaluator !== 'site') return [];
    const siteCheck = check as SiteCheck;
    const applies = siteCheck.appliesTo?.(site) ?? true;
    return [resultOf(check, applies ? siteCheck.run(site) : notApplicable(SITE_DOES_NOT_APPLY))];
  });
}

/** The results that failed, for callers that only need findings. */
export function failedResults(results: readonly CheckResult[]): CheckResult[] {
  return results.filter((result) => result.outcome === 'fail');
}
