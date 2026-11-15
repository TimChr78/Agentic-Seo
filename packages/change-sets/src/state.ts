import { schema, type Tx } from '@agentic-seo/db';

/** The states a change-set run can be in (0010_change_sets.sql lists them with their meaning). */
export type ChangeSetState =
  | 'draft'
  | 'in_review'
  | 'approved'
  | 'applying'
  | 'pr_open'
  | 'merged'
  | 'deploying'
  | 'deployed'
  | 'verified'
  | 'verification_failed'
  | 'deploy_not_detected'
  | 'closed'
  | 'stale'
  | 'rolled_back'
  | 'superseded'
  | 'failed';

/** Who caused a transition. */
export type ChangeSetActor = 'person' | 'agent' | 'system';

import { and, eq, inArray, sql } from 'drizzle-orm';

// The change-set state machine (ADR-0007, domain-model §4). One row per change set records where the
// change is in the world; every transition appends a `change_set_events` row with the reason and the
// evidence, because there is no audit outbox yet and a reviewer has to be able to answer "why did
// this go back to review?" without reading logs.
//
// Transitions are compare-and-set on the state that was read: a poller and an apply job that race
// cannot both advance the same change set, and the loser re-reads instead of overwriting.

export const CHANGE_SET_STATES = [
  'draft',
  'in_review',
  'approved',
  'applying',
  'pr_open',
  'merged',
  'deploying',
  'deployed',
  'verified',
  'verification_failed',
  'deploy_not_detected',
  'closed',
  'stale',
  'rolled_back',
  'superseded',
  'failed',
] as const satisfies readonly ChangeSetState[];

/**
 * A change set that still holds a claim on its site's URLs and source files. The conflict hold
 * reads these, so terminal history never blocks new work.
 */
export const OPEN_STATES = ['draft', 'in_review', 'approved', 'applying', 'pr_open', 'merged', 'deploying', 'deployed'] as const;

/** States after which no further progress happens without a new draft. */
export const TERMINAL_STATES = [
  'verified',
  'verification_failed',
  'deploy_not_detected',
  'closed',
  'stale',
  'rolled_back',
  'superseded',
  'failed',
] as const;

export type ChangeSetRun = typeof schema.changeSetRuns.$inferSelect;

/** Who caused a transition, from a command context. */
export function actorOf(ctx: { principal: { type: 'user' | 'agent'; userId: string; agent?: { id: string } } }): {
  type: ChangeSetActor;
  id: string;
} {
  return ctx.principal.type === 'user'
    ? { type: 'person', id: ctx.principal.userId }
    : { type: 'agent', id: ctx.principal.agent?.id ?? ctx.principal.userId };
}

export interface TransitionOptions {
  reason: string;
  actor: { type: ChangeSetActor; id?: string | null };
  evidence?: Record<string, unknown>;
  at?: Date;
  /** Columns to write with the transition (SHAs, branch, error). */
  set?: Partial<typeof schema.changeSetRuns.$inferInsert>;
}

/** The timestamp column a state records, so the pipeline strip shows when each step happened. */
const STAMP: Partial<Record<ChangeSetState, keyof typeof schema.changeSetRuns.$inferInsert>> = {
  in_review: 'submittedAt',
  approved: 'approvedAt',
  pr_open: 'appliedAt',
  merged: 'mergedAt',
  deployed: 'deployedAt',
  verified: 'verifiedAt',
  closed: 'closedAt',
  failed: 'failedAt',
};

/** Appends one event; the caller has already decided the transition is legitimate. */
export async function recordEvent(
  tx: Tx,
  input: {
    workspaceId: string;
    artifactId: string;
    fromState: ChangeSetState | null;
    toState: ChangeSetState;
    actor: { type: ChangeSetActor; id?: string | null };
    reason: string;
    evidence?: Record<string, unknown>;
    at?: Date;
  },
): Promise<void> {
  await tx.insert(schema.changeSetEvents).values({
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
    fromState: input.fromState,
    toState: input.toState,
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    reason: input.reason,
    evidence: input.evidence ?? {},
    ...(input.at ? { at: input.at } : {}),
  });
}

/**
 * Moves a change set to `to` when it is still in `from`, appending the event in the same
 * transaction. Returns the updated row, or null when another writer moved it first: the caller then
 * re-reads rather than assuming its transition happened.
 */
