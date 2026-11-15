import { randomBytes, randomUUID } from 'node:crypto';
import { type AnyCommand, createExecutor, userPrincipal } from '@agentic-seo/commands';
import { createDb, type Db } from '@agentic-seo/db';
import { accessTokenForConnection, type HttpClient, type OAuthDeps } from '@agentic-seo/integrations';
import type { ProviderCallInput, ProviderGateway } from '@agentic-seo/providers';
import { localKeyProvider } from '@agentic-seo/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import {
  addDays,
  gscConnect,
  gscDisconnect,
  gscProperties,
  gscSelect,
  gscStatus,
  gscSync,
  runGscSync,
  searchPages,
  searchPerformance,
  today,
} from '../src';

// Every `search.*` command against a real Postgres, through the executor (the only surface a person,
// the UI or an agent reaches). The provider gateway is a fake, so no test reaches Google; the
// credential seam inside it is the real one, which is what proves the connection row is not locked
// across a provider call (a refresh would deadlock on it).

const NOW = new Date('2026-11-15T12:00:00Z');
const TODAY = today(NOW);
const CLIENT = { clientId: 'client-id.apps.googleusercontent.com', clientSecret: 'client-secret' };
const PUBLIC_URL = 'https://seo.example.com';

const appUrl = (url: URL) => {
  const u = new URL(url.toString());
  u.username = APP_ROLE.appRole;
  u.password = APP_ROLE.appRolePassword;
  return u.toString();
};

interface Fake {
  gateway: ProviderGateway;
  calls: ProviderCallInput[];
}

