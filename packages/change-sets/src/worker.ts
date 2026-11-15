import type { Db } from '@agentic-seo/db';
import type { KeyProvider } from '@agentic-seo/secrets';
import { logger } from '@agentic-seo/telemetry';
import { runChangesApply } from './apply';
import type { GitHubSeam } from './connector';
import { runChangesPoll } from './poll';
import { CHANGES_VERIFY_TASK } from './tasks';
import { runChangesVerify } from './verify';

// The three graphile-worker tasks (apps/server/src/workers.ts registers them):
//
// - `changes_apply` runs once per approved change set. A transient GitHub failure is rethrown so the
//   queue retries it and the retry adopts whatever the first attempt created.
// - `changes_poll` runs every five minutes, discovers work across workspaces and acts inside
//   `db.withWorkspace`. It also re-enqueues a verification retry with a backoff.
// - `changes_verify` re-fetches the affected URLs against the deployed commit.
//
// The enqueue callback is supplied per job by the server, because Graphile's `addJob` belongs to the
// job's helper object. A direct call from a test can leave it out and read the returned result.

export interface ChangeSetTaskDeps {
  kp: KeyProvider;
  /** Test seam: a local fake GitHub through the client's request function. */
  github?: GitHubSeam;
  /** The crawler's user agent for verification fetches. */
  userAgent?: string;
  now?: () => Date;
  enqueue?: (identifier: string, payload: Record<string, unknown>, options?: { runAt?: Date; jobKey?: string }) => Promise<void>;
  /** Test seam: where the deploy detector reads a site, when its domain cannot carry a port. */
  siteUrlFor?: (domain: string) => string;
}

/** The payload every change-set job carries. */
export interface ChangeSetPayload {
  workspaceId: string;
  siteId?: string;
  artifactId: string;
}

function payloadOf(raw: unknown): ChangeSetPayload {
  const payload = (raw ?? {}) as { workspaceId?: unknown; artifactId?: unknown; siteId?: unknown };
  if (typeof payload.workspaceId !== 'string' || typeof payload.artifactId !== 'string') {
    throw new Error('a change-set job needs a workspaceId and an artifactId');
  }
  return {
    workspaceId: payload.workspaceId,
    artifactId: payload.artifactId,
    ...(typeof payload.siteId === 'string' ? { siteId: payload.siteId } : {}),
  };
}

/** `changes_apply`: apply one approved change set as a pull request. */
export async function runChangesApplyTask(db: Db, raw: unknown, deps: ChangeSetTaskDeps): Promise<void> {
  const payload = payloadOf(raw);
  const result = await runChangesApply(db, payload, {
    kp: deps.kp,
    ...(deps.github ? { github: deps.github } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (result.status === 'stale' || result.status === 'failed') {
    // Recorded on the run row and its event log; retrying would hit the same refusal.
    logger.warn({ artifactId: payload.artifactId, status: result.status, reason: result.reason }, 'change set was not applied');
    return;
  }
  logger.info({ artifactId: payload.artifactId, status: result.status }, 'change set apply ran');
}

/** `changes_poll`: pull request state, stale approvals, merge and deploy detection. */
export async function runChangesPollTask(db: Db, deps: ChangeSetTaskDeps): Promise<void> {
  const summary = await runChangesPoll(db, {
    kp: deps.kp,
    ...(deps.github ? { github: deps.github } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    verifyTask: CHANGES_VERIFY_TASK,
    ...(deps.enqueue ? { enqueue: deps.enqueue } : {}),
    ...(deps.siteUrlFor ? { siteUrlFor: deps.siteUrlFor } : {}),
  });
  if (summary.polled) logger.info(summary, 'change set poller ran');
}

/** `changes_verify`: re-fetch the affected URLs and record pass/fail per change. */
export async function runChangesVerifyTask(db: Db, raw: unknown, deps: ChangeSetTaskDeps): Promise<void> {
  const payload = payloadOf(raw);
  const result = await runChangesVerify(db, payload, {
    ...(deps.userAgent ? { userAgent: deps.userAgent } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.siteUrlFor ? { siteUrlFor: deps.siteUrlFor } : {}),
  });
  if (result.status === 'retry') {
    if (deps.enqueue) {
      await deps.enqueue(
        CHANGES_VERIFY_TASK,
        { workspaceId: payload.workspaceId, siteId: payload.siteId, artifactId: payload.artifactId },
        {
          runAt: new Date((deps.now?.() ?? new Date()).getTime() + result.retryAfterMs),
          jobKey: `${CHANGES_VERIFY_TASK}:${payload.artifactId}:${result.attempt + 1}`,
        },
      );
    }
    logger.info({ artifactId: payload.artifactId, attempt: result.attempt }, 'verification could not fetch every page; retrying');
    return;
  }
  logger.info({ artifactId: payload.artifactId, status: result.status }, 'change set verification ran');
}
