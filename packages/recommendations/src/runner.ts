import {
  AiUnavailable,
  estimateTokens,
  modelErrorText,
  modelFor,
  type ReadyModel,
  recordAiCall,
  reserveTokens,
  settleReservation,
} from '@agentic-seo/ai';
import { artifactTypes, type Recommendation, validateContent } from '@agentic-seo/artifacts';
import { AppError, hashValue, newId } from '@agentic-seo/core';
import { type Db, schema, type Tx } from '@agentic-seo/db';
import { estimateReach } from '@agentic-seo/search-data';
import type { KeyProvider } from '@agentic-seo/secrets';
import { logger } from '@agentic-seo/telemetry';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { RECOMMENDATIONS_GENERATE_TASK } from './enqueue';
import { type EvidenceItem, pagesOf, problemsText, resolveEvidence } from './evidence';
import { type FactsPayload, factsText, gatherFacts } from './facts';
import {
  type RecommendationDraft,
  type StructuredCall,
  strategistOutputSchema,
  structuredCall,
  type TechnicalCandidate,
  technicalOutputSchema,
} from './model';
import { ensureSpecialists, type InstalledSpecialist, type SpecialistName, tierOfSpecialist } from './specialists';
import { proseProblems } from './validation';

// The run behind `recommendations.generate` (agents-and-autonomy.md §5, "full audit run"). A run is
// two model steps over facts nobody made up:
//
//   1. the technical specialist (fast tier) proposes candidates from the site's open issues;
//   2. the strategist (deep tier) merges them into falsifiable recommendations;
//   3. every item is validated — its evidence ids exist for this site, no number in its prose is
//      missing from the facts, no forbidden promise — retried once with those errors, then dropped
//      with the reason, which the run records.
//
// Model calls happen outside any transaction (as packages/ai's worker does), each with a token
// reservation settled against the provider's budget and a row in the AI decision log. The drafts and
// the run row are written in one transaction at the end: a run that fails creates nothing.

const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;

export interface RecommendationRunDeps {
  kp: KeyProvider;
  /** Test-only: the scripted LLM server listens on loopback, which the production guard refuses. */
  fetch?: typeof fetch;
  now?: () => Date;
  /** Queues a retry or a reconciler's job; supplied per job by the server. */
  enqueue?: (identifier: string, payload: Record<string, unknown>) => Promise<void>;
}

export interface RunPayload {
  workspaceId: string;
  runId: string;
  siteId: string;
}

export interface RunOutcome {
  status: 'completed' | 'failed' | 'skipped';
  created: number;
  dropped: number;
  error?: string;
}

/** Why a run stopped: the budget message is the one a person can act on. */
class RunFailure extends AppError {}

const payloadOf = (raw: unknown): RunPayload => {
  const payload = (raw ?? {}) as { workspaceId?: unknown; runId?: unknown; siteId?: unknown };
  if (typeof payload.workspaceId !== 'string' || typeof payload.runId !== 'string' || typeof payload.siteId !== 'string')
    throw new Error('a recommendation job needs a workspaceId, a runId and a siteId');
  return { workspaceId: payload.workspaceId, runId: payload.runId, siteId: payload.siteId };
};

interface Prepared {
  facts: FactsPayload;
  specialists: Record<SpecialistName, InstalledSpecialist>;
  technical: ReadyModel;
  strategist: ReadyModel;
  /** The person the specialists' artifacts name as sponsor. */
  sponsor: string;
}

