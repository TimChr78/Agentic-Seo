import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, type Db } from '@agentic-seo/db';
import type { ProviderCallInput, ProviderGateway } from '@agentic-seo/providers';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { addDays, addMonths, dayString, runGscSync } from '../src';

// The Search Console sync at its entry point (`runGscSync`). The provider gateway is a fake that
// records each window and answers with deterministic rows, so the test checks the 16-month
// backfill, its resumption after a failure, provisional re-fetching and idempotent upserts without
// reaching Google.

const NOW = new Date('2026-11-15T12:00:00Z');
const TODAY = dayString(NOW);
const CONNECTION_ID = 'con_0123456789abcdef0123456789abcdef';

type Rows = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[];

function dayRows(start: string, end: string, clickOf: (day: string) => number): Rows {
  const rows: Rows = [];
  for (let day = start; day <= end; day = addDays(day, 1)) {
    const clicks = clickOf(day);
    rows.push({ keys: [day], clicks, impressions: clicks * 10, ctr: 0.1, position: 3 });
  }
  return rows;
}

function pageRows(start: string, end: string, clickOf: (day: string) => number): Rows {
  const rows: Rows = [];
  for (let day = start; day <= end; day = addDays(day, 1)) {
    const clicks = clickOf(day);
    rows.push({ keys: [day, 'https://example.com/a/', '', ''], clicks, impressions: clicks * 10, ctr: 0.1, position: 2 });
  }
  return rows;
}

interface Fake {
  gateway: ProviderGateway;
  calls: ProviderCallInput[];
}

function fakeGateway(handler: (call: ProviderCallInput) => Rows): Fake {
  const calls: ProviderCallInput[] = [];
  const call = async (input: ProviderCallInput) => {
    calls.push(input);
    return {
      data: { rows: handler(input), finality: 'provisional', coverage: null },
      providerId: 'google-search-console',
      callId: null,
      cache: 'miss',
      fetchedAt: NOW.toISOString(),
      actualCostMicros: 0,
      currency: 'USD',
      overrun: false,
    };
  };
  return { calls, gateway: { call } as unknown as ProviderGateway };
}

const requestOf = (call: ProviderCallInput) => call.request as { startDate: string; endDate: string; dimensions: string[] };

