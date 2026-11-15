// How a check reports what it saw (crawler-and-audits.md §5, ADR-0008).
//
// A check answers three ways: it passed, it failed with evidence, or it does not apply to this
// subject. A failure may carry many evidence items (every image missing alt on a page), so a page
// with thousands of offenders cannot produce an unbounded finding: the list is capped and the true
// total travels beside it. Issues and the health score arrive in a later task; this package only
// produces outcomes.

/** One thing a check saw, addressed so a person can find it. */
export interface Evidence {
  /** The URL the evidence is about, or `url#selector` when it names a fragment of a page. */
  subject: string;
  /** What was found, e.g. the title text or the status code. */
  value?: string;
  /** What the check expected instead, in the copy the UI can show. */
  expected?: string;
  /** A CSS selector pointing at the element, when the evidence is one. */
  selector?: string;
  /** The page that links to or declares the subject, when it is not the subject itself. */
  sourceUrl?: string;
  /** One sentence of context for the item. */
  detail?: string;
}

export interface PassOutcome {
  outcome: 'pass';
}

export interface FailOutcome {
  outcome: 'fail';
  evidence: Evidence[];
  /** The true number of failing items, before the evidence cap. */
  total: number;
  /** Whether evidence was dropped because the cap was reached. */
  truncated: boolean;
}

export interface NotApplicableOutcome {
  outcome: 'not_applicable';
  /** Why the check could not judge this subject, in words a person can read. */
  reason: string;
}

export type CheckOutcome = PassOutcome | FailOutcome | NotApplicableOutcome;

/**
 * How many evidence items one finding keeps. A page can have 2,000 images or links; the finding
 * names the first 50 and reports the rest through `total`, so storage and UI stay bounded.
 */
export const MAX_EVIDENCE = 50;

export function pass(): PassOutcome {
  return { outcome: 'pass' };
}

/**
 * A failure with evidence. Pass one item or a list; the list is capped at {@link MAX_EVIDENCE}.
 * `total` may be supplied when the caller stopped building items at the cap and knows the real count.
 */
export function fail(evidence: Evidence | readonly Evidence[], total?: number): FailOutcome {
  const items = Array.isArray(evidence) ? (evidence as readonly Evidence[]) : [evidence as Evidence];
  const kept = items.slice(0, MAX_EVIDENCE);
  const trueTotal = total ?? items.length;
  return { outcome: 'fail', evidence: kept, total: trueTotal, truncated: trueTotal > kept.length };
}

export function notApplicable(reason: string): NotApplicableOutcome {
  return { outcome: 'not_applicable', reason };
}