/** Claims the run, reads the facts and the playbooks, and resolves both models. */
async function prepare(db: Db, payload: RunPayload, deps: RecommendationRunDeps, now: Date): Promise<Prepared | 'skipped'> {
  return db.withWorkspace(payload.workspaceId, async (tx) => {
    const [run] = await tx.select().from(schema.recommendationRuns).where(eq(schema.recommendationRuns.id, payload.runId)).for('update');
    if (!run) throw new RunFailure('not_found', `Recommendation run ${payload.runId} does not exist in this workspace.`);
    if (run.state === 'completed' || run.state === 'failed') return 'skipped' as const;
    // A live worker holds the lease; a retried job waits for it to expire rather than running twice.
    if (run.state === 'running' && run.leaseUntil && run.leaseUntil.getTime() > now.getTime() && run.attempts > 0)
      return 'skipped' as const;
    if (run.attempts >= MAX_ATTEMPTS) throw new RunFailure('conflict', `This run failed ${run.attempts} times; start a new one.`);
    await tx
      .update(schema.recommendationRuns)
      .set({
        state: 'running',
        attempts: run.attempts + 1,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        startedAt: run.startedAt ?? now,
        updatedAt: now,
      })
      .where(eq(schema.recommendationRuns.id, run.id));

    const [site] = await tx
      .select({ name: schema.sites.name, archived: schema.sites.archived })
      .from(schema.sites)
      .where(eq(schema.sites.id, payload.siteId));
    if (!site) throw new RunFailure('not_found', `Site ${payload.siteId} does not exist in this workspace.`);
    if (site.archived) throw new RunFailure('conflict', `Site “${site.name}” is archived, so there is nothing to recommend for it.`);

    const specialists = await ensureSpecialists(tx, payload.workspaceId, run.requestedById);
    const facts = await gatherFacts(tx, {
      workspaceId: payload.workspaceId,
      siteId: payload.siteId,
      ...(run.auditId ? { auditId: run.auditId } : {}),
      maxRecommendations: run.maxRecommendations,
      now,
    });
    if (!facts.audit)
      throw new RunFailure(
        'precondition_failed',
        'This site has no completed audit, so there are no facts for the specialists to read. Run audits.run first.',
      );
    if (facts.audit.id !== run.auditId)
      await tx.update(schema.recommendationRuns).set({ auditId: facts.audit.id }).where(eq(schema.recommendationRuns.id, run.id));

    const technical = await modelForTier(tx, deps.kp, 'technical', deps);
    const strategist = await modelForTier(tx, deps.kp, 'strategist', deps);
    return {
      facts,
      specialists: {
        technical: specialists.find((specialist) => specialist.name === 'technical') as InstalledSpecialist,
        strategist: specialists.find((specialist) => specialist.name === 'strategist') as InstalledSpecialist,
      },
      technical,
      strategist,
      sponsor: run.requestedById,
    };
  });
}

async function modelForTier(tx: Tx, kp: KeyProvider, name: SpecialistName, deps: RecommendationRunDeps): Promise<ReadyModel> {
  const tier = tierOfSpecialist(name) === 'fast' ? 'fast' : 'default';
  try {
    return await modelFor(tx, kp, 'agents', tier, deps.fetch ? { fetch: deps.fetch } : {});
  } catch (err) {
    if (err instanceof AiUnavailable) throw new RunFailure('precondition_failed', budgetMessage(err));
    throw err;
  }
}

const budgetMessage = (err: AiUnavailable): string =>
  err.reason === 'no_provider'
    ? 'No AI provider is set up for the agents use. Add one with aiProviders.create and useFor ["agents"], then run recommendations.generate again.'
    : err.reason === 'budget'
      ? 'The agents provider’s monthly token budget is used up, so this run could not start. Raise the budget with aiProviders.update, or wait for the next month.'
      : 'The agents provider has no API key. Add one with aiProviders.update, then run recommendations.generate again.';

/** Token totals one call was billed, after settlement. */
interface Billed {
  input: number;
  output: number;
}

/**
 * One structured call with the budget around it: reserve before the network, settle with the
 * `ai_calls` row after it. A model that answers with the wrong shape still cost tokens, so its usage
 * is read out of the error; without a report the reservation's estimate stands in.
 */
