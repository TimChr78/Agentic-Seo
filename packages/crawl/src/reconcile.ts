import type { Db } from '@agentic-seo/db';
import { schema } from '@agentic-seo/db';
import { and, eq, sql } from 'drizzle-orm';
import { type CrawlChunkPayload, nextChunkNumber } from './engine';
import { type ForcedFinalize, finalizeAudit } from './finalize';
import { limitsOf } from './limits';
import { lockAudit, releaseExpiredLeases } from './store';

// The reconciler (crawler-and-audits.md §2): every minute it looks for audits that are not moving.
// It runs cross-tenant, like the OAuth cleanup, but only reads the bookkeeping that way; every write
// goes through `withWorkspace`, so tenant data stays under RLS.
//
//   - no progress for 10 minutes: release expired leases and re-enqueue one chunk (once per stall);
//   - no progress for 30 minutes: `partial` when something was crawled, else `failed`, with a reason;
//   - `maxDurationMs` passed: `partial` with reason `time_limit`;
//   - a cancelled audit that never finalized: finalize it now.

export interface ReconcileOptions {
  /** Enqueues a chunk; the worker passes Graphile's `addJob`, a test its own recorder. */
  enqueue?: (payload: CrawlChunkPayload) => Promise<void>;
  now?: () => number;
  /** How long without progress before a chunk is re-enqueued. Default 10 minutes. */
  noProgressMs?: number;
  /** How long without progress before the audit ends. Default 30 minutes. */
  stallMs?: number;
}

export interface ReconcileResult {
  checked: number;
  dispatched: number;
  repaired: number;
  finalized: number;
}

interface BookkeepingRow {
  workspace_id: string;
  id: string;
}

/** Reads the audits that are not finished yet, across workspaces (owner connection, read only). */
async function openAudits(db: Db, limit: number): Promise<BookkeepingRow[]> {
  const { rows } = await db.admin.query<BookkeepingRow>(
    `SELECT workspace_id, id FROM audits
     WHERE finished_at IS NULL AND state IN ('queued', 'running', 'finalizing', 'cancelled')
     ORDER BY last_progress_at ASC
     LIMIT $1`,
    [limit],
  );
  return rows;
}

/** Marks a stalled audit as repaired so the next tick does not enqueue another chunk. */
async function markReconciled(db: Db, workspaceId: string, auditId: string, now: Date): Promise<void> {
  await db.withWorkspace(workspaceId, (tx) =>
    tx
      .update(schema.audits)
      .set({ reconciledAt: now })
      .where(and(eq(schema.audits.workspaceId, workspaceId), eq(schema.audits.id, auditId))),
  );
}

