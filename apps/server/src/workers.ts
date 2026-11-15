import { runQueuedPromptTests } from '@agentic-seo/ai';
import { cleanupExpiredOAuthWorkspaceSelections } from '@agentic-seo/auth';
import {
  CHANGES_APPLY_TASK,
  CHANGES_POLL_TASK,
  CHANGES_VERIFY_TASK,
  runChangesApplyTask,
  runChangesPollTask,
  runChangesVerifyTask,
} from '@agentic-seo/change-sets';
import { type CrawlChunkPayload, PgHostLimiter, reconcileCrawls, runCrawlChunk } from '@agentic-seo/crawl';
import type { Db } from '@agentic-seo/db';
import { buildUserAgent } from '@agentic-seo/fetch';
import { GSC_CONNECTOR_ID, refreshDueConnections } from '@agentic-seo/integrations';
import { createProviderGateway } from '@agentic-seo/providers';
import { runGscSync } from '@agentic-seo/search-data';
import type { KeyProvider } from '@agentic-seo/secrets';
import { logger } from '@agentic-seo/telemetry';
import { type Runner, run, type TaskList } from 'graphile-worker';
import type { Config } from './config';
import { googleOAuthDeps, providerAdapters } from './google';
import { keyProviderFor } from './keys';
import { VERSION } from './version';

// Background work (ADR-0004). Phase 0 has two recurring jobs: the cross-tenant cleanup of abandoned
// OAuth consent choices, which cannot run in a request (it must see every workspace) and belongs to
// the scheduler, and the queued prompt test cases of the AI gateway, which call a model outside any
// transaction. Phase 1 adds the Google token refresher, the Search Console sync and the crawler:
// `crawl_chunk` seeds robots.txt and the sitemaps on its first run, then crawls up to 200 URLs of one
// audit, and `crawl_reconcile` dispatches queued audits and repairs stalled ones. `audits.run`
// enqueues its first chunk transactionally through migration 0007's `crawl_enqueue`; the reconciler
// is the fallback for an install whose Graphile schema did not exist yet. Change-set application and
// report rendering arrive with their phases; their tasks go into the same list.
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

/** One crawl chunk of one audit (crawler-and-audits.md §2). */
export const CRAWL_CHUNK_TASK = 'crawl_chunk';

/** The cross-tenant audit dispatcher and repairer; every write it makes is workspace-scoped. */
export const CRAWL_RECONCILE_TASK = 'crawl_reconcile';

/**
 * Recurring jobs in Graphile Worker's crontab format (minute hour day-of-month month weekday task).
 * Prompt tests are picked up within a minute, which is the latency the command's copy promises;
 * hourly is plenty for the consent choice, which lives for a day. Google's access tokens last an
 * hour, so the refresher runs every five minutes with a ten-minute margin. The Search Console sync
 * runs once a day, early in the UTC morning; the on-demand command enqueues the same per-site job.
 * The crawl reconciler runs every minute: it dispatches queued audits and repairs stalled ones.
 */
export const CRONTAB = [
  `* * * * * ${AI_PROMPT_TESTS_TASK}`,
  `0 * * * * ${CLEANUP_OAUTH_SELECTIONS_TASK}`,
  `*/5 * * * * ${CONNECTIONS_REFRESH_TASK}`,
  `0 3 * * * ${GSC_SYNC_TASK}`,
  `* * * * * ${CRAWL_RECONCILE_TASK}`,
  // Change sets wait on GitHub and a deploy; five minutes is the latency the change-set screen
  // promises, and the poller only reads what is already open.
  `*/5 * * * * ${CHANGES_POLL_TASK}`,
].join('\n');

/** Options the crawl tasks accept; the version goes into the honest user agent. */
export interface CrawlWorkerOptions {
  crawlVersion?: string;
  /** The most requests in flight to one host, globally. Default 4. */
  maxConcurrencyPerHost?: number;
}

/**
 * The task list. Each phase adds its tasks here; an unknown job is retried and then fails visibly.
 * `config` is optional so a test can list the tasks without building a server configuration; a job
 * that needs Google does nothing when the installation has no OAuth client.
 */
export function taskListFor(db: Db, kp: KeyProvider, config?: Config, options: CrawlWorkerOptions = {}): TaskList {
  const providers = config ? createProviderGateway({ db, adapters: providerAdapters(config, db, kp) }) : undefined;
  // One limiter per worker process: its leases live in Postgres, so every replica still shares the
  // per-host limit.
  const limiter = new PgHostLimiter(db, {
    owner: `worker:${process.pid}`,
    ...(options.maxConcurrencyPerHost === undefined ? {} : { maxConcurrencyPerHost: options.maxConcurrencyPerHost }),
  });
  const enqueueChunk = (payload: CrawlChunkPayload) => ({ jobKey: `crawl_chunk:${payload.auditId}:${payload.chunk}` });
  const dispatchKey = (payload: CrawlChunkPayload) => ({ jobKey: `crawl_dispatch:${payload.auditId}` });
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
    [CRAWL_CHUNK_TASK]: async (payload, helpers) => {
      const result = await runCrawlChunk(db, payload as CrawlChunkPayload, {
        limiter,
        version: options.crawlVersion ?? VERSION,
        logger,
        enqueueNext: (next, spec) =>
          helpers
            .addJob(CRAWL_CHUNK_TASK, next, { ...enqueueChunk(next), ...(spec?.runAt ? { runAt: spec.runAt } : {}) })
            .then(() => undefined),
      });
      logger.info({ ...result, auditId: (payload as CrawlChunkPayload).auditId }, 'crawl chunk ran');
    },
    [CRAWL_RECONCILE_TASK]: async (_payload, helpers) => {
      const result = await reconcileCrawls(db, {
        enqueue: (next) => helpers.addJob(CRAWL_CHUNK_TASK, next, dispatchKey(next)).then(() => undefined),
      });
      if (result.dispatched || result.finalized || result.repaired) logger.info(result, 'crawl reconciler ran');
    },
    // A change set's three jobs share one dependency bag; `enqueue` is per job because Graphile's
    // addJob belongs to the helper the handler receives.
    [CHANGES_APPLY_TASK]: async (payload, helpers) => {
      await runChangesApplyTask(db, payload, {
        kp,
        enqueue: (identifier, job, options) => helpers.addJob(identifier, job, options ?? {}).then(() => undefined),
      });
    },
    [CHANGES_POLL_TASK]: async (_payload, helpers) => {
      await runChangesPollTask(db, {
        kp,
        userAgent: userAgentFor(options),
        enqueue: (identifier, job, jobOptions) => helpers.addJob(identifier, job, jobOptions ?? {}).then(() => undefined),
      });
    },
    [CHANGES_VERIFY_TASK]: async (payload, helpers) => {
      await runChangesVerifyTask(db, payload, {
        kp,
        userAgent: userAgentFor(options),
        enqueue: (identifier, job, jobOptions) => helpers.addJob(identifier, job, jobOptions ?? {}).then(() => undefined),
      });
    },
  };
}

/** The honest user agent every change-set fetch uses (verification re-fetches the site's pages). */
function userAgentFor(options: CrawlWorkerOptions): string {
  return buildUserAgent({ version: options.crawlVersion ?? VERSION });
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
  const taskList = taskListFor(db, keyProviderFor(config), config, { crawlVersion: VERSION });
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