async function callWithBudget<T>(
  db: Db,
  input: {
    workspaceId: string;
    ready: ReadyModel;
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    maxOutputTokens: number;
    promptId: string;
    promptVersion: number;
    runId: string;
    siteId: string;
    specialist: SpecialistName;
    label: string;
  },
): Promise<{ call: StructuredCall<T>; billed: Billed }> {
  const callId = newId('aic');
  const estimate = estimateTokens({ system: input.system, prompt: input.prompt }, input.maxOutputTokens);
  const facts = { runId: input.runId, siteId: input.siteId, specialist: input.specialist, factsChars: input.prompt.length };
  // The row exists before the reservation: `ai_token_reservations.call_id` points at it, exactly as
  // packages/ai's worker queues a call before it holds budget for it. The call is then updated with
  // its outcome, so the decision log has the row whether or not the model answered.
  await db.withWorkspace(input.workspaceId, (tx) =>
    tx.insert(schema.aiCalls).values({
      workspaceId: input.workspaceId,
      id: callId,
      kind: 'generate',
      status: 'pending',
      providerId: input.ready.providerId,
      model: input.ready.modelId,
      promptId: input.promptId,
      promptVersion: input.promptVersion,
      input: facts,
    }),
  );
  let reservation: string;
  try {
    reservation = await reserveTokens(db, input.workspaceId, input.ready.providerId, estimate, { callId });
  } catch (err) {
    // Nothing will settle the hold, so the call is closed as failed with the reason.
    const message = err instanceof AiUnavailable ? budgetMessage(err) : modelErrorText(err);
    await db.withWorkspace(input.workspaceId, (tx) =>
      tx
        .update(schema.aiCalls)
        .set({ status: 'failed', error: message.slice(0, 1000), finishedAt: new Date(), billedAt: new Date() })
        .where(eq(schema.aiCalls.id, callId)),
    );
    if (err instanceof AiUnavailable) throw new RunFailure('precondition_failed', message);
    throw err;
  }
  let call: StructuredCall<T> | null = null;
  let failure: unknown = null;
  try {
    call = await structuredCall({
      model: input.ready.model,
      system: input.system,
      prompt: input.prompt,
      schema: input.schema,
      maxOutputTokens: input.maxOutputTokens,
    });
  } catch (err) {
    failure = err;
  }
  const fromError = (failure as { usage?: { inputTokens?: number; outputTokens?: number } } | null)?.usage;
  const reported = call ? call.usageReported : fromError !== undefined;
  const billed: Billed = reported
    ? { input: call?.inputTokens ?? fromError?.inputTokens ?? 0, output: call?.outputTokens ?? fromError?.outputTokens ?? 0 }
    : { input: estimate, output: 0 };
  const status: 'done' | 'failed' = failure ? 'failed' : 'done';
  const outcome = {
    status,
    output: call ? summarise(input.specialist, call.value) : null,
    rationale:
      input.specialist === 'technical'
        ? 'The technical specialist read the site’s open issues and proposed candidates for the strategist.'
        : 'The strategist merged the candidates and the open recommendations into falsifiable recommendations.',
    error: failure ? modelErrorText(failure) : null,
    inputTokens: billed.input,
    outputTokens: billed.output,
    latencyMs: call?.latencyMs ?? null,
    finishedAt: new Date(),
    billedAt: new Date(),
  };
  const write = async (tx: Tx) => {
    await tx.update(schema.aiCalls).set(outcome).where(eq(schema.aiCalls.id, callId));
  };
  const settled = await settleReservation(db, input.workspaceId, reservation, write, {
    // A write that fails its own transaction still records the usage in a fresh one.
    fallback: async () => {
      await recordAiCall(db, input.workspaceId, {
        id: callId,
        kind: 'generate',
        status,
        inputTokens: billed.input,
        outputTokens: billed.output,
      });
    },
    label: input.label,
  });
  if (settled === 'held') logger.error({ runId: input.runId, callId }, 'recommendation call usage not recorded; budget reservation kept');
  if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
  return { call: call as StructuredCall<T>, billed };
}

/** A compact output for the decision log: titles and counts, never a second copy of the payload. */
const summarise = (specialist: SpecialistName, value: unknown): Record<string, unknown> => {
  if (specialist === 'technical') {
    const output = value as { candidates?: { title: string }[] };
    return {
      candidates: output.candidates?.length ?? 0,
      titles: (output.candidates ?? []).map((candidate) => candidate.title).slice(0, 20),
    };
  }
  const output = value as { recommendations?: { title: string }[] };
  return {
    recommendations: output.recommendations?.length ?? 0,
    titles: (output.recommendations ?? []).map((recommendation) => recommendation.title).slice(0, 20),
  };
};

const candidatePrompt = (facts: FactsPayload): string =>
  `<facts>\n${factsText(facts)}\n</facts>\n\n<task>\nPropose at most ${facts.limits.maxRecommendations} candidates, worst first. Every number you state must appear in the facts.\n</task>`;

const strategistPrompt = (facts: FactsPayload, candidates: TechnicalCandidate[]): string =>
  `<facts>\n${factsText(facts)}\n</facts>\n\n<candidates>\n${JSON.stringify(candidates, null, 2)}\n</candidates>\n\n<task>\nWrite at most ${facts.limits.maxRecommendations} recommendations. Cite evidence ids from the facts, state only numbers the facts carry, and make each one falsifiable.\n</task>`;

