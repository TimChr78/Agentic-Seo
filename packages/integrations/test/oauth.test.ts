import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, type Db, schema } from '@agentic-seo/db';
import { localKeyProvider } from '@agentic-seo/secrets';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import {
  accessTokenForConnection,
  beginAuthorization,
  completeAuthorization,
  connectionForSite,
  connectionSecrets,
  connectionView,
  GSC_CONNECTOR_ID,
  type HttpClient,
  type OAuthDeps,
  REFRESH_REFUSED,
  refreshConnection,
} from '../src';

// OAuth 2.0 at its entry points: the authorize URL (PKCE and the hashed state), the callback (state
// round trip, replay and expiry refusal), the sealed tokens, and the refresh lease. The token
// endpoint is the `http` seam, so no test reaches Google.

const PUBLIC_URL = 'https://seo.example.com';
const CLIENT = { clientId: 'client-id.apps.googleusercontent.com', clientSecret: 'client-secret' };

describe.skipIf(!hasTestDatabase())('OAuth 2.0 for Search Console', () => {
  let disposable: Awaited<ReturnType<typeof createDisposableDb>>;
  let db: Db;
  let kp: ReturnType<typeof localKeyProvider>;
  let siteId: string;

  beforeAll(async () => {
    disposable = await createDisposableDb('intoauth');
    const appUrl = new URL(disposable.url.toString());
    appUrl.username = APP_ROLE.appRole;
    appUrl.password = APP_ROLE.appRolePassword;
    db = createDb({ adminUrl: disposable.url.toString(), appUrl: appUrl.toString(), poolSize: 6 });
    kp = localKeyProvider(randomBytes(32).toString('base64'));
    siteId = randomUUID();
    await db.admin.query(
      `INSERT INTO sites (workspace_id, id, name, primary_domain, verification_token)
       VALUES ($1, $2, 'Example', 'example.com', 'verify-token')`,
      [disposable.workspace, siteId],
    );
  });

  afterAll(async () => {
    await db?.close();
    await disposable?.close();
  });

  const deps = (overrides: Partial<OAuthDeps> = {}): OAuthDeps => ({
    db,
    kp,
    client: CLIENT,
    publicUrl: PUBLIC_URL,
    ...overrides,
  });

  /** A token endpoint that answers by grant type and counts each exchange. */
  function google(options: { failRefresh?: boolean } = {}) {
    const grants: string[] = [];
    let access = 1;
    const http: HttpClient = async (_url, init) => {
      const params = new URLSearchParams(init.body ?? '');
      const grant = params.get('grant_type') ?? '';
      grants.push(grant);
      if (grant === 'refresh_token' && options.failRefresh)
        return { status: 400, body: JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) };
      access += 1;
      return {
        status: 200,
        body: JSON.stringify({
          access_token: `access-${access}`,
          refresh_token: `refresh-${access}`,
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      };
    };
    return { http, grants };
  }

  async function start(site = siteId) {
    return db.withWorkspace(disposable.workspace, async (tx) => {
      const row = await connectionForSite(tx, {
        workspaceId: disposable.workspace,
        siteId: site,
        connector: GSC_CONNECTOR_ID,
        label: 'Google Search Console',
      });
      const started = await beginAuthorization(tx, { row, kp, client: CLIENT, publicUrl: PUBLIC_URL });
      return { row, ...started };
    });
  }

  it('round-trips PKCE and the state, then seals the tokens', async () => {
    const { row, url, redirectUri } = await start();
    const authorize = new URL(url);
    expect(authorize.origin + authorize.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}/oauth/callback`);
    expect(redirectUri).toBe(`${PUBLIC_URL}/oauth/callback`);
    expect(authorize.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/webmasters.readonly');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize.searchParams.get('access_type')).toBe('offline');

    // The state in the URL is not stored as-is: only its hash is.
    const state = authorize.searchParams.get('state') ?? '';
    const pending = await db.admin.query<{ oauth_pending: { stateHash: string } }>(
      'SELECT oauth_pending FROM connections WHERE workspace_id = $1 AND id = $2',
      [disposable.workspace, row.id],
    );
    expect(pending.rows[0]?.oauth_pending.stateHash).not.toBe(state);
    expect(pending.rows[0]?.oauth_pending.stateHash).toMatch(/^[0-9a-f]{64}$/);

    const fake = google();
    const result = await completeAuthorization(deps({ http: fake.http }), { state, code: 'auth-code' });
    expect(result).toMatchObject({ ok: true });

    const stored = await db.admin.query<{ state: string; secrets: Buffer; token_expires_at: Date }>(
      'SELECT state, secrets, token_expires_at FROM connections WHERE workspace_id = $1 AND id = $2',
      [disposable.workspace, row.id],
    );
    expect(stored.rows[0]?.state).toBe('active');
    expect(stored.rows[0]?.token_expires_at.getTime()).toBeGreaterThan(Date.now());
    // Not readable in the column, but readable through the sealed accessor.
    expect(stored.rows[0]?.secrets.toString('utf8')).not.toContain('access-');
    const secrets = await db.withWorkspace(disposable.workspace, async (tx) => {
      const [connection] = await tx.select().from(schema.connections).where(eq(schema.connections.id, row.id));
      return connectionSecrets(tx, connection!, kp);
    });
    expect((secrets.__oauth as { accessToken?: string }).accessToken).toBe('access-2');

    // A replay of the same state finds it consumed.
    const replay = await completeAuthorization(deps({ http: fake.http }), { state, code: 'auth-code' });
    expect(replay.ok).toBe(false);
    expect(replay.text).toMatch(/expired/i);
  });

  it('refuses an expired state', async () => {
    const { url } = await start();
    const state = new URL(url).searchParams.get('state') ?? '';
    const later = new Date(Date.now() + 16 * 60_000);
    const result = await completeAuthorization(deps({ http: google().http, now: () => later }), { state, code: 'code' });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/expired/i);
  });

  it('refreshes before expiry under a lease, so two refreshers exchange once', async () => {
    const { row, url } = await start();
    const state = new URL(url).searchParams.get('state') ?? '';
    const first = google();
    await completeAuthorization(deps({ http: first.http }), { state, code: 'code' });

    await db.admin.query("UPDATE connections SET token_expires_at = now() - interval '1 minute' WHERE workspace_id = $1 AND id = $2", [
      disposable.workspace,
      row.id,
    ]);
    const second = google();
    const both = await Promise.all([
      refreshConnection(deps({ http: second.http }), { workspaceId: disposable.workspace, connectionId: row.id }),
      refreshConnection(deps({ http: second.http }), { workspaceId: disposable.workspace, connectionId: row.id }),
    ]);
    expect(second.grants.filter((grant) => grant === 'refresh_token')).toHaveLength(1);
    expect(both.filter((outcome) => outcome === 'refreshed')).toHaveLength(1);
    expect(both.filter((outcome) => outcome === 'skipped')).toHaveLength(1);

    const token = await accessTokenForConnection(deps({ http: second.http }), {
      workspaceId: disposable.workspace,
      connectionId: row.id,
    });
    expect(token).toMatch(/^access-/);
  });

  it('marks the connection error when Google refuses the refresh token', async () => {
    const { row, url } = await start();
    const state = new URL(url).searchParams.get('state') ?? '';
    await completeAuthorization(deps({ http: google().http }), { state, code: 'code' });
    await db.admin.query("UPDATE connections SET token_expires_at = now() - interval '1 minute' WHERE workspace_id = $1 AND id = $2", [
      disposable.workspace,
      row.id,
    ]);

    const outcome = await refreshConnection(deps({ http: google({ failRefresh: true }).http }), {
      workspaceId: disposable.workspace,
      connectionId: row.id,
      force: true,
    });
    expect(outcome).toBe('failed');
    const stored = await db.admin.query<{ state: string; last_error: string }>(
      'SELECT state, last_error FROM connections WHERE workspace_id = $1 AND id = $2',
      [disposable.workspace, row.id],
    );
    expect(stored.rows[0]).toEqual({ state: 'error', last_error: REFRESH_REFUSED });
    expect(REFRESH_REFUSED).toBe('Google refused the refresh token; reconnect Search Console');
  });

  it('keeps the sealed tokens out of the connection view', async () => {
    const { row, url } = await start();
    const state = new URL(url).searchParams.get('state') ?? '';
    await completeAuthorization(deps({ http: google().http }), { state, code: 'code' });
    const [connection] = await db.withWorkspace(disposable.workspace, (tx) =>
      tx.select().from(schema.connections).where(eq(schema.connections.id, row.id)),
    );
    const view = connectionView(connection!);
    expect(JSON.stringify(view)).not.toContain('access-');
    expect(Object.keys(view)).not.toContain('oauthPending');
  });
});
