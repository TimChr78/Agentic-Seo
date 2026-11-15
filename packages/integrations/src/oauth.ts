import { createHash, randomBytes } from 'node:crypto';
import { AppError, providerDiagnostic, redactCredentials, sha256 } from '@agentic-seo/core';
import { type Db, schema, type Tx } from '@agentic-seo/db';
import type { KeyProvider } from '@agentic-seo/secrets';
import { logger } from '@agentic-seo/telemetry';
import { and, eq, sql } from 'drizzle-orm';
import { type ConnectionRow, clearedSecrets, connectionSecrets, getConnection, sealConnectionSecrets } from './connections';
import { guardedHttp, type HttpClient } from './http';
import { type Connector, connectorOf, type OAuthEndpoints } from './sdk';

// OAuth 2.0 with PKCE for connectors (data-providers.md §5). Ported from Agentic Marketing's
// packages/integrations `oauth.ts` at 9a7a5721 and cut down: no inbound webhooks, deliveries or
// marketing connectors. The authorization state is hashed in the table; tokens are sealed with the
// workspace's secrets key; a refresh runs under a lease so two replicas never redeem one rotating
// refresh token; a refused refresh marks the connection `error` with a sentence a person can act on.
//
// The state carries the workspace and connection ids (base64url JSON) so the callback can find the
// row through the app role under RLS. It is still verified against the stored hash, time limit and
// consumed marker, so a state cannot be forged or replayed. The owner pool is never used on this
// request path.

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
}

/** The installation's OAuth client (Google: from GOOGLE_OAUTH_CLIENT_ID / _SECRET). */
export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface OAuthDeps {
  db: Db;
  kp: KeyProvider;
  client: OAuthClient;
  publicUrl: string;
  /** Test seam: a deterministic token endpoint instead of the guarded network request. */
  http?: HttpClient;
  /** Test seam: the clock used for expiry, pending-timeout and lease decisions. */
  now?: () => Date;
}

interface PendingAuthorization {
  stateHash: string;
  verifier: string;
  redirectUri: string;
  at: string;
  consumedAt?: string;
}

const PENDING_MS = 15 * 60_000;
const REFRESH_MARGIN_MS = 10 * 60_000;
/** One replica may refresh one connection at a time; a token exchange is bounded at 15 s. */
const REFRESH_LEASE_MS = 2 * 60_000;
/** Refresh this long before the provider's expiry, so a call never starts with a dead token. */
const USE_MARGIN_MS = 60_000;

/** The message a refused refresh leaves on the connection (search.gsc.status shows it verbatim). */
export const REFRESH_REFUSED = 'Google refused the refresh token; reconnect Search Console';

export const oauthRedirectUri = (publicUrl: string) => `${publicUrl.replace(/\/$/, '')}/oauth/callback`;

const stateHash = (state: string) => sha256(`oauth-state:${state}`);

export function encodeState(workspaceId: string, connectionId: string): string {
  return Buffer.from(JSON.stringify({ v: 1, w: workspaceId, c: connectionId, n: randomBytes(18).toString('base64url') })).toString(
    'base64url',
  );
}

export function decodeState(state: string): { workspaceId: string; connectionId: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as { v?: unknown; w?: unknown; c?: unknown };
    if (parsed.v !== 1 || typeof parsed.w !== 'string' || typeof parsed.c !== 'string') return null;
    if (!/^con_[0-9a-f]{32}$/.test(parsed.c)) return null;
    if (!/^[0-9a-f-]{36}$/.test(parsed.w)) return null;
    return { workspaceId: parsed.w, connectionId: parsed.c };
  } catch {
    return null;
  }
}

/** One line of provider text, credential-redacted and bounded: it reaches the callback page. */
const MAX_OAUTH_TEXT = 300;
function safeOAuthText(text: string): string {
  const first = redactCredentials(String(text)).split('\n')[0]?.trim() ?? '';
  return first.length > MAX_OAUTH_TEXT ? `${first.slice(0, MAX_OAUTH_TEXT - 1)}…` : first;
}

/** An expected token-endpoint refusal: its safe diagnostic may be shown, unlike a transport error. */
class OAuthTokenError extends Error {
  constructor(
    readonly code: string | undefined,
    readonly diagnostic: string,
  ) {
    super(diagnostic);
    this.name = 'OAuthTokenError';
  }
}