const retryPrompt = (prompt: string, problems: { title: string; errors: string[] }[]): string =>
  `${prompt}\n\n<validation_errors>\n${JSON.stringify(problems, null, 2)}\n</validation_errors>\n\nReturn only the corrected items, each keeping its title exactly. Fix every error listed; an item that still fails is dropped from the run.`;

interface Validated {
  draft: RecommendationDraft;
  problems: string[];
}

/**
 * The evidence and prose checks for a batch of drafts, inside the workspace transaction. The content
 * schema runs later, when the draft is built (it needs the computed reach).
 */
async function validateDrafts(db: Db, payload: RunPayload, facts: FactsPayload, drafts: RecommendationDraft[]): Promise<Validated[]> {
  return db.withWorkspace(payload.workspaceId, async (tx) => {
    const out: Validated[] = [];
    for (const draft of drafts) {
      const problems = [...proseProblems(draft, facts)];
      const resolution = await resolveEvidence(tx, {
        workspaceId: payload.workspaceId,
        siteId: payload.siteId,
        items: draft.evidence as EvidenceItem[],
      });
      if (!resolution.ok) problems.push(...resolution.problems.map((problem) => problem.problem));
      out.push({ draft, problems });
    }
    return out;
  });
}

/** The specialist's agent row, created on first use, so its drafts land in the action ledger. */
async function specialistAgent(tx: Tx, workspaceId: string, name: string, sponsor: string): Promise<string> {
  const [existing] = await tx
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.name, name)));
  if (existing) return existing.id;
  const id = newId('agt');
  await tx.insert(schema.agents).values({ workspaceId, id, name, sponsorUserId: sponsor });
  return id;
}

export const specialistAgentName = (name: SpecialistName): string => (name === 'technical' ? 'Technical specialist' : 'Strategist');

/**
 * Runs one queued run to completion. Returns what it did; a failure is recorded on the run row and
 * returned, never thrown for the worker to retry (a validation drop is not a transient error).
 */
export async function runRecommendationGeneration(db: Db, raw: unknown, deps: RecommendationRunDeps): Promise<RunOutcome> {
  const payload = payloadOf(raw);
  const now = deps.now?.() ?? new Date();
  let prepared: Prepared | 'skipped';
  try {
    prepared = await prepare(db, payload, deps, now);
  } catch (err) {
    return failRun(db, payload, err, deps);
  }
  if (prepared === 'skipped') return { status: 'skipped', created: 0, dropped: 0 };

  const { facts, specialists, technical, strategist } = prepared;
  const billed: Billed = { input: 0, output: 0 };

  try {
    const technicalCall = await callWithBudget(db, {
      workspaceId: payload.workspaceId,
      ready: technical,
      system: specialists.technical.skill.instructions,
      prompt: candidatePrompt(facts),
      schema: technicalOutputSchema,
      maxOutputTokens: 1500,
      promptId: specialists.technical.artifactId,
      promptVersion: specialists.technical.version,
      runId: payload.runId,
      siteId: payload.siteId,
      specialist: 'technical',
      label: `recommendation candidates ${payload.runId}`,
    });
    billed.input += technicalCall.billed.input;
    billed.output += technicalCall.billed.output;
    const candidates = technicalCall.call.value.candidates;

    const base = strategistPrompt(facts, candidates);
    const first = await callWithBudget(db, {
      workspaceId: payload.workspaceId,
      ready: strategist,
      system: specialists.strategist.skill.instructions,
      prompt: base,
      schema: strategistOutputSchema,
      maxOutputTokens: 4000,
      promptId: specialists.strategist.artifactId,
      promptVersion: specialists.strategist.version,
      runId: payload.runId,
      siteId: payload.siteId,
      specialist: 'strategist',
      label: `recommendations ${payload.runId}`,
    });
    billed.input += first.billed.input;
    billed.output += first.billed.output;
    const drafts = first.call.value.recommendations.slice(0, facts.limits.maxRecommendations);
    let validated = await validateDrafts(db, payload, facts, drafts);

    const invalid = validated.filter((item) => item.problems.length > 0);
    if (invalid.length) {
      // One retry, with the errors in the prompt. Only the corrected items come back, matched by
      // title, so a valid item from the first answer is never lost to a second one.
      const retry = await callWithBudget(db, {
        workspaceId: payload.workspaceId,
        ready: strategist,
        system: specialists.strategist.skill.instructions,
        prompt: retryPrompt(
          base,
          invalid.map((item) => ({ title: item.draft.title, errors: item.problems })),
        ),
        schema: strategistOutputSchema,
        maxOutputTokens: 4000,
        promptId: specialists.strategist.artifactId,
        promptVersion: specialists.strategist.version,
        runId: payload.runId,
        siteId: payload.siteId,
        specialist: 'strategist',
        label: `recommendations retry ${payload.runId}`,
      });
      billed.input += retry.billed.input;
      billed.output += retry.billed.output;
      const corrected = await validateDrafts(db, payload, facts, retry.call.value.recommendations);
      const byTitle = new Map(corrected.map((item) => [item.draft.title, item]));
      validated = validated.map((item) => {
        if (!item.problems.length) return item;
        const replacement = byTitle.get(item.draft.title);
        if (!replacement)
          return {
            draft: item.draft,
            problems: [...item.problems, 'the retry did not return this item, so it was dropped'],
          };
        return replacement;
      });
    }

    const kept = validated.filter((item) => item.problems.length === 0).map((item) => item.draft);
    const dropped = validated
      .filter((item) => item.problems.length > 0)
      .map((item) => ({ title: item.draft.title, reason: item.problems.join('; ') }));

    const outcome = await createDrafts(db, {
      payload,
      facts,
      drafts: kept,
      dropped,
      specialists,
      sponsor: prepared.sponsor,
      billed,
      candidates: candidates.length,
      derived: drafts.length,
    });
    logger.info({ runId: payload.runId, ...outcome }, 'recommendation run finished');
    return outcome;
  } catch (err) {
    return failRun(db, payload, err, deps, billed);
  }
}

