import { existsSync } from 'node:fs';
import { activeMandate } from '@agentic-seo/artifacts';
import {
  type AuthConfig,
  acceptInvitation,
  authDirectory,
  chooseOAuthWorkspace,
  createAuth,
  invitationWorkspace,
  isMcpResourceUrlAllowed,
  withConsentRequest,
} from '@agentic-seo/auth';
import { registerCheckAuditHooks } from '@agentic-seo/checks';
import { createExecutor, type Services, userPrincipal } from '@agentic-seo/commands';
import { AppError, newUuid, remoteAddressFromEnv, resolveClientIp } from '@agentic-seo/core';
import { createDb } from '@agentic-seo/db';
import { createProviderGateway } from '@agentic-seo/providers';
import { endpointLocation, logger } from '@agentic-seo/telemetry';
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from '@better-auth/oauth-provider';
import { makeWorkerUtils } from 'graphile-worker';
import { type Context, Hono } from 'hono';
import { agentLedgerServices } from './agents/ledger';
import type { Config } from './config';
import { googleOAuthDeps, providerAdapters } from './google';
import { bodyLimit } from './http/body-limit';
import { type BrowserRequestPolicy, browserBody, formCsrfRefusal } from './http/csrf';
import { MCP_MAX_BODY, mcpEndpoint } from './http/mcp';
import { metricsHandler } from './http/metrics';
import { oauthCallbackRoute } from './http/oauth-callback';
import { consentPage, invitePage, loginPage, pageNonce, pagesCsp } from './http/pages';
import { restApi } from './http/rest';
import { securityHeaders } from './http/security-headers';
import { staticSite } from './http/static';
import { createInputWarningRecorder } from './inputWarnings';
import { keyProviderFor } from './keys';
import { createMetricsRegistry, routeGroup, statusClass } from './metrics';
import { COMMIT, VERSION } from './version';

// An invitation token is short; the limit runs before the session lookup and the body parse.
const INVITATION_MAX_BODY = 8 * 1024;
// A consent form is a decision and the signed authorization query; 16 KB leaves ample room while
// refusing an unbounded body before Better Auth reads it (#790).
const CONSENT_MAX_BODY = 16 * 1024;

// The generic /api/auth/* catch-all forwards every other Better Auth POST here. Every POST this app
// enables, and its largest legitimate body (#932):
//
//   | endpoint(s)                                                          | largest body        |
//   |----------------------------------------------------------------------|---------------------|
//   | sign-in/up/out, change-password, verify-email, OAuth token/revoke     | under 1 KB          |
//   | /oauth2/register (dynamic client registration, metadata and JWKS)     | under 64 KB         |
//
// No organization, passkey, 2FA or SSO plugin is enabled. 256 KB covers the dynamic client
// registration documents with room for JSON escaping, while still bounding an unauthenticated body
// before `auth.handler` buffers it.
const AUTH_CATCHALL_MAX_BODY = 256 * 1024;

/**
 * The header the app resolves the client IP into before Better Auth reads it. A caller-supplied
 * value of this header is always deleted, so a sign-in cannot choose (or share) a rate-limit bucket.
 */
const RESOLVED_CLIENT_IP_HEADER = 'x-aseo-client-ip';

/** `overrides` exist for tests, e.g. a stub transport for Client ID Metadata Documents. */
export interface ServerOverrides {
  cimd?: AuthConfig['cimd'];
}

