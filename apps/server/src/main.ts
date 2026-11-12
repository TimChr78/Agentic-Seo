import { migrateAuth } from '@agentic-seo/auth';
import { createDb, migrate } from '@agentic-seo/db';
import { initTelemetry, logger, shutdownTelemetry } from '@agentic-seo/telemetry';
import { serve } from '@hono/node-server';
import { createServer } from './app';
import { ConfigError, loadConfig } from './config';
import { COMMIT, VERSION } from './version';
import { startScheduler, startWorkers } from './workers';

// One image, several roles (ADR-0004): `api` (UI, REST, MCP), `worker` (background jobs) and
// `scheduler` (recurring enqueues). `all` runs everything in one process, the Compose default.
let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  // A container log should say what to fix, not show a stack from loadConfig.
  console.error(err.message);
  process.exit(1);
}
initTelemetry('agentic-seo');
logger.info({ version: VERSION, commit: COMMIT }, 'agentic-seo starting');

// Migrate before the auth instance exists: Better Auth validates its schema when it is created
// and caches a mismatch, so a fresh database would otherwise fail every auth request.
if (!config.skipMigrations) {
  const boot = createDb({ adminUrl: config.adminDatabaseUrl, appUrl: config.appDatabaseUrl });
  try {
    await migrate(boot.admin, { appRolePassword: config.appDbPassword, appRole: config.appDbRole, log: (m) => logger.info(m) });
    // 0002 already carries Better Auth's tables; this keeps an installation that was created by an
    // older build, or whose auth plugin set changed, in step with the library.
    await migrateAuth({ baseUrl: config.publicUrl, secret: config.authSecret, db: boot });
  } finally {
    await boot.close();
  }
}

const srv = createServer(config);
const { app, db } = srv;

const servers: { close: () => void }[] = [];
if (config.roles.has('api')) {
  servers.push(
    serve({ fetch: app.fetch, port: config.port }, () => logger.info({ url: config.publicUrl, roles: [...config.roles] }, 'api listening')),
  );
}

const stopWorkers = new AbortController();
const running: Promise<void>[] = [];
// One Graphile Worker runner serves both roles when a process holds both, so ROLE=all does not
// start two runners on the same queue.
if (config.roles.has('worker') || config.roles.has('scheduler')) {
  running.push((await startWorkers(config, stopWorkers.signal, db)).done);
}
if (config.roles.has('scheduler')) running.push(startScheduler(config, stopWorkers.signal).done);

const shutdown = async () => {
  logger.info('shutting down');
  for (const s of servers) s.close();
  stopWorkers.abort();
  await Promise.allSettled(running);
  await db.close();
  await shutdownTelemetry();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