function oauthFailureText(err: unknown): string {
  if (err instanceof OAuthTokenError) return err.diagnostic;
  return 'the token endpoint could not be reached; connect again';
}

function endpointsFor(connector: Connector, settings: unknown): OAuthEndpoints {
  if (connector.auth !== 'oauth2' || !connector.oauth) throw new AppError('invalid_input', `${connector.label} does not use OAuth 2.0.`);
  return connector.oauth(connector.settings.parse(settings));
}

/** Calls the token endpoint (authorization code or refresh token) and returns what to store. */
async function tokenRequest(deps: OAuthDeps, endpoints: OAuthEndpoints, params: Record<string, string>) {
  const http = deps.http ?? guardedHttp;
  const res = await http(endpoints.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    // A non-JSON body is diagnosed by its status below, never echoed: it may carry credentials.
  }
  if (res.status < 200 || res.status >= 300 || typeof body.access_token !== 'string') {
    const code = typeof body.error === 'string' ? body.error : undefined;
    const diagnostic = providerDiagnostic(res.body) || (code ? safeOAuthText(code) : `HTTP ${res.status}`);
    throw new OAuthTokenError(code, diagnostic);
  }
  const expiresIn = body.expires_in;
  return {
    tokens: {
      accessToken: body.access_token,
      ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
      ...(typeof body.token_type === 'string' ? { tokenType: body.token_type } : {}),
      ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
    } satisfies OAuthTokens,
    expiresAt:
      typeof expiresIn === 'number' || typeof expiresIn === 'string'
        ? new Date((deps.now ?? (() => new Date()))().getTime() + Number(expiresIn) * 1000)
        : null,
  };
}

/**
 * Seals tokens on the row. `authorization` marks a completed (re)authorization, possibly by another
 * Google account: it bumps the generation, so a property list or a sync obtained under the previous
 * grant is refused. A refresh keeps the same grant and leaves the generation alone.
 */
async function storeTokens(
  tx: Tx,
  row: ConnectionRow,
  kp: KeyProvider,
  tokens: OAuthTokens,
  expiresAt: Date | null,
  now: Date,
  authorization = false,
) {
  const current = await connectionSecrets(tx, row, kp);
  const previous = (current.__oauth ?? {}) as Partial<OAuthTokens>;
  // Providers often send a refresh token only the first time: keep the one we have.
  const merged = { ...current, __oauth: { ...tokens, refreshToken: tokens.refreshToken ?? previous.refreshToken } };
  const sealed = await sealConnectionSecrets(tx, row, kp, merged);
  await tx
    .update(schema.connections)
    .set({
      secrets: sealed.blob,
      secretsKeyId: sealed.keyId,
      state: 'active',
      lastError: null,
      oauthPending: null,
      tokenExpiresAt: expiresAt,
      refreshLeaseUntil: null,
      refreshLeaseToken: null,
      ...(authorization ? { generation: sql`${schema.connections.generation} + 1` } : {}),
      updatedAt: now,
    })
    .where(and(eq(schema.connections.workspaceId, row.workspaceId), eq(schema.connections.id, row.id)));
}

export interface BeginAuthorizationInput {
  row: ConnectionRow;
  kp: KeyProvider;
  client: OAuthClient;
  publicUrl: string;
  connector?: Connector;
  now?: Date;
}

/**
 * Starts the authorization for one connection: stores the hashed state and PKCE verifier, and
 * returns the provider URL the person opens. Connecting again replaces an earlier pending attempt,
 * so a stale link cannot win.
 */
export async function beginAuthorization(tx: Tx, input: BeginAuthorizationInput): Promise<{ url: string; redirectUri: string }> {
  const connector = input.connector ?? connectorOf(input.row.connector);
  const endpoints = endpointsFor(connector, input.row.settings);
  const redirectUri = oauthRedirectUri(input.publicUrl);
  const state = encodeState(input.row.workspaceId, input.row.id);
  const verifier = randomBytes(48).toString('base64url');
  const now = input.now ?? new Date();
  const pending: PendingAuthorization = { stateHash: stateHash(state), verifier, redirectUri, at: now.toISOString() };
  await tx
    .update(schema.connections)
    .set({
      state: input.row.state === 'active' ? 'active' : 'pending',
      lastError: null,
      oauthPending: pending as unknown as Record<string, unknown>,
      updatedAt: now,
    })
    .where(and(eq(schema.connections.workspaceId, input.row.workspaceId), eq(schema.connections.id, input.row.id)));
  const url = new URL(endpoints.authorizeUrl);
  for (const [key, value] of Object.entries({
    response_type: 'code',
    client_id: input.client.clientId,
    redirect_uri: redirectUri,
    scope: endpoints.scopes.join(' '),
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    ...(endpoints.params ?? {}),
  }))
    if (value) url.searchParams.set(key, value);
  return { url: url.toString(), redirectUri };
}

