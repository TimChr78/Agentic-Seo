import { createDb, type Db } from '@agentic-seo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import type { AdapterCallContext } from '../src';
import { createProviderGateway, ProviderCallError } from '../src';
import { createGoogleSearchConsoleAdapter } from '../src/adapters/google-search-console';

// The GSC adapter's contract: the request shape Google expects, the mapping to the SearchConsole
// port, pagination by startRow, the provisional/final flag, and (through a real gateway and
// database) a cache key that never lets one property's data answer another's question. No test
// reaches the internet: the `request` option is the seam.

const NOW = new Date('2026-11-15T12:00:00Z');

function ctx(overrides: Partial<AdapterCallContext> = {}, options: Record<string, unknown> = {}): AdapterCallContext {
  return {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    callId: 'call-1',
    idempotencyKey: 'idem-1',
    port: 'SearchConsole',
    operation: 'searchAnalytics',
    credentialKey: 'con_0123456789abcdef0123456789abcdef',
    propertyKey: 'sc-domain:example.com',
    market: '',
    options,
    onSubmitted: async () => undefined,
    ...overrides,
  };
}

const limits = { maxCostMicros: 0, currency: 'USD' };

interface Recorded {
  url: string;
  body: Record<string, unknown> | null;
}

function scripted(responses: (body: Record<string, unknown>) => unknown) {
  const calls: Recorded[] = [];
  const request = async (url: string, init: RequestInit): Promise<Response> => {
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url, body });
    return new Response(JSON.stringify(responses(body ?? {})), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, request };
}

const row = (keys: string[], clicks: number) => ({ keys, clicks, impressions: clicks * 10, ctr: 0.1, position: 4 });

describe('the Google Search Console adapter', () => {
  it('asks for fresh data with the caller’s aggregation and maps the rows', async () => {
    const script = scripted(() => ({ rows: [row(['2026-11-01'], 7)] }));
    const adapter = createGoogleSearchConsoleAdapter({
      accessToken: async () => 'token',
      request: script.request,
      now: () => NOW,
    });
    const result = (await adapter.call(
      'searchAnalytics',
      {
        property: 'sc-domain:example.com',
        startDate: '2026-11-01',
        endDate: '2026-11-01',
        dimensions: ['date'],
        rowLimit: 1_000,
        searchType: 'web',
      },
      ctx({}, { aggregationType: 'byProperty' }),
      limits,
    )) as { data: { rows: unknown[]; finality: string; coverage: null } };

    expect(script.calls[0]?.url).toContain('/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query');
    expect(script.calls[0]?.body).toMatchObject({
      startDate: '2026-11-01',
      endDate: '2026-11-01',
      dimensions: ['date'],
      type: 'web',
      aggregationType: 'byProperty',
      dataState: 'all',
      rowLimit: 1_000,
      startRow: 0,
    });
    expect(result.data.rows).toEqual([{ keys: ['2026-11-01'], clicks: 7, impressions: 70, ctr: 0.1, position: 4 }]);
    expect(result.data.finality).toBe('final');
    expect(result.data.coverage).toBeNull();
  });

  it('paginates with startRow until a short page', async () => {
    const pages: Record<string, unknown>[] = [{ rows: [row(['a'], 1), row(['b'], 2)] }, { rows: [row(['c'], 3)] }];
    const script = scripted((body) => pages[Number(body.startRow ?? 0) === 0 ? 0 : 1]);
    const adapter = createGoogleSearchConsoleAdapter({ accessToken: async () => 'token', request: script.request, now: () => NOW });
    const result = (await adapter.call(
      'searchAnalytics',
      {
        property: 'https://example.com/',
        startDate: '2026-10-01',
        endDate: '2026-10-30',
        dimensions: ['date', 'page'],
        rowLimit: 2,
        searchType: 'web',
      },
      ctx({}, { aggregationType: 'byPage' }),
      limits,
    )) as { data: { rows: unknown[] } };

    expect(script.calls.map((call) => call.body?.startRow)).toEqual([0, 2]);
    expect(result.data.rows).toHaveLength(3);
  });

  it('marks a window that ends within three days as provisional and an older one as final', async () => {
    const script = scripted(() => ({ rows: [row(['2026-11-15'], 1)] }));
    const adapter = createGoogleSearchConsoleAdapter({ accessToken: async () => 'token', request: script.request, now: () => NOW });
    const ask = async (endDate: string) =>
      (await adapter.call(
        'searchAnalytics',
        { property: 'sc-domain:example.com', startDate: endDate, endDate, dimensions: ['date'], rowLimit: 10, searchType: 'web' },
        ctx(),
        limits,
      )) as { data: { finality: string } };
    expect((await ask('2026-11-15')).data.finality).toBe('provisional');
    expect((await ask('2026-11-13')).data.finality).toBe('provisional');
    expect((await ask('2026-11-12')).data.finality).toBe('final');
    expect((await ask('2026-11-11')).data.finality).toBe('final');
  });

  it('lists the properties the grant can read', async () => {
    const script = scripted(() => ({
      siteEntry: [
        { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
        { siteUrl: 'https://example.com/blog/', permissionLevel: 'siteRestrictedUser' },
      ],
    }));
    const adapter = createGoogleSearchConsoleAdapter({ accessToken: async () => 'token', request: script.request });
    const result = (await adapter.call('sites', {}, ctx({ operation: 'sites' }), limits)) as {
      data: { sites: { siteUrl: string; permissionLevel: string }[] };
    };
    expect(script.calls[0]?.url).toBe('https://www.googleapis.com/webmasters/v3/sites');
    expect(result.data.sites).toEqual([
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
      { siteUrl: 'https://example.com/blog/', permissionLevel: 'siteRestrictedUser' },
    ]);
  });

  it('turns a revoked grant into an actionable message, never echoing the token', async () => {
    const adapter = createGoogleSearchConsoleAdapter({
      accessToken: async () => 'secret-token',
      request: async () =>
        new Response(JSON.stringify({ error: { message: 'Request had insufficient authentication scopes.' } }), { status: 403 }),
    });
    const failure = await adapter.call('sites', {}, ctx({ operation: 'sites' }), limits).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderCallError);
    expect((failure as Error).message).toMatch(/reconnect it with search\.gsc\.connect/);
    expect((failure as Error).message).not.toContain('secret-token');
  });

  it('is free', () => {
    const adapter = createGoogleSearchConsoleAdapter({ accessToken: async () => 'token' });
    expect(adapter.estimate('sites', {})).toMatchObject({ maxCostMicros: 0, currency: 'USD' });
  });
});

