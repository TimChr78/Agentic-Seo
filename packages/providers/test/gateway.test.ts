import { randomUUID } from 'node:crypto';
import { createDb, type Db, type Tx } from '@agentic-seo/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import {
  type BudgetThresholdEvent,
  type CallOverrunEvent,
  createProviderGateway,
  defineAdapter,
  fakeAdapter,
  type ProviderAdapter,
  ProviderBudgetError,
  ProviderCallUnknownError,
  ProviderCostError,
  type ProviderGateway,
  ProviderRateLimitError,
  ProviderTimeoutError,
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

/** A promise a test resolves by hand, to hold an adapter inside the gateway at an exact point. */
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

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
    expect(result.released).toBeGreaterThanOrEqual(1);
    expect(await budgetOf(gw, id)).toMatchObject({ spentMicros: 0, heldMicros: 0 });
    const row = await db.admin.query<{ state: string }>('SELECT state FROM provider_calls WHERE id = $1', [callId]);
    expect(row.rows[0]?.state).toBe('released');
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

  it('refuses an authorised ceiling below the adapter estimate instead of holding nothing', async () => {
    const id = providerId('ceiling-refused');
    const fake = fakeAdapter({ id, ports: ['KeywordData'], estimateMicros: 1_000, actualMicros: 1_000 });
    const gw = gateway([fake]);
    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 1_000 });

    // The probe from the review: a zero ceiling used to reserve nothing, so twenty calls ran and
    // spent 20,000 against a 1,000 budget. A ceiling below the bounded estimate is not a discount.
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => call(gw, id, { keywords: [`ceiling-${i}`], market: 'us' }, { maxCostMicros: 0 })),
    );
    for (const attempt of attempts) {
      expect(attempt.status).toBe('rejected');
      const reason = (attempt as PromiseRejectedResult).reason as Error;
      expect(reason).toBeInstanceOf(ProviderCostError);
      expect(reason.message).toMatch(/ceiling/i);
    }
    expect(fake.callCount).toBe(0);
    expect(await budgetOf(gw, id)).toMatchObject({ spentMicros: 0, heldMicros: 0 });
  });

  it('holds the larger of the caller ceiling and the estimate, and passes the ceiling to the adapter', async () => {
    const id = providerId('ceiling-hold');
    const started = deferred();
    const hold = deferred();
    const fake = fakeAdapter({
      id,
      ports: ['KeywordData'],
      estimateMicros: 1_000,
      actualMicros: 1_000,
      holdBeforeSubmit: async () => {
        started.resolve();
        await hold.promise;
      },
    });
    const gw = gateway([fake]);
    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 6_000 });

    const first = call(gw, id, { keywords: ['ceiling-hold-1'], market: 'us' }, { maxCostMicros: 5_000 });
    await started.promise;
    expect(await budgetOf(gw, id)).toMatchObject({ heldMicros: 5_000 });

    // The caller's ceiling is held, not the smaller estimate, so this call cannot fit.
    const blocked = await call(gw, id, { keywords: ['ceiling-hold-2'], market: 'us' }, { maxCostMicros: 5_000 }).catch((err) => err);
    expect(blocked).toBeInstanceOf(ProviderBudgetError);

    hold.resolve();
    const settled = await first;
    expect(settled.actualCostMicros).toBe(1_000);
    expect(fake.ceilings).toEqual([5_000]);

    const again = await call(gw, id, { keywords: ['ceiling-hold-3'], market: 'us' }, { maxCostMicros: 5_000 });
    expect(again.actualCostMicros).toBe(1_000);
    expect(await budgetOf(gw, id)).toMatchObject({ spentMicros: 2_000, heldMicros: 0, remainingMicros: 4_000 });
  });

  it('records an overrun and alerts when the provider charges above the hold', async () => {
    const id = providerId('overrun');
    const fake = fakeAdapter({ id, ports: ['KeywordData'], estimateMicros: 1_000, actualMicros: 3_000 });
    const events: CallOverrunEvent[] = [];
    const gw = createProviderGateway({
      db,
      adapters: [fake],
      onCallOverrun: (event) => {
        events.push(event);
      },
    });
    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 10_000 });

    const result = await call(gw, id, { keywords: ['overrun'], market: 'us' });
    expect(result.actualCostMicros).toBe(3_000);
    expect(result.overrun).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      callId: result.callId,
      workspaceId: workspace,
      providerId: id,
      currency: 'USD',
      maxCostMicros: 1_000,
      actualCostMicros: 3_000,
      overrunMicros: 2_000,
    });
    expect(await budgetOf(gw, id)).toMatchObject({ spentMicros: 3_000, heldMicros: 0 });
    const row = await db.admin.query<{ overrun: boolean }>('SELECT overrun FROM provider_calls WHERE id = $1', [result.callId]);
    expect(row.rows[0]?.overrun).toBe(true);
  });

  it('never releases the hold of a call that is being dispatched', async () => {
    const id = providerId('dispatching');
    const started = deferred();
    const hold = deferred();
    const fake = fakeAdapter({
      id,
      ports: ['KeywordData'],
      estimateMicros: 1_000,
      actualMicros: 1_000,
      holdBeforeSubmit: async () => {
        started.resolve();
        await hold.promise;
      },
    });
    const gw = gateway([fake]);
    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 1_000 });

    const inFlight = call(gw, id, { keywords: ['live'], market: 'us' }, { idempotencyKey: 'live-key' });
    await started.promise;

    // Cleanup runs while the call is in flight. It must not release the hold: the provider may
    // still charge, and a second call spending that money would overspend the budget.
    await gw.reconcileAbandoned({ olderThanMinutes: 0 });
    const row = await db.admin.query<{ state: string }>('SELECT state FROM provider_calls WHERE idempotency_key = $1', ['live-key']);
    expect(row.rows[0]?.state).toBe('unknown');
    expect((await budgetOf(gw, id))?.heldMicros).toBe(1_000);

    const second = await call(gw, id, { keywords: ['intruder'], market: 'us' }).catch((err) => err);
    expect(second).toBeInstanceOf(ProviderBudgetError);

    hold.resolve();
    const result = await inFlight;
    expect(result.actualCostMicros).toBe(1_000);
    expect(await budgetOf(gw, id)).toMatchObject({ spentMicros: 1_000, heldMicros: 0, remainingMicros: 0 });
    const settledRow = await db.admin.query<{ state: string }>('SELECT state FROM provider_calls WHERE id = $1', [result.callId]);
    expect(settledRow.rows[0]?.state).toBe('settled');
  });

  it('reconciles a lost response that has no provider task id, charging once', async () => {
    const id = providerId('no-task-id');
    const fake = fakeAdapter({
      id,
      ports: ['KeywordData'],
      estimateMicros: 1_000,
      actualMicros: 1_000,
      timeoutAfterCharge: 1,
      taskId: () => undefined,
    });
    const gw = gateway([fake]);
    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 10_000 });

    const failure = await call(gw, id, { keywords: ['lost'], market: 'us' }, { idempotencyKey: 'lost-key' }).catch((err) => err);
    expect(failure).toBeInstanceOf(ProviderCallUnknownError);
    const unknown = failure as ProviderCallUnknownError;
    const row = await db.admin.query<{ provider_task_id: string | null; state: string }>(
      'SELECT provider_task_id, state FROM provider_calls WHERE id = $1',
      [unknown.callId],
    );
    expect(row.rows[0]).toMatchObject({ provider_task_id: null, state: 'unknown' });
    expect((await budgetOf(gw, id))?.heldMicros).toBe(1_000);

    // Reconciliation must work from the persisted call identity, without a task id.
    const reconciled = await gw.reconcileUnknown(unknown.callId);
    expect(reconciled.state).toBe('settled');
    expect(reconciled.actualCostMicros).toBe(1_000);
    expect(fake.reconcileRequests).toHaveLength(1);
    expect(fake.reconcileRequests[0]).toMatchObject({ callId: unknown.callId, idempotencyKey: 'lost-key' });
    expect(fake.reconcileRequests[0]?.providerTaskId).toBeUndefined();
    expect(await budgetOf(gw, id)).toMatchObject({ spentMicros: 1_000, heldMicros: 0 });
  });

  it('reconciles a call that crashed while submitting, without charging twice', async () => {
    const id = providerId('crash-submit');
    const started = deferred();
    const hold = deferred();
    const fake = fakeAdapter({
      id,
      ports: ['KeywordData'],
      estimateMicros: 1_000,
      actualMicros: 1_000,
      taskId: () => undefined,
      holdAfterCharge: async () => {
        started.resolve();
        await hold.promise;
      },
    });
    const gw = gateway([fake]);
    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 10_000 });

    const inFlight = call(gw, id, { keywords: ['crash'], market: 'us' }, { idempotencyKey: 'crash-key' });
    await started.promise;
    const before = await db.admin.query<{ state: string; dispatched_at: Date | null }>(
      'SELECT state, dispatched_at FROM provider_calls WHERE idempotency_key = $1',
      ['crash-key'],
    );
    expect(before.rows[0]?.state).toBe('dispatching');
    expect(before.rows[0]?.dispatched_at).not.toBeNull();

    // The dispatching row has no outcome; reconciliation resolves it from the call identity.
    const cleanup = await gw.reconcileAbandoned({ olderThanMinutes: 0 });
    expect(cleanup.settled).toBeGreaterThanOrEqual(1);
    expect(await budgetOf(gw, id)).toMatchObject({ spentMicros: 1_000, heldMicros: 0 });

    hold.resolve();
    const result = await inFlight;
    expect(result.actualCostMicros).toBe(1_000);
    expect(await budgetOf(gw, id)).toMatchObject({ spentMicros: 1_000, heldMicros: 0 });
    const after = await db.admin.query<{ state: string }>('SELECT state FROM provider_calls WHERE id = $1', [result.callId]);
    expect(after.rows[0]?.state).toBe('settled');
  });

  it('keeps the hold and surfaces a call whose adapter cannot reconcile', async () => {
    const id = providerId('no-reconcile');
    const adapter = defineAdapter({
      id,
      ports: ['KeywordData'],
      estimate: () => ({ maxCostMicros: 1_000, currency: 'USD', basis: 'one bounded request' }),
      call: async () => {
        throw new ProviderTimeoutError('the provider did not answer');
      },
    });
    const gw = gateway([adapter]);
    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 10_000 });

    const failure = await call(gw, id, { keywords: ['unreconcilable'], market: 'us' }, { idempotencyKey: 'stuck-key' }).catch((err) => err);
    expect(failure).toBeInstanceOf(ProviderCallUnknownError);
    const callId = (failure as ProviderCallUnknownError).callId;

    const result = await gw.reconcileUnknown(callId);
    expect(result.state).toBe('unknown');
    expect(result.reason).toMatch(/cannot reconcile/i);
    expect((await budgetOf(gw, id))?.heldMicros).toBe(1_000);

    const unresolved = await gw.unresolved({ workspaceId: workspace });
    expect(unresolved).toContainEqual(
      expect.objectContaining({ callId, state: 'unknown', heldMicros: 1_000, providerId: id, currency: 'USD' }),
    );
  });

  it('refuses to change a budget currency once the period has spend', async () => {
    const id = providerId('currency-lock');
    const fake = fakeAdapter({ id, ports: ['KeywordData'], estimateMicros: 1_000, actualMicros: 1_000 });
    const gw = gateway([fake]);
    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 10_000 });
    await call(gw, id, { keywords: ['priced'], market: 'us' });

    const error = await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'EUR', budgetMicros: 10_000 }).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/USD/);
    expect((error as Error).message).toMatch(/cannot change|immutable/i);
    expect(await budgetOf(gw, id)).toMatchObject({ currency: 'USD', spentMicros: 1_000, budgetMicros: 10_000 });

    // Nothing was held or spent in a later period, so its currency is still free to choose.
    const next = await gw.setBudget({
      workspaceId: workspace,
      providerId: id,
      period: '2030-01',
      currency: 'EUR',
      budgetMicros: 5_000,
    });
    expect(next.currency).toBe('EUR');
  });

  it('marks a call unknown when the adapter reports a currency other than the reservation', async () => {
    const id = providerId('currency-mismatch');
    const fake = fakeAdapter({
      id,
      ports: ['KeywordData'],
      estimateMicros: 1_000,
      actualMicros: 1_000,
      resultCurrency: 'EUR',
    });
    const gw = gateway([fake]);
    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 10_000 });

    const failure = await call(gw, id, { keywords: ['currency'], market: 'us' }, { idempotencyKey: 'currency-key' }).catch((err) => err);
    expect(failure).toBeInstanceOf(ProviderCallUnknownError);
    expect((failure as Error).message).toMatch(/EUR/);
    expect((failure as Error).message).toMatch(/USD/);
    expect(await budgetOf(gw, id)).toMatchObject({ currency: 'USD', spentMicros: 0, heldMicros: 1_000 });
    const row = await db.admin.query<{ state: string; error: string | null }>(
      'SELECT state, error FROM provider_calls WHERE idempotency_key = $1',
      ['currency-key'],
    );
    expect(row.rows[0]?.state).toBe('unknown');
    expect(row.rows[0]?.error).toMatch(/EUR/);
  });

  it('refuses a concurrent budget creation that would relabel a period with activity', async () => {
    const id = providerId('currency-race');
    const fake = fakeAdapter({ id, ports: ['KeywordData'], estimateMicros: 100, actualMicros: 100 });
    const gw = gateway([fake]);

    // B reads "no budget", then stops between that read and its write. A whole budget is created
    // and spent in that window, so B's EUR upsert lands on a period holding USD.
    const read = deferred();
    const resume = deferred();
    const racer = db.withWorkspace(workspace, async (tx) => {
      let statements = 0;
      const paused = {
        execute: async (query: Parameters<Tx['execute']>[0]) => {
          const result = await tx.execute(query);
          statements += 1;
          if (statements === 1) {
            read.resolve();
            await resume.promise;
          }
          return result;
        },
      } as unknown as Tx;
      return gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'EUR', budgetMicros: 10_000, tx: paused });
    });
    await read.promise;

    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 10_000 });
    await call(gw, id, { keywords: ['relabel'], market: 'us' });
    expect(await budgetOf(gw, id)).toMatchObject({ currency: 'USD', spentMicros: 100 });

    resume.resolve();
    const error = await racer.then(
      () => null,
      (err) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/cannot change/i);
    expect((error as Error).message).toMatch(/EUR/);
    expect(await budgetOf(gw, id)).toMatchObject({ currency: 'USD', budgetMicros: 10_000, spentMicros: 100 });
  });

  it('validates the budget currency even when the estimate holds nothing', async () => {
    const id = providerId('zero-hold-currency');
    // A zero estimate used to skip the budget check entirely, so a later 100 settle was added to
    // whatever currency the budget happened to be in.
    const fake = fakeAdapter({ id, ports: ['KeywordData'], estimateMicros: 0, actualMicros: 100 });
    const gw = gateway([fake]);
    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'EUR', budgetMicros: 10_000 });

    const error = await call(gw, id, { keywords: ['free-looking'], market: 'us' }, { idempotencyKey: 'zero-hold-key' }).catch((err) => err);
    expect(error).toBeInstanceOf(ProviderBudgetError);
    expect((error as Error).message).toMatch(/EUR/);
    expect((error as Error).message).toMatch(/USD/);
    expect(fake.callCount).toBe(0);
    expect(await budgetOf(gw, id)).toMatchObject({ currency: 'EUR', spentMicros: 0, heldMicros: 0 });
    const calls = await db.admin.query<{ count: string }>('SELECT count(*)::text AS count FROM provider_calls WHERE provider_id = $1', [
      id,
    ]);
    expect(Number(calls.rows[0]?.count)).toBe(0);
  });

  it('keeps a zero-hold call unknown when the budget switches currency before settlement', async () => {
    const id = providerId('zero-hold-settlement');
    const started = deferred();
    const resume = deferred();
    const fake = fakeAdapter({
      id,
      ports: ['KeywordData'],
      estimateMicros: 0,
      actualMicros: 100,
      holdBeforeSubmit: async () => {
        started.resolve();
        await resume.promise;
      },
    });
    const gw = gateway([fake]);
    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 10_000 });

    const inFlight = call(gw, id, { keywords: ['late-currency'], market: 'us' }, { idempotencyKey: 'late-currency-key' });
    await started.promise;

    // With a zero hold the period has no activity, so its currency is still free to change.
    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'EUR', budgetMicros: 10_000 });
    resume.resolve();

    const failure = await inFlight.catch((err) => err);
    expect(failure).toBeInstanceOf(ProviderCallUnknownError);
    expect((failure as Error).message).toMatch(/EUR/);
    const row = await db.admin.query<{ state: string; error: string | null }>(
      'SELECT state, error FROM provider_calls WHERE idempotency_key = $1',
      ['late-currency-key'],
    );
    expect(row.rows[0]?.state).toBe('unknown');
    expect(row.rows[0]?.error).toMatch(/EUR/);
    expect(await budgetOf(gw, id)).toMatchObject({ currency: 'EUR', spentMicros: 0, heldMicros: 0 });
    expect(fake.callCount).toBe(1);
  });

  it('returns the persisted outcome from a reconciler that loses the settle transition', async () => {
    const id = providerId('reconcile-race');
    const seeded = fakeAdapter({ id, ports: ['KeywordData'], estimateMicros: 1_000, actualMicros: 1_000, timeoutAfterCharge: 1 });
    const seed = gateway([seeded]);
    await seed.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 10_000 });
    const failure = await call(seed, id, { keywords: ['race'], market: 'us' }, { idempotencyKey: 'race-key' }).catch((err) => err);
    expect(failure).toBeInstanceOf(ProviderCallUnknownError);
    const callId = (failure as ProviderCallUnknownError).callId;

    const metrics = {
      keywords: [
        {
          keyword: 'race',
          searchVolume: 1_000,
          cpcMicros: 120_000,
          difficulty: 35,
          intent: 'informational',
          trend: Array.from({ length: 12 }, (_, i) => 500 + i * 10),
          competition: 0.4,
        },
      ],
    };
    const bothInFlight = deferred();
    const settled = deferred();
    let reconciles = 0;
    const reachTransition = async () => {
      reconciles += 1;
      if (reconciles === 2) bothInFlight.resolve();
      await bothInFlight.promise;
    };
    const reconciler = (outcome: 'settled' | 'failed') =>
      defineAdapter({
        id,
        ports: ['KeywordData'] as const,
        estimate: () => ({ maxCostMicros: 1_000, currency: 'USD', basis: 'one bounded request' }),
        call: async () => {
          throw new ProviderTimeoutError('reconciliation does not call the provider');
        },
        reconcile: async () => {
          await reachTransition();
          if (outcome === 'failed') await settled.promise;
          return outcome === 'settled'
            ? { state: 'settled' as const, actualCostMicros: 100, data: metrics, currency: 'USD' }
            : { state: 'failed' as const, error: 'the provider reports that the task failed' };
        },
      });
    const settledSide = createProviderGateway({ db, adapters: [reconciler('settled')] });
    const failedSide = createProviderGateway({ db, adapters: [reconciler('failed')] });

    const settling = settledSide.reconcileUnknown(callId);
    const failing = failedSide.reconcileUnknown(callId);
    await bothInFlight.promise;
    const settledResult = await settling;
    settled.resolve();
    const failedResult = await failing;

    // The failed transition lost the race, so it reports what was persisted, not its own outcome.
    expect(settledResult).toMatchObject({ callId, state: 'settled', actualCostMicros: 100 });
    expect(failedResult).toMatchObject({ callId, state: 'settled', actualCostMicros: 100 });
    expect(failedResult.overrun).toBeFalsy();
    expect(await budgetOf(seed, id)).toMatchObject({ spentMicros: 100, heldMicros: 0 });
    const row = await db.admin.query<{ state: string; actual_cost_micros: string }>(
      'SELECT state, actual_cost_micros::text AS actual_cost_micros FROM provider_calls WHERE id = $1',
      [callId],
    );
    expect(row.rows[0]).toMatchObject({ state: 'settled', actual_cost_micros: '100' });
  });

  it('reports the persisted cost, not its own, when a reconciler loses the settlement', async () => {
    const id = providerId('reconcile-cost-race');
    const seeded = fakeAdapter({ id, ports: ['KeywordData'], estimateMicros: 1_000, actualMicros: 1_000, timeoutAfterCharge: 1 });
    const seed = gateway([seeded]);
    await seed.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 10_000 });
    const failure = await call(seed, id, { keywords: ['cost-race'], market: 'us' }, { idempotencyKey: 'cost-race-key' }).catch(
      (err) => err,
    );
    expect(failure).toBeInstanceOf(ProviderCallUnknownError);
    const callId = (failure as ProviderCallUnknownError).callId;

    const metrics = (keyword: string) => ({
      keywords: [
        {
          keyword,
          searchVolume: 1_000,
          cpcMicros: 120_000,
          difficulty: 35,
          intent: 'informational',
          trend: Array.from({ length: 12 }, (_, i) => 500 + i * 10),
          competition: 0.4,
        },
      ],
    });
    const bothInFlight = deferred();
    const settled = deferred();
    let reconciles = 0;
    const reachTransition = async () => {
      reconciles += 1;
      if (reconciles === 2) bothInFlight.resolve();
      await bothInFlight.promise;
    };
    const reconciler = (actualCostMicros: number, waitForSettlement: boolean) =>
      defineAdapter({
        id,
        ports: ['KeywordData'] as const,
        estimate: () => ({ maxCostMicros: 1_000, currency: 'USD', basis: 'one bounded request' }),
        call: async () => {
          throw new ProviderTimeoutError('reconciliation does not call the provider');
        },
        reconcile: async () => {
          await reachTransition();
          if (waitForSettlement) await settled.promise;
          return { state: 'settled' as const, actualCostMicros, data: metrics(`cost-${actualCostMicros}`), currency: 'USD' };
        },
      });
    const first = createProviderGateway({ db, adapters: [reconciler(100, false)] });
    const second = createProviderGateway({ db, adapters: [reconciler(200, true)] });

    const winning = first.reconcileUnknown(callId);
    const losing = second.reconcileUnknown(callId);
    await bothInFlight.promise;
    const winningResult = await winning;
    settled.resolve();
    const losingResult = await losing;

    expect(winningResult).toMatchObject({ callId, state: 'settled', actualCostMicros: 100 });
    expect(losingResult).toMatchObject({ callId, state: 'settled', actualCostMicros: 100 });
    expect(await budgetOf(seed, id)).toMatchObject({ spentMicros: 100, heldMicros: 0 });
  });

  it('purges raw responses per workspace through row-level-security-scoped transactions', async () => {
    const id = providerId('purge-scope');
    const fake = fakeAdapter({ id, ports: ['KeywordData'], estimateMicros: 1_000, actualMicros: 1_000 });
    const seen: { workspaceId: string; role: string }[] = [];
    const spy: Db = {
      ...db,
      withWorkspace: async (workspaceId, fn, opts) =>
        db.withWorkspace(
          workspaceId,
          async (tx) => {
            const { rows } = await tx.execute<{ role: string }>(sql`SELECT current_user AS role`);
            seen.push({ workspaceId, role: rows[0]?.role ?? '' });
            return fn(tx);
          },
          opts,
        ),
    };
    const gw = createProviderGateway({ db: spy, adapters: [fake] });
    await gw.setBudget({ workspaceId: workspace, providerId: id, currency: 'USD', budgetMicros: 10_000 });
    await gw.setBudget({ workspaceId: otherWorkspace, providerId: id, currency: 'USD', budgetMicros: 10_000 });
    await call(gw, id, { keywords: ['purge-scope-a'], market: 'us' });
    await call(gw, id, { keywords: ['purge-scope-b'], market: 'us' }, {}, otherWorkspace);

    seen.length = 0;
    const purged = await gw.purgeRawResponses(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
    expect(purged).toBeGreaterThanOrEqual(2);
    // Every purge transaction is scoped to one workspace and runs as the application role, so RLS
    // applies; the owner connection only discovers which workspaces have expired rows.
    expect(new Set(seen.map((entry) => entry.workspaceId))).toEqual(new Set([workspace, otherWorkspace]));
    expect(seen.every((entry) => entry.role === APP_ROLE.appRole)).toBe(true);
    const remaining = await db.admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM provider_calls WHERE provider_id = $1 AND raw_response IS NOT NULL',
      [id],
    );
    expect(Number(remaining.rows[0]?.n)).toBe(0);
  });
});
