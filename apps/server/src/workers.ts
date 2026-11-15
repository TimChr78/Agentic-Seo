import { runQueuedPromptTests } from '@agentic-seo/ai';
import { cleanupExpiredOAuthWorkspaceSelections } from '@agentic-seo/auth';
import type { Db } from '@agentic-seo/db';
import { GSC_CONNECTOR_ID, refreshDueConnections } from '@agentic-seo/integrations';
import { createProviderGateway } from '@agentic-seo/providers';
import { runGscSync } from '@agentic-seo/search-data';
import type { KeyProvider } from '@agentic-seo/secrets';
import { logger } from '@agentic-seo/telemetry';
import { type Runner, run, type TaskList } from 'graphile-worker';
import type { Config } from './config';
import { googleOAuthDeps, providerAdapters } from './google';
import { keyProviderFor } from './keys';

// Background work (ADR-0004). Phase 0 has two jobs: the cross-tenant cleanup of abandoned OAuth
// consent choices, and the queued prompt tests of the AI gateway. Phase 1 adds the Google token
// refresher and the Search Console sync. The crawler, change-set application and report rendering
// arrive with their phases; their tasks go into the same list.
//
// Both `worker` and `scheduler` start a runner: in Graphile Worker the same runtime executes jobs
// and a scheduler only decides when to enqueue them, and one process may hold both roles. Only the
// scheduler registers the crontab, so a split deployment does not enqueue every job twice.

/** The cross-tenant sweep of abandoned OAuth consent choices. */
// Graphile Worker task identifiers allow letters, digits, `_`, `-` and `:` only (a dot fails the crontab parse).
export const CLEANUP_OAUTH_SELECTIONS_TASK = 'oauth_workspace_selections_cleanup';

/** Queued `prompts.test` cases; the command returns before the model is called. */
export const AI_PROMPT_TESTS_TASK = 'ai_prompt_tests';

/** Refreshes Google tokens that expire within ten minutes. */
export const CONNECTIONS_REFRESH_TASK = 'connections_refresh';

/** One site's Search Console sync, or the daily fan-out when it has no payload. */
export const GSC_SYNC_TASK = 'gsc_sync';

/**
 * Recurring jobs in Graphile Worker's crontab format (minute hour day-of-month month weekday task).
 * Google's access tokens last an hour, so the refresher runs every five minutes with a ten-minute
 * margin: a token is renewed before a call can use it. The Search Console sync runs once a day,
 * early in the UTC morning; the on-demand command enqueues the same per-site job.
 */
export const CRONTAB = [
  `* * * * * ${AI_PROMPT_TESTS_TASK}`,
  `0 * * * * ${CLEANUP_OAUTH_SELECTIONS_TASK}`,
  `*/5 * * * * ${CONNECTIONS_REFRESH_TASK}`,
  `0 3 * * * ${GSC_SYNC_TASK}`,
].join('\n');

/**
 * The task list. Each phase adds its tasks here; an unknown job is retried and then fails visibly.
 * `config` is optional so a test can list the tasks without building a server configuration; a job
 * that needs Google does nothing when the installation has no OAuth client.
 */
export function taskListFor(db: Db, kp: KeyProvider, config?: Config): TaskList {
  const providers = config ? createProviderGateway({ db, adapters: providerAdapters(config, db, kp) }) : undefined;
  return {
    [CLEANUP_OAUTH_SELECTIONS_TASK]: async () => {
      const removed = await cleanupExpiredOAuthWorkspaceSelections(db);
      if (removed) logger.info({ removed }, 'dropped expired OAuth workspace choices');
    },
    [AI_PROMPT_TESTS_TASK]: async () => {
      const handled = await runQueuedPromptTests(db, { kp });
      if (handled) logger.info({ handled }, 'ran queued prompt tests');
    },
    [CONNECTIONS_REFRESH_TASK]: async () => {
      const deps = config ? googleOAuthDeps(config, db, kp) : null;
      if (!deps) return;
      const { refreshed, failed } = await refreshDueConnections(deps);
      if (refreshed || failed) logger.info({ refreshed, failed }, 'refreshed Google connections');
    },
    [GSC_SYNC_TASK]: async (payload, helpers) => {
      if (!config || !providers) {
        logger.warn('the Search Console sync ran without a server configuration; nothing to do');
        return;
      }
      const job = (payload ?? {}) as { workspaceId?: unknown; siteId?: unknown };
      if (typeof job.workspaceId === 'string' && typeof job.siteId === 'string') {
        await runGscSync({ db, providers }, { workspaceId: job.workspaceId, siteId: job.siteId });
        return;
      }
      // The daily tick: queue one job per site, so one broken connection does not stop the rest.
      // The discovery query reads across workspaces; each sync then runs inside withWorkspace.
      const { rows } = await db.admin.query<{ workspace_id: string; site_id: string }>(
        `SELECT workspace_id, site_id FROM connections
          WHERE connector = $1 AND state = 'active'
            AND settings ->> 'property' IS NOT NULL
          ORDER BY workspace_id, site_id`,
        [GSC_CONNECTOR_ID],
      );
      for (const row of rows)
        await helpers.addJob(GSC_SYNC_TASK, { workspaceId: row.workspace_id, siteId: row.site_id }, { maxAttempts: 3 });
      if (rows.length) logger.info({ sites: rows.length }, 'queued Search Console syncs');
    },
  };
}

export interface WorkerHandle {
  runner: Runner;
  /** Resolves when the runner has stopped. */
  done: Promise<void>;
}

/**
 * Starts a Graphile Worker runner against the owner connection (the queue schema and its
 * bookkeeping tables are installation-level, not tenant data). `signal` stops it cleanly: the
 * runner finishes the jobs it holds before it resolves.
 */
export async function startWorkers(config: Config, signal: AbortSignal, db: Db): Promise<WorkerHandle> {
  const taskList = taskListFor(db, keyProviderFor(config), config);
  const scheduled = config.roles.has('scheduler');
  const runner = await run({
    connectionString: config.adminDatabaseUrl,
    concurrency: config.worker.concurrency,
    pollInterval: config.worker.pollIntervalMs,
    taskList,
    ...(scheduled ? { crontab: CRONTAB } : {}),
    // The process owns its signals; main.ts stops this runner explicitly.
    noHandleSignals: true,
  });
  logger.info({ concurrency: config.worker.concurrency, tasks: Object.keys(taskList).length, scheduled }, 'worker role started');

  const stop = () => {
    logger.info('worker role stopping');
    runner.stop().catch((err) => logger.error({ err }, 'worker did not stop cleanly'));
  };
  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });

  return { runner, done: runner.promise.then(() => undefined) };
}

/**
 * The scheduler role's tick. Recurring work is registered as the runner's crontab above; this loop
 * stays for the phases whose schedule depends on data (due audits, retry windows) rather than the
 * clock.
 */
export function startScheduler(config: Config, signal: AbortSignal): { done: Promise<void> } {
  logger.info({ tickMs: config.worker.tickMs }, 'scheduler role started');
  const done = new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      // Later phases enqueue due work here.
    }, config.worker.tickMs);
    timer.unref?.();
    const finish = () => {
      clearInterval(timer);
      resolve();
    };
    if (signal.aborted) finish();
    else signal.addEventListener('abort', finish, { once: true });
  });
  return { done };
}
