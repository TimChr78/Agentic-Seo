import { safeErrorText } from '@agentic-seo/core';
import { type Db, schema, type Tx } from '@agentic-seo/db';
import type { KeyProvider } from '@agentic-seo/secrets';
import { logger } from '@agentic-seo/telemetry';
import { eq, inArray, sql } from 'drizzle-orm';
import { modelErrorText, promptVersion, runTestCase, tierOf } from './prompts';
import { AiUnavailable, billingReservationTtlMs, estimateTokens, modelFor, reserveTokens, settleReservation } from './providers';

// The AI worker's one job in Phase 0: run the prompt test cases `prompts.test` queued. A pending
// row in ai_calls is the work item; the worker claims it with a lease, reads the prompt and its
// model in one transaction, calls the model outside any transaction, then records the outcome and
// settles the budget reservation together. Ported from the test-case half of Agentic Marketing
// 9a7a5721 (packages/ai/src/steps.ts); the journey steps, classify, hosted and decision paths are
// not part of this task.

export interface AiWorkerDeps {
  kp: KeyProvider;
  /** Test-only: the scripted LLM server listens on loopback, which the production guard refuses. */
  fetch?: typeof fetch;
}

const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 3;

type CallRow = typeof schema.aiCalls.$inferSelect;

/** The outcome columns a finished call writes; the lease and finish time are always cleared/set. */
type CallOutcome = Partial<typeof schema.aiCalls.$inferInsert>;

const finishIn = (tx: Tx, c: CallRow, outcome: CallOutcome) =>
  tx
    .update(schema.aiCalls)
    .set({ leaseUntil: null, finishedAt: new Date(), billedAt: new Date(), ...outcome })
    .where(eq(schema.aiCalls.id, c.id));

/** Writes an outcome with no model call behind it (a missing prompt, no provider, an old row). */
async function finish(db: Db, c: CallRow, outcome: CallOutcome) {
  await db.withWorkspace(c.workspaceId, (tx) => finishIn(tx, c, outcome));
}

/**
 * What a finished call records as its tokens. A model that answered but reported no usage (or a
 * call that failed after it was sent) was still billed: the reservation's estimate stands in, which
 * is the conservative direction for a budget. The estimate is recorded as input tokens so the total
 * the budget sums is right even when the split is unknown, and a reported count is always trusted
 * (a reported zero is still a report).
 */
const billedUsage = (usage: { inputTokens: number; outputTokens: number }, reported: boolean, estimate: number) =>
  reported ? usage : { inputTokens: estimate, outputTokens: 0 };

/** One queued prompt test case: run outside any transaction, then recorded. */
async function handleTest(db: Db, c: CallRow, deps: AiWorkerDeps) {
  const index = Number((c.input as { index?: number }).index);
  const ready = await db.withWorkspace(c.workspaceId, async (tx) => {
    const p = await promptVersion(tx, c.promptId ?? '', c.promptVersion ?? undefined);
    const test = p?.def.tests[index];
    if (!p || !test) return null;
    try {
      return { def: p.def, test, model: await modelFor(tx, deps.kp, 'agents', tierOf(p.def), { fetch: deps.fetch }) };
    } catch (err) {
      if (err instanceof AiUnavailable) return { error: `${err.reason}: ${err.message}` };
      throw err;
    }
  });
  if (!ready) return finish(db, c, { status: 'failed', error: 'the prompt version or test case is gone' });
  if ('error' in ready) return finish(db, c, { status: 'failed', error: ready.error ?? null });

  const estimate = estimateTokens({ def: ready.def, test: ready.test }, ready.def.maxOutputTokens);
  let reservation: string;
  try {
    // Before any network I/O, and durable past the call: the process may die after the provider
    // billed. The hold names its attempt, so a recovered stale attempt keeps counting it.
    reservation = await reserveTokens(db, c.workspaceId, ready.model.providerId, estimate, {
      ttlMs: billingReservationTtlMs(),
      callId: c.id,
    });
  } catch (err) {
    if (err instanceof AiUnavailable) return finish(db, c, { status: 'failed', error: `${err.reason}: ${err.message}` });
    throw err;
  }

  const started = Date.now();
  let outcome: CallOutcome;
  try {
    const r = await runTestCase(ready.model, ready.def, ready.test);
    outcome = {
      status: r.problems.length ? 'failed' : 'done',
      providerId: ready.model.providerId,
      model: ready.model.modelId,
      input: { ...c.input, input: r.input },
      output: r.answer,
      error: r.problems.length ? safeErrorText(r.problems.join('; '), 1000) : null,
      ...billedUsage(r.usage, r.usageReported, estimate),
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    // runTestCase reports a failed call as a problem; this is the unexpected kind (a broken prompt).
    outcome = {
      status: 'failed',
      error: modelErrorText(err),
      ...billedUsage({ inputTokens: 0, outputTokens: 0 }, false, estimate),
      latencyMs: Date.now() - started,
    };
  }
  // The usage and the released hold commit together: a concurrent call sees the hold or the usage,
  // never a gap. A write that keeps failing holds the budget through the month on purpose.
  const settled = await settleReservation(
    db,
    c.workspaceId,
    reservation,
    async (tx) => {
      await finishIn(tx, c, outcome);
    },
    { label: `ai prompt test ${c.id}` },
  );
  if (settled === 'held') logger.error({ workspaceId: c.workspaceId, callId: c.id }, 'AI test usage not recorded; budget reservation kept');
}

/**
 * Claims due prompt test cases across workspaces and runs them, a few at a time. Returns how many
 * it handled. The discovery query reads across tenants through the owner connection, exactly like
 * the OAuth cleanup; every read and write about a call then runs under that workspace's RLS.
 */
export async function runQueuedPromptTests(db: Db, deps: AiWorkerDeps, opts: { batch?: number } = {}): Promise<number> {
  const { rows } = await db.admin.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM ai_calls
     WHERE kind = 'test' AND (status = 'pending' OR (status = 'running' AND lease_until < now())) LIMIT 100`,
  );
  let handled = 0;
  for (const { workspace_id: ws } of rows) {
    const claimed = await db.withWorkspace(ws, async (tx) => {
      const res = await tx.execute<{ id: string }>(sql`
        UPDATE ai_calls SET status = 'running', lease_until = now() + ${`${LEASE_MS} milliseconds`}::interval, attempts = attempts + 1
        WHERE workspace_id = ${ws} AND id IN (
          SELECT id FROM ai_calls
          WHERE kind = 'test' AND (status = 'pending' OR (status = 'running' AND lease_until < now()))
          ORDER BY created_at LIMIT ${opts.batch ?? 8} FOR UPDATE SKIP LOCKED)
        RETURNING id`);
      if (!res.rows.length) return [];
      return tx
        .select()
        .from(schema.aiCalls)
        .where(
          inArray(
            schema.aiCalls.id,
            res.rows.map((r) => r.id),
          ),
        );
    });
    await Promise.all(
      claimed.map((c) =>
        (c.attempts > MAX_ATTEMPTS
          ? finish(db, c, { status: 'failed', error: `gave up after ${MAX_ATTEMPTS} attempts` })
          : handleTest(db, c, deps)
        ).catch((err) => logger.error({ err, call: c.id }, 'AI prompt test failed')),
      ),
    );
    handled += claimed.length;
  }
  return handled;
}