export function createServer(config: Config, overrides: ServerOverrides = {}) {
  // The check catalogue's audit hooks must be registered before any crawl chunk or finalize runs,
  // in every process role: `createServer` runs first in the API, the worker and the combined role.
  // Registering twice is a no-op (the package guards it), so several servers in one test are fine.
  registerCheckAuditHooks();
  const db = createDb({ adminUrl: config.adminDatabaseUrl, appUrl: config.appDatabaseUrl });
  const mcpEnabled = isMcpResourceUrlAllowed(config.publicUrl);
  if (!mcpEnabled) {
    logger.warn(
      // PUBLIC_URL may carry basic-auth userinfo or a query token; never put either in the logs.
      { publicUrl: endpointLocation(config.publicUrl) },
      'MCP/OAuth client endpoints are disabled because PUBLIC_URL is plain HTTP on a non-loopback host; the admin UI and REST API still work. Use HTTPS (e.g. Tailscale or a Cloudflare Tunnel) to enable MCP.',
    );
  }
  const auth = createAuth({
    baseUrl: config.publicUrl,
    secret: config.authSecret,
    db,
    trustedOrigins: config.trustedOrigins,
    clientIpHeaders: [RESOLVED_CLIENT_IP_HEADER],
    cimd: overrides.cimd,
  });
  // Better Auth initialises plugins (including seeding OAuth resources) asynchronously. Callers
  // that close their pools soon after creating the server, such as the CLI, wait for this.
  const ready = auth.$context.then(
    () => undefined,
    (err) => {
      logger.error({ err }, 'auth initialisation failed');
    },
  );
  const keyProvider = keyProviderFor(config);
  const directory = authDirectory(db);
  const inputWarnings = createInputWarningRecorder(db);
  const metrics = createMetricsRegistry();
  // The gateway is the one route to paid or rate-limited APIs. Search Console is the first adapter;
  // a port without a configured adapter answers with the key that unlocks it instead of faking data.
  const providers = createProviderGateway({ db, adapters: providerAdapters(config, db, keyProvider) });
  // Commands queue background work (search.gsc.sync); the queue lives on the admin connection
  // because Graphile Worker's tables are installation-level, not tenant data.
  let queueUtils: ReturnType<typeof makeWorkerUtils> | undefined;
  const enqueueTask = async (identifier: string, payload: Record<string, unknown>) => {
    queueUtils ??= makeWorkerUtils({ pgPool: db.admin });
    const utils = await queueUtils;
    await utils.addJob(identifier, payload, { maxAttempts: 3 });
  };
  const services: Services = {
    keyProvider,
    directory,
    providers,
    googleOAuth: config.googleOAuth,
    enqueueTask,
    publicUrl: config.publicUrl,
    serverVersion: VERSION,
    strictInputs: config.strictInputs,
    activeMandate,
    ...agentLedgerServices(),
  };
  const executor = createExecutor(db, services, {
    strictInputs: config.strictInputs,
    onUnknownKeys: (command, unknown, principal) => {
      logger.warn({ command, unknownKeys: unknown.map((u) => u.path) }, 'command input has unknown keys');
      inputWarnings.record(command, unknown, principal);
    },
    // Counted for `/metrics`; the command package stays independent of any metrics library.
    onCommand: (event) => metrics.recordCommand(event),
  });

  // The prefix re-dispatch below does not exist here, but the weak mark still keeps a future
  // internal dispatch from being counted twice. The path map labels the single count correctly.
  const innerDispatch = new WeakSet<Request>();
  const metricsPath = new WeakMap<Request, string>();

  const app = new Hono();
  // What a cookie-authenticated browser write must prove: the app's own origin, or one the
  // operator trusts (TRUSTED_ORIGINS). Shared by the REST surface and the two form endpoints.
  const origin: BrowserRequestPolicy = { publicUrl: config.publicUrl, trustedOrigins: config.trustedOrigins };
  // Prometheus counters and durations for every request except the scrape itself. The labels are
  // the route group and status class, so the series count is fixed whatever clients request.
  app.use('*', async (c, next) => {
    if (c.req.path === '/metrics' || innerDispatch.has(c.req.raw)) return next();
    const started = performance.now();
    const group = () => routeGroup(metricsPath.get(c.req.raw) ?? c.req.path);
    try {
      await next();
    } catch (err) {
      // AppErrors still get their real class: the error handler turns them into a response, but
      // only after this middleware's stack has unwound.
      metrics.recordHttp(group(), err instanceof AppError ? statusClass(err.status) : '5xx', (performance.now() - started) / 1000);
      throw err;
    }
    metrics.recordHttp(group(), statusClass(c.res.status), (performance.now() - started) / 1000);
  });
  // Baseline security headers on every response; routes with their own policy keep it.
  app.use(
    '*',
    securityHeaders({
      https: config.publicUrl.startsWith('https://'),
      // The OAuth callback carries a one-time code and the state in its URL.
      noReferrerPaths: ['/oauth/callback'],
    }),
  );

  /**
   * Resolves the client IP once, then replaces any caller-supplied value of the resolved header.
   * Better Auth reads only that header, so admin sign-ins cannot share (or pick) a rate-limit
   * bucket through a spoofed forwarding header.
   */
  const withClientIp = (c: { req: { raw: Request }; env: unknown }) => {
    const headers = new Headers(c.req.raw.headers);
    headers.delete(RESOLVED_CLIENT_IP_HEADER);
    const ip = resolveClientIp({
      header: (name) => headers.get(name) ?? undefined,
      remoteAddress: remoteAddressFromEnv(c.env),
      headerNames: config.clientIpHeaders,
      trustedProxyCidrs: config.trustedProxyCidrs,
    });
    if (ip) headers.set(RESOLVED_CLIENT_IP_HEADER, ip);
    return new Request(c.req.raw, { headers });
  };

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.status as 400);
    const requestId = newUuid();
    logger.error({ err, requestId, path: c.req.path }, 'unhandled error');
    return c.json({ error: 'internal', message: 'Something went wrong on our side.', requestId }, 500);
  });

  // Operators and release checks read the running build here, not from a hard-coded literal.
  const build = COMMIT ? { version: VERSION, commit: COMMIT } : { version: VERSION };
  app.get('/healthz', (c) => c.json({ ok: true, ...build }));
  app.get('/readyz', async (c) => {
    try {
      await db.ping();
      return c.json({ ok: true, ...build });
    } catch {
      return c.json({ ok: false, ...build }, 503);
    }
  });
  // Prometheus text exposition on the main listener only, and only once METRICS_TOKEN is set.
  app.get('/metrics', metricsHandler({ token: config.metricsToken, registry: metrics, db }));

  // The OAuth consent flow binds a workspace choice to one authorization request. The provider
  // hook that issues the grant only receives the session, so the request's stable parameters are
  // carried in an async context: /authorize from its URL query, /oauth2/consent from the
  // oauth_query it was posted with. The body is replayed unchanged for Better Auth to read.
  const authorize = (c: Context) =>
    withConsentRequest({ query: new URL(c.req.url).search, mode: 'authorize' }, () => auth.handler(withClientIp(c)));
  app.get('/api/auth/oauth2/authorize', authorize);
  app.get('/api/auth/oauth2/authorize/*', authorize);
  app.post(
    '/api/auth/oauth2/consent',
    bodyLimit(CONSENT_MAX_BODY, (c) =>
      c.json({ error: 'payload_too_large', message: `Requests are limited to ${CONSENT_MAX_BODY / 1024} KB.` }, 413),
    ),
    async (c) => {
      const raw = await c.req.text();
      let query: string | undefined;
      try {
        const body = JSON.parse(raw) as { oauth_query?: unknown };
        if (typeof body.oauth_query === 'string') query = body.oauth_query;
      } catch {
        // Not JSON: Better Auth answers with its own validation error for the replayed request.
      }
      const request = new Request(c.req.raw.url, { method: 'POST', headers: c.req.raw.headers, body: raw });
      return withConsentRequest({ query, mode: 'consent' }, () => auth.handler(withClientIp({ req: { raw: request }, env: c.env })));
    },
  );
  app.on(
    ['GET', 'POST'],
    '/api/auth/*',
    bodyLimit(AUTH_CATCHALL_MAX_BODY, (c) =>
      c.json({ error: 'payload_too_large', message: `Requests are limited to ${AUTH_CATCHALL_MAX_BODY / 1024} KB.` }, 413),
    ),
    (c) => auth.handler(withClientIp(c)),
  );

  // OAuth discovery at the root, where MCP clients look (RFC 8414 path insertion included). The MCP
  // plugin answers RFC 9728 protected-resource metadata itself when the root path reaches it.
  const asMeta = oauthProviderAuthServerMetadata(auth);
  const oidcMeta = oauthProviderOpenIdConfigMetadata(auth);
  app.get('/.well-known/oauth-authorization-server', (c) => asMeta(c.req.raw));
  app.get('/.well-known/oauth-authorization-server/*', (c) => asMeta(c.req.raw));
  app.get('/.well-known/openid-configuration', (c) => oidcMeta(c.req.raw));
  app.get('/.well-known/openid-configuration/*', (c) => oidcMeta(c.req.raw));
  if (mcpEnabled) {
    app.get('/.well-known/oauth-protected-resource', (c) => auth.handler(withClientIp(c)));
    app.get('/.well-known/oauth-protected-resource/*', (c) => auth.handler(withClientIp(c)));
  }

  // The server-rendered pages carry one inline script and one inline style each: a per-response
  // nonce lets exactly those run and blocks an injected handler or a later inline script.
  const inlinePage = (c: Context, render: (nonce: string) => string) => {
    const nonce = pageNonce();
    c.header('Content-Security-Policy', pagesCsp(nonce));
    return c.html(render(nonce));
  };
  app.get('/login', (c) => inlinePage(c, loginPage));
  app.get('/consent', (c) => inlinePage(c, consentPage));
  app.get('/invite', (c) => inlinePage(c, invitePage));

  // The consent page chooses the workspace an OAuth client acts in. The choice is checked against
  // the person's memberships and role here, then stored for this exact authorization request; the
  // OAuth provider reads it as the grant's reference id.
  app.post(
    '/api/oauth/workspace',
    bodyLimit(INVITATION_MAX_BODY, (c) =>
      c.json({ error: 'payload_too_large', message: `Requests are limited to ${INVITATION_MAX_BODY / 1024} KB.` }, 413),
    ),
    async (c) => {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) throw new AppError('unauthorized', 'Sign in first, then choose the workspace this connection acts in.');
      const refused = formCsrfRefusal(c, origin);
      if (refused) return refused;
      const body = (await browserBody(c)) as { workspaceId?: unknown; scope?: unknown; oauthQuery?: unknown };
      if (typeof body.workspaceId !== 'string')
        throw new AppError('invalid_input', 'Choose the workspace (workspaceId) this connection acts in.');
      const choice = await chooseOAuthWorkspace(db, {
        sessionId: session.session.id,
        userId: session.user.id,
        workspaceId: body.workspaceId,
        scope: typeof body.scope === 'string' ? body.scope : undefined,
        oauthQuery: typeof body.oauthQuery === 'string' ? body.oauthQuery : undefined,
      });
      return c.json({ workspaceId: choice.id, name: choice.name });
    },
  );

  // Accepting an invitation: the person is signed in but not yet a member, so the workspace comes
  // from the token rather than from their memberships.
  app.post(
    '/api/invitations/accept',
    bodyLimit(INVITATION_MAX_BODY, (c) =>
      c.json({ error: 'payload_too_large', message: `Requests are limited to ${INVITATION_MAX_BODY / 1024} KB.` }, 413),
    ),
    async (c) => {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) throw new AppError('unauthorized', 'Sign in (or create an account) with the invited e-mail address first.');
      const refused = formCsrfRefusal(c, origin);
      if (refused) return refused;
      const { token } = (await browserBody(c)) as { token?: unknown };
      const inv = typeof token === 'string' ? await invitationWorkspace(db, token) : null;
      if (!inv) throw new AppError('not_found', 'This invitation link is not valid any more. Ask for a new one.');
      // Accepting needs no permission; the principal carries none until the membership exists.
      const invitee = { ...userPrincipal(session.user.id, inv.workspaceId, inv.role), permissions: new Set<never>() };
      const out = await executor.execute(acceptInvitation, { token, email: session.user.email }, invitee, { surface: 'rest' });
      return c.json(out);
    },
  );

  if (mcpEnabled) {
    const mcp = mcpEndpoint({
      auth,
      db,
      executor,
      resource: `${config.publicUrl}/mcp`,
      textContent: config.mcpTextContent,
      toolNameStyle: config.mcpToolNameStyle,
    });
    app.all(
      '/mcp',
      bodyLimit(MCP_MAX_BODY, (c) =>
        c.json({ error: 'payload_too_large', message: `MCP requests are limited to ${MCP_MAX_BODY / (1024 * 1024)} MB.` }, 413),
      ),
      (c) => mcp(c.req.raw),
    );
  }
  // Where Google returns the person after they allow access. Without an OAuth client there is no
  // callback to serve; the commands and `aseo doctor` name the two settings that enable it.
  const googleOAuth = googleOAuthDeps(config, db, keyProvider);
  app.get(
    '/oauth/callback',
    googleOAuth
      ? oauthCallbackRoute(googleOAuth)
      : (c: Context) =>
          c.text('Google Search Console is not configured on this server. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.', 404),
  );

  app.route('/', restApi({ auth, db, executor, origin }));

  // API-owned roots answer JSON on every role, even when nothing below them matched. An unmatched
  // OAuth path must never become the admin SPA or Hono's text/plain 404 (#751). Registered after
  // every real route above, so it only catches what nothing else claimed. SCIM is not ported.
  const apiNotFound = (c: Context) => c.json({ error: 'not_found', message: 'Not found.' }, 404);
  app.all('/oauth', apiNotFound);
  app.all('/oauth/*', apiNotFound);

  // Last, so every API route above wins. Without a build (packages/tests, server-only install) the
  // middleware is a no-op and the server behaves exactly as before.
  if (existsSync(config.webDist)) {
    app.use('*', staticSite({ root: config.webDist }));
    logger.info({ webDist: config.webDist }, 'serving the admin UI at /');
  }

  return {
    app,
    db,
    auth,
    executor,
    ready,
    keyProvider,
    directory,
    services,
    publicUrl: config.publicUrl,
    authSecret: config.authSecret,
  };
}
