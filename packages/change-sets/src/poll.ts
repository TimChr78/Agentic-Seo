import { type DeployResult, detectGitHubDeployment, detectVersionFile, timeoutAfter } from '@agentic-seo/changes';
import { crawlFetchSeams } from '@agentic-seo/crawl';
import type { Db } from '@agentic-seo/db';
import { schema } from '@agentic-seo/db';
import type { KeyProvider } from '@agentic-seo/secrets';
import { logger } from '@agentic-seo/telemetry';
import { and, eq } from 'drizzle-orm';
import { activeConnection, clientFor, type GitHubSeam } from './connector';
import { type ChangeSetJobPayload, changeSetJobKey, enqueueChangeSetJob } from './enqueue';
import { invalidateApproval, loadRun, recordEvent, transition } from './state';
import { CHANGES_APPLY_TASK, CHANGES_VERIFY_TASK } from './tasks';

// The five-minute poller (ADR-0007): PR open → merged → deploying → deployed. It is the only place
// that reads GitHub's opinion of the pull request and the site's opinion of the deployment, and it
// records both as states with evidence, so "merged but not live" is a visible state and not a
// guess.
//
// It also enforces the stale-approval rule: a commit pushed to the pull request after approval makes
// the head differ from the SHA the approval covered, and the change set returns to review with its
// approval invalidated. The pull request is closed, because a pull request Agentic SEO opened that
// is no longer approved must not be merged by mistake; the branch keeps the work.
//
// Cross-tenant discovery runs on the owner connection (the poller is a scheduler job with no
// workspace); every write happens inside `db.withWorkspace`.

export interface PollDeps {
  kp: KeyProvider;
  github?: GitHubSeam;
  now?: () => Date;
  /** Queues the verification job once a deploy is detected, when the durability wrapper cannot. */
  enqueue?: (identifier: string, payload: Record<string, unknown>, options?: { runAt?: Date; jobKey?: string }) => Promise<void>;
  /** The task identifier for verification; the server passes its own constant. */
  verifyTask?: string;
  /**
   * The URL a deploy detector reads, from the site's primary domain. Production uses
   * `https://<domain>`; a test points it at its fixture site, whose port a domain cannot carry.
   */
  siteUrlFor?: (domain: string) => string;
  /**
   * How long an `approved` or `deployed` change set may wait for its job before the poller queues
   * it again. Defaults to 15 minutes (three five-minute polls).
   */
  reconcileAfterMinutes?: number;
}

export interface PollSummary {
  polled: number;
  merged: number;
  deployed: number;
  invalidated: number;
  closed: number;
  failed: number;
  queued: number;
  /** Jobs the reconciliation queued again because their state had not moved. */
  requeued: number;
}

interface DeployContext {
  run: Awaited<ReturnType<typeof loadRun>>;
  settings: Awaited<ReturnType<typeof activeConnection>>['settings'];
  token: string;
  domain: string;
}

