import { runQueuedPromptTests } from '@agentic-seo/ai';
import { cleanupExpiredOAuthWorkspaceSelections } from '@agentic-seo/auth';
import type { Db } from '@agentic-seo/db';
import type { KeyProvider } from '@agentic-seo/secrets';
import { logger } from '@agentic-seo/telemetry';
import { type Runner, run, type TaskList } from 'graphile-worker';
import type { Config } from './config';
import { keyProviderFor } from './keys';

// Background work (ADR-0004). Phase 0 has two recurring jobs: the cross-tenant cleanup of abandoned
// OAuth consent choices, which cannot run in a request (it must see every workspace) and belongs to
// the scheduler, and the queued prompt test cases of the AI gateway, which call a model outside any
// transaction. The crawler, provider syncs, change-set application and report rendering arrive with
// their phases; their tasks go into the same list.
//
// Both `worker` and `scheduler` start a runner: in Graphile Worker the same runtime executes jobs
// and a scheduler only decides when to enqueue them, and one process may hold both roles. Only the
// scheduler registers the crontab, so a split deployment does not enqueue every job twice.

/** The cross-tenant sweep of abandoned OAuth consent choices. */
// Graphile Worker task identifiers allow letters, digits, `_`, `-` and `:` only (a dot fails the crontab parse).
export const CLEANUP_OAUTH_SELECTIONS_TASK = 'oauth_workspace_selections_cleanup';

/** Queued `prompts.test` cases; the command returns before the model is called. */
export const AI_PROMPT_TESTS_TASK = 'ai_prompt_tests';

/**
 * Recurring jobs in Graphile Worker's crontab format (minute hour day-of-month month weekday task).
 * Prompt tests are picked up within a minute, which is the latency the command's copy promises;
 * hourly is plenty for the consent choice, which lives for a day.
 */
export const CRONTAB = [`* * * * * ${AI_PROMPT_TESTS_TASK}`, `0 * * * * ${CLEANUP_OAUTH_SELECTIONS_TASK}`].join('\n');

/** The task list. Each phase adds its tasks here; an unknown job is retried and then fails visibly. */
export function taskListFor(db: Db, kp: KeyProvider): TaskList {
  return {
    [CLEANUP_OAUTH_SELECTIONS_TASK]: async () => {
      const removed = await cleanupExpiredOAuthWorkspaceSelections(db);
      if (removed) logger.info({ removed }, 'dropped expired OAuth workspace choices');
    },
    [AI_PROMPT_TESTS_TASK]: async () => {
      const handled = await runQueuedPromptTests(db, { kp });
      if (handled) logger.info({ handled }, 'ran queued prompt tests');
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
  const taskList = taskListFor(db, keyProviderFor(config));
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