describe.skipIf(!hasTestDatabase())('the GSC cache key', () => {
  let disposable: Awaited<ReturnType<typeof createDisposableDb>>;
  let db: Db;
  let requests = 0;

  beforeAll(async () => {
    disposable = await createDisposableDb('gscadapter');
    const appUrl = new URL(disposable.url.toString());
    appUrl.username = APP_ROLE.appRole;
    appUrl.password = APP_ROLE.appRolePassword;
    db = createDb({ adminUrl: disposable.url.toString(), appUrl: appUrl.toString(), poolSize: 4 });
  });

  afterAll(async () => {
    await db?.close();
    await disposable?.close();
  });

  it('never serves one property’s rows for another property', async () => {
    const adapter = createGoogleSearchConsoleAdapter({
      accessToken: async () => 'token',
      request: async () => {
        requests += 1;
        return new Response(JSON.stringify({ siteEntry: [{ siteUrl: `sc-domain:${requests}.example`, permissionLevel: 'siteOwner' }] }), {
          status: 200,
        });
      },
    });
    const gateway = createProviderGateway({ db, adapters: [adapter] });
    const list = (propertyKey: string) =>
      gateway.call({
        workspaceId: disposable.workspace,
        port: 'SearchConsole',
        operation: 'sites',
        request: {},
        caller: { type: 'person', id: 'user_test' },
        purpose: 'cache-key test',
        credentialKey: 'con_0123456789abcdef0123456789abcdef',
        propertyKey,
      });

    await list('sc-domain:one.example');
    await list('sc-domain:two.example');
    // The same property again is a cache hit: the gateway answers it without another provider call.
    const again = await list('sc-domain:one.example');
    expect(requests).toBe(2);
    expect(again.cache).toBe('hit');
  });
});
