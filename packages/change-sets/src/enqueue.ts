import type { Tx } from '@agentic-seo/db';
import { sql } from 'drizzle-orm';
import type { CHANGES_APPLY_TASK, CHANGES_VERIFY_TASK } from './tasks';

// Durable job enqueueing (ADR-0007). The publish that approves a change set and the deploy detection
// that makes it live each move a row and must queue the next job in the same transaction: a crash
// between the commit and a helper's `addJob` would leave the change set in `approved` or `deployed`
// with no job to move it. The app role has no rights on Graphile Worker's tables, so migration 0010's
// `change_set_enqueue` (security definer) is the one narrow door, modelled on `crawl_enqueue`.
//
// A false return means Graphile Worker's schema is not installed yet. That is not an error: the
// caller falls back to the server's enqueue helper, and the poller's reconciliation queues the job on
// a later tick if both were lost.

export type ChangeSetJobTask = typeof CHANGES_APPLY_TASK | typeof CHANGES_VERIFY_TASK;

/** The payload every change-set job carries; the wrapper accepts exactly these three keys. */
export interface ChangeSetJobPayload extends Record<string, unknown> {
  workspaceId: string;
  artifactId: string;
  siteId: string;
}

/** The job key a task uses for one change set (the wrapper derives the same one). */
export const changeSetJobKey = (task: ChangeSetJobTask, artifactId: string): string => `${task}:${artifactId}`;

/**
 * Enqueues one change-set job through the database wrapper, inside the caller's transaction.
 * Returns whether the job was actually queued: false means Graphile's schema is absent, so the
 * caller must fall back to its own queue or leave the row for the poller's reconciliation.
 */
export async function enqueueChangeSetJob(
  tx: Tx,
  task: ChangeSetJobTask,
  payload: ChangeSetJobPayload,
  options: { runAt?: Date } = {},
): Promise<boolean> {
  const { rows } = await tx.execute<{ enqueued: boolean }>(sql`
    SELECT change_set_enqueue(
      ${task},
      ${JSON.stringify(payload)}::jsonb,
      ${options.runAt ? options.runAt.toISOString() : null}::timestamptz
    ) AS enqueued`);
  return rows[0]?.enqueued === true;
}

/** The payload a run row already carries, for a call from a transition that has it in hand. */
export const payloadOfRun = (run: { workspaceId: string; artifactId: string; siteId: string }): ChangeSetJobPayload => ({
  workspaceId: run.workspaceId,
  artifactId: run.artifactId,
  siteId: run.siteId,
});