/** Runs the detector for one `deploying` change set and records what it found. */
async function detectDeploy(
  db: Db,
  client: ReturnType<typeof clientFor>,
  context: DeployContext,
  deps: PollDeps,
  summary: PollSummary,
): Promise<void> {
  const { run, settings } = context;
  const now = deps.now ?? (() => new Date());
  if (!run.mergeCommitSha) return;
  const hours = settings.deployTimeoutHours;
  const siteUrl = deps.siteUrlFor?.(context.domain) ?? `https://${context.domain}`;
  const seams = crawlFetchSeams();

  let result: DeployResult;
  if (settings.deploy.detector === 'version_file') {
    result = await detectVersionFile({
      siteUrl,
      mergeSha: run.mergeCommitSha,
      versionPath: settings.deploy.path,
      compare: (base, head) => client.compareCommits(base, head),
      ...(seams.resolver ? { resolver: seams.resolver } : {}),
      ...(seams.allow ? { allow: seams.allow } : {}),
      ...(seams.ca ? { ca: seams.ca } : {}),
    });
  } else {
    result = await detectGitHubDeployment({
      mergeSha: run.mergeCommitSha,
      environment: settings.deploy.environment,
      github: client,
    });
  }

  // A detector that cannot tell (`unknown`) counts toward the deploy window exactly like a pending
  // one: a site that never publishes its version file, or whose comparison keeps failing, is not a
  // change that may wait forever. Only `deployed` stops the clock.
  const decided: DeployResult | { code: 'deploy_not_detected'; reason: string } =
    result.state === 'deployed' ? result : (timeoutAfter({ startedAt: run.mergedAt ?? run.createdAt, hours, now: now() }) ?? result);
  const detectorEvidence = {
    detector: result.detector,
    detectorState: result.state,
    detectorReason: 'reason' in result && result.reason ? result.reason : null,
  };

  if ('code' in decided) {
    await db.withWorkspace(run.workspaceId, async (tx) => {
      const current = await loadRun(tx, run.workspaceId, run.artifactId);
      if (current.state !== 'deploying') return;
      await transition(tx, current, 'deploy_not_detected', {
        reason: decided.reason,
        actor: { type: 'system' },
        evidence: {
          mergeCommitSha: run.mergeCommitSha,
          deployTimeoutHours: hours,
          ...detectorEvidence,
        },
        at: now(),
        set: {
          lastError: `${decided.reason} The deploy detector last reported: ${result.state === 'unknown' ? result.reason : 'not live yet'}.`,
        },
      });
    });
    summary.failed += 1;
    return;
  }

  if (decided.state === 'deployed') {
    const payload: ChangeSetJobPayload = { workspaceId: run.workspaceId, artifactId: run.artifactId, siteId: run.siteId };
    let durable = false;
    const moved = await db.withWorkspace(run.workspaceId, async (tx) => {
      const current = await loadRun(tx, run.workspaceId, run.artifactId);
      if (current.state !== 'deploying') return null;
      const transitioned = await transition(tx, current, 'deployed', {
        reason: `The deployed commit ${decided.deployedSha} contains the merge commit ${run.mergeCommitSha}.`,
        actor: { type: 'system' },
        evidence: { detector: decided.detector, deployedSha: decided.deployedSha, mergeCommitSha: run.mergeCommitSha },
        at: now(),
        set: { deployedSha: decided.deployedSha, lastError: null },
      });
      if (!transitioned) return null;
      // The verification job is queued in this same transaction: a crash after the commit cannot
      // leave a deployed change set with nothing to verify it.
      durable = await enqueueChangeSetJob(tx, CHANGES_VERIFY_TASK, payload);
      return transitioned;
    });
    if (!moved) return;
    summary.deployed += 1;
    if (durable) {
      summary.queued += 1;
    } else if (deps.enqueue && deps.verifyTask) {
      await deps.enqueue(deps.verifyTask, payload, { jobKey: changeSetJobKey(CHANGES_VERIFY_TASK, run.artifactId) });
      summary.queued += 1;
    }
    return;
  }

  // Still pending, or the detector cannot tell yet: stay deploying. The reason is kept on the row so
  // `changes.status` explains the wait without an event per poll.
  await db.withWorkspace(run.workspaceId, async (tx) => {
    const current = await loadRun(tx, run.workspaceId, run.artifactId);
    if (current.state !== 'deploying') return;
    const reason =
      decided.state === 'unknown'
        ? `The deploy could not be detected yet: ${decided.reason}`
        : `The deploy has not reached the merge commit yet.${decided.reason ? ` ${decided.reason}` : ''}`;
    await tx
      .update(schema.changeSetRuns)
      .set({ lastError: reason, updatedAt: now() })
      .where(and(eq(schema.changeSetRuns.workspaceId, run.workspaceId), eq(schema.changeSetRuns.artifactId, run.artifactId)));
  });
}

