import type { FactsPayload } from './facts';
import { metricNumbers } from './facts';
import type { RecommendationDraft } from './model';

// Output validation (agents-and-autonomy.md §5): a recommendation without evidence ids, a hypothesis,
// a falsification check and a leading indicator fails and is retried, then dropped with a reason. The
// content schema enforces the fields; this module enforces the two rules a schema cannot express:
//
//   * no metric in the prose that the facts did not supply, and
//   * no forbidden promise (DESIGN.md §6: never "boost", "skyrocket", "guaranteed", "SEO juice").
//
// The number rule is applied to the rationale and the expected-impact summary only — the two places
// a recommendation makes a claim about the world. A falsification check may name its own threshold
// ("not ≥ control + 5%"), which is a pre-registered decision, not a statement of fact.

/** DESIGN.md §6: words a recommendation never uses. */
export const FORBIDDEN_WORDS = ['boost', 'skyrocket', 'guarantee', 'guaranteed', 'seo juice'] as const;

/** The fields a number may appear in, with the name a person sees in the error. */
const CLAIM_FIELDS: { path: string; text: (item: RecommendationDraft) => string }[] = [
  { path: 'title', text: (item) => item.title },
  { path: 'rationale', text: (item) => item.rationale },
  { path: 'expectedImpact.summary', text: (item) => item.expectedImpact.summary },
];

/** The fields forbidden words are checked in: everything a person reads as a sentence. */
const PROSE_FIELDS: { path: string; text: (item: RecommendationDraft) => string }[] = [
  ...CLAIM_FIELDS,
  { path: 'hypothesis', text: (item) => item.hypothesis },
  { path: 'verificationPlan.recheck', text: (item) => item.verificationPlan.recheck },
  { path: 'verificationPlan.when', text: (item) => item.verificationPlan.when },
  { path: 'falsificationCheck', text: (item) => item.falsificationCheck },
  { path: 'leadingIndicator', text: (item) => item.leadingIndicator },
  // Every other field a person reads: an evidence note and a proposed change's summary are prose
  // the strategist writes, and a promise hidden in one is as visible as one in the rationale.
  { path: 'evidence[].note', text: (item) => item.evidence.map((evidence) => evidence.note).join('\n') },
  { path: 'proposedChanges[].summary', text: (item) => item.proposedChanges.map((change) => change.summary).join('\n') },
];

/** A number as written: "1,240", "28", "10". Trailing punctuation is not part of it. */
const NUMBER_TOKEN = /\d[\d,]*(?:\.\d+)?/g;

const tokensOf = (text: string): string[] => (text.match(NUMBER_TOKEN) ?? []).map((token) => token.replace(/,/g, ''));

/**
 * The problems with one draft's prose, as sentences for the retry and for the run's dropped list.
 * Empty means the draft may be created.
 */
export function proseProblems(item: RecommendationDraft, facts: FactsPayload): string[] {
  const problems: string[] = [];
  // The fields the synthesis method makes structural. The model's JSON schema marks them required,
  // but an empty string is still an answer; this is where "hypothesis: ''" is refused.
  const required: { path: string; value: string }[] = [
    { path: 'title', value: item.title },
    { path: 'rationale', value: item.rationale },
    { path: 'hypothesis', value: item.hypothesis },
    { path: 'expectedImpact.summary', value: item.expectedImpact.summary },
    { path: 'verificationPlan.recheck', value: item.verificationPlan.recheck },
    { path: 'verificationPlan.when', value: item.verificationPlan.when },
    { path: 'falsificationCheck', value: item.falsificationCheck },
    { path: 'leadingIndicator', value: item.leadingIndicator },
  ];
  for (const field of required)
    if (!field.value?.trim())
      problems.push(
        `${field.path} is empty. A recommendation needs every synthesis field: evidence, a hypothesis, a verification plan, a falsification check and a leading indicator`,
      );
  if (!item.evidence.length)
    problems.push('evidence is empty. A recommendation rests on at least one issue, finding, page with Search Console data, or audit');

  const allowed = metricNumbers(facts);
  for (const field of CLAIM_FIELDS) {
    const text = field.text(item);
    if (tokensOf(text).some((token) => !allowed.has(token)))
      // The offending number is deliberately not quoted: this sentence is fed back to the model on
      // its retry, and model-written text must not travel inside the instruction block.
      problems.push(
        `${field.path} states a number the facts this run supplied do not carry. Use only the counts, page totals and clicks the facts carry, or drop the number`,
      );
  }
  const prose = (item: RecommendationDraft): { path: string; text: string }[] =>
    PROSE_FIELDS.map((field) => ({ path: field.path, text: field.text(item) }));
  for (const field of prose(item)) {
    for (const word of FORBIDDEN_WORDS) {
      const pattern = new RegExp(`\\b${word.replace(' ', '\\s+')}\\b`, 'i');
      if (pattern.test(field.text))
        problems.push(
          `${field.path} uses "${word}", which a recommendation never says. State an expectation ("Expected: …"), never a promise`,
        );
    }
  }
  return problems;
}