export interface CallbackInput {
  state: string;
  code?: string;
  error?: string;
  errorDescription?: string;
}

export interface CallbackResult {
  ok: boolean;
  text: string;
  workspaceId?: string;
  connectionId?: string;
}

/**
 * GET /oauth/callback: validate and consume the one-time state in a short transaction, exchange the
 * code outside every transaction (a slow provider must not hold the app pool), then store the
 * tokens only while this exact authorization is still current.
 */
export async function completeAuthorization(deps: OAuthDeps, input: CallbackInput): Promise<CallbackResult> {
  const decoded = decodeState(input.state);
  if (!decoded) return { ok: false, text: 'This link is not valid any more. Start connecting again.' };
  const hash = stateHash(input.state);
  const now = (deps.now ?? (() => new Date()))();
  const { workspaceId, connectionId } = decoded;

  const prepared = await deps.db.withWorkspace(workspaceId, async (tx) => {
    // Locked, so two callbacks for the same state cannot both pass the consumption check: the second
    // waits for the first to commit and then finds the marker (Agentic Marketing #375's rule).
    // Locked, so two callbacks for the same state cannot both pass the consumption check: the second
    // waits for the first to commit and then finds the marker (Agentic Marketing #375's rule).
    const [row] = await tx
      .select()
      .from(schema.connections)
      .where(and(eq(schema.connections.workspaceId, workspaceId), eq(schema.connections.id, connectionId)))
      .for('update');
    if (!row || row.state === 'revoked') return { ok: false as const, text: 'This connection was disconnected. Start connecting again.' };
    const pending = row.oauthPending as unknown as PendingAuthorization | null;
    if (!pending || pending.stateHash !== hash) return { ok: false as const, text: 'This link has expired. Start connecting again.' };
    if (pending.consumedAt || now.getTime() - Date.parse(pending.at) > PENDING_MS)
      return { ok: false as const, text: 'This link has expired. Start connecting again.' };
    if (input.error) {
      const why = safeOAuthText(input.errorDescription ?? input.error);
      await tx
        .update(schema.connections)
        .set({ state: 'error', lastError: `Google did not allow access: ${why}`, oauthPending: null, updatedAt: now })
        .where(and(eq(schema.connections.workspaceId, workspaceId), eq(schema.connections.id, connectionId)));
      return { ok: false as const, text: `Google did not allow access: ${why}` };
    }
    // One-time: mark this state consumed before the network call. A replay finds the marker.
    await tx
      .update(schema.connections)
      .set({ oauthPending: { ...pending, consumedAt: now.toISOString() } as unknown as Record<string, unknown>, updatedAt: now })
      .where(and(eq(schema.connections.workspaceId, workspaceId), eq(schema.connections.id, connectionId)));
    const connector = connectorOf(row.connector);
    return {
      ok: true as const,
      row,
      pending,
      endpoints: endpointsFor(connector, row.settings),
      secrets: await connectionSecrets(tx, row, deps.kp),
    };
  });
  if (!prepared.ok) return { ...prepared, workspaceId, connectionId };

  let exchanged: Awaited<ReturnType<typeof tokenRequest>>;
  try {
    exchanged = await tokenRequest(deps, prepared.endpoints, {
      grant_type: 'authorization_code',
      code: input.code ?? '',
      redirect_uri: prepared.pending.redirectUri,
      client_id: deps.client.clientId,
      client_secret: deps.client.clientSecret,
      code_verifier: prepared.pending.verifier,
    });
  } catch (err) {
    const why = oauthFailureText(err);
    const result = await deps.db.withWorkspace(workspaceId, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.connections)
        .where(and(eq(schema.connections.workspaceId, workspaceId), eq(schema.connections.id, connectionId)))
        .for('update');
      if (!row || row.state === 'revoked') return { ok: false, text: 'This connection was disconnected. Nothing was connected.' };
      const pending = row.oauthPending as unknown as PendingAuthorization | null;
      // The authorization was replaced or completed by a newer callback: leave it alone.
      if (!pending || pending.stateHash !== hash || !pending.consumedAt)
        return { ok: false, text: 'A newer authorization replaced this one. Start connecting again.' };
      await tx
        .update(schema.connections)
        .set({ state: 'error', lastError: `Google did not complete the connection: ${why}`, oauthPending: null, updatedAt: now })
        .where(and(eq(schema.connections.workspaceId, workspaceId), eq(schema.connections.id, connectionId)));
      return { ok: false, text: `Google did not complete the connection: ${why}` };
    });
    return { ...result, workspaceId, connectionId };
  }

  const result = await deps.db.withWorkspace(workspaceId, async (tx): Promise<{ ok: boolean; text: string }> => {
    const [row] = await tx
      .select()
      .from(schema.connections)
      .where(and(eq(schema.connections.workspaceId, workspaceId), eq(schema.connections.id, connectionId)))
      .for('update');
    if (!row || row.state === 'revoked') return { ok: false, text: 'This connection was disconnected. Nothing was connected.' };
    const pending = row.oauthPending as unknown as PendingAuthorization | null;
    if (!pending || pending.stateHash !== hash || !pending.consumedAt)
      return { ok: false, text: 'A newer authorization replaced this one. Start connecting again.' };
    await storeTokens(tx, row, deps.kp, exchanged.tokens, exchanged.expiresAt, now, true);
    return { ok: true, text: `${row.label || connectorOf(row.connector).label} is connected. You can close this window.` };
  });
  return { ...result, workspaceId, connectionId };
}

