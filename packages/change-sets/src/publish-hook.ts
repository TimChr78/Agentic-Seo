import { publishHooks, versionClosedHooks } from '@agentic-seo/artifacts';
import { logger } from '@agentic-seo/telemetry';
import { type ChangeSetJobPayload, enqueueChangeSetJob } from './enqueue';
import { actorOf, findRun, transition } from './state';
import { CHANGES_APPLY_TASK } from './tasks';

// Publishing a change set *is* the approval to apply it (ADR-0007, agents-and-autonomy §3). The
// artifact approval flow already decided whether that publish needed a person; this hook is the
// bridge from "the version is live" to "the apply job may run", written inside the publish
// transaction so the two cannot disagree: a published version whose run row was not marked approved
// would sit forever, and an approved run around a version that never published would apply work
// nobody approved.

/** States a publish may move to `approved` from: anything before the change reaches GitHub. */
const APPLICABLE = ['draft', 'in_review', 'approved', 'stale', 'closed', 'verification_failed', 'deploy_not_detected', 'failed'];

let registered = false;

/**
 * Registers the publish hook once. The server calls it at startup; a package import also does, so a
 * test that publishes a change set exercises the real path.
 */
export function registerChangeSetPublishHook(): void {
  if (registered) return;
  registered = true;
  publishHooks.push(async (ctx, artifact, version) => {
    if (artifact.type !== 'change_set') return;
    const run = await findRun(ctx.tx, artifact.workspaceId, artifact.id);
    if (!run || !APPLICABLE.includes(run.state)) return;
    const moved = await transition(ctx.tx, run, 'approved', {
      reason: `Version ${version} was published, so it is approved to be applied through the site's GitHub connector.`,
      actor: actorOf(ctx),
      evidence: { version, previousState: run.state },
      set: { approvedVersion: version, approvedHeadSha: null, lastError: null },
    });
    if (!moved) {
      logger.warn({ artifactId: artifact.id, version }, 'a change set was published but its run row moved at the same time');
      return;
    }
    const payload: ChangeSetJobPayload = { workspaceId: artifact.workspaceId, artifactId: artifact.id, siteId: moved.siteId };
    // Durable first: the job is inserted in this transaction, so the commit and the job cannot
    // disagree. When Graphile's schema is absent the wrapper returns false and the helper (called
    // after commit) is the fallback; the poller reconciles an `approved` row either way.
    const durable = await enqueueChangeSetJob(ctx.tx, CHANGES_APPLY_TASK, payload);
    if (durable) return;
    const enqueue = ctx.services.enqueueTask;
    if (!enqueue) {
      // Without a queue the change set waits in `approved`, which `changes.status` reports and the
      // poller's reconciliation queues once a queue exists. Every server wires jobs, so this is a
      // misconfigured install rather than a normal path.
      logger.warn({ artifactId: artifact.id }, 'no background queue is configured; the approved change set will wait for reconciliation');
      return;
    }
    const job = () => enqueue(CHANGES_APPLY_TASK, payload);
    if (ctx.afterCommit) ctx.afterCommit(job);
    else await job();
  });
}

/** States a rejected request or a discarded draft may close: nothing of this version reached GitHub. */
const PRE_GITHUB = ['draft', 'in_review', 'approved'];

let closedRegistered = false;

/**
 * Registers the hook that moves a change set's run on when its version is closed without publishing:
 * `approvals.reject` rejected the request, or `artifacts.discardDraft` discarded the version.
 *
 * Without it the run stays `in_review`, which is a lie about the world and — worse — keeps the
 * rollback guard busy: a rejected rollback proposal would block the next `changes.rollback` forever
 * because the run still looks open. The artifact version is what a reviewer acted on, so the run
 * follows it: rejected, discarded, nothing applied.
 */
export function registerChangeSetClosedHook(): void {
  if (closedRegistered) return;
  closedRegistered = true;
  versionClosedHooks.push(async (ctx, artifact, version, how) => {
    if (artifact.type !== 'change_set') return;
    const run = await findRun(ctx.tx, artifact.workspaceId, artifact.id);
    if (!run || !PRE_GITHUB.includes(run.state)) return;
    // Only the version the run was waiting on closes it. Rejecting a newer draft while an earlier
    // version is live changes nothing about where the change set is.
    if (run.approvedVersion !== null && run.approvedVersion !== version) return;
    const what =
      how === 'rejected'
        ? `The approval request for version ${version} was rejected, so nothing was applied`
        : `Version ${version} was discarded, so nothing was applied`;
    const moved = await transition(ctx.tx, run, 'closed', {
      reason: `${what}. Draft it again with changes.updateDraft if the change is still wanted.`,
      actor: { type: 'system', id: null },
      evidence: { version, how },
      set: { approvalId: null },
    });
    if (!moved) logger.warn({ artifactId: artifact.id, version }, 'a change set version closed but its run row moved at the same time');
  });
}