/** One update for one change set; returns what happened so the caller can count it. */
async function pollOne(db: Db, target: { workspaceId: string; artifactId: string }, deps: PollDeps, summary: PollSummary): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const prepared = await db.withWorkspace(target.workspaceId, async (tx) => {
    const run = await loadRun(tx, target.workspaceId, target.artifactId);
    if (run.state !== 'pr_open' && run.state !== 'deploying') return null;
    const [site] = await tx
      .select({ domain: schema.sites.primaryDomain })
      .from(schema.sites)
      .where(and(eq(schema.sites.workspaceId, target.workspaceId), eq(schema.sites.id, run.siteId)));
    if (!site) return null;
    try {
      const connection = await activeConnection(tx, { workspaceId: target.workspaceId, siteId: run.siteId, kp: deps.kp });
      return { run, settings: connection.settings, token: connection.token, domain: site.domain };
    } catch (error) {
      // A disconnected repository cannot be polled: say so once, on the row, and stop.
      await tx
        .update(schema.changeSetRuns)
        .set({ lastError: error instanceof Error ? error.message : String(error), updatedAt: now() })
        .where(and(eq(schema.changeSetRuns.workspaceId, target.workspaceId), eq(schema.changeSetRuns.artifactId, target.artifactId)));
      return null;
    }
  });
  if (!prepared) return;
  const client = clientFor(prepared.settings, prepared.token, deps.github);

  if (prepared.run.state === 'pr_open') {
    if (prepared.run.prNumber === null) return;
    const pr = await client.getPullRequest(prepared.run.prNumber);

    // The head the approval covers, checked before any progression: an open PR that moved on, and
    // equally a PR that was merged before the poller saw the push. A merged PR whose head is not
    // the approved commit contains work nobody approved; it must not be deployed or verified as if
    // it were the change set.
    const unexpectedHead = !prepared.run.approvedHeadSha || pr.headSha !== prepared.run.approvedHeadSha;
    if (pr.merged && unexpectedHead) {
      const failed = await db.withWorkspace(target.workspaceId, async (tx) => {
        const current = await loadRun(tx, target.workspaceId, target.artifactId);
        if (current.state !== 'pr_open') return null;
        const reason = `Pull request #${pr.number} was merged with commits that were not approved: its head is ${pr.headSha || '(unknown)'}, but approval covered ${current.approvedHeadSha ?? '(no recorded head)'}. Nothing is deployed or verified for this change set; a person must decide what to do with the merged content.`;
        return transition(tx, current, 'failed', {
          reason,
          actor: { type: 'system' },
          evidence: {
            prNumber: pr.number,
            mergeCommitSha: pr.mergeCommitSha,
            approvedHeadSha: current.approvedHeadSha,
            mergedHeadSha: pr.headSha,
            baseSha: pr.baseSha,
          },
          at: now(),
          set: { mergeCommitSha: pr.mergeCommitSha ?? `unknown:${pr.number}`, mergedAt: now(), lastError: reason },
        });
      });
      if (failed) summary.failed += 1;
      return;
    }

    if (pr.merged) {
      const merged = await db.withWorkspace(target.workspaceId, async (tx) => {
        const current = await loadRun(tx, target.workspaceId, target.artifactId);
        if (current.state !== 'pr_open') return null;
        const at = now();
        const asMerged = await transition(tx, current, 'merged', {
          reason: `Pull request #${pr.number} was merged at ${pr.mergeCommitSha ?? 'an unknown commit'}.`,
          actor: { type: 'system' },
          evidence: { prNumber: pr.number, mergeCommitSha: pr.mergeCommitSha, baseSha: pr.baseSha, headSha: pr.headSha },
          at,
          set: { mergeCommitSha: pr.mergeCommitSha ?? `unknown:${pr.number}`, mergedAt: at },
        });
        if (!asMerged) return null;
        return transition(tx, asMerged, 'deploying', {
          reason: 'Waiting for the deployed site to serve the merge commit.',
          actor: { type: 'system' },
          at,
        });
      });
      if (merged) {
        summary.merged += 1;
        await detectDeploy(db, client, { ...prepared, run: merged }, deps, summary);
      }
      return;
    }

    // A push after approval: the commit under review is not the commit that was approved.
    if (pr.state === 'open' && unexpectedHead) {
      const invalidated = await db.withWorkspace(target.workspaceId, async (tx) => {
        const current = await loadRun(tx, target.workspaceId, target.artifactId);
        if (current.state !== 'pr_open') return null;
        return invalidateApproval(tx, current, {
          reason: `A commit was pushed to pull request #${pr.number} after approval, so the approval no longer covers what would be merged. Approve the change set again.`,
          evidence: { approvedHeadSha: current.approvedHeadSha, headSha: pr.headSha, prNumber: pr.number },
          at: now(),
        });
      });
      if (invalidated) {
        summary.invalidated += 1;
        // Closing our own pull request is the safe half of the invalidation: the branch keeps the
        // work, and nobody merges a change whose approval was withdrawn.
        await client.closePullRequest(pr.number).catch((error: unknown) => {
          logger.warn({ artifactId: target.artifactId, err: error }, 'could not close the stale-approval pull request');
        });
      }
      return;
    }

    if (pr.state === 'closed') {
      const closed = await db.withWorkspace(target.workspaceId, async (tx) => {
        const current = await loadRun(tx, target.workspaceId, target.artifactId);
        if (current.state !== 'pr_open') return null;
        return transition(tx, current, 'closed', {
          reason: `Pull request #${pr.number} was closed without being merged, so nothing was applied.`,
          actor: { type: 'system' },
          evidence: { prNumber: pr.number, headSha: pr.headSha },
          at: now(),
        });
      });
      if (closed) summary.closed += 1;
    }
    return;
  }

  await detectDeploy(db, client, prepared, deps, summary);
}