interface RefreshClaim {
  row: ConnectionRow;
  secrets: Record<string, unknown>;
  leaseToken: string;
}

/** Claims the refresh lease in a short transaction and reads the latest row and secrets. */
async function claimRefresh(deps: OAuthDeps, workspaceId: string, connectionId: string, force: boolean): Promise<RefreshClaim | null> {
  const now = (deps.now ?? (() => new Date()))();
  return deps.db.withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.connections)
      .where(and(eq(schema.connections.workspaceId, workspaceId), eq(schema.connections.id, connectionId)))
      .for('update');
    if (row?.state !== 'active') return null;
    if (row.refreshLeaseUntil && row.refreshLeaseUntil.getTime() > now.getTime()) return null;
    if (!force && (!row.tokenExpiresAt || row.tokenExpiresAt.getTime() > now.getTime() + REFRESH_MARGIN_MS)) return null;
    const leaseToken = randomBytes(16).toString('hex');
    const [claimed] = await tx
      .update(schema.connections)
      .set({ refreshLeaseUntil: new Date(now.getTime() + REFRESH_LEASE_MS), refreshLeaseToken: leaseToken, updatedAt: now })
      .where(and(eq(schema.connections.workspaceId, workspaceId), eq(schema.connections.id, connectionId)))
      .returning();
    return { row: claimed!, secrets: await connectionSecrets(tx, claimed!, deps.kp), leaseToken };
  });
}

async function releaseRefreshLease(deps: OAuthDeps, workspaceId: string, connectionId: string, leaseToken: string) {
  await deps.db
    .withWorkspace(workspaceId, (tx) =>
      tx
        .update(schema.connections)
        .set({ refreshLeaseUntil: null, refreshLeaseToken: null })
        .where(
          and(
            eq(schema.connections.workspaceId, workspaceId),
            eq(schema.connections.id, connectionId),
            eq(schema.connections.refreshLeaseToken, leaseToken),
          ),
        ),
    )
    .catch((err) => logger.warn({ err, connection: connectionId }, 'OAuth refresh lease could not be released'));
}