export async function transition(tx: Tx, run: ChangeSetRun, to: ChangeSetState, options: TransitionOptions): Promise<ChangeSetRun | null> {
  const at = options.at ?? new Date();
  const stamp = STAMP[to];
  const [updated] = await tx
    .update(schema.changeSetRuns)
    .set({
      ...options.set,
      state: to,
      stateChangedAt: at,
      updatedAt: at,
      ...(stamp ? { [stamp]: at } : {}),
    })
    .where(
      and(
        eq(schema.changeSetRuns.workspaceId, run.workspaceId),
        eq(schema.changeSetRuns.artifactId, run.artifactId),
        eq(schema.changeSetRuns.state, run.state),
      ),
    )
    .returning();
  if (!updated) return null;
  await recordEvent(tx, {
    workspaceId: run.workspaceId,
    artifactId: run.artifactId,
    fromState: run.state,
    toState: to,
    actor: options.actor,
    reason: options.reason,
    ...(options.evidence ? { evidence: options.evidence } : {}),
    at,
  });
  return updated;
}

/** The change set's run row, or a request-shaped not-found error. */
export async function loadRun(tx: Tx, workspaceId: string, artifactId: string): Promise<ChangeSetRun> {
  const [run] = await tx
    .select()
    .from(schema.changeSetRuns)
    .where(and(eq(schema.changeSetRuns.workspaceId, workspaceId), eq(schema.changeSetRuns.artifactId, artifactId)));
  if (!run) throw new ChangeSetNotFound(artifactId);
  return run;
}

/** A missing run row, distinguishable from any other failure so a command can name what is missing. */
export class ChangeSetNotFound extends Error {
  constructor(readonly artifactId: string) {
    super(`Change set ${artifactId} does not exist in this workspace.`);
    this.name = 'ChangeSetNotFound';
  }
}

/** Finds an existing run row without throwing, for the create path and the poller. */
export async function findRun(tx: Tx, workspaceId: string, artifactId: string): Promise<ChangeSetRun | null> {
  const [run] = await tx
    .select()
    .from(schema.changeSetRuns)
    .where(and(eq(schema.changeSetRuns.workspaceId, workspaceId), eq(schema.changeSetRuns.artifactId, artifactId)));
  return run ?? null;
}

/** Its events, oldest first. */
export async function eventsOf(tx: Tx, workspaceId: string, artifactId: string) {
  return tx
    .select()
    .from(schema.changeSetEvents)
    .where(and(eq(schema.changeSetEvents.workspaceId, workspaceId), eq(schema.changeSetEvents.artifactId, artifactId)))
    .orderBy(schema.changeSetEvents.seq);
}

/** The newest verification attempt's rows, per change index. */
export async function latestVerifications(tx: Tx, workspaceId: string, artifactId: string) {
  const [latest] = await tx
    .select({ attempt: sql<number | null>`max(${schema.changeSetVerifications.attempt})` })
    .from(schema.changeSetVerifications)
    .where(and(eq(schema.changeSetVerifications.workspaceId, workspaceId), eq(schema.changeSetVerifications.artifactId, artifactId)));
  if (latest?.attempt == null) return { attempt: null, rows: [] };
  const rows = await tx
    .select()
    .from(schema.changeSetVerifications)
    .where(
      and(
        eq(schema.changeSetVerifications.workspaceId, workspaceId),
        eq(schema.changeSetVerifications.artifactId, artifactId),
        eq(schema.changeSetVerifications.attempt, latest.attempt),
      ),
    )
    .orderBy(schema.changeSetVerifications.changeIndex);
  return { attempt: latest.attempt, rows };
}

/** The site's change sets that still claim URLs or files, newest first. */
export async function openRunsForSite(tx: Tx, workspaceId: string, siteId: string) {
  return tx
    .select()
    .from(schema.changeSetRuns)
    .where(
      and(
        eq(schema.changeSetRuns.workspaceId, workspaceId),
        eq(schema.changeSetRuns.siteId, siteId),
        inArray(schema.changeSetRuns.state, [...OPEN_STATES]),
      ),
    )
    .orderBy(schema.changeSetRuns.createdAt);
}