describe.skipIf(!hasTestDatabase())('the Search Console sync', () => {
  let disposable: Awaited<ReturnType<typeof createDisposableDb>>;
  let db: Db;
  let siteId: string;

  beforeAll(async () => {
    disposable = await createDisposableDb('searchsync');
    const appUrl = new URL(disposable.url.toString());
    appUrl.username = APP_ROLE.appRole;
    appUrl.password = APP_ROLE.appRolePassword;
    db = createDb({ adminUrl: disposable.url.toString(), appUrl: appUrl.toString(), poolSize: 6 });
    siteId = randomUUID();
    await db.admin.query(
      `INSERT INTO sites (workspace_id, id, name, primary_domain, verification_token)
       VALUES ($1, $2, 'Example', 'example.com', 'verify-token')`,
      [disposable.workspace, siteId],
    );
    await db.admin.query(
      `INSERT INTO connections (workspace_id, id, site_id, connector, label, settings, state)
       VALUES ($1, $2, $3, 'google-search-console', 'Google Search Console', $4::jsonb, 'active')`,
      [disposable.workspace, CONNECTION_ID, siteId, JSON.stringify({ property: 'sc-domain:example.com' })],
    );
  });

  afterAll(async () => {
    await db?.close();
    await disposable?.close();
  });

  const run = (fake: Fake, maxChunks: number, dataset: 'property_totals' | 'page_aggregates' = 'property_totals') =>
    runGscSync({ db, providers: fake.gateway, now: () => NOW }, { workspaceId: disposable.workspace, siteId, dataset, maxChunks });

  it('backfills 16 months in chunks and resumes from the watermark', async () => {
    const fake = fakeGateway((call) => {
      const request = requestOf(call);
      return dayRows(request.startDate, request.endDate, () => 1);
    });
    const first = await run(fake, 2);
    const provisional = requestOf(fake.calls[0]!);
    expect(provisional.startDate).toBe(addDays(TODAY, -4));
    expect(provisional.endDate).toBe(TODAY);
    // 16 months back, two 30-day chunks.
    expect(fake.calls).toHaveLength(3);
    const backfillStart = addMonths(TODAY, -16);
    expect(requestOf(fake.calls[1]!).startDate).toBe(backfillStart);
    expect(first.datasets[0]!.backfillComplete).toBe(false);
    const through = first.datasets[0]!.backfillThrough!;
    expect(through).toBe(addDays(backfillStart, 59));

    const second = fakeGateway((call) => {
      const request = requestOf(call);
      return dayRows(request.startDate, request.endDate, () => 1);
    });
    await run(second, 1);
    const resumed = second.calls.find((call) => !call.refresh && requestOf(call).dimensions.length === 1)!;
    expect(requestOf(resumed).startDate).toBe(addDays(through, 1));
  });

  it('resumes after a failed chunk from the last committed watermark', async () => {
    const first = fakeGateway((call) => {
      const request = requestOf(call);
      return dayRows(request.startDate, request.endDate, () => 1);
    });
    const successful = await run(first, 1);
    const through = successful.datasets[0]!.backfillThrough!;
    const nextStart = addDays(through, 1);

    const failing = fakeGateway((call) => {
      const request = requestOf(call);
      if (!call.refresh && request.startDate === nextStart) throw new Error('Google answered 503');
      return dayRows(request.startDate, request.endDate, () => 1);
    });
    await expect(run(failing, 1)).rejects.toThrow(/503/);
    const state = await db.admin.query<{ backfill_through: string; last_error: string }>(
      'SELECT backfill_through::text, last_error FROM gsc_sync_state WHERE workspace_id = $1 AND site_id = $2 AND dataset = $3',
      [disposable.workspace, siteId, 'property_totals'],
    );
    expect(state.rows[0]).toEqual({ backfill_through: through, last_error: 'Google answered 503' });

    const recovered = fakeGateway((call) => {
      const request = requestOf(call);
      return dayRows(request.startDate, request.endDate, () => 1);
    });
    await run(recovered, 1);
    const resumed = recovered.calls.find((call) => !call.refresh)!;
    expect(requestOf(resumed).startDate).toBe(nextStart);
    const cleared = await db.admin.query<{ last_error: string | null }>(
      'SELECT last_error FROM gsc_sync_state WHERE workspace_id = $1 AND site_id = $2 AND dataset = $3',
      [disposable.workspace, siteId, 'property_totals'],
    );
    expect(cleared.rows[0]?.last_error).toBeNull();
  });

  it('replaces a provisional day on a re-fetch and flips it final once Google stops revising it', async () => {
    let clicks = 7;
    const fake = fakeGateway((call) => {
      const request = requestOf(call);
      return pageRows(request.startDate, request.endDate, (day) => (day === TODAY ? clicks : 1));
    });
    await run(fake, 0, 'page_aggregates');
    clicks = 9;
    await run(fake, 0, 'page_aggregates');

    const rows = await db.admin.query<{ date: string; clicks: number; is_final: boolean; n: string }>(
      `SELECT date::text, clicks, is_final, count(*) OVER (PARTITION BY date)::text AS n
       FROM gsc_page_aggregates
       WHERE workspace_id = $1 AND site_id = $2 AND page = 'https://example.com/a/'
       ORDER BY date`,
      [disposable.workspace, siteId],
    );
    const today = rows.rows.find((row) => row.date === TODAY);
    expect(today).toMatchObject({ clicks: 9, is_final: false, n: '1' });
    const cutoff = rows.rows.find((row) => row.date === addDays(TODAY, -4));
    expect(cutoff?.is_final).toBe(true);
    // Every day appears once: a second sync upserts rather than duplicating.
    expect(rows.rows.every((row) => row.n === '1')).toBe(true);
    expect(rows.rows).toHaveLength(5);
  });

  it('refuses a site with no active connection', async () => {
    const other = randomUUID();
    await db.admin.query(
      `INSERT INTO sites (workspace_id, id, name, primary_domain, verification_token)
       VALUES ($1, $2, 'Other', 'other.example', 'verify-token')`,
      [disposable.workspace, other],
    );
    const fake = fakeGateway(() => []);
    await expect(
      runGscSync({ db, providers: fake.gateway, now: () => NOW }, { workspaceId: disposable.workspace, siteId: other }),
    ).rejects.toThrow(/Search Console is not connected for this site/);
  });

  it('scopes every fact to its workspace under row-level security', async () => {
    const otherWorkspace = randomUUID();
    await db.admin.query('INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, $2, $3)', [otherWorkspace, 'Other', 'none']);
    const otherSite = randomUUID();
    await db.admin.query(
      `INSERT INTO sites (workspace_id, id, name, primary_domain, verification_token)
       VALUES ($1, $2, 'Other', 'other.example', 'verify-token')`,
      [otherWorkspace, otherSite],
    );
    await db.admin.query(
      `INSERT INTO connections (workspace_id, id, site_id, connector, label, settings, state)
       VALUES ($1, $2, $3, 'google-search-console', 'Google Search Console', $4::jsonb, 'active')`,
      [otherWorkspace, `con_${randomBytes(16).toString('hex')}`, otherSite, JSON.stringify({ property: 'sc-domain:other.example' })],
    );

    // aseo is the test-server superuser, which bypasses RLS; the app role is what a request uses.
    const appUrl = new URL(disposable.url.toString());
    appUrl.username = APP_ROLE.appRole;
    appUrl.password = APP_ROLE.appRolePassword;
    const appDb = createDb({ adminUrl: disposable.url.toString(), appUrl: appUrl.toString(), poolSize: 3 });
    try {
      const visible = await appDb.withWorkspace(disposable.workspace, async (tx) => {
        const connections = await tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM connections`);
        const facts = await tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM gsc_page_aggregates`);
        return { connections: Number(connections.rows[0]?.n), facts: Number(facts.rows[0]?.n) };
      });
      expect(visible.connections).toBe(1);
      expect(visible.facts).toBeGreaterThan(0);
      const hidden = await appDb.withWorkspace(otherWorkspace, async (tx) => {
        const connections = await tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM connections`);
        return Number(connections.rows[0]?.n);
      });
      expect(hidden).toBe(1);
    } finally {
      await appDb.close();
    }
  });
});
