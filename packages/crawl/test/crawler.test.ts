import { schema } from '@agentic-seo/db';
import type { HostLease, HostLimiter } from '@agentic-seo/fetch';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase } from '../../db/test/disposable';
import type { PageFacts } from '../src';
import {
  auditPages,
  auditStatus,
  cancelAudit,
  crawlFetch,
  finalizeAudit,
  nextChunkNumber,
  reconcileCrawls,
  registerAuditHooks,
  runAudit,
  runCrawlChunk,
} from '../src';
import { type FixtureSite, startFixture } from './fixture';
import {
  addSite,
  auditRow,
  type CrawlTestContext,
  clearFixture,
  createCrawlTestContext,
  drainAudit,
  frontierRows,
  limiterFor,
  ownerPrincipal,
  run,
  setFrontier,
  snapshotRows,
  useFixture,
} from './support';

// The crawl engine against the fixture site: seeding, discovery order and depth, robots skips,
// the page limit, idempotent retries, the reconciler's repair, atomic finalize and the hooks, plus
// the review-round fences (a paused page cannot write into a finished audit, progress moves,
// quota-blocked sections do not deadlock, redirects are policed hop by hop, and a chunk stops
// within its deadline).

const TERMINAL_STATES = new Set(['completed', 'partial', 'failed', 'cancelled']);

/** A promise a test resolves by hand, to pause a chunk at a persistence boundary. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A limiter that never grants a slot: the request must be aborted, not left waiting. */
class NeverGrantingLimiter implements HostLimiter {
  acquire(_host: string, options: { signal?: AbortSignal } = {}): Promise<HostLease> {
    return new Promise<HostLease>((_resolve, reject) => {
      const signal = options.signal;
      const fail = () => reject(signal?.reason ?? new Error('aborted'));
      if (signal?.aborted) fail();
      else signal?.addEventListener('abort', fail, { once: true });
    });
  }
  async release(): Promise<void> {}
  async noteResponse(): Promise<void> {}
}

