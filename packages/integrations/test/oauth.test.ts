import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createDb, type Db, schema } from '@agentic-seo/db';
import { localKeyProvider } from '@agentic-seo/secrets';
import { and, eq } from 'drizzle-orm';
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
  revokedColumns,
} from '../src';

// OAuth 2.0 at its entry points: the authorize URL (PKCE and the hashed state), the callback (state
// round trip, replay, concurrency, staleness and expiry refusal), the sealed tokens, and the refresh
// lease. The token endpoint is the `http` seam, so no test reaches Google, and it verifies the PKCE
// verifier against the challenge the authorize URL carried: a dropped or mismatched verifier fails
// the exchange, exactly as Google refuses it.

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

  /** The `code_challenge` of the most recent authorize URL, for the fake token endpoint. */
  let challenge = '';

  /**
   * A token endpoint that answers by grant type, counts each exchange and checks the PKCE verifier:
   * `S256(verifier)` must equal the challenge the authorize URL carried, as Google checks it.
   */
  function google(options: { failRefresh?: boolean } = {}) {
    const grants: string[] = [];
    const pkce: boolean[] = [];
    let access = 1;
    const http: HttpClient = async (_url, init) => {
      const params = new URLSearchParams(init.body ?? '');
      const grant = params.get('grant_type') ?? '';
      grants.push(grant);
      if (grant === 'authorization_code') {
        const verifier = params.get('code_verifier') ?? '';
        const digest = createHash('sha256').update(verifier).digest('base64url');
        const ok = verifier.length > 0 && digest === challenge;
        pkce.push(ok);
        if (!ok)
          return {
            status: 400,
            body: JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE verification failed.' }),
          };
      }
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
    return { http, grants, pkce };
  }

  async function start(site = siteId) {
    const started = await db.withWorkspace(disposable.workspace, async (tx) => {
      const row = await connectionForSite(tx, {
        workspaceId: disposable.workspace,
        siteId: site,
        connector: GSC_CONNECTOR_ID,
        label: 'Google Search Console',
      });
      const began = await beginAuthorization(tx, { row, kp, client: CLIENT, publicUrl: PUBLIC_URL });
      return { row, ...began };
    });
    challenge = new URL(started.url).searchParams.get('code_challenge') ?? '';
    return started;
  }

  /** The connection's stored state and tokens, read with the owner pool (the test's own view). */
  async function connectionRow(connectionId: string) {
    const result = await db.admin.query<{ state: string; secrets: Buffer | null; generation: number }>(
      'SELECT state, secrets, generation FROM connections WHERE workspace_id = $1 AND id = $2',
      [disposable.workspace, connectionId],
    );
    return result.rows[0]!;
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
    // The exchange proved PKCE: the verifier's S256 digest is the challenge Google was given.
    expect(fake.pkce).toEqual([true]);

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

  it('takes the row lock before consuming the state, so two concurrent callbacks exchange once', async () => {
    const { row, url } = await start();
    const state = new URL(url).searchParams.get('state') ?? '';
    const fake = google();
    // Hold the connection row from outside, so the callback's validate-and-consume has to wait for
    // this transaction: that wait is the lock. Without it the callback reads the row straight away,
    // consumes the state and exchanges the code while the holder is still open.
    const holder = await db.admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM connections WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [disposable.workspace, row.id]);
      let settled = 0;
      const callbacks = [
        completeAuthorization(deps({ http: fake.http }), { state, code: 'first' }),
        completeAuthorization(deps({ http: fake.http }), { state, code: 'second' }),
      ].map(async (pending) => {
        const value = await pending;
        settled += 1;
        return { value };
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fake.grants).toHaveLength(0);
      expect(settled).toBe(0);
      await holder.query('COMMIT');
      const results = await Promise.all(callbacks);
      // Exactly one exchange and one success: the callback that lost the lock found the marker.
      expect(fake.grants.filter((grant) => grant === 'authorization_code')).toHaveLength(1);
      expect(results.filter((result) => result.value.ok)).toHaveLength(1);
      expect(results.find((result) => !result.value.ok)?.value.text).toMatch(/expired/i);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('refuses a callback whose authorization a newer connect replaced', async () => {
    const first = await start();
    const state = new URL(first.url).searchParams.get('state') ?? '';
    const before = await connectionRow(first.row.id);
    // The person started again before finishing the first sign-in: the pending state is replaced.
    await start();

    const fake = google();
    const result = await completeAuthorization(deps({ http: fake.http }), { state, code: 'auth-code' });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/expired/i);
    expect(fake.grants).toHaveLength(0);
    // Nothing was written: the connection still holds what the newer authorization left, not tokens
    // from the stale callback.
    const after = await connectionRow(first.row.id);
    expect(after.state).toBe(before.state);
    expect(after.secrets).toEqual(before.secrets);
  });

  it('refuses a callback after the connection was disconnected', async () => {
    const { row, url } = await start();
    const state = new URL(url).searchParams.get('state') ?? '';
    await db.withWorkspace(disposable.workspace, (tx) =>
      tx
        .update(schema.connections)
        .set(revokedColumns(new Date()))
        .where(and(eq(schema.connections.workspaceId, disposable.workspace), eq(schema.connections.id, row.id))),
    );

    const fake = google();
    const result = await completeAuthorization(deps({ http: fake.http }), { state, code: 'auth-code' });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/disconnected/i);
    expect(fake.grants).toHaveLength(0);
    expect((await connectionRow(row.id)).state).toBe('revoked');
  });

  it('refuses the exchange when the verifier does not match the challenge', async () => {
    const { row, url } = await start();
    const state = new URL(url).searchParams.get('state') ?? '';
    // A verifier that belongs to some other authorization: Google refuses it, so we must report that.
    challenge = createHash('sha256').update('a-different-verifier').digest('base64url');
    const fake = google();
    const result = await completeAuthorization(deps({ http: fake.http }), { state, code: 'auth-code' });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/did not complete the connection/i);
    expect((await connectionRow(row.id)).state).toBe('error');
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
