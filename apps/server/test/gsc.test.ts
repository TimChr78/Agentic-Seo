import { agentPrincipal } from '@agentic-seo/commands';
import { gscConnect } from '@agentic-seo/search-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// The Search Console surface at the server's own entry points: the executor refuses an agent's
// connect (a people-only settings change), the callback route answers without a real Google, and
// the setup checklist counts a search connection only when it is active and has a property.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';

beforeAll(async () => {
  t = await startTestServer('gsc', testPort(2542), {
    GOOGLE_OAUTH_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  });
  owner = await t.signUp(`gsc-owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
});

afterAll(async () => {
  await t?.close();
});

describe('Search Console over the command surface', () => {
  it('refuses an agent running search.gsc.connect', async () => {
    const api = t.api(owner, ws);
    const { site } = await api.call('sites.create', { name: 'GSC site', domain: 'gsc.example' });
    const agent = agentPrincipal(
      { id: 'agent_gsc', name: 'Agent', status: 'active', statusReason: null },
      owner.id,
      'client_gsc',
      ws,
      'owner',
      ['sites:read', 'sites:write', 'workspace:admin'],
    );
    await expect(t.srv.executor.execute(gscConnect, { siteId: site.id }, agent, { surface: 'internal' })).rejects.toThrow(
      /can only be run by a person/,
    );
  });

  it('returns the Google authorize URL to a person and refuses a second step before authorization', async () => {
    const api = t.api(owner, ws);
    const { site } = await api.call('sites.create', { name: 'Authorize site', domain: 'authorize.example' });
    const started = await api.call('search.gsc.connect', { siteId: site.id });
    const authorize = new URL(started.url);
    expect(authorize.origin + authorize.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(authorize.searchParams.get('client_id')).toBe('client-id.apps.googleusercontent.com');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${t.base}/oauth/callback`);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(started.redirectUri).toBe(`${t.base}/oauth/callback`);

    // Connecting again reuses the connection: one live row per site and connector.
    const again = await api.call('search.gsc.connect', { siteId: site.id });
    expect(again.connectionId).toBe(started.connectionId);
    const count = await t.srv.db.admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM connections WHERE workspace_id = $1 AND site_id = $2',
      [ws, site.id],
    );
    expect(count.rows[0]?.n).toBe('1');

    // The authorization is pending, so reading or syncing says what to do instead of calling Google.
    await expect(api.call('search.gsc.select', { siteId: site.id, property: 'sc-domain:authorize.example' })).rejects.toThrow(
      /has not finished authorizing/,
    );
    await expect(api.call('search.gsc.sync', { siteId: site.id })).rejects.toThrow(/has not finished authorizing/);
  });

  it('reports no connection on a fresh site', async () => {
    const api = t.api(owner, ws);
    const { site } = await api.call('sites.create', { name: 'Fresh site', domain: 'fresh.example' });
    await expect(api.call('search.gsc.status', { siteId: site.id })).resolves.toEqual({
      connection: null,
      property: null,
      datasets: [],
    });
  });

  it('shows the checklist item only for an active connection with a property', async () => {
    const api = t.api(owner, ws);
    const { site } = await api.call('sites.create', { name: 'Checklist site', domain: 'checklist.example' });
    expect((await api.call('sites.checklist', { siteId: site.id })).searchConsole).toBe(false);

    await t.srv.db.admin.query(
      `INSERT INTO connections (workspace_id, id, site_id, connector, label, settings, state)
       VALUES ($1, $2, $3, 'google-search-console', 'Google Search Console', '{}'::jsonb, 'active')`,
      [ws, `con_${'b'.repeat(32)}`, site.id],
    );
    // Active but no property selected: the sync has nothing to read.
    expect((await api.call('sites.checklist', { siteId: site.id })).searchConsole).toBe(false);

    await t.srv.db.admin.query(`UPDATE connections SET settings = $1::jsonb WHERE workspace_id = $2 AND id = $3`, [
      JSON.stringify({ property: 'sc-domain:checklist.example' }),
      ws,
      `con_${'b'.repeat(32)}`,
    ]);
    expect((await api.call('sites.checklist', { siteId: site.id })).searchConsole).toBe(true);
  });

  it('answers the OAuth callback without a state, and with an unknown one', async () => {
    const missing = await fetch(`${t.base}/oauth/callback`);
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain('Start connecting again');

    const unknown = await fetch(`${t.base}/oauth/callback?state=not-a-state&code=x`);
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain('Not connected');
  });
});
