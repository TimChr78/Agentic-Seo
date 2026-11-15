import type { Tx } from '@agentic-seo/db';
import { sql } from 'drizzle-orm';

// Durable job enqueueing for a recommendation run. The command creates the run row and must not
// commit without its job: a crash between the commit and the server's `addJob` would leave a run
// nobody runs. The app role has no rights on Graphile Worker's tables, so migration 0011's
// `recommendation_enqueue` (security definer) is the one narrow door, modelled on `crawl_enqueue`.
//
// A false return means Graphile Worker's schema is not installed yet. That is not an error: the run
// stays `queued` and the server's reconciler queues it on a later tick.

/** The Graphile Worker task identifiers (letters, digits, `_`, `-`, `:` only). */
export const RECOMMENDATIONS_GENERATE_TASK = 'recommendations_generate';
export const RECOMMENDATIONS_RECONCILE_TASK = 'recommendations_reconcile';

/** The payload every run job carries. */
export interface RecommendationRunPayload extends Record<string, unknown> {
  workspaceId: string;
  runId: string;
  siteId: string;
}

/** Enqueues one run through the database wrapper, inside the caller's transaction. */
export async function enqueueRecommendationRun(tx: Tx, payload: RecommendationRunPayload, runAt?: Date): Promise<boolean> {
  const { rows } = await tx.execute<{ enqueued: boolean }>(sql`
    SELECT recommendation_enqueue(
      ${RECOMMENDATIONS_GENERATE_TASK},
      ${JSON.stringify(payload)}::jsonb,
      ${runAt ? runAt.toISOString() : null}::timestamptz
    ) AS enqueued`);
  return rows[0]?.enqueued === true;
}
