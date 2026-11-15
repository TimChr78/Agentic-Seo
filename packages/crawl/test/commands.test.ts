import { agentPrincipal, createExecutor } from '@agentic-seo/commands';
import { schema } from '@agentic-seo/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase } from '../../db/test/disposable';
import { auditPage, auditPages, auditStatus, cancelAudit, finalizeAudit, listAudits, reconcileCrawls, runAudit } from '../src';
import { type FixtureSite, startFixture } from './fixture';
import {
  addSite,
  auditRow,
  type CrawlTestContext,
  clearFixture,
  createCrawlTestContext,
  drainAudit,
  frontierRows,
  ownerPrincipal,
  run,
  services,
  snapshotRows,
  useFixture,
} from './support';

// The audit commands: scope seeding, refusals, the running-audit conflict, cursored reads, tenancy,
// and the action ledger an agent's crawl lands in.

describe.skipIf(!hasTestDatabase())('audit commands', () => {
  let ctx: CrawlTestContext;
  let fixture: FixtureSite;
  let ws = '';
  let siteId = '';

  const newAudit = async (input: Record<string, unknown> = {}) =>
    (await run(ctx.executor, runAudit, { siteId, ...input }, ownerPrincipal(ws))).audit;

  const finishLiveAudits = async (workspaceId = ws) => {
    const { rows } = await ctx.db.admin.query<{ id: string }>('SELECT id FROM audits WHERE workspace_id = $1 AND finished_at IS NULL', [
      workspaceId,
    ]);
    for (const row of rows) {
      await ctx.db.admin.query("UPDATE audits SET state = 'cancelled', state_reason = 'cancelled' WHERE workspace_id = $1 AND id = $2", [
        workspaceId,
        row.id,
      ]);
      await finalizeAudit(ctx.db, { workspaceId, auditId: row.id });
    }
  };

  beforeAll(async () => {
    fixture = await startFixture();
    ctx = await createCrawlTestContext('crawl_commands');
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
    await finishLiveAudits();
  });

  it('seeds a section audit from the prefix and only crawls pages under it', async () => {
    const audit = await newAudit({ scope: 'section', section: '/deep' });
    await drainAudit(ctx.db, ws, audit.id);
    const status = await run(ctx.executor, auditStatus, { auditId: audit.id }, ownerPrincipal(ws));
    expect(status.audit.state).toBe('completed');
    expect(status.audit.coverage).toMatchObject({ scope: 'section', section: '/deep' });
    const urls = (await snapshotRows(ctx.db, ws, audit.id)).map((row) => new URL(row.url).pathname);
    expect(urls.length).toBeGreaterThan(0);
    for (const path of urls) expect(path.startsWith('/deep')).toBe(true);
    expect(urls).toContain('/deep/one');
  });

  it('seeds a list audit from exactly the URLs it was given', async () => {
    const audit = await newAudit({ scope: 'list', urls: [`${fixture.origin}/a`, `${fixture.origin}/a2`] });
    await drainAudit(ctx.db, ws, audit.id);
    const urls = (await snapshotRows(ctx.db, ws, audit.id)).map((row) => row.url).sort();
    expect(urls).toEqual([`${fixture.origin}/a`, `${fixture.origin}/a2`]);
    const status = await run(ctx.executor, auditStatus, { auditId: audit.id }, ownerPrincipal(ws));
    expect(status.audit.coverage).toMatchObject({ scope: 'list', urls: [`${fixture.origin}/a`, `${fixture.origin}/a2`] });
  });

  it('refuses input that cannot describe a crawl', async () => {
    await expect(run(ctx.executor, runAudit, { siteId, scope: 'section' }, ownerPrincipal(ws))).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('Section scope needs a section path'),
    });
    await expect(run(ctx.executor, runAudit, { siteId, scope: 'list' }, ownerPrincipal(ws))).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('at least one URL'),
    });
    await expect(
      run(ctx.executor, runAudit, { siteId, scope: 'list', urls: ['https://other.example/page'] }, ownerPrincipal(ws)),
    ).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining("not on this site's hosts") });
    await expect(run(ctx.executor, runAudit, { siteId, scope: 'list', urls: ['not a url'] }, ownerPrincipal(ws))).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('not an http(s) URL'),
    });
    // Rendering arrives in Phase 2; refusing is better than silently reading raw HTML for an "auto" audit.
    await expect(run(ctx.executor, runAudit, { siteId, renderMode: 'auto' }, ownerPrincipal(ws))).rejects.toMatchObject({
      code: 'precondition_failed',
      message: expect.stringContaining('No renderer is configured (Phase 2)'),
    });
  });

  it('refuses a second audit while one is live, naming it', async () => {
    const first = await newAudit();
    await expect(newAudit()).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining(first.id),
    });
  });

  it('reads pages by status class and one page’s full facts, with URL cursors', async () => {
    const audit = await newAudit();
    await drainAudit(ctx.db, ws, audit.id);

    const failed = await run(ctx.executor, auditPages, { auditId: audit.id, status: 'server_error' }, ownerPrincipal(ws));
    expect(failed.pages.map((page) => new URL(page.url).pathname)).toContain('/boom');
    expect(failed.pages.every((page) => page.status === 500)).toBe(true);
    const missing = await run(ctx.executor, auditPages, { auditId: audit.id, status: 'client_error' }, ownerPrincipal(ws));
    expect(missing.pages.map((page) => new URL(page.url).pathname)).toContain('/missing');

    const firstPage = await run(ctx.executor, auditPages, { auditId: audit.id, limit: 2 }, ownerPrincipal(ws));
    expect(firstPage.pages).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await run(
      ctx.executor,
      auditPages,
      { auditId: audit.id, limit: 2, cursor: firstPage.nextCursor ?? undefined },
      ownerPrincipal(ws),
    );
    expect(secondPage.pages[0]?.url > firstPage.pages[1]!.url).toBe(true);

    const facts = await run(ctx.executor, auditPage, { auditId: audit.id, url: `${fixture.origin}/a` }, ownerPrincipal(ws));
    expect(facts.page).toMatchObject({ url: `${fixture.origin}/a`, status: 200 });
    expect((facts.page as unknown as { html: { title: string } }).html.title).toBe('A');
    // The rich page's facts survive the round trip through jsonb.
    const rich = await run(ctx.executor, auditPage, { auditId: audit.id, url: `${fixture.origin}/rich` }, ownerPrincipal(ws));
    const html = (rich.page as unknown as { html: { canonicalOutsideHead: boolean; images: { alt: string | null }[]; wordCount: number } })
      .html;
    expect(html.canonicalOutsideHead).toBe(true);
    expect(html.images.some((image) => image.alt === null)).toBe(true);
    expect(html.images.some((image) => image.alt === '')).toBe(true);
    expect(html.wordCount).toBe(14);
  });

  it('lists audits newest first with a working cursor', async () => {
    for (let index = 0; index < 3; index += 1) {
      const audit = await newAudit();
      await run(ctx.executor, cancelAudit, { auditId: audit.id }, ownerPrincipal(ws));
      await finalizeAudit(ctx.db, { workspaceId: ws, auditId: audit.id });
    }
    const first = await run(ctx.executor, listAudits, { siteId, limit: 2 }, ownerPrincipal(ws));
    expect(first.audits).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await run(ctx.executor, listAudits, { siteId, limit: 2, cursor: first.nextCursor ?? undefined }, ownerPrincipal(ws));
    expect(second.audits.length).toBeGreaterThan(0);
    const seen = new Set([...first.audits, ...second.audits].map((audit) => audit.id));
    expect(seen.size).toBe(first.audits.length + second.audits.length);
    await expect(run(ctx.executor, listAudits, { cursor: 'not-a-cursor' }, ownerPrincipal(ws))).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('refuses to cancel an audit that already finished', async () => {
    const audit = await newAudit();
    await run(ctx.executor, cancelAudit, { auditId: audit.id }, ownerPrincipal(ws));
    await finalizeAudit(ctx.db, { workspaceId: ws, auditId: audit.id });
    await expect(run(ctx.executor, cancelAudit, { auditId: audit.id }, ownerPrincipal(ws))).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('already finished'),
    });
  });

  it('does not cancel an audit that finished while the command waited for its row lock', async () => {
    const audit = await newAudit();
    const client = await ctx.db.admin.connect();
    try {
      // Hold the audit row as a finalize does, then finish the audit while cancel is waiting.
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM audits WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [ws, audit.id]);
      const cancelling = run(ctx.executor, cancelAudit, { auditId: audit.id }, ownerPrincipal(ws));
      let blocked = false;
      for (let attempt = 0; attempt < 250 && !blocked; attempt += 1) {
        const { rows } = await ctx.db.admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'`,
        );
        blocked = (rows[0]?.n ?? 0) > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      await client.query("UPDATE audits SET state = 'completed', finished_at = now() WHERE workspace_id = $1 AND id = $2", [ws, audit.id]);
      await client.query('COMMIT');
      await expect(cancelling).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('already finished') });
    } finally {
      client.release();
    }
    // The conditional update matched nothing, so the completed audit was not overwritten.
    expect((await auditRow(ctx.db, ws, audit.id))?.state).toBe('completed');
  });

  it('keeps audits and snapshots invisible to another workspace (RLS)', async () => {
    const otherWorkspace = '11111111-1111-4111-8111-111111111111';
    await ctx.db.admin.query('INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, $2, $3)', [
      otherWorkspace,
      'Other workspace',
      'none',
    ]);
    const otherSite = await addSite(ctx.db, otherWorkspace, { domain: 'other.test' });
    const otherAudit = (await run(ctx.executor, runAudit, { siteId: otherSite }, ownerPrincipal(otherWorkspace))).audit;
    await run(ctx.executor, cancelAudit, { auditId: otherAudit.id }, ownerPrincipal(otherWorkspace));

    await expect(run(ctx.executor, auditStatus, { auditId: otherAudit.id }, ownerPrincipal(ws))).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      run(ctx.executor, auditPage, { auditId: otherAudit.id, url: 'https://other.test/' }, ownerPrincipal(ws)),
    ).rejects.toMatchObject({ code: 'not_found' });
    const listed = await run(ctx.executor, listAudits, {}, ownerPrincipal(ws));
    expect(listed.audits.map((audit) => audit.id)).not.toContain(otherAudit.id);

    const visible = await ctx.db.withWorkspace(ws, (tx) =>
      tx.select({ id: schema.audits.id }).from(schema.audits).where(eq(schema.audits.id, otherAudit.id)),
    );
    expect(visible).toHaveLength(0);
  });

  it('records an agent’s audits.run in the action ledger with class crawl', async () => {
    // The mandate may grant level 3, but the workspace ceiling has to allow it too.
    await ctx.db.admin.query(`UPDATE workspaces SET settings = '{"maxLevel":{"crawl":3}}'::jsonb WHERE id = $1`, [ws]);
    const entries: { actionClass: string; decision: string; ok: boolean; command: string }[] = [];
    const agentExecutor = createExecutor(ctx.db, {
      ...services,
      activeMandate: async () => ({
        view: { id: 'mnd_crawl_test', version: 1, levels: { crawl: 3 }, holdWindow: '1 hour', purpose: 'Crawl the site' },
        outsideHours: null,
      }),
      agentCounters: async () => ({ changes: 0 }),
      onAgentAction: async (tx, entry) => {
        entries.push({ actionClass: entry.actionClass, decision: entry.decision, ok: entry.ok, command: entry.command });
        await tx.insert(schema.agentActions).values({
          workspaceId: ws,
          agentId: entry.agentId,
          command: entry.command,
          actionClass: entry.actionClass,
          decision: entry.decision,
          reasons: entry.reasons,
          impact: entry.impact as Record<string, unknown>,
          ok: entry.ok,
          error: entry.error,
          target: entry.target,
          surface: entry.surface,
          level: entry.level,
          intent: entry.intent,
          undo: entry.undo,
          mandateId: entry.mandateId ?? null,
          mandateVersion: entry.mandateVersion ?? null,
        });
      },
    });
    const agent = agentPrincipal(
      { id: 'agt_crawl_ledger', name: 'Crawler', status: 'active', statusReason: null },
      'user_owner',
      'client_crawl',
      ws,
      'editor',
      ['audits:run', 'sites:read'],
    );
    const audit = await agentExecutor.execute(runAudit, { siteId }, agent, { surface: 'mcp' });
    expect(audit.audit.state).toBe('queued');
    expect(entries).toEqual([{ actionClass: 'crawl', decision: 'allow', ok: true, command: 'audits.run' }]);

    const { rows } = await ctx.db.admin.query(
      "SELECT action_class, decision, ok FROM agent_actions WHERE workspace_id = $1 AND agent_id = 'agt_crawl_ledger'",
      [ws],
    );
    expect(rows[0]).toMatchObject({ action_class: 'crawl', decision: 'allow', ok: true });

    // Without a mandate the same agent is refused (level 1, and a crawl cannot wait for approval),
    // and the refusal is still in the ledger with the same class.
    const strict = createExecutor(ctx.db, {
      ...services,
      agentCounters: async () => ({ changes: 0 }),
      onAgentAction: async (tx, entry) => {
        entries.push({ actionClass: entry.actionClass, decision: entry.decision, ok: entry.ok, command: entry.command });
        await tx.insert(schema.agentActions).values({
          workspaceId: ws,
          agentId: entry.agentId,
          command: entry.command,
          actionClass: entry.actionClass,
          decision: entry.decision,
          reasons: entry.reasons,
          impact: entry.impact as Record<string, unknown>,
          ok: entry.ok,
          error: entry.error,
          target: entry.target,
          surface: entry.surface,
          level: entry.level,
          intent: entry.intent,
          undo: entry.undo,
          mandateId: entry.mandateId ?? null,
          mandateVersion: entry.mandateVersion ?? null,
        });
      },
    });
    await expect(strict.execute(runAudit, { siteId }, agent, { surface: 'mcp' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(entries.at(-1)).toMatchObject({ actionClass: 'crawl', decision: 'deny', ok: false });
  });

  it('keeps a chunk’s frontier rows unique per audit', async () => {
    const audit = await newAudit({ limits: { maxPages: 10, maxDepth: 10, maxDurationMs: 30 * 60 * 1000 } });
    await drainAudit(ctx.db, ws, audit.id);
    const rows = await frontierRows(ctx.db, ws, audit.id);
    expect(new Set(rows.map((row) => row.url)).size).toBe(rows.length);
    expect((await auditRow(ctx.db, ws, audit.id))?.state).toBe('completed');
  });

  it('enqueues its first chunk when Graphile Worker is installed and leaves it to the reconciler otherwise', async () => {
    // No Graphile schema in a fresh test database: the wrapper reports false, the audit stays
    // queued, and the reconciler is the fallback that dispatches it.
    const queued = await newAudit();
    expect(queued.state).toBe('queued');
    const dispatched: { auditId: string }[] = [];
    await reconcileCrawls(ctx.db, { enqueue: async (payload) => void dispatched.push(payload) });
    expect(dispatched.map((payload) => payload.auditId)).toContain(queued.id);
    await run(ctx.executor, cancelAudit, { auditId: queued.id }, ownerPrincipal(ws));
    await finalizeAudit(ctx.db, { workspaceId: ws, auditId: queued.id });

    // With Graphile present, `audits.run` enqueues the job in its own transaction, so the crawl
    // starts at once. The function is resolved at call time, which is why this works after migration.
    // The fake `add_job` mimics 0.17's semantics for the key modes this migration uses: a job key is
    // unique across tasks, and `unsafe_dedupe` never rewrites an existing row.
    await ctx.db.admin.query(`
      CREATE SCHEMA graphile_worker;
      CREATE TABLE graphile_worker.jobs (
        id bigserial PRIMARY KEY,
        identifier text NOT NULL,
        payload jsonb NOT NULL,
        run_at timestamptz NOT NULL DEFAULT now(),
        job_key text CONSTRAINT jobs_job_key_key UNIQUE
      );
      CREATE FUNCTION graphile_worker.add_job(
        identifier text,
        payload jsonb DEFAULT '{}'::jsonb,
        queue_name text DEFAULT NULL,
        run_at timestamptz DEFAULT now(),
        max_attempts integer DEFAULT NULL,
        job_key text DEFAULT NULL,
        priority integer DEFAULT NULL,
        flags text[] DEFAULT NULL,
        job_key_mode text DEFAULT 'replace'
      ) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        IF job_key_mode = 'unsafe_dedupe' THEN
          INSERT INTO graphile_worker.jobs (identifier, payload, run_at, job_key)
          VALUES (add_job.identifier, add_job.payload, coalesce(add_job.run_at, now()), add_job.job_key)
          ON CONFLICT ON CONSTRAINT jobs_job_key_key DO NOTHING;
        ELSE
          INSERT INTO graphile_worker.jobs (identifier, payload, run_at, job_key)
          VALUES (add_job.identifier, add_job.payload, coalesce(add_job.run_at, now()), add_job.job_key)
          ON CONFLICT ON CONSTRAINT jobs_job_key_key DO UPDATE
            SET identifier = excluded.identifier, payload = excluded.payload, run_at = excluded.run_at;
        END IF;
      END $$;
    `);
    try {
      const started = await newAudit();
      const { rows } = await ctx.db.admin.query<{ identifier: string; payload: Record<string, unknown>; job_key: string }>(
        "SELECT identifier, payload, job_key FROM graphile_worker.jobs WHERE payload ->> 'auditId' = $1",
        [started.id],
      );
      expect(rows[0]?.identifier).toBe('crawl_chunk');
      expect(rows[0]?.payload).toMatchObject({ workspaceId: ws, auditId: started.id });
      expect(rows[0]?.payload.chunk).toBeGreaterThan(0);
      // The key is derived inside the function; the caller never passes one.
      expect(rows[0]?.job_key).toBe(`crawl_chunk:${started.id}:${String(rows[0]?.payload.chunk)}`);

      // Two calls for the same audit and chunk dedupe onto that one job.
      const chunk = Number(rows[0]?.payload.chunk);
      const payload = JSON.stringify({ workspaceId: ws, auditId: started.id, chunk });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await ctx.db.withWorkspace(ws, (tx) => tx.execute(sql`SELECT crawl_enqueue('crawl_chunk', ${payload}::jsonb, now())`));
      }
      const { rows: deduped } = await ctx.db.admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE job_key = $1',
        [`crawl_chunk:${started.id}:${chunk}`],
      );
      expect(deduped[0]?.n).toBe(1);

      // Another task's job that happens to hold the derived key is never replaced: the wrapper's
      // `unsafe_dedupe` only leaves it alone (our chunk then waits for the reconciler instead).
      await ctx.db.admin.query('DELETE FROM graphile_worker.jobs WHERE job_key = $1', [`crawl_chunk:${started.id}:${chunk}`]);
      await ctx.db.admin.query(
        "INSERT INTO graphile_worker.jobs (identifier, payload, job_key) VALUES ('ai_prompt_tests', '{}'::jsonb, $1)",
        [`crawl_chunk:${started.id}:${chunk}`],
      );
      await ctx.db.withWorkspace(ws, (tx) => tx.execute(sql`SELECT crawl_enqueue('crawl_chunk', ${payload}::jsonb, now())`));
      const { rows: other } = await ctx.db.admin.query<{ identifier: string; n: number }>(
        'SELECT identifier, count(*) OVER ()::int AS n FROM graphile_worker.jobs WHERE job_key = $1',
        [`crawl_chunk:${started.id}:${chunk}`],
      );
      expect(other).toHaveLength(1);
      expect(other[0]?.identifier).toBe('ai_prompt_tests');

      // There is no job-key parameter to misuse: the wrapper takes exactly task, payload and run_at.
      const { rows: signature } = await ctx.db.admin.query<{ nargs: number }>(
        `SELECT p.pronargs::int AS nargs FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'crawl_enqueue'`,
      );
      expect(signature[0]?.nargs).toBe(3);
    } finally {
      await ctx.db.admin.query('DROP SCHEMA graphile_worker CASCADE');
    }
  });

  it('refuses an enqueue that is not a crawl_chunk for this workspace', async () => {
    const message = async (promise: Promise<unknown>): Promise<string> => {
      try {
        await promise;
      } catch (error) {
        const parts: string[] = [];
        let current = error as { message?: unknown; cause?: unknown } | undefined;
        for (let depth = 0; current && depth < 5; depth += 1, current = current.cause as typeof current) {
          if (typeof current.message === 'string') parts.push(current.message);
        }
        return parts.join(' | ');
      }
      throw new Error('expected the enqueue to be refused');
    };

    const audit = await newAudit();
    expect(
      await message(
        ctx.db.withWorkspace(ws, (tx) =>
          tx.execute(
            sql`SELECT crawl_enqueue('crawl_reconcile', ${JSON.stringify({ workspaceId: ws, auditId: audit.id, chunk: 1 })}::jsonb, now())`,
          ),
        ),
      ),
    ).toMatch(/only enqueues crawl_chunk/);
    expect(
      await message(
        ctx.db.withWorkspace(ws, (tx) =>
          tx.execute(
            sql`SELECT crawl_enqueue('crawl_chunk', ${JSON.stringify({ workspaceId: '11111111-1111-4111-8111-111111111111', auditId: audit.id, chunk: 1 })}::jsonb, now())`,
          ),
        ),
      ),
    ).toMatch(/current workspace/);
    expect(
      await message(
        ctx.db.withWorkspace(ws, (tx) =>
          tx.execute(sql`SELECT crawl_enqueue('crawl_chunk', ${JSON.stringify({ workspaceId: ws, auditId: audit.id })}::jsonb, now())`),
        ),
      ),
    ).toMatch(/exactly workspaceId, auditId and chunk/);
    // The wrapper no longer takes a job key at all: a four-argument call does not resolve.
    expect(
      await message(
        ctx.db.withWorkspace(ws, (tx) =>
          tx.execute(
            sql`SELECT crawl_enqueue('crawl_chunk', ${JSON.stringify({ workspaceId: ws, auditId: audit.id, chunk: 1 })}::jsonb, 'crawl_chunk:clobber', now())`,
          ),
        ),
      ),
    ).toMatch(/function crawl_enqueue\(unknown, jsonb, unknown, timestamp with time zone\) does not exist/);
  });
});
