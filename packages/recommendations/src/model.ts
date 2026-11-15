import { modelErrorText, usageFromError } from '@agentic-seo/ai';
import { generateText, type LanguageModel, NoObjectGeneratedError, Output } from 'ai';
import { z } from 'zod';

// The two model steps of a run, in the AI SDK's structured-output mode: each call returns a parsed
// object, never prose, so the validator reads fields instead of Markdown. The schemas here are the
// contract with the model; `packages/artifacts`' recommendation schema is the contract with the
// product, and the runner validates one against the other.
//
// The schemas deliberately omit the traffic at stake and the dependency ids: the first is computed
// from the evidence pages, the second names recommendations the model cannot know the ids of.

/** What the technical specialist returns: groups of issues one change can fix. */
export const technicalCandidateSchema = z.object({
  title: z.string().describe('One line: what to fix, e.g. "Add the missing titles on 12 product pages"'),
  issueIds: z.array(z.string()).max(50).describe('Every issue id this candidate covers, from the facts'),
  changeTypes: z
    .array(z.enum(['meta.title', 'meta.description', 'schema.jsonld', 'image.alt', 'redirect']))
    .max(5)
    .describe('The change types a fix needs; empty when the site cannot apply any of them yet'),
  rationale: z.string().describe('One or two sentences: the severity, the affected pages and the clicks, from the facts'),
  effort: z.enum(['small', 'medium', 'large']),
  affectedUrls: z.array(z.string()).max(10).describe('The page URLs this candidate touches, from the facts'),
});

export const technicalOutputSchema = z.object({ candidates: z.array(technicalCandidateSchema).max(20) });

/** What the strategist returns: the recommendations themselves, without the computed fields. */
export const recommendationDraftSchema = z.object({
  title: z.string().max(200).describe('What to do, in one line'),
  rationale: z.string().max(4000).describe('Why this, why now, in Markdown; only numbers the facts carry'),
  evidence: z
    .array(
      z.object({
        kind: z.enum(['issue', 'finding', 'search_fact', 'audit']),
        id: z.string().describe('An issue id, a finding id, the audit id, or a page URL with Search Console data, from the facts'),
        note: z.string().describe('What this evidence shows, in one line'),
      }),
    )
    .min(1)
    .max(20)
    .describe('At least one item, from the facts'),
  hypothesis: z.string().max(2000).describe('If we do this, then that, because …'),
  expectedImpact: z.object({
    summary: z.string().max(1000).describe('An estimate, e.g. "Expected: CTR +10–20% on 34 queries"'),
    confidence: z.enum(['low', 'medium', 'high']),
  }),
  effort: z.enum(['small', 'medium', 'large']),
  verificationPlan: z.object({
    recheck: z.string().max(2000).describe('What to re-fetch or re-measure, and what it must show'),
    when: z.string().max(500).describe('When, e.g. "28 days after the deploy"'),
  }),
  falsificationCheck: z.string().max(1000).describe('Starts with "We will know this failed if"'),
  leadingIndicator: z.string().max(500).describe('The earliest daily signal that it is working'),
  proposedChanges: z
    .array(
      z.object({
        type: z.enum(['meta.title', 'meta.description', 'schema.jsonld', 'image.alt', 'redirect']),
        url: z.string().describe('The page the change is about'),
        summary: z.string().max(500).describe('The edit, in one line'),
      }),
    )
    .max(20)
    .describe('The changes it implies; only types the site can apply'),
});

export const strategistOutputSchema = z.object({ recommendations: z.array(recommendationDraftSchema).max(20) });

export type TechnicalCandidate = z.output<typeof technicalCandidateSchema>;
/** One recommendation as the strategist returns it: the content without the server-derived fields. */
export type RecommendationDraft = z.output<typeof recommendationDraftSchema>;
export type StrategistRecommendation = RecommendationDraft;

export interface StructuredCall<T> {
  value: T;
  inputTokens: number;
  outputTokens: number;
  /** False when the provider reported no usage and the reservation's estimate stands in. */
  usageReported: boolean;
  latencyMs: number;
}

/**
 * One structured call. `system` is the specialist's playbook (a published `skill` artifact), `prompt`
 * is the bounded facts payload plus, on a retry, the validation errors to fix. A model that answers
 * with something the schema refuses is a `NoObjectGeneratedError`; its usage is still read out of the
 * error, because the provider billed for it.
 */
export async function structuredCall<T>(input: {
  model: LanguageModel;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxOutputTokens: number;
  timeoutMs?: number;
}): Promise<StructuredCall<T>> {
  const started = Date.now();
  try {
    const result = await generateText({
      model: input.model,
      system: input.system,
      prompt: input.prompt,
      maxOutputTokens: input.maxOutputTokens,
      maxRetries: 1,
      timeout: input.timeoutMs ?? 120_000,
      output: Output.object({ schema: input.schema }),
    });
    return {
      value: result.output as T,
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      usageReported: result.usage.inputTokens !== undefined || result.usage.outputTokens !== undefined,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    // A schema refusal still cost tokens; the runner settles the reservation with them.
    if (NoObjectGeneratedError.isInstance(err)) {
      const usage = usageFromError(err);
      const error = Object.assign(new Error(`the model's answer was not the expected JSON object (${modelErrorText(err)})`), {
        usage: usage ?? null,
      });
      throw error;
    }
    throw new Error(modelErrorText(err));
  }
}
