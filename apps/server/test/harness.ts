import type { AddressInfo } from 'node:net';
import { migrateAuth } from '@agentic-seo/auth';
import { type ApiError, createClient } from '@agentic-seo/client';
import { newUuid } from '@agentic-seo/core';
import { createDb, migrate } from '@agentic-seo/db';
import { serve } from '@hono/node-server';
import { Client, type OAuthClientProvider, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import pg from 'pg';
import { scopedDbName } from '../../../packages/db/test/run';
import { createServer } from '../src/app';
import { loadConfig } from '../src/config';
import type { Commands } from '../src/registry';

// A complete server on a fresh Postgres database, copied from the migrated template.

export type User = { email: string; cookie: string; id: string };
export const PASSWORD = 'correct-horse-battery-staple';

export const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

export const rejects = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('expected the call to fail');
};

export async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() - started > ms) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
}

export class TestOAuthProvider implements OAuthClientProvider {
  constructor(readonly clientMetadataUrl?: string) {}
  info: any;
  tokenSet: any;
  verifier = '';
  discovery: any;
  authorizationUrl?: URL;
  get redirectUrl() {
    return 'http://localhost/callback';
  }
  get clientMetadata() {
    return {
      client_name: 'Phase 0 test agent',
      redirect_uris: ['http://localhost/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i: unknown) {
    this.info = i;
  }
  tokens() {
    return this.tokenSet;
  }
  saveTokens(t: unknown) {
    this.tokenSet = t;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
  saveDiscoveryState(s: unknown) {
    this.discovery = s;
  }
  discoveryState() {
    return this.discovery;
  }
}

export const grantFrom = (requested: string, permissions: string[]) =>
  requested
    .split(' ')
    .filter((s) => !s.includes(':') || permissions.includes(s))
    .join(' ');

/** Plays the person in the browser: authorize → sign in → consent with the chosen permissions. */
export async function connectAgent(BASE: string, u: User, permissions: string[], clientMetadataUrl?: string, workspaceId?: string) {
  const provider = new TestOAuthProvider(clientMetadataUrl);
  const first = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { authProvider: provider });
  const unauthorized = await new Client({ name: 't', version: '0' }).connect(first).then(
    () => null,
    (e) => e,
  );
  if (!(unauthorized instanceof UnauthorizedError)) throw new Error('expected the first MCP connection to need authorization');

  const authz = await fetch(provider.authorizationUrl!, { redirect: 'manual', headers: { accept: 'application/json' } });
  const login = new URL(authz.headers.get('location') ?? (await authz.json()).url, BASE);
  const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email: u.email, password: PASSWORD, oauth_query: login.search.slice(1) }),
  });
  let next = new URL((await signIn.json()).url, BASE);
  if (next.pathname === '/consent') {
    // Like the consent page, choose the workspace before accepting when the person belongs to several.
    if (workspaceId) {
      const chosen = await fetch(`${BASE}/api/oauth/workspace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE, cookie: cookieOf(signIn) },
        body: JSON.stringify({
          workspaceId,
          scope: grantFrom(next.searchParams.get('scope') ?? '', permissions),
          oauthQuery: next.search.slice(1),
        }),
      });
      if (!chosen.ok) throw new Error(`workspace choice failed: ${await chosen.text()}`);
    }
    const consent = await fetch(`${BASE}/api/auth/oauth2/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, cookie: cookieOf(signIn) },
      // Like the consent page: identity scopes as requested, permissions as chosen (never more than requested).
      body: JSON.stringify({
        accept: true,
        scope: grantFrom(next.searchParams.get('scope') ?? '', permissions),
        oauth_query: next.search.slice(1),
      }),
    });
    const body = await consent.json();
    if (!body.url) throw new Error(`consent failed: ${JSON.stringify(body)}`);
    next = new URL(body.url);
  }
  await first.finishAuth(next.searchParams);
  const client = new Client({ name: 'phase-0-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { authProvider: provider }));
  return { client, clientId: provider.info.client_id as string, provider };
}

/**
 * A test file's port, moved into its worker's own block: test files run in parallel workers, and
 * the numbers in the files repeat. Worker n adds (n - 1) * 1000; the files use 2500–3499.
 */
export const testPort = (port: number) => port + (Number(process.env.VITEST_POOL_ID ?? '1') - 1) * 1000;

/** The migrated database that setup.ts prepares once per run; run-scoped like every test database. */
export const TEMPLATE_DB = scopedDbName('aseo_test_template');

const APP_ROLE = { appRole: 'aseo_test_app', appRolePassword: 'aseo_test_password' };

export { APP_ROLE };

/** The admin URL of a test database on the TEST_DATABASE_URL server. */
export function testDatabaseUrl(dbName: string) {
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://aseo:aseo@localhost:5432/aseo_test');
  url.pathname = `/${dbName}`;
  return url;
}

/**
 * Builds the template: SQL migrations (which include Better Auth's tables) and the app role, once
 * per run (setup.ts). Each file's database is then a copy, instead of running every migration again.
 */
export async function prepareTemplateDatabase() {
  const maint = new pg.Client({ connectionString: testDatabaseUrl('postgres').toString() });
  await maint.connect();
  try {
    await maint.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    await maint.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  } finally {
    await maint.end();
  }
  const db = createDb({ adminUrl: testDatabaseUrl(TEMPLATE_DB).toString(), appUrl: testDatabaseUrl(TEMPLATE_DB).toString() });
  try {
    await migrate(db.admin, APP_ROLE);
    // 0002 already created them; this keeps the template honest if the library's schema changed.
    await migrateAuth({ baseUrl: 'http://localhost', secret: 'test-secret-test-secret-test-secret-123', db });
  } finally {
    await db.close();
  }
}

/**
 * Drops everything this run created, by its own prefix only. setup.ts runs it in global teardown;
 * `ASEO_TEST_KEEP_DB=1` keeps the databases of a failed run for inspection.
 */
export async function dropRunDatabases() {
  const prefix = TEMPLATE_DB.slice(0, TEMPLATE_DB.indexOf('test_template'));
  if (process.env.ASEO_TEST_KEEP_DB || !prefix) return;
  const maint = new pg.Client({ connectionString: testDatabaseUrl('postgres').toString() });
  await maint.connect();
  try {
    const { rows } = await maint.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE NOT datistemplate AND starts_with(datname, $1)',
      [prefix],
    );
    for (const { datname } of rows) await maint.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
  } finally {
    await maint.end();
  }
}