function fakeGateway(
  answer: (call: ProviderCallInput) => unknown,
  options: { before?: (call: ProviderCallInput) => Promise<void>; properties?: string[] } = {},
): Fake {
  const calls: ProviderCallInput[] = [];
  const call = async (input: ProviderCallInput) => {
    calls.push(input);
    if (options.before) await options.before(input);
    const data =
      input.port === 'SearchConsole' && input.operation === 'sites'
        ? { sites: (options.properties ?? []).map((siteUrl) => ({ siteUrl, permissionLevel: 'siteOwner' })) }
        : answer(input);
    return {
      data,
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

const dayRows = (call: ProviderCallInput) => {
  const request = call.request as { startDate: string; endDate: string };
  const rows: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[] = [];
  for (let day = request.startDate; day <= request.endDate; day = addDays(day, 1))
    rows.push({ keys: [day], clicks: 1, impressions: 10, ctr: 0.1, position: 3 });
  return { rows, metadata: null, truncated: false, rowLimitReached: null };
};

describe.skipIf(!hasTestDatabase())('the Search Console commands', () => {
  let disposable: Awaited<ReturnType<typeof createDisposableDb>>;
  let db: Db;
  let kp: ReturnType<typeof localKeyProvider>;
  let executor: ReturnType<typeof createExecutor>;
  let queues: { identifier: string; payload: Record<string, unknown> }[];
  let revokes: string[];
  let oauthHttp: HttpClient;
  let provider: Fake;
  let principal: ReturnType<typeof userPrincipal>;
  let siteId: string;
  /** The site's own domain and the domain property that names it, unique per test. */
  let domain: string;
  let property: string;
  let properties: string[];

  // The real clock: `beginAuthorization` and the callback both run in this test, and the pending
  // state's 15-minute limit is measured against it.
  const oauthDeps = (): OAuthDeps => ({ db, kp, client: CLIENT, publicUrl: PUBLIC_URL, http: oauthHttp });

  const services = () => ({
    serverVersion: 'test',
    strictInputs: false,
    keyProvider: kp,
    publicUrl: PUBLIC_URL,
    googleOAuth: CLIENT,
    providers: provider.gateway,
    integrationHttp: async (): Promise<{ status: number; body: string }> => {
      revokes.push('revoke');
      return { status: 200, body: '{}' };
    },
    enqueueTask: async (identifier: string, payload: Record<string, unknown>) => {
      queues.push({ identifier, payload });
    },
  });

  const call = (command: AnyCommand, input: unknown) => executor.execute(command, input, principal, { surface: 'internal' });

  beforeAll(async () => {
    disposable = await createDisposableDb('searchcmds');
    db = createDb({ adminUrl: disposable.url.toString(), appUrl: appUrl(disposable.url), poolSize: 8 });
    kp = localKeyProvider(randomBytes(32).toString('base64'));
    oauthHttp = async (_url, init) => {
      const params = new URLSearchParams(init.body ?? '');
      if (params.get('grant_type') === 'refresh_token')
        return { status: 200, body: JSON.stringify({ access_token: 'refreshed-access', expires_in: 3600, token_type: 'Bearer' }) };
      return {
        status: 200,
        body: JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer' }),
      };
    };
    const userId = randomUUID();
    principal = userPrincipal(userId, disposable.workspace, 'owner');
  });

  afterAll(async () => {
    await db?.close();
    await disposable?.close();
  });

  /** A fresh site (its own domain, so `sites_active_domain` stays unique) and a fake provider. */
  async function setup(
    answer: Parameters<typeof fakeGateway>[0] = dayRows,
    extra: { before?: (call: ProviderCallInput) => Promise<void> } = {},
  ) {
    siteId = randomUUID();
    domain = `site${siteId.slice(0, 8)}.example`;
    property = `sc-domain:${domain}`;
    properties = [property, `https://${domain}/blog/`, 'sc-domain:other.example'];
    provider = fakeGateway(answer, { ...extra, properties });
    queues = [];
    revokes = [];
    executor = createExecutor(db, services());
    await db.admin.query(
      `INSERT INTO sites (workspace_id, id, name, primary_domain, verification_token)
       VALUES ($1, $2, 'Example', $3, 'verify-token')`,
      [disposable.workspace, siteId, domain],
    );
    return siteId;
  }

  /** Runs the connect → callback round trip so the site has an active, sealed connection. */
  async function connect(site = siteId) {
    const started = await call(gscConnect, { siteId: site });
    const state = new URL(started.url).searchParams.get('state') ?? '';
    const { completeAuthorization } = await import('@agentic-seo/integrations');
    const result = await completeAuthorization(oauthDeps(), { state, code: 'auth-code' });
    expect(result.ok).toBe(true);
    return started;
  }

  it('connects a site, lists the properties and marks the one that matches the site', async () => {
    await setup();
    const started = await connect();
    expect(new URL(started.url).searchParams.get('scope')).toBe('https://www.googleapis.com/auth/webmasters.readonly');

    const listed = await call(gscProperties, { siteId });
    expect(listed.connectionId).toBe(started.connectionId);
    expect(listed.selected).toBeNull();
    expect(listed.suggested).toBe(property);
    expect(
      listed.properties.map((entry: { property: string; matchesSite: boolean; kind: string }) => [
        entry.property,
        entry.matchesSite,
        entry.kind,
      ]),
    ).toEqual([
      [property, true, 'domain'],
      [`https://${domain}/blog/`, true, 'urlPrefix'],
      ['sc-domain:other.example', false, 'domain'],
    ]);
  });

  it('selects a property the account can read and refuses one it cannot', async () => {
    await setup();
    await connect();
    await expect(call(gscSelect, { siteId, property: 'sc-domain:not-mine.example' })).rejects.toThrow(
      /not a property this Google account can read/,
    );

    const selected = await call(gscSelect, { siteId, property });
    expect(selected.settings.property).toBe(property);
    // Choosing the same property again does not bump the generation (nothing changed).
    const generation = async () =>
      (
        await db.admin.query<{ generation: number }>('SELECT generation FROM connections WHERE workspace_id = $1 AND id = $2', [
          disposable.workspace,
          selected.id,
        ])
      ).rows[0]?.generation;
    const first = await generation();
    await call(gscSelect, { siteId, property });
    expect(await generation()).toBe(first);
    // A different property is a new meaning for the connection: the generation fences an old sync.
    await call(gscSelect, { siteId, property: properties[1]! });
    expect(await generation()).toBe((first ?? 0) + 1);

    const status = await call(gscStatus, { siteId });
    expect(status.property).toBe(properties[1]);
  });

  it('does not hold the connection row across a provider call, so an expiring token refreshes instead of deadlocking', async () => {
    // The fake gateway clocks the real credential seam, as the real adapter does: the token is
    // refreshed in its own transaction while the command is still running.
    await setup();
    await connect();
    // The access token expires now, so every provider call has to refresh it first.
    await db.admin.query("UPDATE connections SET token_expires_at = now() - interval '1 minute' WHERE workspace_id = $1", [
      disposable.workspace,
    ]);
    provider = fakeGateway(dayRows, {
      properties,
      before: (input) =>
        accessTokenForConnection(oauthDeps(), {
          workspaceId: disposable.workspace,
          connectionId: input.credentialKey ?? '',
        }).then(() => undefined),
    });
    executor = createExecutor(db, services());

    // Both commands that call Google must complete. With the row locked across the call, the refresh
    // waits for a lock the command is holding and Postgres aborts one side as a deadlock.
    await expect(call(gscProperties, { siteId })).resolves.toMatchObject({ connectionId: expect.any(String) });
    await expect(call(gscSelect, { siteId, property })).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('refuses a selection whose property list went stale while it loaded (review round 2)', async () => {
    // Selection A pauses in its property lookup while selection B commits another property; A must
    // not overwrite B. Then a re-authorization lands during A's lookup; A must not use the old list.
    let interleave: (() => Promise<unknown>) | null = null;
    await setup(dayRows, {
      before: async () => {
        const step = interleave;
        interleave = null;
        if (step) await step();
      },
    });
    await connect();
    const blog = `https://${domain}/blog/`;
    interleave = () => call(gscSelect, { siteId, property: blog });
    await expect(call(gscSelect, { siteId, property })).rejects.toThrow(/changed while the property list was loading/);
    expect((await call(gscStatus, { siteId })).connection).toMatchObject({ settings: { property: blog } });

    interleave = () => connect();
    await expect(call(gscSelect, { siteId, property })).rejects.toThrow(/changed while the property list was loading/);
    // With nothing in between, the same selection goes through.
    await expect(call(gscSelect, { siteId, property })).resolves.toMatchObject({ settings: { property } });
  });

  it('disconnects, then reads the replacement connection after reconnecting', async () => {
    await setup();
    const first = await connect();
    const disconnected = await call(gscDisconnect, { siteId });
    expect(disconnected).toEqual({ revoked: true, googleRevoked: true });
    expect(revokes).toHaveLength(1);

    // Nothing is connected: status says so and select refuses.
    expect((await call(gscStatus, { siteId })).connection).toBeNull();
    await expect(call(gscSelect, { siteId, property })).rejects.toThrow(/not connected/i);

    // Reconnecting makes a new row; the revoked history must never answer for it.
    const second = await connect();
    expect(second.connectionId).not.toBe(first.connectionId);
    const status = await call(gscStatus, { siteId });
    expect(status.connection).toMatchObject({ id: second.connectionId, state: 'active' });

    // Sync and select work on the replacement, and the sync's facts land under its property.
    await call(gscSelect, { siteId, property });
    await runGscSync({ db, providers: provider.gateway, now: () => NOW }, { workspaceId: disposable.workspace, siteId, maxChunks: 0 });
    const facts = await db.admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM gsc_property_totals WHERE workspace_id = $1 AND site_id = $2 AND property = $3',
      [disposable.workspace, siteId, property],
    );
    expect(Number(facts.rows[0]?.n)).toBeGreaterThan(0);
  });

  it('queues a sync once and refuses a second request within a minute', async () => {
    await setup();
    await connect();
    await call(gscSelect, { siteId, property });
    const queued = await call(gscSync, { siteId });
    expect(queued).toEqual({ enqueued: true, siteId });
    expect(queues).toEqual([{ identifier: 'gsc_sync', payload: { workspaceId: disposable.workspace, siteId } }]);

    await expect(call(gscSync, { siteId })).rejects.toThrow(/less than a minute ago/);
    expect(queues).toHaveLength(1);
  });

  it('reads daily totals and page aggregates from Postgres, with provisionalFrom', async () => {
    await setup();
    await connect();
    await call(gscSelect, { siteId, property });
    const { runGscSync: sync } = await import('../src');
    // A window Google still reports incomplete from yesterday: yesterday and today are provisional.
    await sync(
      {
        db,
        providers: fakeGateway((input) => ({
          ...dayRows(input),
          metadata: { firstIncompleteDate: addDays(TODAY, -1), firstIncompleteHour: null },
        })).gateway,
        now: () => NOW,
      },
      { workspaceId: disposable.workspace, siteId, dataset: 'property_totals', maxChunks: 0 },
    );
    // Page aggregates for the same days, one page per day.
    await sync(
      {
        db,
        providers: fakeGateway((input) => {
          const request = input.request as { startDate: string; endDate: string };
          const rows = [];
          for (let day = request.startDate; day <= request.endDate; day = addDays(day, 1))
            rows.push({ keys: [day, 'https://example.com/a/', '', ''], clicks: 2, impressions: 20, ctr: 0.1, position: 2 });
          return { rows, metadata: null, truncated: false, rowLimitReached: null };
        }).gateway,
        now: () => NOW,
      },
      { workspaceId: disposable.workspace, siteId, dataset: 'page_aggregates', maxChunks: 0 },
    );

    const performance = await call(searchPerformance, { siteId, startDate: addDays(TODAY, -4), endDate: TODAY });
    expect(performance.property).toBe(property);
    expect(performance.series).toHaveLength(5);
    expect(performance.totals).toEqual({ clicks: 5, impressions: 50, ctr: 0.1, position: 3 });
    expect(performance.provisionalFrom).toBe(addDays(TODAY, -1));

    const pages = await call(searchPages, { siteId, startDate: addDays(TODAY, -4), endDate: TODAY, limit: 2 });
    expect(pages.pages).toEqual([{ page: 'https://example.com/a', clicks: 10, impressions: 100, ctr: 0.1, position: 2 }]);
    expect(pages.nextCursor).toBeNull();
    expect(pages.provisionalFrom).toBeNull();
  });

  it('pages through the top pages with a cursor', async () => {
    await setup();
    await connect();
    await call(gscSelect, { siteId, property });
    // Ten pages on one day, written as the sync writes them.
    for (let i = 0; i < 10; i += 1)
      await db.admin.query(
        `INSERT INTO gsc_page_aggregates
           (workspace_id, site_id, property, date, search_type, page, page_key, country, device, clicks, impressions, ctr, position, is_final)
         VALUES ($1, $2, $3, $4, 'web', $5, $6, '', '', $7, $8, 0.1, 3, true)`,
        [
          disposable.workspace,
          siteId,
          property,
          addDays(TODAY, -1),
          `https://example.com/p${i}`,
          `https://example.com/p${i}`,
          i + 1,
          (i + 1) * 10,
        ],
      );
    const first = await call(searchPages, { siteId, startDate: addDays(TODAY, -2), endDate: TODAY, limit: 4 });
    expect(first.pages.map((page: { page: string }) => page.page)).toEqual([
      'https://example.com/p9',
      'https://example.com/p8',
      'https://example.com/p7',
      'https://example.com/p6',
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await call(searchPages, { siteId, startDate: addDays(TODAY, -2), endDate: TODAY, limit: 4, cursor: first.nextCursor });
    expect(second.pages.map((page: { page: string }) => page.page)).toEqual([
      'https://example.com/p5',
      'https://example.com/p4',
      'https://example.com/p3',
      'https://example.com/p2',
    ]);
  });

  it('stops a sync whose property changed mid-run, without writing the new property’s facts', async () => {
    await setup();
    await connect();
    await call(gscSelect, { siteId, property });

    // The fake pauses before the first window is stored, so the property can change underneath it.
    let release: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pausedOnce = false;
    provider = fakeGateway(dayRows, {
      properties,
      before: async () => {
        if (pausedOnce) return;
        pausedOnce = true;
        await paused;
      },
    });
    executor = createExecutor(db, services());
    const sync = runGscSync(
      { db, providers: provider.gateway, now: () => NOW },
      { workspaceId: disposable.workspace, siteId, maxChunks: 0 },
    );

    // Wait until the sync is inside its first provider call, then move the connection to another
    // property through the command a person would use.
    while (!pausedOnce) await new Promise((resolve) => setTimeout(resolve, 5));
    await call(gscSelect, { siteId, property: properties[1]! });
    release();

    await expect(sync).rejects.toThrow(/connection changed while its .* sync was running/);
    const newProperty = await db.admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM gsc_property_totals WHERE workspace_id = $1 AND site_id = $2 AND property = $3',
      [disposable.workspace, siteId, properties[1]!],
    );
    expect(newProperty.rows[0]?.n).toBe('0');
    // The new property inherits nothing: no coverage, no backfill progress, no final day. The old
    // run's failure is recorded against the property it was actually for, not this one.
    const status = await call(gscStatus, { siteId });
    expect(status.property).toBe(properties[1]);
    expect(status.datasets).toEqual([]);
  });
});
