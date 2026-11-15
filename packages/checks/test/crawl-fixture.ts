import {
  nextChunkNumber,
  PgHostLimiter,
  resetRobotsCache,
  resetSeedRobotsCache,
  runCrawlChunk,
  setCrawlFetchSeams,
} from '@agentic-seo/crawl';
import type { Db } from '@agentic-seo/db';
import type { FixtureSite } from '../../crawl/test/fixture';

// The crawl test seams this package needs, copied from packages/crawl/test/support.ts rather than
// imported: that file builds a command executor whose `Services` type picks up the secrets package's
// augmentation through this package's dependency on search-data, which the crawl package does not
// have. Keeping the four helpers here avoids changing another task's test support.

export function useFixture(fixture: FixtureSite): void {
  setCrawlFetchSeams({
    resolver: fixture.resolver,
    allow: fixture.allow,
    ca: fixture.certificate,
    sitePort: fixture.port,
    httpPort: fixture.httpPort,
  });
  resetRobotsCache();
  resetSeedRobotsCache();
}

export function clearFixture(): void {
  setCrawlFetchSeams(null);
  resetRobotsCache();
  resetSeedRobotsCache();
}

export function limiterFor(db: Db, owner = 'checks-test'): PgHostLimiter {
  return new PgHostLimiter(db, { owner, minDelayMs: 0, pollIntervalMs: 5, leaseTtlMs: 60_000 });
}

const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled']);

/** Runs chunks until the audit reaches a terminal state, or nothing more can happen. */
export async function drainAudit(db: Db, workspaceId: string, auditId: string, options: { limiter?: PgHostLimiter } = {}): Promise<void> {
  const limiter = options.limiter ?? limiterFor(db);
  for (let index = 0; index < 60; index += 1) {
    const chunk = await nextChunkNumber(db);
    const result = await runCrawlChunk(db, { workspaceId, auditId, chunk }, { limiter, version: 'test', softDeadlineMs: 120_000 });
    const { rows } = await db.admin.query<{ state: string }>('SELECT state FROM audits WHERE workspace_id = $1 AND id = $2', [
      workspaceId,
      auditId,
    ]);
    const state = rows[0]?.state ?? '';
    if (TERMINAL.has(state)) return;
    if (result.leased === 0 && !result.finalized) return;
  }
}