/**
 * Queues the job of a change set whose state moved but whose job never ran.
 *
 * The transactional enqueue in the publish hook and the deploy transition makes a lost job unlikely,
 * but not impossible: an install without Graphile's schema falls back to the server's helper, and
 * that call can fail after the commit. A change set that has been `approved` or `deployed` for the
 * whole window with no event saying its job was queued again is exactly that case. The event written
 * here is also the dedupe: a second poll within the window does not queue it twice.
 */
async function reconcileLostJobs(db: Db, deps: PollDeps, summary: PollSummary): Promise<void> {
  const minutes = deps.reconcileAfterMinutes ?? 15;
  const { rows } = await db.admin.query<{ workspace_id: string; artifact_id: string; site_id: string; state: 'approved' | 'deployed' }>(
    `SELECT r.workspace_id::text AS workspace_id, r.artifact_id, r.site_id::text AS site_id, r.state
       FROM change_set_runs r
      WHERE (
              (r.state = 'deployed' AND r.deployed_at < now() - ($1::int * interval '1 minute') AND r.verification_attempts < 3)
              OR (r.state = 'approved' AND r.approved_at < now() - ($1::int * interval '1 minute'))
            )
        AND NOT EXISTS (
              SELECT 1 FROM change_set_events e
               WHERE e.workspace_id = r.workspace_id
                 AND e.artifact_id = r.artifact_id
                 AND e.evidence ->> 'reconcile' IN ('changes_apply', 'changes_verify')
                 AND e.at > now() - ($1::int * interval '1 minute')
            )
      ORDER BY r.workspace_id, r.artifact_id`,
    [minutes],
  );

  for (const row of rows) {
    const task = row.state === 'deployed' ? CHANGES_VERIFY_TASK : CHANGES_APPLY_TASK;
    const payload: ChangeSetJobPayload = { workspaceId: row.workspace_id, artifactId: row.artifact_id, siteId: row.site_id };
    const durable = await db.withWorkspace(row.workspace_id, async (tx) => {
      const current = await loadRun(tx, row.workspace_id, row.artifact_id);
      if (current.state !== row.state) return null;
      const enqueued = await enqueueChangeSetJob(tx, task, payload);
      await recordEvent(tx, {
        workspaceId: row.workspace_id,
        artifactId: row.artifact_id,
        fromState: current.state,
        toState: current.state,
        actor: { type: 'system' },
        reason:
          task === CHANGES_VERIFY_TASK
            ? `Verification did not run within ${minutes} minutes of the deploy; queued it again.`
            : `The apply job did not run within ${minutes} minutes of approval; queued it again.`,
        evidence: { reconcile: task, enqueued },
      });
      return enqueued;
    });
    if (durable === null) continue;
    if (durable) {
      summary.requeued += 1;
    } else if (deps.enqueue) {
      await deps.enqueue(task, payload, { jobKey: changeSetJobKey(task, row.artifact_id) });
      summary.requeued += 1;
    }
  }
}

/** Everything waiting on GitHub or a deploy, for every workspace. */
export async function runChangesPoll(db: Db, deps: PollDeps): Promise<PollSummary> {
  const summary: PollSummary = { polled: 0, merged: 0, deployed: 0, invalidated: 0, closed: 0, failed: 0, queued: 0, requeued: 0 };
  const { rows } = await db.admin.query<{ workspace_id: string; artifact_id: string }>(
    `SELECT workspace_id::text AS workspace_id, artifact_id
       FROM change_set_runs
      WHERE state IN ('pr_open', 'deploying')
      ORDER BY workspace_id, artifact_id`,
  );
  for (const row of rows) {
    summary.polled += 1;
    try {
      await pollOne(db, { workspaceId: row.workspace_id, artifactId: row.artifact_id }, deps, summary);
    } catch (error) {
      logger.warn({ artifactId: row.artifact_id, err: error }, 'change set poll failed for one change set');
    }
  }
  await reconcileLostJobs(db, deps, summary);
  return summary;
}