/** The failure is only ours if nobody refreshed or re-authorized the connection meanwhile. */
function stillOwnsRefresh(claim: RefreshClaim, row: ConnectionRow, secrets: Record<string, unknown>) {
  const before = (claim.secrets.__oauth ?? {}) as Partial<OAuthTokens>;
  const after = (secrets.__oauth ?? {}) as Partial<OAuthTokens>;
  return (
    row.refreshLeaseToken === claim.leaseToken &&
    before.accessToken === after.accessToken &&
    before.refreshToken === after.refreshToken &&
    (row.tokenExpiresAt?.getTime() ?? null) === (claim.row.tokenExpiresAt?.getTime() ?? null)
  );
}

async function failConnection(deps: OAuthDeps, workspaceId: string, connectionId: string, leaseToken: string, message: string) {
  const now = (deps.now ?? (() => new Date()))();
  await deps.db.withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.connections)
      .where(and(eq(schema.connections.workspaceId, workspaceId), eq(schema.connections.id, connectionId)))
      .for('update');
    if (row?.state !== 'active' || row.refreshLeaseToken !== leaseToken) return;
    await tx
      .update(schema.connections)
      .set({ state: 'error', lastError: message, oauthPending: null, refreshLeaseUntil: null, refreshLeaseToken: null, updatedAt: now })
      .where(and(eq(schema.connections.workspaceId, workspaceId), eq(schema.connections.id, connectionId)));
  });
}

/**
 * Refreshes one connection's tokens. A refused refresh token (`invalid_grant`) marks the connection
 * `error` with REFRESH_REFUSED; a transport failure is retried by the next worker round.
 */
export async function refreshConnection(
  deps: OAuthDeps,
  input: { workspaceId: string; connectionId: string; force?: boolean },
): Promise<'refreshed' | 'skipped' | 'failed' | 'retry'> {
  const claim = await claimRefresh(deps, input.workspaceId, input.connectionId, input.force ?? false);
  if (!claim) return 'skipped';
  const now = (deps.now ?? (() => new Date()))();
  const refreshToken = (claim.secrets.__oauth as Partial<OAuthTokens> | undefined)?.refreshToken;
  try {
    if (!refreshToken) {
      await failConnection(
        deps,
        input.workspaceId,
        input.connectionId,
        claim.leaseToken,
        'The access token expired and there is no refresh token; reconnect Search Console',
      );
      return 'failed';
    }
    const endpoints = endpointsFor(connectorOf(claim.row.connector), claim.row.settings);
    const { tokens, expiresAt } = await tokenRequest(deps, endpoints, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: deps.client.clientId,
      client_secret: deps.client.clientSecret,
    });
    await deps.db.withWorkspace(input.workspaceId, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.connections)
        .where(and(eq(schema.connections.workspaceId, input.workspaceId), eq(schema.connections.id, input.connectionId)))
        .for('update');
      if (row?.state !== 'active') return;
      const current = await connectionSecrets(tx, row, deps.kp);
      // The winner already stored newer tokens, or the person re-authorized: discard this result.
      if (!stillOwnsRefresh(claim, row, current)) return;
      await storeTokens(tx, row, deps.kp, tokens, expiresAt, now);
    });
    return 'refreshed';
  } catch (err) {
    const code = (err as { code?: string }).code;
    // invalid_grant: revoked or expired for good. Anything else is retried on the next round.
    if (err instanceof OAuthTokenError && code === 'invalid_grant') {
      await failConnection(deps, input.workspaceId, input.connectionId, claim.leaseToken, REFRESH_REFUSED);
      return 'failed';
    }
    logger.warn({ err, connection: input.connectionId }, 'OAuth token refresh failed; will retry');
    return 'retry';
  } finally {
    await releaseRefreshLease(deps, input.workspaceId, input.connectionId, claim.leaseToken);
  }
}

/**
 * The credential seam for adapters: a current access token for one connection, refreshing it when
 * it is about to expire. Adapters never see the database; the server wires this function to them.
 */