/** Builds and writes the valid drafts, with the specialists' ledger entries, then closes the run. */
async function createDrafts(
  db: Db,
  input: {
    payload: RunPayload;
    facts: FactsPayload;
    drafts: RecommendationDraft[];
    dropped: { title: string; reason: string }[];
    specialists: Record<SpecialistName, InstalledSpecialist>;
    sponsor: string;
    billed: Billed;
    candidates: number;
    derived: number;
  },
): Promise<RunOutcome> {
  return db.withWorkspace(input.payload.workspaceId, async (tx) => {
    const createdIds: string[] = [];
    const dropped = [...input.dropped];
    const agents = new Map<SpecialistName, string>();
    for (const name of ['technical', 'strategist'] as const)
      agents.set(name, await specialistAgent(tx, input.payload.workspaceId, specialistAgentName(name), input.sponsor));

    // Which specialist wrote each item: the strategist is the author of record (agents-and-autonomy
    // §5); the technical specialist's candidates are folded into it and named in the rationale.
    const agentId = agents.get('strategist') as string;
    for (const draft of input.drafts) {
      try {
        const resolution = await resolveEvidence(tx, {
          workspaceId: input.payload.workspaceId,
          siteId: input.payload.siteId,
          items: draft.evidence as EvidenceItem[],
        });
        if (!resolution.ok) {
          dropped.push({ title: draft.title, reason: problemsText(resolution.problems) });
          continue;
        }
        const reach = await estimateReach(tx, {
          workspaceId: input.payload.workspaceId,
          siteId: input.payload.siteId,
          urls: pagesOf(resolution.items),
        });
        const content = (await validateContent(
          'recommendation',
          {
            title: draft.title,
            rationale: draft.rationale,
            evidence: draft.evidence,
            hypothesis: draft.hypothesis,
            expectedImpact: { summary: draft.expectedImpact.summary, trafficAtStake: reach, confidence: draft.expectedImpact.confidence },
            effort: draft.effort,
            dependsOn: [],
            verificationPlan: draft.verificationPlan,
            falsificationCheck: draft.falsificationCheck,
            leadingIndicator: draft.leadingIndicator,
            proposedChanges: draft.proposedChanges,
            author: { kind: 'specialist', specialist: 'strategist' },
          },
          'draft',
        )) as unknown as Recommendation;
        const id = newId(artifactTypes.recommendation.prefix);
        await tx.insert(schema.artifacts).values({
          workspaceId: input.payload.workspaceId,
          id,
          type: 'recommendation',
          name: content.title,
          siteId: input.payload.siteId,
          latestVersion: 1,
          ownerAgentId: agentId,
        });
        await tx.insert(schema.artifactVersions).values({
          workspaceId: input.payload.workspaceId,
          artifactId: id,
          number: 1,
          state: 'draft',
          content,
          contentHash: hashValue(content),
          note: `Generated by the strategist from run ${input.payload.runId}`,
          authorType: 'agent',
          authorId: agentId,
          authorClient: null,
        });
        // The ledger keeps the specialist's action, as for any agent write.
        await tx.insert(schema.agentActions).values({
          workspaceId: input.payload.workspaceId,
          agentId,
          command: 'recommendations.generate',
          actionClass: 'draft',
          decision: 'allow',
          reasons: [
            `The strategist synthesised this recommendation from audit ${input.facts.audit?.id ?? 'the site'} and run ${input.payload.runId}.`,
          ],
          impact: { runId: input.payload.runId, siteId: input.payload.siteId, evidence: content.evidence.length, trafficAtStake: reach },
          ok: true,
          target: id,
          surface: 'internal',
          intent: 'recommendation',
        });
        createdIds.push(id);
      } catch (err) {
        dropped.push({ title: draft.title, reason: err instanceof AppError ? err.message : modelErrorText(err) });
      }
    }
    await tx
      .update(schema.recommendationRuns)
      .set({
        state: 'completed',
        candidates: input.candidates,
        derived: input.derived,
        createdCount: createdIds.length,
        droppedCount: dropped.length,
        dropped,
        createdIds,
        inputTokens: input.billed.input,
        outputTokens: input.billed.output,
        finishedAt: new Date(),
        leaseUntil: null,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.recommendationRuns.id, input.payload.runId));
    return { status: 'completed' as const, created: createdIds.length, dropped: dropped.length };
  });
}

