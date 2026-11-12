import { randomUUID } from 'node:crypto';
import { createDb } from '@agentic-seo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import {
  type BudgetThresholdEvent,
  createProviderGateway,
  fakeAdapter,
  type ProviderAdapter,
  ProviderBudgetError,
  ProviderCallUnknownError,
  type ProviderGateway,
  ProviderRateLimitError,
} from '../src';

// Integration tests against a disposable, freshly migrated Postgres. They pin the gateway's money
// invariants: holds settle to actual cost, concurrent calls cannot overspend, a timeout after the
// provider accepted the call is reconciled before any retry, the cache is free and tenant-scoped,
// estimate mode spends nothing, and abandoned holds are released.

const appUrl = (url: URL) => {
  const u = new URL(url.toString());
  u.username = APP_ROLE.appRole;
  u.password = APP_ROLE.appRolePassword;
  return u.toString();
};

const providerId = (prefix: string) => `${prefix}-${randomUUID()}`;

describe.skipIf(!hasTestDatabase())('provider gateway', () => {
  let current: Awaited<ReturnType<typeof createDisposableDb>>;
  let db: ReturnType<typeof createDb>;
  let workspace: string;
  let otherWorkspace: string;

  beforeAll(async () => {
    current = await createDisposableDb('providers');
    workspace = current.workspace;
    otherWorkspace = randomUUID();
    db = createDb({ adminUrl: current.url.toString(), appUrl: appUrl(current.url), poolSize: 10 });
    await db.admin.query('INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, $2, $3)', [
      otherWorkspace,
      'Other workspace',
      'none',
    ]);
  });

  afterAll(async () => {
    await db?.close();
    await current?.close();
  });

  const gateway = (adapters: ProviderAdapter[]) => createProviderGateway({ db, adapters });

  const call = (gw: ProviderGateway, providerIdValue: string, request: unknown, overrides: Record<string, unknown> = {}, ws = workspace) =>
    gw.call({
      workspaceId: ws,
      port: 'KeywordData',
      operation: 'metrics',
      request,
      caller: { type: 'person', id: 'user-1' },
      purpose: 'test',
      providerId: providerIdValue,
      ...overrides,
    });

  const budgetOf = async (gw: ProviderGateway, providerIdValue: string, ws = workspace) => {
    const budgets = await gw.budgets({ workspaceId: ws, period: gw.currentPeriod() });
    return budgets.find((budget) => budget.providerId === providerIdValue);
  };

  it('holds the maximum authorised cost, settles to the actual cost and releases a failed hold', async () => {
    const id = providerId('money');
    const ok = fakeAdapter({ id, ports: ['KeywordData'], estimateMicros: 3_000, actualMicros: 2_000 });
    const gw = gateway([ok]);
    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 10_000 });

    const result = await call(gw, id, { keywords: ['first'], market: 'us' });
    expect(result.cache).toBe('miss');
    expect(result.actualCostMicros).toBe(2_000);
    expect(await budgetOf(gw, id)).toMatchObject({
      budgetMicros: 10_000,
      spentMicros: 2_000,
      heldMicros: 0,
      remainingMicros: 8_000,
    });

    const failing = fakeAdapter({ id, ports: ['KeywordData'], estimateMicros: 1_000, failure: () => new Error('quota exceeded') });
    const gw2 = gateway([failing]);
    await expect(call(gw2, id, { keywords: ['second'], market: 'us' })).rejects.toThrow(/quota exceeded/);
    expect(await budgetOf(gw2, id)).toMatchObject({ spentMicros: 2_000, heldMicros: 0, remainingMicros: 8_000 });

    const spend = await gw2.spend({ workspaceId: workspace, period: gw2.currentPeriod() });
    expect(spend).toContainEqual(expect.objectContaining({ providerId: id, costMicros: 2_000, calls: 1 }));
  });

  it('never lets concurrent calls overspend a budget of five calls', async () => {
    const id = providerId('concurrent');
    const fake = fakeAdapter({ id, ports: ['KeywordData'], estimateMicros: 1_000, actualMicros: 1_000 });
    const gw = gateway([fake]);
    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 5_000 });

    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => call(gw, id, { keywords: [`keyword-${i}`], market: 'us' })),
    );
    const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(5);
    expect(rejected).toHaveLength(15);
    for (const attempt of rejected) expect(attempt.reason).toBeInstanceOf(ProviderBudgetError);
    expect(fake.callCount).toBe(5);
    expect(await budgetOf(gw, id)).toMatchObject({ budgetMicros: 5_000, spentMicros: 5_000, heldMicros: 0 });
  });

  it('records a timeout after charge as unknown, reconciles it, and does not charge twice', async () => {
    const id = providerId('timeout');
    const fake = fakeAdapter({ id, ports: ['KeywordData'], estimateMicros: 1_000, actualMicros: 1_000, timeoutAfterCharge: 1 });
    const gw = gateway([fake]);
    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 10_000 });

    const failure = await call(gw, id, { keywords: ['timeout'], market: 'us' }, { idempotencyKey: 'timeout-key' }).catch((err) => err);
    expect(failure).toBeInstanceOf(ProviderCallUnknownError);
    const unknown = failure as ProviderCallUnknownError;
    expect((await budgetOf(gw, id))?.heldMicros).toBe(1_000);
    expect((await budgetOf(gw, id))?.spentMicros).toBe(0);

    const reconciled = await gw.reconcileUnknown(unknown.callId);
    expect(reconciled.state).toBe('settled');
    expect(reconciled.actualCostMicros).toBe(1_000);
    expect(await budgetOf(gw, id)).toMatchObject({ spentMicros: 1_000, heldMicros: 0 });
    expect(fake.reconcileCount).toBe(1);

    const retry = await call(gw, id, { keywords: ['timeout'], market: 'us' }, { idempotencyKey: 'timeout-key' });
    expect(retry.cache).toBe('hit');
    expect(retry.actualCostMicros).toBe(0);
    expect(fake.callCount).toBe(1);
    expect(await budgetOf(gw, id)).toMatchObject({ spentMicros: 1_000, heldMicros: 0 });
  });

  it('serves a cache hit for free and keeps it scoped to the workspace and property', async () => {
    const id = providerId('cache');
    const fake = fakeAdapter({ id, ports: ['KeywordData'], estimateMicros: 1_000, actualMicros: 1_000 });
    const gw = gateway([fake]);
    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 100_000 });
    await gw.setBudget({ workspaceId: otherWorkspace, providerId: id, currency: 'USD', budgetMicros: 100_000 });

    const first = await call(gw, id, { keywords: ['cached'], market: 'us' });
    const second = await call(gw, id, { keywords: ['cached'], market: 'us' });
    expect(second.cache).toBe('hit');
    expect(second.callId).toBeNull();
    expect(second.actualCostMicros).toBe(0);
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(fake.callCount).toBe(1);

    // A different workspace never sees the first workspace's cache.
    const other = await call(gw, id, { keywords: ['cached'], market: 'us' }, {}, otherWorkspace);
    expect(other.cache).toBe('miss');
    expect(fake.callCount).toBe(2);

    const estimate = await gw.estimate({
      workspaceId: workspace,
      port: 'KeywordData',
      operation: 'metrics',
      request: { keywords: ['cached'], market: 'us' },
      caller: { type: 'person', id: 'user-1' },
      purpose: 'test',
      providerId: id,
    });
    expect(estimate.cached).toBe(true);

    // Google data is keyed by its property: the same request under another property is a miss.
    const gscId = providerId('gsc');
    const gsc = fakeAdapter({ id: gscId, ports: ['SearchConsole'], estimateMicros: 500, actualMicros: 500 });
    const gscGateway = gateway([gsc]);
    await gscGateway.setBudget({ workspaceId: workspace, providerId: gscId, currency: 'USD', budgetMicros: 100_000 });
    const search = {
      property: 'sc-domain:example.com',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      dimensions: ['query'],
    };
    const gscCall = (propertyKey: string) =>
      gscGateway.call({
        workspaceId: workspace,
        port: 'SearchConsole',
        operation: 'searchAnalytics',
        request: search,
        propertyKey,
        caller: { type: 'person', id: 'user-1' },
        purpose: 'test',
        providerId: gscId,
      });
    await gscCall('sc-domain:example.com');
    const sameProperty = await gscCall('sc-domain:example.com');
    expect(sameProperty.cache).toBe('hit');
    const otherProperty = await gscCall('sc-domain:other.com');
    expect(otherProperty.cache).toBe('miss');
    expect(gsc.callCount).toBe(2);
  });

  it('returns an estimate without creating a call or spending', async () => {
    const id = providerId('estimate');
    const fake = fakeAdapter({ id, ports: ['KeywordData'], estimateMicros: 3_000, actualMicros: 3_000 });
    const gw = gateway([fake]);

    const estimate = await call(gw, id, { keywords: ['estimate'], market: 'us' }, { estimate: true });
    expect(estimate).toMatchObject({ providerId: id, maxCostMicros: 3_000, currency: 'USD', cached: false });
    const calls = await db.admin.query<{ count: string }>('SELECT count(*)::text AS count FROM provider_calls WHERE provider_id = $1', [
      id,
    ]);
    expect(Number(calls.rows[0]?.count)).toBe(0);
    expect(await budgetOf(gw, id)).toBeUndefined();
  });

  it('names the key that unlocks a port when no adapter is configured', async () => {
    const id = providerId('keyword-only');
    const gw = gateway([fakeAdapter({ id, ports: ['KeywordData'] })]);
    const error = await gw
      .call({
        workspaceId: workspace,
        port: 'SerpData',
        operation: 'organic',
        request: { query: 'example', market: 'us' },
        caller: { type: 'person', id: 'user-1' },
        purpose: 'test',
      })
      .catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/DataForSEO API key/);
    expect((error as Error).message).toMatch(/Settings/);
    expect((error as { details?: unknown }).details).toMatchObject({ port: 'SerpData', key: 'dataforseo.login' });
  });

  it('refuses a call that exceeds the budget and says who can raise it', async () => {
    const id = providerId('exhausted');
    const fake = fakeAdapter({ id, ports: ['KeywordData'], estimateMicros: 2_000, actualMicros: 2_000 });
    const gw = gateway([fake]);
    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 1_000 });

    const error = await call(gw, id, { keywords: ['too expensive'], market: 'us' }).catch((err) => err);
    expect(error).toBeInstanceOf(ProviderBudgetError);
    expect((error as Error).message).toMatch(new RegExp(`The ${id} monthly budget`));
    expect((error as Error).message).toMatch(/workspace admin/);
    const calls = await db.admin.query<{ count: string }>('SELECT count(*)::text AS count FROM provider_calls WHERE provider_id = $1', [
      id,
    ]);
    expect(Number(calls.rows[0]?.count)).toBe(0);
  });

  it('releases a hold that was abandoned before submission', async () => {
    const id = providerId('abandoned');
    const gw = gateway([fakeAdapter({ id, ports: ['KeywordData'] })]);
    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 10_000 });
    const period = gw.currentPeriod();
    const callId = randomUUID();
    await db.admin.query(
      `INSERT INTO provider_calls (id, workspace_id, idempotency_key, caller_type, caller_id, purpose, provider_id, port, operation,
         request_hash, cache_key, max_cost_micros, reserved_micros, currency, budget_period, state)
       VALUES ($1, $2, 'abandoned-key', 'person', 'user-1', 'test', $3, 'KeywordData', 'metrics', 'hash', 'cache', 1000, 1000, 'USD', $4, 'pending')`,
      [callId, workspace, id, period],
    );
    await db.admin.query(
      `UPDATE provider_budgets SET held_micros = held_micros + 1000 WHERE workspace_id = $1 AND provider_id = $2 AND period = $3`,
      [workspace, id, period],
    );
    await db.admin.query(
      `UPDATE provider_calls SET created_at = now() - interval '2 hours', updated_at = now() - interval '2 hours' WHERE id = $1`,
      [callId],
    );
    expect((await budgetOf(gw, id))?.heldMicros).toBe(1_000);

    const result = await gw.reconcileAbandoned({ olderThanMinutes: 60 });
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(await budgetOf(gw, id)).toMatchObject({ spentMicros: 0, heldMicros: 0 });
    const row = await db.admin.query<{ state: string }>('SELECT state FROM provider_calls WHERE id = $1', [callId]);
    expect(row.rows[0]?.state).toBe('failed');
  });

  it('enforces a token bucket per provider and credential before holding budget', async () => {
    const id = providerId('rate');
    const fake = fakeAdapter({
      id,
      ports: ['KeywordData'],
      estimateMicros: 1_000,
      actualMicros: 1_000,
      rateLimit: { capacity: 1, refillPerSecond: 0 },
    });
    const gw = gateway([fake]);
    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 100_000 });

    await call(gw, id, { keywords: ['rate-1'], market: 'us' });
    const error = await call(gw, id, { keywords: ['rate-2'], market: 'us' }).catch((err) => err);
    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(fake.callCount).toBe(1);
    expect(await budgetOf(gw, id)).toMatchObject({ spentMicros: 1_000, heldMicros: 0 });
  });

  it('announces the 50, 80 and 100% budget thresholds once each', async () => {
    const id = providerId('thresholds');
    const cost = (_operation: string, request: unknown) => {
      const keywords = (request as { keywords?: string[] }).keywords ?? [];
      return keywords[0] === 't1' ? 6_000 : 2_000;
    };
    const fake = fakeAdapter({ id, ports: ['KeywordData'], estimateMicros: cost, actualMicros: cost });
    const events: BudgetThresholdEvent[] = [];
    const gw = createProviderGateway({
      db,
      adapters: [fake],
      onBudgetThreshold: (event) => {
        events.push(event);
      },
    });
    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 10_000 });

    await call(gw, id, { keywords: ['t1'], market: 'us' });
    await call(gw, id, { keywords: ['t2'], market: 'us' });
    await call(gw, id, { keywords: ['t3'], market: 'us' });

    expect(events.map((event) => event.threshold)).toEqual([50, 80, 100]);
    expect(events[2]).toMatchObject({
      providerId: id,
      period: gw.currentPeriod(),
      budgetMicros: 10_000,
      spentMicros: 10_000,
      currency: 'USD',
    });
  });

  it('purges raw provider responses after their seven-day window', async () => {
    const id = providerId('raw');
    const fake = fakeAdapter({ id, ports: ['KeywordData'], estimateMicros: 1_000, actualMicros: 1_000 });
    const gw = gateway([fake]);
    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 10_000 });
    await call(gw, id, { keywords: ['raw'], market: 'us' });

    const before = await db.admin.query<{ present: boolean }>(
      `SELECT raw_response IS NOT NULL AS present FROM provider_calls WHERE provider_id = $1`,
      [id],
    );
    expect(before.rows[0]?.present).toBe(true);
    const purged = await gw.purgeRawResponses(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
    expect(purged).toBeGreaterThanOrEqual(1);
    const after = await db.admin.query<{ present: boolean }>(
      `SELECT raw_response IS NOT NULL AS present FROM provider_calls WHERE provider_id = $1`,
      [id],
    );
    expect(after.rows[0]?.present).toBe(false);
  });
});
