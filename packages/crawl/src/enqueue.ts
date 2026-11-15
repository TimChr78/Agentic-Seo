import type { Tx } from '@agentic-seo/db';
import { sql } from 'drizzle-orm';
import type { CrawlChunkPayload } from './engine';

// Starting a crawl (crawler-and-audits.md §2). `audits.run` creates the audit inside its own
// transaction; enqueueing the first chunk in that same transaction means the crawl starts at once
// instead of waiting up to a minute for the reconciler. The app role has no rights on Graphile
// Worker's tables, so migration 0007's `crawl_enqueue` (security definer) is the one narrow door:
// it accepts only a `crawl_chunk` job for an audit of the current workspace and returns false when
// Graphile's schema is not installed yet (it is created by the worker on first start). A false
// answer is not an error: the reconciler dispatches the audit on its next tick, which is the
// fallback that keeps a fresh install working.

/** The next lease generation, inside a transaction. */
export async function nextChunkNumberIn(tx: Tx): Promise<number> {
  const { rows } = await tx.execute<{ nextval: string }>(sql`SELECT nextval('crawl_chunk_seq')::text AS nextval`);
  return Number(rows[0]?.nextval);
}

export interface EnqueueChunkOptions {
  /** Postpone the job (a host backoff end). Default: run now. */
  runAt?: Date;
}

/**
 * Enqueues one `crawl_chunk` job through the database wrapper. Returns whether the job was actually
 * queued: false means Graphile Worker's schema is not present, so the caller must leave the audit
 * for the reconciler. The job key is derived inside the wrapper (audit id and chunk generation), so
 * an app-role caller cannot choose one and cannot replace another task's job.
 */
export async function enqueueCrawlChunk(tx: Tx, payload: CrawlChunkPayload, options: EnqueueChunkOptions = {}): Promise<boolean> {
  const { rows } = await tx.execute<{ enqueued: boolean }>(sql`
    SELECT crawl_enqueue(
      ${'crawl_chunk'},
      ${JSON.stringify(payload)}::jsonb,
      ${options.runAt ? options.runAt.toISOString() : null}::timestamptz
    ) AS enqueued`);
  return rows[0]?.enqueued === true;
}

/**
 * Enqueues an audit's first chunk. Call inside the command's transaction, after the audit exists:
 * if Graphile is missing the audit stays `queued` and the reconciler takes it.
 */
export async function enqueueFirstChunk(tx: Tx, workspaceId: string, auditId: string): Promise<boolean> {
  const chunk = await nextChunkNumberIn(tx);
  return enqueueCrawlChunk(tx, { workspaceId, auditId, chunk });
}