describe.skipIf(!hasTestDatabase())('crawl engine', () => {
  let ctx: CrawlTestContext;
  let fixture: FixtureSite;
  let ws = '';
  let siteId = '';

  beforeAll(async () => {
    fixture = await startFixture();
    ctx = await createCrawlTestContext('crawl_engine');
    ws = ctx.disposable.workspace;
    useFixture(fixture);
    siteId = await addSite(ctx.db, ws, { domain: 'fixture.test' });
  }, 180_000);

  afterAll(async () => {
    clearFixture();
    await ctx?.db.close();
    await ctx?.disposable.close();
    await fixture?.close();
  });

  beforeEach(() => {
    useFixture(fixture);
  });

  afterEach(async () => {
    clearFixture();
    // Pacing is global per host, so a test's backoff must not slow the next test's fixture fetches.
    await ctx.db.admin.query('DELETE FROM crawl_host_pacing');
    await ctx.db.admin.query('DELETE FROM crawl_host_leases');
    // Finish anything a test left live: the one-live-audit index would otherwise refuse the next.
    const { rows } = await ctx.db.admin.query<{ id: string }>('SELECT id FROM audits WHERE workspace_id = $1 AND finished_at IS NULL', [
      ws,
    ]);
    for (const row of rows) {
      await ctx.db.admin.query("UPDATE audits SET state = 'cancelled', state_reason = 'cancelled' WHERE workspace_id = $1 AND id = $2", [
        ws,
        row.id,
      ]);
      await finalizeAudit(ctx.db, { workspaceId: ws, auditId: row.id });
    }
  });

  const newAudit = async (input: Record<string, unknown> = {}) =>
    (await run(ctx.executor, runAudit, { siteId, ...input }, ownerPrincipal(ws))).audit;

  it('seeds robots.txt and the sitemap index in the worker, crawls the site and records site facts', async () => {
    const audit = await newAudit();
    expect(audit.state).toBe('queued');
    expect(audit.pagesDiscovered).toBeGreaterThan(0);
    // The command itself does no network I/O: robots.txt is read by the first chunk's seed step.
    expect(fixture.paths()).not.toContain('/robots.txt');

    // The first chunk hands the next one to the worker's queue while URLs remain.
    const nextChunks: { payload: { workspaceId: string; auditId: string; chunk: number }; runAt?: Date }[] = [];
    const firstChunk = await runCrawlChunk(
      ctx.db,
      { workspaceId: ws, auditId: audit.id, chunk: await nextChunkNumber(ctx.db) },
      {
        limiter: limiterFor(ctx.db),
        version: 'test',
        enqueueNext: async (payload, options) => void nextChunks.push({ payload, ...(options?.runAt ? { runAt: options.runAt } : {}) }),
      },
    );
    expect(firstChunk.processed).toBeGreaterThan(0);
    expect(nextChunks).toHaveLength(1);
    expect(nextChunks[0]?.payload).toMatchObject({ workspaceId: ws, auditId: audit.id });
    expect(nextChunks[0]?.payload.chunk).toBeGreaterThan(0);
    expect(fixture.paths()).toContain('/robots.txt');

    await drainAudit(ctx.db, ws, audit.id);
    const status = await run(ctx.executor, auditStatus, { auditId: audit.id }, ownerPrincipal(ws));
    expect(status.audit.state).toBe('completed');
    // robots.txt disallows a linked page, so the graph is truncated even though the crawl finished.
    expect(status.audit.coverage).toMatchObject({ scope: 'site', graph: 'truncated' });
    expect(status.audit.coverage?.reasons).toContain('robots');
    expect(status.progress.crawled).toBeGreaterThan(20);

    const row = await auditRow(ctx.db, ws, audit.id);
    const siteFacts = row?.site_facts as {
      origin: string;
      robotsTxt: { url: string; status: number; sitemaps: string[] };
      sitemaps: { kind: string; status: number }[];
      home: { url: string; status: number } | null;
      httpRedirectsToHttps: boolean | null;
    };
    expect(siteFacts.origin).toBe(fixture.origin);
    expect(siteFacts.robotsTxt).toMatchObject({ url: `${fixture.origin}/robots.txt`, status: 200 });
    // The index, the gzipped child, the second child, and the 404 for the conventional
    // `/sitemap.xml` this site does not publish (recorded as evidence, not treated as fatal).
    expect(siteFacts.sitemaps.filter((entry) => entry.kind === 'urlset')).toHaveLength(2);
    expect(siteFacts.sitemaps.some((entry) => entry.kind === 'index')).toBe(true);
    expect(siteFacts.sitemaps.some((entry) => entry.status === 404)).toBe(true);
    // The plain-HTTP listener answers the probe with a redirect to HTTPS.
    expect(siteFacts.httpRedirectsToHttps).toBe(true);
    expect(siteFacts.home).toMatchObject({ url: `${fixture.origin}/`, status: 200 });

    // An honest user agent, and no request to the external link.
    const home = fixture.requests.find((request) => request.url === '/');
    expect(String(home?.headers['user-agent'])).toMatch(/^AgenticSEO\//);
    expect((await frontierRows(ctx.db, ws, audit.id)).every((row) => row.url.startsWith(fixture.origin))).toBe(true);
  });

  it('crawls link-discovered pages breadth-first and sitemap-only pages after them', async () => {
    const audit = await newAudit();
    await drainAudit(ctx.db, ws, audit.id);
    const rows = await frontierRows(ctx.db, ws, audit.id);
    const byUrl = new Map(rows.map((row) => [row.url, row]));

    expect(byUrl.get(`${fixture.origin}/`)?.depth).toBe(0);
    expect(byUrl.get(`${fixture.origin}/a`)?.depth).toBe(1);
    expect(byUrl.get(`${fixture.origin}/a2`)?.depth).toBe(2);
    expect(byUrl.get(`${fixture.origin}/a3`)?.depth).toBe(3);
    expect(byUrl.get(`${fixture.origin}/orphan`)).toMatchObject({
      depth: null,
      discovered_by: 'sitemap',
      in_sitemap: true,
      state: 'crawled',
    });
    // Linked and listed: the sitemap credit stays, and the click depth fills in.
    expect(byUrl.get(`${fixture.origin}/dup-in-sitemap`)).toMatchObject({ depth: 3, discovered_by: 'link', in_sitemap: true });

    const paths = fixture.paths();
    // The sitemap-only orphan waits until the link frontier is spent.
    expect(paths.indexOf('/a3')).toBeLessThan(paths.indexOf('/orphan'));
    expect(paths.indexOf('/a')).toBeLessThan(paths.indexOf('/orphan'));
  });

  it('records a robots-disallowed page as a skip with a status-0 snapshot', async () => {
    const audit = await newAudit();
    await drainAudit(ctx.db, ws, audit.id);
    const rows = await frontierRows(ctx.db, ws, audit.id);
    const secret = rows.find((row) => row.url === `${fixture.origin}/private/secret`);
    expect(secret).toMatchObject({ state: 'skipped', skip_reason: 'robots' });

    const snapshot = (await snapshotRows(ctx.db, ws, audit.id)).find((row) => row.url === `${fixture.origin}/private/secret`);
    expect(snapshot).toMatchObject({ status: 0 });
    expect(snapshot?.facts).toMatchObject({ robotsAllowed: false, html: null, fetchError: null });

    const robotsPage = await run(ctx.executor, auditPages, { auditId: audit.id, status: 'robots' }, ownerPrincipal(ws));
    expect(robotsPage.pages.map((page) => page.url)).toEqual([`${fixture.origin}/private/secret`]);
    // It was never requested from the site.
    expect(fixture.paths()).not.toContain('/private/secret');
  });

  it('stops at maxPages, ending completed with a truncated page_limit graph', async () => {
    const audit = await newAudit({ limits: { maxPages: 3, maxDepth: 10, maxDurationMs: 30 * 60 * 1000 } });
    await drainAudit(ctx.db, ws, audit.id);
    const status = await run(ctx.executor, auditStatus, { auditId: audit.id }, ownerPrincipal(ws));
    expect(status.audit.state).toBe('completed');
    expect(status.audit.coverage).toMatchObject({ graph: 'truncated' });
    expect(status.audit.coverage?.reasons).toContain('page_limit');
    expect(status.audit.pagesCrawled).toBe(3);
    const skipped = (await frontierRows(ctx.db, ws, audit.id)).filter((row) => row.skip_reason === 'page_limit');
    expect(skipped.length).toBeGreaterThan(0);
  });

  it('re-fetches a page after a killed chunk and stores it once (real recovery, not a hand reset)', async () => {
    const audit = await newAudit();
    const limiter = limiterFor(ctx.db);

    // A worker dies after fetching the home page but before it commits anything: the lease stays
    // held, exactly as a crash leaves it.
    await expect(
      runCrawlChunk(
        ctx.db,
        { workspaceId: ws, auditId: audit.id, chunk: await nextChunkNumber(ctx.db) },
        {
          limiter,
          version: 'test',
          boundary: async (point) => {
            if (point === 'afterFetch') throw new Error('worker died after the fetch');
          },
        },
      ),
    ).rejects.toThrow('worker died after the fetch');
    expect(await snapshotRows(ctx.db, ws, audit.id)).toHaveLength(0);
    const afterKillHomeFetches = fixture.requests.filter((request) => request.url === '/').length;

    // The reconciler releases the expired lease and re-enqueues; the retry really re-fetches the
    // page (nothing was replayed) and stores it once, with its discoveries.
    await ctx.db.withWorkspace(ws, (tx) =>
      tx.execute(sql`
        UPDATE crawl_frontier SET lease_expires_at = now() - interval '1 minute'
        WHERE workspace_id = ${ws} AND audit_id = ${audit.id} AND state = 'leased'`),
    );
    await ctx.db.admin.query("UPDATE audits SET last_progress_at = now() - interval '11 minutes' WHERE id = $1", [audit.id]);
    const enqueued: { workspaceId: string; auditId: string; chunk: number }[] = [];
    const reconciled = await reconcileCrawls(ctx.db, { enqueue: async (payload) => void enqueued.push(payload) });
    expect(reconciled.repaired).toBe(1);
    expect(enqueued).toHaveLength(1);
    await runCrawlChunk(ctx.db, enqueued[0]!, { limiter, version: 'test' });

    // The killed chunk fetched it; the retry fetched it again: a retry re-fetches, it does not replay.
    expect(fixture.requests.filter((request) => request.url === '/').length).toBe(afterKillHomeFetches + 1);
    const afterSnapshots = await snapshotRows(ctx.db, ws, audit.id);
    expect(afterSnapshots.filter((row) => row.url === `${fixture.origin}/`)).toHaveLength(1);
    expect(new Set(afterSnapshots.map((row) => row.url)).size).toBe(afterSnapshots.length);
    const afterFrontier = await frontierRows(ctx.db, ws, audit.id);
    expect(new Set(afterFrontier.map((row) => row.url)).size).toBe(afterFrontier.length);
    // The home page's discoveries were stored by the retry, not lost with the killed attempt.
    expect(afterFrontier.some((row) => row.url === `${fixture.origin}/a`)).toBe(true);

    await drainAudit(ctx.db, ws, audit.id, { limiter });
    const status = await run(ctx.executor, auditStatus, { auditId: audit.id }, ownerPrincipal(ws));
    expect(status.audit.state).toBe('completed');
  });

  it('drops a paused page instead of writing into a cancelled, finalized audit', async () => {
    const audit = await newAudit();
    const arrived = deferred();
    const gate = deferred();
    let pageHooks = 0;
    const dispose = registerAuditHooks({
      onPage: async (_tx, ref) => {
        if (ref.auditId === audit.id) pageHooks += 1;
      },
    });
    try {
      const chunkPromise = runCrawlChunk(
        ctx.db,
        { workspaceId: ws, auditId: audit.id, chunk: await nextChunkNumber(ctx.db) },
        {
          limiter: limiterFor(ctx.db),
          version: 'test',
          softDeadlineMs: 120_000,
          boundary: async (point) => {
            if (point !== 'afterFetch') return;
            arrived.resolve();
            await gate.promise;
          },
        },
      );
      await arrived.promise;

      // The audit is cancelled and finalized while the fetched page is still paused before its
      // commit; the finalize clears the lease it holds.
      await run(ctx.executor, cancelAudit, { auditId: audit.id }, ownerPrincipal(ws));
      expect(await finalizeAudit(ctx.db, { workspaceId: ws, auditId: audit.id })).toBe(true);
      gate.resolve();

      const result = await chunkPromise;
      expect(result.dropped).toBe(1);
      expect(result.processed).toBe(0);
      // Nothing was written: no snapshot, no edge, and the page hook never ran.
      expect(await snapshotRows(ctx.db, ws, audit.id)).toHaveLength(0);
      expect(pageHooks).toBe(0);
      const { rows: edges } = await ctx.db.admin.query(
        'SELECT count(*)::int AS n FROM link_edges WHERE workspace_id = $1 AND audit_id = $2',
        [ws, audit.id],
      );
      expect(edges[0].n).toBe(0);
      const home = (await frontierRows(ctx.db, ws, audit.id)).find((row) => row.url === `${fixture.origin}/`);
      expect(home).toMatchObject({ state: 'skipped', skip_reason: 'cancelled' });
    } finally {
      dispose();
    }
  });

  it('drops a resumed page when the reconciler reassigned its expired lease', async () => {
    const audit = await newAudit({ limits: { maxPages: 2, maxDepth: 10, maxDurationMs: 30 * 60 * 1000 } });
    const limiter = limiterFor(ctx.db);
    const arrived = deferred();
    const gate = deferred();
    const chunkA = runCrawlChunk(
      ctx.db,
      { workspaceId: ws, auditId: audit.id, chunk: await nextChunkNumber(ctx.db) },
      {
        limiter,
        version: 'test',
        softDeadlineMs: 120_000,
        boundary: async (point) => {
          if (point !== 'afterFetch') return;
          arrived.resolve();
          await gate.promise;
        },
      },
    );
    await arrived.promise;

    // The lease expires (as if the worker had died) and the reconciler repairs it.
    await ctx.db.withWorkspace(ws, (tx) =>
      tx.execute(sql`
        UPDATE crawl_frontier SET lease_expires_at = now() - interval '1 minute'
        WHERE workspace_id = ${ws} AND audit_id = ${audit.id} AND state = 'leased'`),
    );
    await ctx.db.admin.query("UPDATE audits SET last_progress_at = now() - interval '11 minutes' WHERE id = $1", [audit.id]);
    const enqueued: { workspaceId: string; auditId: string; chunk: number }[] = [];
    const reconciled = await reconcileCrawls(ctx.db, { enqueue: async (payload) => void enqueued.push(payload) });
    expect(reconciled.repaired).toBe(1);
    expect(enqueued).toHaveLength(1);

    // A second chunk takes the URL over and stores it under its own lease generation.
    await runCrawlChunk(ctx.db, enqueued[0]!, { limiter, version: 'test' });
    gate.resolve();
    const resultA = await chunkA;
    expect(resultA.dropped).toBe(1);

    await drainAudit(ctx.db, ws, audit.id, { limiter });
    const status = await run(ctx.executor, auditStatus, { auditId: audit.id }, ownerPrincipal(ws));
    expect(status.audit.state).toBe('completed');
    const snapshots = await snapshotRows(ctx.db, ws, audit.id);
    expect(new Set(snapshots.map((row) => row.url)).size).toBe(snapshots.length);
    expect(snapshots.filter((row) => row.url === `${fixture.origin}/`)).toHaveLength(1);
  });

  it('drops a seed that finishes after the audit was finalized, without storing site facts or URLs', async () => {
    const audit = await newAudit();
    const arrived = deferred();
    const gate = deferred();
    // The seed's robots.txt fetch is where it has done most of its network work; pause there, end
    // the audit, then let the seed finish and try to persist.
    const seedFetch = async (url: string, options: Parameters<typeof crawlFetch>[1]) => {
      if (url.endsWith('/robots.txt')) {
        arrived.resolve();
        await gate.promise;
      }
      return crawlFetch(url, options);
    };
    const chunkPromise = runCrawlChunk(
      ctx.db,
      { workspaceId: ws, auditId: audit.id, chunk: await nextChunkNumber(ctx.db) },
      { limiter: limiterFor(ctx.db), version: 'test', seedFetch, seedDeadlineMs: 30_000 },
    );
    await arrived.promise;
    await run(ctx.executor, cancelAudit, { auditId: audit.id }, ownerPrincipal(ws));
    expect(await finalizeAudit(ctx.db, { workspaceId: ws, auditId: audit.id })).toBe(true);
    gate.resolve();
    await chunkPromise;

    const row = await auditRow(ctx.db, ws, audit.id);
    // The seed's persistence was dropped: no seeded_at, the skeleton site facts stay, and the sitemap
    // URLs it read never entered the frontier of a finished audit.
    expect(row?.seeded_at).toBeNull();
    const seedFacts = row?.site_facts as { robotsTxt: { status: number } } | undefined;
    expect(seedFacts?.robotsTxt.status).toBe(0);
    const urls = (await frontierRows(ctx.db, ws, audit.id)).map((frontier) => frontier.url);
    expect(urls).toEqual([`${fixture.origin}/`]);
  });

  it('runs a page commit concurrently with chunk cleanup without a deadlock', async () => {
    const audit = await newAudit({ limits: { maxPages: 10, maxDepth: 10, maxDurationMs: 30 * 60 * 1000 } });
    // `/a` sorts first (depth 0), so the first chunk leases it; the home page sorts second.
    await setFrontier(ctx.db, ws, audit.id, [
      { url: `${fixture.origin}/a`, depth: 0 },
      { url: `${fixture.origin}/`, depth: 1 },
    ]);
    const limiter = limiterFor(ctx.db);

    // Chunk B leases /a and waits for a host slot that never comes. Its deadline then releases the
    // lease and refreshes the counters — a transaction that touches /a and the audit row.
    const chunkB = runCrawlChunk(
      ctx.db,
      { workspaceId: ws, auditId: audit.id, chunk: await nextChunkNumber(ctx.db) },
      { limiter: new NeverGrantingLimiter(), version: 'test', chunkSize: 1, softDeadlineMs: 3_000 },
    );
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const rows = await frontierRows(ctx.db, ws, audit.id);
      if (rows.find((row) => row.url === `${fixture.origin}/a`)?.state === 'leased') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // Chunk A leases the home page and pauses inside its page transaction, holding the audit row
    // lock; when it resumes it stores the discovered /a, which B's cleanup has locked.
    const arrived = deferred();
    const gate = deferred();
    const chunkA = runCrawlChunk(
      ctx.db,
      { workspaceId: ws, auditId: audit.id, chunk: await nextChunkNumber(ctx.db) },
      {
        limiter,
        version: 'test',
        chunkSize: 1,
        boundary: async (point) => {
          if (point !== 'insidePageWrite') return;
          arrived.resolve();
          await gate.promise;
        },
      },
    );
    await arrived.promise;
    // Let B's deadline fire and its cleanup reach the audit lock A holds, then let A continue: with
    // frontier-before-audit locking the two deadlock (40P01), with the audit lock first they queue.
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    gate.resolve();
    const [a, b] = await Promise.all([chunkA, chunkB]);
    expect(a.processed).toBe(1);
    expect(b.processed).toBe(0);
    expect(b.released).toBe(1);
  });

  it('stops a chunk within seconds of a cancel while every slot waits for a host', async () => {
    const audit = await newAudit({ limits: { maxPages: 10, maxDepth: 10, maxDurationMs: 30 * 60 * 1000 } });
    await setFrontier(
      ctx.db,
      ws,
      audit.id,
      ['a', 'b', 'c', 'd'].map((name) => ({ url: `${fixture.origin}/${name}`, depth: 0 })),
    );
    const started = Date.now();
    const chunkPromise = runCrawlChunk(
      ctx.db,
      { workspaceId: ws, auditId: audit.id, chunk: await nextChunkNumber(ctx.db) },
      {
        limiter: new NeverGrantingLimiter(),
        version: 'test',
        chunkSize: 4,
        softDeadlineMs: 60_000,
        cancelPollMs: 100,
      },
    );
    // Every page slot is waiting for a host that never grants one.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await run(ctx.executor, cancelAudit, { auditId: audit.id }, ownerPrincipal(ws));
    const result = await chunkPromise;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.stopped).toBe(true);
    expect(result.released).toBe(4);
  });

  it('aborts and settles in-flight work before a failed cancellation read propagates (review round 3)', async () => {
    const audit = await newAudit({ limits: { maxPages: 10, maxDepth: 10, maxDurationMs: 30 * 60 * 1000 } });
    await setFrontier(
      ctx.db,
      ws,
      audit.id,
      ['a', 'b'].map((name) => ({ url: `${fixture.origin}/${name}`, depth: 0 })),
    );
    const signals: AbortSignal[] = [];
    const limiter = new NeverGrantingLimiter();
    const acquire = limiter.acquire.bind(limiter);
    limiter.acquire = (host, options = {}) => {
      if (options.signal) signals.push(options.signal);
      return acquire(host, options);
    };
    // Every database call after the slots are waiting is a cancellation poll: make it fail.
    let failing = false;
    const db = new Proxy(ctx.db, {
      get(target, prop, receiver) {
        if (prop === 'withWorkspace' && failing) return async () => Promise.reject(new Error('the database went away'));
        return Reflect.get(target, prop, receiver);
      },
    });
    const chunk = runCrawlChunk(
      db,
      { workspaceId: ws, auditId: audit.id, chunk: await nextChunkNumber(ctx.db) },
      { limiter, version: 'test', chunkSize: 2, softDeadlineMs: 60_000, cancelPollMs: 50 },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    failing = true;
    await expect(chunk).rejects.toThrow(/database went away/);
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) expect(signal.aborted).toBe(true);
  });

  it('counts a robots-skipped page as discovered, never as crawled, while the crawl runs (review round 3)', async () => {
    const audit = await newAudit({ limits: { maxPages: 10, maxDepth: 10, maxDurationMs: 30 * 60 * 1000 } });
    await setFrontier(ctx.db, ws, audit.id, [
      { url: `${fixture.origin}/private/secret`, depth: 0 },
      { url: `${fixture.origin}/a`, depth: 0 },
    ]);
    const seen: { counter: number; crawledRows: number }[] = [];
    const boundary = async (point: string) => {
      if (point !== 'afterPageCommit') return;
      const row = await auditRow(ctx.db, ws, audit.id);
      const rows = await frontierRows(ctx.db, ws, audit.id);
      seen.push({ counter: Number(row?.pages_crawled), crawledRows: rows.filter((r) => r.state === 'crawled').length });
    };
    await runCrawlChunk(
      ctx.db,
      { workspaceId: ws, auditId: audit.id, chunk: await nextChunkNumber(ctx.db) },
      { limiter: limiterFor(ctx.db), version: 'test', chunkSize: 2, softDeadlineMs: 60_000, boundary },
    );
    expect(seen).toHaveLength(2);
    // Live progress, before any recount: the counter always equals the crawled frontier rows.
    for (const point of seen) expect(point.counter).toBe(point.crawledRows);
    const rows = await frontierRows(ctx.db, ws, audit.id);
    expect(rows.find((r) => r.url.endsWith('/private/secret'))?.state).toBe('skipped');
  });

  it('postpones the successor past a host pause that outlives the chunk', async () => {
    const audit = await newAudit({ limits: { maxPages: 10, maxDepth: 10, maxDurationMs: 30 * 60 * 1000 } });
    await setFrontier(ctx.db, ws, audit.id, [{ url: `${fixture.origin}/a`, depth: 0 }]);
    const limiter = limiterFor(ctx.db);
    // Another replica paused the host for a minute; this chunk's soft deadline is far shorter.
    await limiter.pause('fixture.test', 60_000);
    const started = Date.now();
    const scheduled: { runAt?: Date }[] = [];
    const result = await runCrawlChunk(
      ctx.db,
      { workspaceId: ws, auditId: audit.id, chunk: await nextChunkNumber(ctx.db) },
      {
        limiter,
        version: 'test',
        chunkSize: 1,
        softDeadlineMs: 300,
        enqueueNext: async (_payload, options) => void scheduled.push({ ...(options?.runAt ? { runAt: options.runAt } : {}) }),
      },
    );
    expect(result.more).toBe(true);
    expect(scheduled).toHaveLength(1);
    // The successor is not sent before the shared pause ends, even though this chunk saw no 429.
    const runAt = scheduled[0]?.runAt?.getTime() ?? 0;
    expect(runAt).toBeGreaterThan(started + 50_000);
  });

  it('marks the graph truncated when a crawled page had more links than the extractor kept', async () => {
    const audit = await newAudit({
      scope: 'list',
      urls: [`${fixture.origin}/many-links`],
      limits: { maxPages: 5, maxDepth: 10, maxDurationMs: 30 * 60 * 1000 },
    });
    await drainAudit(ctx.db, ws, audit.id);
    const status = await run(ctx.executor, auditStatus, { auditId: audit.id }, ownerPrincipal(ws));
    expect(status.audit.state).toBe('completed');
    expect(status.audit.coverage).toMatchObject({ graph: 'truncated' });
    expect(status.audit.coverage?.reasons).toContain('links_truncated');
    const snapshot = (await snapshotRows(ctx.db, ws, audit.id)).find((row) => row.url === `${fixture.origin}/many-links`);
    const linksTruncated = (snapshot?.facts.html as { linksTruncated?: boolean } | undefined)?.linksTruncated;
    expect(linksTruncated).toBe(true);
  });

  it('marks the graph truncated when sitemap seeding stopped at a cap', async () => {
    const audit = await newAudit();
    // A one-document sitemap read stops after the fixture's index, so its child sitemaps are never
    // read: their URLs cannot be crawled, and orphan detection has to know that.
    const result = await runCrawlChunk(
      ctx.db,
      { workspaceId: ws, auditId: audit.id, chunk: await nextChunkNumber(ctx.db) },
      { limiter: limiterFor(ctx.db), version: 'test', seedSitemapCaps: { maxDocuments: 1 } },
    );
    expect(result.processed).toBeGreaterThan(0);
    const row = await auditRow(ctx.db, ws, audit.id);
    const sitemapFacts = row?.site_facts as { sitemapsTruncated?: boolean } | undefined;
    expect(sitemapFacts?.sitemapsTruncated).toBe(true);
    await drainAudit(ctx.db, ws, audit.id);
    const status = await run(ctx.executor, auditStatus, { auditId: audit.id }, ownerPrincipal(ws));
    expect(status.audit.coverage?.reasons).toContain('sitemaps_truncated');
  });

  it('stops a redirect loop at the first repeated URL instead of following it', async () => {
    const audit = await newAudit({
      scope: 'list',
      urls: [`${fixture.origin}/loop-a`],
      limits: { maxPages: 5, maxDepth: 10, maxDurationMs: 30 * 60 * 1000 },
    });
    await drainAudit(ctx.db, ws, audit.id);
    const snapshot = (await snapshotRows(ctx.db, ws, audit.id)).find((row) => row.url === `${fixture.origin}/loop-a`);
    const facts = snapshot?.facts as unknown as PageFacts;
    expect(facts.fetchError).toBe('redirect_loop');
    expect(facts.finalUrl).toBe(`${fixture.origin}/loop-a`);
    expect(facts.status).toBe(302);
    expect(facts.redirects.map((hop) => hop.url)).toEqual([`${fixture.origin}/loop-a`, `${fixture.origin}/loop-b`]);
    // The loop stopped: the second URL was requested once, not forever.
    expect(fixture.paths().filter((path) => path === '/loop-a' || path === '/loop-b').length).toBeLessThan(6);
  });

  it('keeps the page counters exact while commits use deltas', async () => {
    const audit = await newAudit();
    await drainAudit(ctx.db, ws, audit.id);
    const status = await run(ctx.executor, auditStatus, { auditId: audit.id }, ownerPrincipal(ws));
    const rows = await frontierRows(ctx.db, ws, audit.id);
    const snapshots = await snapshotRows(ctx.db, ws, audit.id);
    expect(status.audit.pagesCrawled).toBe(rows.filter((row) => row.state === 'crawled').length);
    expect(status.audit.pagesDiscovered).toBe(rows.length);
    expect(status.audit.pagesFailed).toBe(
      snapshots.filter((row) => {
        const facts = row.facts as { fetchError?: string | null };
        return row.status >= 500 || facts.fetchError !== null;
      }).length,
    );
  });

  it('moves last_progress_at with every committed page, so a long crawl is not seen as stalled', async () => {
    const audit = await newAudit({ limits: { maxPages: 200, maxDepth: 10, maxDurationMs: 24 * 60 * 60 * 1000 } });
    const limiter = limiterFor(ctx.db);
    const start = Date.now();
    let clock = start;
    let commits = 0;
    const boundary = async (point: string) => {
      if (point !== 'afterPageCommit') return;
      commits += 1;
      // Two minutes of wall clock per page: the crawl outlives the 30-minute stall window.
      clock += 2 * 60 * 1000;
    };

    for (let index = 0; index < 20; index += 1) {
      const result = await runCrawlChunk(
        ctx.db,
        { workspaceId: ws, auditId: audit.id, chunk: await nextChunkNumber(ctx.db) },
        { limiter, version: 'test', softDeadlineMs: 120_000, now: () => clock, boundary },
      );
      const row = await auditRow(ctx.db, ws, audit.id);
      if (row && TERMINAL_STATES.has(String(row.state))) break;
      if (result.leased === 0 && !result.finalized) break;
      if (clock - start > 31 * 60 * 1000) break;
    }

    expect(commits).toBeGreaterThan(5);
    expect(clock - start).toBeGreaterThan(31 * 60 * 1000);
    const before = await auditRow(ctx.db, ws, audit.id);
    expect(before?.state).toBe('running');

    const enqueued: unknown[] = [];
    const reconciled = await reconcileCrawls(ctx.db, { enqueue: async (payload) => void enqueued.push(payload), now: () => clock });
    // The counters moved with the pages, so the audit is neither stalled nor re-dispatched.
    expect(reconciled.finalized).toBe(0);
    expect(reconciled.dispatched).toBe(0);
    const after = await auditRow(ctx.db, ws, audit.id);
    expect(after?.state).toBe('running');
    expect(new Date(String(after?.last_progress_at)).getTime()).toBeGreaterThan(clock - 10 * 60 * 1000);
  });

  it('crawls an eligible sitemap URL when the linked section has spent its quota', async () => {
    const audit = await newAudit({ limits: { maxPages: 10, maxDepth: 10, maxDurationMs: 30 * 60 * 1000 } });
    await setFrontier(ctx.db, ws, audit.id, [
      ...Array.from({ length: 5 }, (_, index) => ({
        url: `${fixture.origin}/blog/${index + 1}`,
        state: 'crawled' as const,
        depth: 1,
      })),
      // One pending URL in the same section: quota-blocked at five of a ten-page budget.
      { url: `${fixture.origin}/blog/pending`, depth: 1 },
      // A sitemap-only URL in another section: it must be crawled instead of the chunk doing nothing.
      { url: `${fixture.origin}/deep/one`, depth: null, inSitemap: true, discoveredBy: 'sitemap' },
    ]);

    const result = await runCrawlChunk(
      ctx.db,
      { workspaceId: ws, auditId: audit.id, chunk: await nextChunkNumber(ctx.db) },
      { limiter: limiterFor(ctx.db), version: 'test' },
    );
    expect(result.leased).toBe(1);
    expect(result.processed).toBe(1);
    expect(fixture.paths()).toContain('/deep/one');
    expect(fixture.paths()).not.toContain('/blog/pending');

    await drainAudit(ctx.db, ws, audit.id);
    const status = await run(ctx.executor, auditStatus, { auditId: audit.id }, ownerPrincipal(ws));
    expect(status.audit.state).toBe('completed');
  });

  it('keeps one section from taking the whole chunk while another has pending URLs', async () => {
    const audit = await newAudit({ limits: { maxPages: 10, maxDepth: 10, maxDurationMs: 30 * 60 * 1000 } });
    await setFrontier(ctx.db, ws, audit.id, [
      ...Array.from({ length: 30 }, (_, index) => ({ url: `${fixture.origin}/blog/${index + 1}`, depth: 1 })),
      { url: `${fixture.origin}/deep/pending`, depth: 1 },
    ]);
    const result = await runCrawlChunk(
      ctx.db,
      { workspaceId: ws, auditId: audit.id, chunk: await nextChunkNumber(ctx.db) },
      { limiter: limiterFor(ctx.db), version: 'test' },
    );
    // Half of maxPages is five, so the blog section may take five and the other section at least one.
    const leased = (await frontierRows(ctx.db, ws, audit.id)).filter((row) => row.state === 'leased' || row.state === 'crawled');
    const blog = leased.filter((row) => new URL(row.url).pathname.startsWith('/blog/')).length;
    expect(blog).toBeLessThanOrEqual(5);
    expect(result.leased).toBe(6);
  });

  it('follows redirects itself, stopping at off-site and robots-disallowed hops', async () => {
    const audit = await newAudit({
      scope: 'list',
      urls: [`${fixture.origin}/redirect`, `${fixture.origin}/offsite`, `${fixture.origin}/to-private`],
      limits: { maxPages: 10, maxDepth: 10, maxDurationMs: 30 * 60 * 1000 },
    });
    await drainAudit(ctx.db, ws, audit.id);
    const snapshots = new Map((await snapshotRows(ctx.db, ws, audit.id)).map((row) => [row.url, row.facts as unknown as PageFacts]));

    // A same-site chain is followed hop by hop and recorded in order.
    const chain = snapshots.get(`${fixture.origin}/redirect`);
    expect(chain).toMatchObject({ status: 200, finalUrl: `${fixture.origin}/d` });
    expect(chain?.redirects.map((hop) => hop.url)).toEqual([`${fixture.origin}/redirect`, `${fixture.origin}/c`]);
    expect(chain?.redirects.map((hop) => hop.status)).toEqual([302, 301]);

    // An off-site target is recorded as the final URL and never fetched.
    const offsite = snapshots.get(`${fixture.origin}/offsite`);
    expect(offsite).toMatchObject({ status: 302, finalUrl: 'https://external.invalid/elsewhere', html: null });
    expect(offsite?.redirects).toHaveLength(1);

    // A robots-disallowed target stops the chain at the 3xx; the target is never requested.
    const blocked = snapshots.get(`${fixture.origin}/to-private`);
    expect(blocked).toMatchObject({ status: 302, finalUrl: `${fixture.origin}/private/secret`, html: null });
    expect(fixture.paths()).not.toContain('/private/secret');
    // The external host is not reachable in this test at all: a fetch would have failed the chunk.
    expect(fixture.paths()).not.toContain('/elsewhere');
  });

  it('releases leases and schedules the successor past a host backoff when the chunk stops', async () => {
    const audit = await newAudit({ limits: { maxPages: 10, maxDepth: 10, maxDurationMs: 30 * 60 * 1000 } });
    // The throttled page sorts first (depth 0) and the other pending URL gives the chunk work it
    // must hand to a successor.
    await setFrontier(ctx.db, ws, audit.id, [
      { url: `${fixture.origin}/throttled`, depth: 0 },
      { url: `${fixture.origin}/a`, depth: 1 },
    ]);
    const started = Date.now();
    const scheduled: { runAt?: Date }[] = [];
    const result = await runCrawlChunk(
      ctx.db,
      { workspaceId: ws, auditId: audit.id, chunk: await nextChunkNumber(ctx.db) },
      {
        limiter: limiterFor(ctx.db),
        version: 'test',
        chunkSize: 1,
        enqueueNext: async (_payload, options) => void scheduled.push({ ...(options?.runAt ? { runAt: options.runAt } : {}) }),
      },
    );
    expect(result.more).toBe(true);
    expect(scheduled).toHaveLength(1);
    // The 429's Retry-After (60 s) becomes the successor's run time, not a busy loop.
    const runAt = scheduled[0]?.runAt?.getTime() ?? 0;
    expect(runAt).toBeGreaterThan(started + 50_000);
    expect(runAt).toBeLessThan(started + 75_000);
    expect((await frontierRows(ctx.db, ws, audit.id)).every((row) => row.state !== 'leased')).toBe(true);
  });

  it('aborts a limiter wait at the soft deadline and releases the lease', async () => {
    const audit = await newAudit({ limits: { maxPages: 10, maxDepth: 10, maxDurationMs: 30 * 60 * 1000 } });
    await setFrontier(ctx.db, ws, audit.id, [{ url: `${fixture.origin}/a`, depth: 0 }]);
    const scheduled: unknown[] = [];
    const started = Date.now();
    const result = await runCrawlChunk(
      ctx.db,
      { workspaceId: ws, auditId: audit.id, chunk: await nextChunkNumber(ctx.db) },
      {
        limiter: new NeverGrantingLimiter(),
        version: 'test',
        softDeadlineMs: 150,
        enqueueNext: async (payload) => void scheduled.push(payload),
      },
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.more).toBe(true);
    expect(result.released).toBe(1);
    expect(scheduled).toHaveLength(1);
    const rows = await frontierRows(ctx.db, ws, audit.id);
    expect(rows.find((row) => row.url === `${fixture.origin}/a`)?.state).toBe('pending');
  });

  it('finalizes from the reconciler when a worker died after the last page commit', async () => {
    const audit = await newAudit({
      scope: 'list',
      urls: [`${fixture.origin}/a`],
      limits: { maxPages: 5, maxDepth: 10, maxDurationMs: 30 * 60 * 1000 },
    });
    let finalized = 0;
    const dispose = registerAuditHooks({
      onFinalize: async (_tx, ref) => {
        if (ref.auditId === audit.id) finalized += 1;
      },
    });
    try {
      await expect(
        runCrawlChunk(
          ctx.db,
          { workspaceId: ws, auditId: audit.id, chunk: await nextChunkNumber(ctx.db) },
          {
            limiter: limiterFor(ctx.db),
            version: 'test',
            boundary: async (point) => {
              if (point === 'beforeFinalize') throw new Error('worker died before the finalize');
            },
          },
        ),
      ).rejects.toThrow('worker died before the finalize');

      // The page committed, the audit is still running, and nothing is pending or leased.
      const running = await auditRow(ctx.db, ws, audit.id);
      expect(running?.state).toBe('running');
      expect((await frontierRows(ctx.db, ws, audit.id)).filter((row) => row.state === 'pending' || row.state === 'leased')).toHaveLength(0);

      const reconciled = await reconcileCrawls(ctx.db, { enqueue: async () => undefined });
      expect(reconciled.finalized).toBeGreaterThanOrEqual(1);
      const status = await run(ctx.executor, auditStatus, { auditId: audit.id }, ownerPrincipal(ws));
      expect(status.audit.state).toBe('completed');
      expect(finalized).toBe(1);
    } finally {
      dispose();
    }
  });

  it('repairs a worker killed after the fetch, rediscovering its page on the retry', async () => {
    const audit = await newAudit();
    const limiter = limiterFor(ctx.db);
    let pageHooks = 0;
    const dispose = registerAuditHooks({
      onPage: async (_tx, ref) => {
        if (ref.auditId === audit.id) pageHooks += 1;
      },
    });
    try {
      await expect(
        runCrawlChunk(
          ctx.db,
          { workspaceId: ws, auditId: audit.id, chunk: await nextChunkNumber(ctx.db) },
          {
            limiter,
            version: 'test',
            boundary: async (point) => {
              if (point === 'afterFetch') throw new Error('worker died after the fetch');
            },
          },
        ),
      ).rejects.toThrow('worker died after the fetch');
    } finally {
      dispose();
    }
    // The fetch happened but nothing was stored; the lease is still held by the dead chunk.
    expect(await snapshotRows(ctx.db, ws, audit.id)).toHaveLength(0);
    expect(pageHooks).toBe(0);
    expect((await frontierRows(ctx.db, ws, audit.id)).find((row) => row.url === `${fixture.origin}/`)?.state).toBe('leased');

    // The reconciler repairs the expired lease and re-enqueues; the retry stores the page once.
    await ctx.db.withWorkspace(ws, (tx) =>
      tx.execute(sql`
        UPDATE crawl_frontier SET lease_expires_at = now() - interval '1 minute'
        WHERE workspace_id = ${ws} AND audit_id = ${audit.id} AND state = 'leased'`),
    );
    await ctx.db.admin.query("UPDATE audits SET last_progress_at = now() - interval '11 minutes' WHERE id = $1", [audit.id]);
    const enqueued: { workspaceId: string; auditId: string; chunk: number }[] = [];
    const reconciled = await reconcileCrawls(ctx.db, { enqueue: async (payload) => void enqueued.push(payload) });
    expect(reconciled.repaired).toBe(1);
    expect(enqueued).toHaveLength(1);
    await runCrawlChunk(ctx.db, enqueued[0]!, { limiter, version: 'test' });
    await drainAudit(ctx.db, ws, audit.id, { limiter });

    const status = await run(ctx.executor, auditStatus, { auditId: audit.id }, ownerPrincipal(ws));
    expect(status.audit.state).toBe('completed');
    const snapshots = await snapshotRows(ctx.db, ws, audit.id);
    expect(new Set(snapshots.map((row) => row.url)).size).toBe(snapshots.length);
    expect(snapshots.filter((row) => row.url === `${fixture.origin}/`)).toHaveLength(1);
    // The home page's discoveries were stored by the retry, not lost with the killed attempt.
    const rows = await frontierRows(ctx.db, ws, audit.id);
    expect(rows.some((row) => row.url === `${fixture.origin}/a`)).toBe(true);
  });

  it('finalizes from the reconciler after a worker died just after the last page commit, without re-fetching', async () => {
    const audit = await newAudit({
      scope: 'list',
      urls: [`${fixture.origin}/a`],
      limits: { maxPages: 5, maxDepth: 10, maxDurationMs: 30 * 60 * 1000 },
    });
    const limiter = limiterFor(ctx.db);
    let pageHooks = 0;
    const dispose = registerAuditHooks({
      onPage: async (_tx, ref) => {
        if (ref.auditId === audit.id) pageHooks += 1;
      },
    });
    try {
      await expect(
        runCrawlChunk(
          ctx.db,
          { workspaceId: ws, auditId: audit.id, chunk: await nextChunkNumber(ctx.db) },
          {
            limiter,
            version: 'test',
            boundary: async (point) => {
              if (point === 'afterPageCommit') throw new Error('worker died after the commit');
            },
          },
        ),
      ).rejects.toThrow('worker died after the commit');
    } catch (error) {
      dispose();
      throw error;
    }
    // The page and its discoveries committed, and the row is already crawled: there is no work to
    // redo, so nothing may be fetched again.
    const fetched = fixture.requests.length;
    expect((await snapshotRows(ctx.db, ws, audit.id)).map((row) => row.url)).toEqual([`${fixture.origin}/a`]);
    expect((await frontierRows(ctx.db, ws, audit.id)).find((row) => row.url === `${fixture.origin}/a`)?.state).toBe('crawled');

    const reconciled = await reconcileCrawls(ctx.db, { enqueue: async () => undefined });
    expect(reconciled.finalized).toBeGreaterThanOrEqual(1);
    const status = await run(ctx.executor, auditStatus, { auditId: audit.id }, ownerPrincipal(ws));
    expect(status.audit.state).toBe('completed');
    expect(fixture.requests.length).toBe(fetched);
    expect((await snapshotRows(ctx.db, ws, audit.id)).filter((row) => row.url === `${fixture.origin}/a`)).toHaveLength(1);
    expect(pageHooks).toBe(1);
    dispose();
  });

  it('calls page and finalize hooks inside the crawler transaction, once per page and audit', async () => {
    const audit = await newAudit();
    const seen = new Map<string, number>();
    let finalized = 0;
    let coverageAtFinalize: unknown = null;
    let edgesAtFinalize = 0;
    const dispose = registerAuditHooks({
      onPage: async (tx, ref, page) => {
        if (ref.auditId !== audit.id) return;
        // The snapshot exists in this very transaction: the hook runs before the commit but after
        // the store, which is what a check needs.
        const { rows } = await tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM page_snapshots WHERE workspace_id = ${ref.workspaceId} AND id = ${page.snapshotId}`,
        );
        expect(rows[0]?.n).toBe(1);
        seen.set(page.snapshotId, (seen.get(page.snapshotId) ?? 0) + 1);
      },
      onFinalize: async (tx, ref) => {
        if (ref.auditId !== audit.id) return;
        finalized += 1;
        coverageAtFinalize = ref.coverage;
        const { rows } = await tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM link_edges WHERE workspace_id = ${ref.workspaceId} AND audit_id = ${ref.auditId}`,
        );
        edgesAtFinalize = rows[0]?.n ?? 0;
        expect(ref.site.home).not.toBeNull();
      },
    });
    try {
      await drainAudit(ctx.db, ws, audit.id);
    } finally {
      dispose();
    }

    expect(finalized).toBe(1);
    expect([...seen.values()].every((count) => count === 1)).toBe(true);
    const rows = await frontierRows(ctx.db, ws, audit.id);
    expect(seen.size).toBe(rows.filter((row) => row.state === 'crawled' || row.skip_reason === 'robots').length);
    expect(coverageAtFinalize).toMatchObject({ scope: 'site', graph: 'truncated' });
    expect(edgesAtFinalize).toBeGreaterThan(0);

    // After finalize the edges are gone and the summary remains.
    const { rows: edges } = await ctx.db.admin.query(
      'SELECT count(*)::int AS n FROM link_edges WHERE workspace_id = $1 AND audit_id = $2',
      [ws, audit.id],
    );
    expect(edges[0].n).toBe(0);
    const { rows: stats } = await ctx.db.admin.query(
      'SELECT count(*)::int AS n FROM page_link_stats WHERE workspace_id = $1 AND audit_id = $2',
      [ws, audit.id],
    );
    expect(stats[0].n).toBeGreaterThan(0);
  });

  it('finalizes exactly once when two writers finish at the same time', async () => {
    const audit = await newAudit({ limits: { maxPages: 1, maxDepth: 0, maxDurationMs: 30 * 60 * 1000 } });
    // Pretend the one chunk finished: its rows are crawled and the counters are written.
    await ctx.db.admin.query("UPDATE crawl_frontier SET state = 'crawled' WHERE workspace_id = $1 AND audit_id = $2", [ws, audit.id]);
    await ctx.db.admin.query('UPDATE audits SET pages_crawled = 1 WHERE workspace_id = $1 AND id = $2', [ws, audit.id]);

    let calls = 0;
    const dispose = registerAuditHooks({
      onFinalize: async (_tx, ref) => {
        if (ref.auditId === audit.id) calls += 1;
      },
    });
    try {
      const results = await Promise.all([
        finalizeAudit(ctx.db, { workspaceId: ws, auditId: audit.id }),
        finalizeAudit(ctx.db, { workspaceId: ws, auditId: audit.id }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    } finally {
      dispose();
    }
    expect(calls).toBe(1);
    const status = await run(ctx.executor, auditStatus, { auditId: audit.id }, ownerPrincipal(ws));
    expect(status.audit.state).toBe('completed');
  });

  it('refuses a site whose host resolves to a private address in the worker, with the reason', async () => {
    const privateSite = await addSite(ctx.db, ws, { domain: 'private.test' });
    const { setCrawlFetchSeams } = await import('../src/fetch-options');
    setCrawlFetchSeams({
      resolver: async (hostname: string) => {
        if (hostname === 'private.test') return [{ address: '10.0.0.5', family: 4 }];
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
      },
    });
    // The command no longer touches the network, so the audit is created; the first chunk's seed
    // step meets the guard and ends the audit as failed with the reason.
    const audit = (await run(ctx.executor, runAudit, { siteId: privateSite }, ownerPrincipal(ws))).audit;
    expect(audit.state).toBe('queued');
    await runCrawlChunk(
      ctx.db,
      { workspaceId: ws, auditId: audit.id, chunk: await nextChunkNumber(ctx.db) },
      { limiter: limiterFor(ctx.db), version: 'test' },
    );
    const status = await run(ctx.executor, auditStatus, { auditId: audit.id }, ownerPrincipal(ws));
    expect(status.audit.state).toBe('failed');
    expect(status.audit.stateReason).toContain('private, loopback or metadata');
  });

  it('refuses a crawl before the site is verified', async () => {
    const unverified = await addSite(ctx.db, ws, { domain: 'unverified.test', verified: false });
    await expect(run(ctx.executor, runAudit, { siteId: unverified }, ownerPrincipal(ws))).rejects.toMatchObject({
      code: 'precondition_failed',
      message: expect.stringContaining('Verify site ownership'),
    });
  });

  it('cancels an audit and finalizes it with reason cancelled', async () => {
    const audit = await newAudit();
    const cancelled = await run(ctx.executor, cancelAudit, { auditId: audit.id }, ownerPrincipal(ws));
    expect(cancelled.audit.state).toBe('cancelled');

    // A chunk leasing after the cancel stops and finalizes.
    const result = await runCrawlChunk(
      ctx.db,
      { workspaceId: ws, auditId: audit.id, chunk: await nextChunkNumber(ctx.db) },
      { limiter: limiterFor(ctx.db), version: 'test' },
    );
    expect(result.finalized).toBe(true);

    const status = await run(ctx.executor, auditStatus, { auditId: audit.id }, ownerPrincipal(ws));
    expect(status.audit.state).toBe('cancelled');
    expect(status.audit.stateReason).toBe('cancelled');
    expect(status.audit.finishedAt).not.toBeNull();
    expect(status.audit.coverage?.reasons).toContain('cancelled');
  });

  it('ends a stalled audit as partial or failed, and an overtime one as partial', async () => {
    // One audit at a time per site, so each ending is arranged and reconciled before the next
    // audit is started.
    const withPages = await newAudit();
    await runCrawlChunk(
      ctx.db,
      { workspaceId: ws, auditId: withPages.id, chunk: await nextChunkNumber(ctx.db) },
      { limiter: limiterFor(ctx.db), version: 'test' },
    );
    // A stalled audit that crawled something ends `partial`, with a reason a person can act on.
    await ctx.db.admin.query("UPDATE audits SET last_progress_at = now() - interval '31 minutes' WHERE id = $1", [withPages.id]);
    const firstPass = await reconcileCrawls(ctx.db, { enqueue: async () => undefined });
    expect(firstPass.finalized).toBeGreaterThanOrEqual(1);
    const partial = await run(ctx.executor, auditStatus, { auditId: withPages.id }, ownerPrincipal(ws));
    expect(partial.audit.state).toBe('partial');
    expect(partial.audit.stateReason).toMatch(/No progress for 30 minutes/);
    expect(partial.audit.coverage?.reasons).toContain('errors');

    // One that never crawled a page and stalled ends `failed`.
    const empty = await newAudit();
    await ctx.db.admin.query("UPDATE audits SET last_progress_at = now() - interval '31 minutes' WHERE id = $1", [empty.id]);
    await reconcileCrawls(ctx.db, { enqueue: async () => undefined });
    const failed = await run(ctx.executor, auditStatus, { auditId: empty.id }, ownerPrincipal(ws));
    expect(failed.audit.state).toBe('failed');
    expect(failed.audit.stateReason).toMatch(/No progress for 30 minutes/);

    // An audit past its wall-clock budget ends `partial` with reason `time_limit`.
    const overtime = await newAudit();
    await runCrawlChunk(
      ctx.db,
      { workspaceId: ws, auditId: overtime.id, chunk: await nextChunkNumber(ctx.db) },
      { limiter: limiterFor(ctx.db), version: 'test' },
    );
    await ctx.db.admin.query("UPDATE audits SET started_at = now() - interval '2 hours' WHERE id = $1", [overtime.id]);
    await reconcileCrawls(ctx.db, { enqueue: async () => undefined });
    const timed = await run(ctx.executor, auditStatus, { auditId: overtime.id }, ownerPrincipal(ws));
    expect(timed.audit.state).toBe('partial');
    expect(timed.audit.stateReason).toBe('The audit reached its time limit.');
    expect(timed.audit.coverage?.reasons).toContain('time_limit');
  });

  it('leaves no frontier row pending or leased when an audit finishes', async () => {
    const audit = await newAudit({ limits: { maxPages: 200, maxDepth: 10, maxDurationMs: 30 * 60 * 1000 } });
    await drainAudit(ctx.db, ws, audit.id);
    const rows = await frontierRows(ctx.db, ws, audit.id);
    expect(rows.filter((row) => row.state === 'pending' || row.state === 'leased')).toHaveLength(0);
    // The audit's sync is durable: the DB pool is the same one the tests used.
    expect(
      (
        await ctx.db.withWorkspace(ws, (tx) =>
          tx
            .select()
            .from(schema.audits)
            .where(and(eq(schema.audits.workspaceId, ws), eq(schema.audits.id, audit.id))),
        )
      ).length,
    ).toBe(1);
  });
});