/** Records the failure on the run row (its own transaction: the run's work rolled back). */
async function failRun(db: Db, payload: RunPayload, err: unknown, _deps: RecommendationRunDeps, billed?: Billed): Promise<RunOutcome> {
  const message = err instanceof AppError ? err.message : modelErrorText(err);
  try {
    await db.withWorkspace(payload.workspaceId, (tx) =>
      tx
        .update(schema.recommendationRuns)
        .set({
          state: 'failed',
          error: message.slice(0, 1000),
          ...(billed ? { inputTokens: billed.input, outputTokens: billed.output } : {}),
          finishedAt: new Date(),
          leaseUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.recommendationRuns.id, payload.runId)),
    );
  } catch (writeError) {
    logger.error({ err: writeError, runId: payload.runId }, 'could not record the recommendation run failure');
  }
  logger.warn({ runId: payload.runId, error: message }, 'recommendation run failed');
  return { status: 'failed', created: 0, dropped: 0, error: message };
}

/**
 * The reconciler: queues runs whose job was lost (a fresh install without Graphile's schema, or a
 * worker that died), and fails runs that have used their attempts. Discovery reads across
 * workspaces through the owner connection; every write is workspace-scoped.
 */
export async function reconcileRecommendationRuns(
  db: Db,
  deps: Pick<RecommendationRunDeps, 'enqueue'>,
): Promise<{ queued: number; failed: number }> {
  const { rows } = await db.admin.query<{ workspace_id: string; id: string; site_id: string; attempts: number }>(
    `SELECT workspace_id, id, site_id, attempts FROM recommendation_runs
      WHERE (state = 'queued' AND created_at < now() - interval '2 minutes')
         OR (state = 'running' AND attempts > 0 AND lease_until < now())
      ORDER BY created_at LIMIT 50`,
  );
  let queued = 0;
  let failed = 0;
  for (const row of rows) {
    if (!deps.enqueue) break;
    if (row.attempts >= MAX_ATTEMPTS) {
      await db.withWorkspace(row.workspace_id, (tx) =>
        tx
          .update(schema.recommendationRuns)
          .set({ state: 'failed', error: `Gave up after ${MAX_ATTEMPTS} attempts.`, finishedAt: new Date(), leaseUntil: null })
          .where(eq(schema.recommendationRuns.id, row.id)),
      );
      failed += 1;
      continue;
    }
    await deps.enqueue(RECOMMENDATIONS_GENERATE_TASK, { workspaceId: row.workspace_id, runId: row.id, siteId: row.site_id });
    queued += 1;
  }
  return { queued, failed };
}

/** Exported for tests: the payload shape a job carries. */
export const runPayloadOf = payloadOf;
