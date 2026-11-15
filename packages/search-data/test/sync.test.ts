import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, type Db } from '@agentic-seo/db';
import type { ProviderCallInput, ProviderGateway } from '@agentic-seo/providers';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { addDays, addMonths, dayString, normalizePageUrl, runGscSync } from '../src';

// The Search Console sync at its entry point (`runGscSync`). The provider gateway is a fake that
// records each window and answers with deterministic rows and metadata, so the test checks the
// 16-month backfill and its resumption, finality from Google's `first_incomplete_date`, the atomic
// replacement of a re-fetched window, the coverage watermark that fills an outage gap, the Pacific
// calendar, and truncation — without reaching Google.

const NOW = new Date('2026-11-15T12:00:00Z');
const TODAY = dayString(NOW);
const CONNECTION_ID = 'con_0123456789abcdef0123456789abcdef';

type Rows = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[];

interface Answer {
  rows: Rows;
  metadata?: { firstIncompleteDate: string | null; firstIncompleteHour: string | null } | null;
  truncated?: boolean;
  rowLimitReached?: number | null;
}

function dayRows(start: string, end: string, clickOf: (day: string) => number): Rows {
  const rows: Rows = [];
  for (let day = start; day <= end; day = addDays(day, 1)) {
    const clicks = clickOf(day);
    rows.push({ keys: [day], clicks, impressions: clicks * 10, ctr: 0.1, position: 3 });
  }
  return rows;
}

function pageRows(start: string, end: string, clickOf: (day: string) => number, pages = ['https://example.com/a/']): Rows {
  const rows: Rows = [];
  for (let day = start; day <= end; day = addDays(day, 1)) {
    const clicks = clickOf(day);
    for (const page of pages) rows.push({ keys: [day, page, '', ''], clicks, impressions: clicks * 10, ctr: 0.1, position: 2 });
  }
  return rows;
}

interface Fake {
  gateway: ProviderGateway;
  calls: ProviderCallInput[];
}

