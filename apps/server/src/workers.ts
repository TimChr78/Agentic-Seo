import { logger } from '@agentic-seo/telemetry';
import { type Runner, run } from 'graphile-worker';
import type { Config } from './config';

// Background work (ADR-0004). Phase 0 has no jobs yet: the crawler, provider syncs, change-set
// application and report rendering arrive with their phases. The runner is started now so the
// worker role is a real process with a real queue, its schema is created on first start, and a
// job registered later needs no infrastructure change.
//
// Both `worker` and `scheduler` start it: in Graphile Worker the same runtime executes jobs and a
// scheduler only decides when to enqueue them, and one process may hold both roles.

/** The task list. Each phase adds its tasks here; an unknown job is retried and then fails visibly. */
export const taskList = {} as const;

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
export async function startWorkers(config: Config, signal: AbortSignal): Promise<WorkerHandle> {
  const runner = await run({
    connectionString: config.adminDatabaseUrl,
    concurrency: config.worker.concurrency,
    pollInterval: config.worker.pollIntervalMs,
    taskList,
    // The process owns its signals; main.ts stops this runner explicitly.
    noHandleSignals: true,
  });
  logger.info({ concurrency: config.worker.concurrency, tasks: Object.keys(taskList).length }, 'worker role started');

  const stop = () => {
    logger.info('worker role stopping');
    runner.stop().catch((err) => logger.error({ err }, 'worker did not stop cleanly'));
  };
  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });

  return { runner, done: runner.promise.then(() => undefined) };
}

/**
 * The scheduler role's tick. Phase 0 has nothing recurring; the loop exists so later phases add
 * their enqueues in one place and the process has the same shape as the other roles.
 */
export function startScheduler(config: Config, signal: AbortSignal): { done: Promise<void> } {
  logger.info({ tickMs: config.worker.tickMs }, 'scheduler role started; no recurring jobs yet');
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
