import { runChangesApplyTask } from '@agentic-seo/change-sets';
import { setTxtResolver } from '@agentic-seo/sites';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { e2eBase, e2ePort, e2eReadinessPort } from '../../../../e2e/ports';
import { startFakeGitHub } from '../../../../packages/change-sets/test/support';
import { PASSWORD, startTestServer } from '../harness';

// A seeded server for Playwright and manual UI work:
//   corepack pnpm --filter @agentic-seo/web build && corepack pnpm exec tsx apps/server/test/e2e/server.ts
// It serves the built UI and the API on http://localhost:3100 (E2E_PORT) against a disposable
// database on the shared test Postgres, so a run never touches a real workspace. Stop with Ctrl-C;
// the next start re-creates the database. e2e/ports.ts moves the default port with TEST_PORT_OFFSET;
// E2E_DB names the database.
//
// The people (all with the harness's password, printed below at start):
//   owner@example.com       owns a workspace with one site, whose DNS record this process resolves
//   newcomer@example.com    owns a workspace with no sites; the journey creates its first one
//   no-sites@example.com    owns a workspace with no sites and is never changed (the no-site screen)
//   no-workspace@example.com  has an account but no workspace (the invitation is not accepted)

const PREFIX = 'verify-';

const t = await startTestServer(process.env.E2E_DB ?? 'e2e', e2ePort, { PUBLIC_URL: e2eBase });

// The thin loop applies through GitHub. This process has no worker and production egress reaches
// api.github.com, so both are replaced here: a local fake repository through the change-sets
// client's own seam (the same one packages/change-sets/test/support.ts uses), and one test-only
// route that runs the apply task the queue would run. Nothing outside this entry can reach either.
const github = await startFakeGitHub('main', {
  'index.html': '<!doctype html><html><head><title>MartechSignal</title></head><body><h1>MartechSignal</h1></body></html>',
  'content/pricing/index.html':
    '<!doctype html><html><head><title>A pricing page title that is far too long to be shown in full</title></head><body><h1>Pricing</h1></body></html>',
});
t.srv.services.github = github.seam;

// Playwright drives the loop through the UI and then runs the approved apply job once; the command
// queue would do this in a server with a worker. The route is registered on the app instance this
// test entry serves, so no production server has it.
t.srv.app.post('/test/changes/apply', async (c) => {
  const payload = await c.req.json<{ workspaceId: string; artifactId: string; siteId?: string }>();
  await runChangesApplyTask(t.srv.db, payload, { kp: t.srv.keyProvider, github: github.seam });
  return c.json({ ok: true });
});

// The DNS seam, reachable only from this test entry: a domain that starts with `verify-` resolves a
// TXT record carrying its own site's token, so the success path is exercised in a browser. Every
// other domain keeps the real "no record" answer, which is what the failure path asserts. The
// resolver reads the token the server created; nothing in production code can reach this override.
setTxtResolver(async (name) => {
  if (!name.startsWith(PREFIX)) {
    const missing = Object.assign(new Error(`queryTxt ENODATA ${name}`), { code: 'ENODATA' });
    throw missing;
  }
  const { rows } = await t.srv.db.admin.query<{ verification_token: string }>(
    'SELECT verification_token FROM sites WHERE primary_domain = $1',
    [name],
  );
  const token = rows[0]?.verification_token;
  return token ? [[`aseo-site-verification=${token}`]] : [[]];
});

const seedStarted = Date.now();
const owner = await t.signUp('owner@example.com');
const ownerWorkspace = await t.workspaceWith([[owner, 'owner']]);
await t.api(owner, ownerWorkspace).call('sites.create', { name: 'MartechSignal', domain: `${PREFIX}martechsignal.example.com` });

const newcomer = await t.signUp('newcomer@example.com');
await t.workspaceWith([[newcomer, 'owner']]);

const noSites = await t.signUp('no-sites@example.com');
await t.workspaceWith([[noSites, 'owner']]);

// An account without a workspace: the invitation has not been accepted, which is its own screen.
await t.signUp('no-workspace@example.com');

console.log(`Seeded in ${((Date.now() - seedStarted) / 1000).toFixed(1)}s`);

// Playwright waits for this, not /healthz: the API answers before the seed finishes, and the specs
// would otherwise race it. It is a separate listener so the app's own routes stay untouched.
const readiness = new Hono();
readiness.get('/ready', (c) => c.text('ok'));
const readinessHttp = serve({ fetch: readiness.fetch, port: e2eReadinessPort, hostname: '127.0.0.1' });

console.log(`\nReady on ${t.base}`);
console.log(`  database ${t.dbName}`);
for (const email of ['owner@example.com', 'newcomer@example.com', 'no-sites@example.com', 'no-workspace@example.com']) {
  console.log(`  ${email}`);
}
console.log(`  password ${PASSWORD}\n`);

const stop = async () => {
  readinessHttp.close();
  await github.close();
  await t.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