/**
 * Drops and creates a test database: a copy of the migrated template when setup.ts made one, else
 * empty. `migrated` says which.
 */
export async function freshDatabase(name: string, useTemplate = true): Promise<{ url: URL; migrated: boolean; dbName: string }> {
  const dbName = scopedDbName(name);
  const template = useTemplate ? process.env.ASEO_TEST_TEMPLATE : undefined;
  const maint = new pg.Client({ connectionString: testDatabaseUrl('postgres').toString() });
  await maint.connect();
  try {
    await maint.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    for (let attempt = 0; ; attempt++) {
      try {
        await maint.query(template ? `CREATE DATABASE ${dbName} TEMPLATE ${template}` : `CREATE DATABASE ${dbName}`);
        break;
      } catch (e) {
        // Two copies of the template starting at the same moment: Postgres refuses the second.
        if (!template || attempt >= 20 || !/being accessed by other users/.test((e as Error).message)) throw e;
        await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
      }
    }
  } finally {
    await maint.end();
  }
  return { url: testDatabaseUrl(dbName), migrated: Boolean(template), dbName };
}

export async function startTestServer(name: string, port: number, env: Record<string, string> = {}) {
  const base = `http://localhost:${port}`;
  const { url: pgUrl, migrated, dbName } = await freshDatabase(`aseo_${name}`);

  const config = loadConfig({
    PORT: String(port),
    DATABASE_URL: pgUrl.toString(),
    APP_DB_ROLE: APP_ROLE.appRole,
    APP_DB_PASSWORD: APP_ROLE.appRolePassword,
    AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
    MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    PUBLIC_URL: base,
    ...env,
  });
  // Migrate before the auth instance exists: Better Auth validates its schema when it is created
  // and caches a mismatch, so a fresh database would fail every auth request.
  if (!migrated) {
    const boot = createDb({ adminUrl: config.adminDatabaseUrl, appUrl: config.appDatabaseUrl });
    try {
      await migrate(boot.admin, { appRolePassword: config.appDbPassword, appRole: config.appDbRole });
      await migrateAuth({ baseUrl: config.publicUrl, secret: config.authSecret, db: boot });
    } finally {
      await boot.close();
    }
  }
  const srv = createServer(config);
  let http: { close: () => void } | undefined;
  await new Promise<void>((resolve) => {
    http = serve({ fetch: srv.app.fetch, port }, (_i: AddressInfo) => resolve());
  });

  async function signUp(email: string): Promise<User> {
    const res = await fetch(`${base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email, password: PASSWORD, name: email.split('@')[0] }),
    });
    if (res.status !== 200) throw new Error(`sign-up failed: ${await res.text()}`);
    return { email, cookie: cookieOf(res), id: (await res.json()).user.id };
  }

  async function workspaceWith(members: [User, string][], policy = 'none') {
    const id = newUuid();
    await srv.db.admin.query('INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, $2, $3)', [id, `ws ${id.slice(-4)}`, policy]);
    for (const [u, role] of members)
      await srv.db.admin.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)', [id, u.id, role]);
    return id;
  }

  return {
    srv,
    base,
    dbName,
    config,
    signUp,
    workspaceWith,
    api: (u: User, workspaceId?: string) =>
      createClient<Commands>({
        baseUrl: base,
        // A browser sends Origin on every POST; the cookie-authenticated REST surface requires it.
        headers: { cookie: u.cookie, origin: base, ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}) },
      }),
    async close() {
      http?.close();
      await srv.db.close();
    },
  };
}