function fakeGateway(handler: (call: ProviderCallInput) => Answer | Rows): Fake {
  const calls: ProviderCallInput[] = [];
  const call = async (input: ProviderCallInput) => {
    calls.push(input);
    const answer = handler(input);
    const body = Array.isArray(answer) ? { rows: answer } : answer;
    return {
      data: {
        rows: body.rows,
        finality: 'provisional',
        coverage: null,
        metadata: body.metadata ?? null,
        truncated: body.truncated ?? false,
        rowLimitReached: body.rowLimitReached ?? null,
      },
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

  /** A site with its own active connection, so independent tests do not share watermarks. */
  async function newSite(name: string): Promise<string> {
    const id = randomUUID();
    await db.admin.query(
      `INSERT INTO sites (workspace_id, id, name, primary_domain, verification_token)
       VALUES ($1, $2, $3, $4, 'verify-token')`,
      [disposable.workspace, id, name, `${name}.example`],
    );
    await db.admin.query(
      `INSERT INTO connections (workspace_id, id, site_id, connector, label, settings, state)
       VALUES ($1, $2, $3, 'google-search-console', 'Google Search Console', $4::jsonb, 'active')`,
      [disposable.workspace, `con_${randomBytes(16).toString('hex')}`, id, JSON.stringify({ property: `sc-domain:${name}.example` })],
    );
    return id;
  }

  const run = (
    fake: Fake,
    maxChunks: number,
    dataset: 'property_totals' | 'page_aggregates' = 'property_totals',
    site = siteId,
    now = NOW,
  ) => runGscSync({ db, providers: fake.gateway, now: () => now }, { workspaceId: disposable.workspace, siteId: site, dataset, maxChunks });

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

  it('marks days before first_incomplete_date final and keeps the rest provisional until Google moves on', async () => {
    const site = await newSite('finality');
    let firstIncomplete: string | null = addDays(TODAY, -1);
    let clicks = 1;
    const fake = fakeGateway((call) => {
      const request = requestOf(call);
      return {
        rows: pageRows(request.startDate, request.endDate, () => clicks),
        metadata: firstIncomplete === null ? null : { firstIncompleteDate: firstIncomplete, firstIncompleteHour: null },
      };
    });
    await run(fake, 0, 'page_aggregates', site);

    const isFinal = async (day: string) => {
      const result = await db.admin.query<{ is_final: boolean }>(
        `SELECT is_final FROM gsc_page_aggregates
         WHERE workspace_id = $1 AND site_id = $2 AND date = $3 AND page = 'https://example.com/a/'`,
        [disposable.workspace, site, day],
      );
      return result.rows[0]?.is_final;
    };
    // Google says yesterday is the first incomplete day: everything before it is final. The old
    // age rule would have called yesterday-1 provisional too, which is the guess this replaces.
    expect(await isFinal(addDays(TODAY, -2))).toBe(true);
    expect(await isFinal(addDays(TODAY, -1))).toBe(false);
    expect(await isFinal(TODAY)).toBe(false);

    // Google has finished revising the window: the same rows become final and the numbers are replaced.
    firstIncomplete = null;
    clicks = 9;
    await run(fake, 0, 'page_aggregates', site);
    expect(await isFinal(addDays(TODAY, -1))).toBe(true);
    expect(await isFinal(TODAY)).toBe(true);
    const today = await db.admin.query<{ clicks: number; n: string }>(
      `SELECT clicks, count(*) OVER ()::text AS n FROM gsc_page_aggregates
       WHERE workspace_id = $1 AND site_id = $2 AND date = $3 AND page = 'https://example.com/a/'`,
      [disposable.workspace, site, TODAY],
    );
    expect(today.rows[0]).toEqual({ clicks: 9, n: '1' });
  });

  it('replaces a fetched window, so a page Google dropped does not linger', async () => {
    const site = await newSite('replace');
    const both = fakeGateway((call) => {
      const request = requestOf(call);
      return pageRows(request.startDate, request.endDate, () => 2, ['https://example.com/a/', 'https://example.com/b/']);
    });
    await run(both, 0, 'page_aggregates', site);
    const count = async () =>
      Number(
        (
          await db.admin.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM gsc_page_aggregates WHERE workspace_id = $1 AND site_id = $2 AND page_key = 'https://example.com/b'`,
            [disposable.workspace, site],
          )
        ).rows[0]?.n,
      );
    expect(await count()).toBe(5);

    // The second fetch no longer returns /b: the refetched days are replaced, not merged.
    const onlyA = fakeGateway((call) => {
      const request = requestOf(call);
      return pageRows(request.startDate, request.endDate, () => 2, ['https://example.com/a/']);
    });
    await run(onlyA, 0, 'page_aggregates', site);
    expect(await count()).toBe(0);
    // The other page is still there, once per day.
    const a = await db.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM gsc_page_aggregates WHERE workspace_id = $1 AND site_id = $2 AND page_key = 'https://example.com/a'`,
      [disposable.workspace, site],
    );
    expect(a.rows[0]?.n).toBe('5');
  });

  it('fills the gap after an outage from the coverage watermark', async () => {
    const site = await newSite('coverage');
    const answer = (call: ProviderCallInput) => {
      const request = requestOf(call);
      return dayRows(request.startDate, request.endDate, () => 1);
    };
    // A clean run on 1 November: coverage is that day.
    const first = fakeGateway(answer);
    await run(first, 0, 'property_totals', site, new Date('2026-11-01T20:00:00Z'));
    const covered = await db.admin.query<{ coverage_through: string }>(
      `SELECT coverage_through::text FROM gsc_sync_state WHERE workspace_id = $1 AND site_id = $2 AND dataset = 'property_totals'`,
      [disposable.workspace, site],
    );
    expect(covered.rows[0]?.coverage_through).toBe('2026-11-01');

    // Two weeks later the machine comes back: the window starts the day after coverage, not four days
    // before today, so 2–15 November are all fetched.
    const resumed = fakeGateway(answer);
    await run(resumed, 0, 'property_totals', site);
    expect(requestOf(resumed.calls[0]!)).toMatchObject({ startDate: '2026-11-02', endDate: TODAY });
  });

  it('asks for days in the Search Console calendar, not UTC', async () => {
    const site = await newSite('pacific');
    const fake = fakeGateway((call) => {
      const request = requestOf(call);
      return dayRows(request.startDate, request.endDate, () => 1);
    });
    // 02:00 UTC on 16 November is 18:00 PST on the 15th: Google's day is still the 15th.
    await run(fake, 0, 'property_totals', site, new Date('2026-11-16T02:00:00Z'));
    expect(requestOf(fake.calls[0]!).endDate).toBe('2026-11-15');
  });

  it('keeps the rows it did read and records a warning when the window is truncated', async () => {
    const site = await newSite('truncated');
    const fake = fakeGateway((call) => {
      const request = requestOf(call);
      return {
        rows: dayRows(request.startDate, request.endDate, () => 1),
        truncated: true,
        rowLimitReached: 1_000_000,
      };
    });
    await run(fake, 0, 'property_totals', site);
    const state = await db.admin.query<{ last_warning: string | null }>(
      `SELECT last_warning FROM gsc_sync_state WHERE workspace_id = $1 AND site_id = $2 AND dataset = 'property_totals'`,
      [disposable.workspace, site],
    );
    expect(state.rows[0]?.last_warning).toMatch(/stopped at the 1000000-row cap/);
    // Truncated is partial: the read upserts, it never deletes the window's rows.
    const rows = await db.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM gsc_property_totals WHERE workspace_id = $1 AND site_id = $2`,
      [disposable.workspace, site],
    );
    expect(rows.rows[0]?.n).toBe('5');
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
      const expected = await db.admin.query<{ n: string }>('SELECT count(*)::text AS n FROM connections WHERE workspace_id = $1', [
        disposable.workspace,
      ]);
      expect(visible.connections).toBe(Number(expected.rows[0]?.n));
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

  it('normalises the page key it stores', () => {
    expect(normalizePageUrl('https://example.com/a/')).toBe('https://example.com/a');
  });
});