export async function reconcileCrawls(db: Db, options: ReconcileOptions = {}): Promise<ReconcileResult> {
  const nowMs = options.now?.() ?? Date.now();
  const noProgressMs = options.noProgressMs ?? 10 * 60 * 1000;
  const stallMs = options.stallMs ?? 30 * 60 * 1000;
  const result: ReconcileResult = { checked: 0, dispatched: 0, repaired: 0, finalized: 0 };

  for (const row of await openAudits(db, 500)) {
    result.checked += 1;
    const audit = await db.withWorkspace(row.workspace_id, async (tx) => {
      const [found] = await tx
        .select()
        .from(schema.audits)
        .where(and(eq(schema.audits.workspaceId, row.workspace_id), eq(schema.audits.id, row.id)));
      if (!found || found.finishedAt) return null;
      const counts = await tx.execute<{ pending: string; leased: string }>(sql`
        SELECT count(*) FILTER (WHERE state = 'pending')::text AS pending,
               count(*) FILTER (WHERE state = 'leased')::text AS leased
        FROM crawl_frontier WHERE workspace_id = ${row.workspace_id} AND audit_id = ${row.id}`);
      return { audit: found, pending: Number(counts.rows[0]?.pending ?? 0), leased: Number(counts.rows[0]?.leased ?? 0) };
    });
    if (!audit) continue;
    const { audit: current, pending, leased } = audit;

    // A cancelled audit never has work left to dispatch; it only needs its finalize.
    if (current.state === 'cancelled') {
      if (await finalizeAudit(db, { workspaceId: row.workspace_id, auditId: row.id })) result.finalized += 1;
      continue;
    }

    // A worker can die after the last page commit and before its finalize call, leaving a `running`
    // audit with nothing pending or leased. There is no work to dispatch, so run the normal
    // finalize path — the same one a chunk uses, exactly once thanks to the audit row lock.
    if (pending === 0 && leased === 0 && (current.state === 'running' || current.state === 'finalizing')) {
      if (await finalizeAudit(db, { workspaceId: row.workspace_id, auditId: row.id })) result.finalized += 1;
      continue;
    }

    const idleMs = nowMs - current.lastProgressAt.getTime();
    const limits = limitsOf(current);
    const startedMs = current.startedAt?.getTime() ?? current.createdAt.getTime();
    const overTime = nowMs - startedMs >= limits.maxDurationMs;

    if (overTime) {
      // The time limit is a recognized ending: `partial` with a reason, and the pages already
      // crawled stay viewable.
      const forced: ForcedFinalize = {
        state: current.pagesCrawled > 0 ? 'partial' : 'failed',
        reason: 'The audit reached its time limit.',
        reasons: ['time_limit'],
        skipPendingAs: 'time_limit',
      };
      if (await finalizeAudit(db, { workspaceId: row.workspace_id, auditId: row.id }, { force: forced })) result.finalized += 1;
      continue;
    }

    if (idleMs >= stallMs) {
      if (await finalizeAudit(db, { workspaceId: row.workspace_id, auditId: row.id }, { force: stallFailure(current.pagesCrawled) }))
        result.finalized += 1;
      continue;
    }

    // Queued audits have never been dispatched from this process; a job key keeps repeated ticks
    // from queueing the same audit twice, so every tick may simply try.
    if (current.state === 'queued') {
      if (options.enqueue) {
        await options.enqueue({ workspaceId: row.workspace_id, auditId: row.id, chunk: await nextChunkNumber(db) });
        result.dispatched += 1;
      }
      await markReconciled(db, row.workspace_id, row.id, new Date(nowMs));
      continue;
    }

    if (idleMs < noProgressMs) continue;
    // Release what a dead worker held before deciding there is work to dispatch. The audit row is
    // locked first — the crawl's one lock order (`lockAudit`) — because this transaction touches
    // frontier rows and the audit's counters; the other order deadlocked against a page commit.
    const released = await db.withWorkspace(row.workspace_id, async (tx) => {
      const live = await lockAudit(tx, row.workspace_id, row.id);
      if (!live || live.finishedAt) return 0;
      return releaseExpiredLeases(tx, row.workspace_id, row.id);
    });
    if (released > 0) result.repaired += released;
    if (released === 0 && leased > 0) continue;
    if (pending === 0 && released === 0) continue;
    const lastAsk = current.reconciledAt?.getTime() ?? 0;
    if (nowMs - lastAsk < noProgressMs) continue;
    if (options.enqueue) {
      await options.enqueue({ workspaceId: row.workspace_id, auditId: row.id, chunk: await nextChunkNumber(db) });
      result.dispatched += 1;
    }
    await markReconciled(db, row.workspace_id, row.id, new Date(nowMs));
  }
  return result;
}

/** The ending a stalled audit gets: `partial` when it crawled something, else `failed`. */
export function stallFailure(pagesCrawled: number): ForcedFinalize {
  return {
    state: pagesCrawled > 0 ? 'partial' : 'failed',
    reason: 'No progress for 30 minutes; the worker may have stopped.',
    reasons: ['errors'],
    skipPendingAs: 'abandoned',
  };
}