export async function accessTokenForConnection(deps: OAuthDeps, input: { workspaceId: string; connectionId: string }): Promise<string> {
  const now = (deps.now ?? (() => new Date()))();
  const read = () =>
    deps.db.withWorkspace(input.workspaceId, async (tx) => {
      const row = await getConnection(tx, input.workspaceId, input.connectionId);
      return { row, secrets: await connectionSecrets(tx, row, deps.kp) };
    });
  let { row, secrets } = await read();
  if (row.state === 'revoked')
    throw new AppError('conflict', 'The Google Search Console connection was disconnected. Reconnect it with search.gsc.connect.');
  if (row.state === 'error')
    throw new AppError(
      'conflict',
      row.lastError ?? 'The Google Search Console connection needs to be reconnected. Run search.gsc.connect.',
    );
  if (!row.tokenExpiresAt || row.tokenExpiresAt.getTime() <= now.getTime() + USE_MARGIN_MS) {
    await refreshConnection(deps, { workspaceId: input.workspaceId, connectionId: input.connectionId });
    ({ row, secrets } = await read());
    if (row.state !== 'active')
      throw new AppError('conflict', row.lastError ?? 'Google refused the refresh token; reconnect Search Console.');
    // Another replica holds the refresh lease, or a transport failure left the old token in place:
    // never hand the adapter a token that is about to expire.
    if (!row.tokenExpiresAt || row.tokenExpiresAt.getTime() <= now.getTime() + USE_MARGIN_MS)
      throw new AppError(
        'conflict',
        'The Google Search Console access token could not be refreshed right now. Try again shortly; if it keeps failing, reconnect Search Console with search.gsc.connect.',
      );
  }
  const token = (secrets.__oauth as Partial<OAuthTokens> | undefined)?.accessToken;
  if (!token)
    throw new AppError('conflict', 'The Google Search Console connection has no access token. Reconnect it with search.gsc.connect.');
  return token;
}

/**
 * Revokes the stored token at the provider. False means the provider did not confirm; the local
 * revoke still stands, because the sealed credential is dropped either way.
 */
export async function revokeTokens(
  connector: Connector,
  settings: unknown,
  secrets: Record<string, unknown>,
  http: HttpClient = guardedHttp,
): Promise<boolean> {
  const tokens = (secrets.__oauth ?? {}) as Partial<OAuthTokens>;
  const token = tokens.refreshToken ?? tokens.accessToken;
  if (!token) return true;
  const endpoints = endpointsFor(connector, settings);
  if (!endpoints.revokeUrl) return false;
  try {
    const res = await http(endpoints.revokeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    // Google answers 400 for a token that is already invalid, which is the outcome we wanted.
    return res.status >= 200 && res.status < 300;
  } catch (err) {
    logger.warn({ err }, 'the provider did not confirm the token revoke');
    return false;
  }
}

/** Reads a connection's sealed token and revokes it at the provider. */
export async function revokeAtProvider(deps: OAuthDeps, row: ConnectionRow): Promise<boolean> {
  const secrets = await deps.db.withWorkspace(row.workspaceId, (tx) => connectionSecrets(tx, row, deps.kp));
  return revokeTokens(connectorOf(row.connector), row.settings, secrets, deps.http);
}

/**
 * One worker round: refresh every active connection whose token expires within the margin. The
 * discovery query reads across workspaces (the queue is installation-level); each refresh then runs
 * inside withWorkspace.
 */
export async function refreshDueConnections(
  deps: OAuthDeps,
  options: { limit?: number } = {},
): Promise<{ refreshed: number; failed: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const { rows } = await deps.db.admin.query<{ workspace_id: string; id: string }>(
    `SELECT workspace_id, id FROM connections
      WHERE state = 'active' AND token_expires_at IS NOT NULL AND token_expires_at < $1
        AND (refresh_lease_until IS NULL OR refresh_lease_until < now())
      ORDER BY token_expires_at
      LIMIT $2`,
    [new Date(now.getTime() + REFRESH_MARGIN_MS), options.limit ?? 100],
  );
  let refreshed = 0;
  let failed = 0;
  for (const row of rows) {
    const outcome = await refreshConnection(deps, { workspaceId: row.workspace_id, connectionId: row.id });
    if (outcome === 'refreshed') refreshed += 1;
    if (outcome === 'failed') failed += 1;
  }
  return { refreshed, failed };
}

/** Drops the sealed credential and marks the row revoked. Kept for the audit trail; facts stay. */
export function revokedColumns(now: Date) {
  return {
    ...clearedSecrets(),
    state: 'revoked' as const,
    // A sync running for this connection sees the bump and stops writing its facts.
    generation: sql`${schema.connections.generation} + 1`,
    oauthPending: null,
    tokenExpiresAt: null,
    refreshLeaseUntil: null,
    refreshLeaseToken: null,
    updatedAt: now,
  };
}
