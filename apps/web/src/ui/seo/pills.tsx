import { OperationalPill, type OperationalState } from '../state';

// The SEO state pills (DESIGN.md §5). Each family maps the server's own states onto the shared
// operational pill: named state text, a marker shape and a tone, never colour alone. The UI never
// invents an execution state — an unknown value stays neutral and shows its raw text.

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

const SEVERITY: Record<Severity, OperationalState> = {
  critical: { key: 'critical', label: 'Critical', tone: 'bad', icon: 'octagon' },
  high: { key: 'high', label: 'High', tone: 'bad', icon: 'dot' },
  medium: { key: 'medium', label: 'Medium', tone: 'warn', icon: 'dot' },
  low: { key: 'low', label: 'Low', tone: 'neutral', icon: 'dot' },
  info: { key: 'info', label: 'Info', tone: 'info', icon: 'dot' },
};

const unknownState = (key: string): OperationalState => ({ key, label: key, tone: 'neutral', icon: 'dot' });

/** Severity of a check's outcome: critical, high, medium, low or info. */
export function SeverityPill({ severity }: { severity: string }) {
  return <OperationalPill state={SEVERITY[severity as Severity] ?? unknownState(severity)} />;
}

export type IssueState = 'open' | 'regressed' | 'resolved' | 'ignored';

const ISSUE: Record<IssueState, OperationalState> = {
  open: { key: 'open', label: 'Open', tone: 'warn', icon: 'dot' },
  regressed: { key: 'regressed', label: 'Regressed', tone: 'bad', icon: 'arrow' },
  resolved: { key: 'resolved', label: 'Resolved', tone: 'good', icon: 'check' },
  ignored: { key: 'ignored', label: 'Ignored', tone: 'neutral', icon: 'dot' },
};

/**
 * An issue's state. "Regressed" is the server's count of times the issue came back after an audit
 * resolved it, with the count in the tooltip. "Not re-checked" is an open issue whose pages a later
 * audit did not evaluate, so its state is from an earlier audit rather than from the latest one.
 */
export function IssueStatePill({ state, regressed, unchecked }: { state: string; regressed?: number; unchecked?: boolean }) {
  if (state === 'open' && regressed !== undefined && regressed > 0) {
    return (
      <span title={`Came back ${regressed} ${regressed === 1 ? 'time' : 'times'} after a later audit resolved it.`}>
        <OperationalPill state={ISSUE.regressed} />
      </span>
    );
  }
  if (state === 'open' && unchecked) {
    return (
      <span title="A later audit did not evaluate this issue’s pages, so this state is from an earlier audit.">
        <OperationalPill state={{ key: 'unchecked', label: 'Not re-checked', tone: 'neutral', icon: 'dot' }} />
      </span>
    );
  }
  return <OperationalPill state={ISSUE[state as IssueState] ?? unknownState(state)} />;
}

export type AuditState = 'queued' | 'running' | 'finalizing' | 'completed' | 'partial' | 'failed' | 'cancelled';

const AUDIT: Record<AuditState, OperationalState> = {
  queued: { key: 'queued', label: 'Queued', tone: 'neutral', icon: 'dot' },
  running: { key: 'running', label: 'Running', tone: 'info', icon: 'arrow' },
  finalizing: { key: 'finalizing', label: 'Finalizing', tone: 'info', icon: 'arrow' },
  completed: { key: 'completed', label: 'Completed', tone: 'good', icon: 'check' },
  partial: { key: 'partial', label: 'Partial', tone: 'warn', icon: 'clock' },
  failed: { key: 'failed', label: 'Failed', tone: 'bad', icon: 'octagon' },
  cancelled: { key: 'cancelled', label: 'Cancelled', tone: 'neutral', icon: 'square' },
};

/** An audit's state. A partial or failed audit carries its reason beside the pill where one exists. */
export function AuditStatePill({ state, detail }: { state: string; detail?: string | null }) {
  const mapped = AUDIT[state as AuditState] ?? unknownState(state);
  return <OperationalPill state={detail ? { ...mapped, detail } : mapped} />;
}

export type ChangeState =
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

/** The change-set pipeline's words: what the change set is doing, in the reviewer's language. */
export const CHANGE_STATE_LABEL: Record<ChangeState, string> = {
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  applying: 'Applying',
  pr_open: 'PR open',
  merged: 'Merged',
  deploying: 'Deploying',
  deployed: 'Deployed',
  verified: 'Verified',
  verification_failed: 'Verification failed',
  deploy_not_detected: 'Deploy not detected',
  closed: 'Closed',
  stale: 'Stale',
  rolled_back: 'Rolled back',
  superseded: 'Superseded',
  failed: 'Failed',
};

const CHANGE: Record<ChangeState, OperationalState> = {
  draft: { key: 'draft', label: CHANGE_STATE_LABEL.draft, tone: 'neutral', icon: 'dot' },
  in_review: { key: 'in_review', label: CHANGE_STATE_LABEL.in_review, tone: 'warn', icon: 'clock' },
  approved: { key: 'approved', label: CHANGE_STATE_LABEL.approved, tone: 'info', icon: 'check' },
  applying: { key: 'applying', label: CHANGE_STATE_LABEL.applying, tone: 'info', icon: 'arrow' },
  pr_open: { key: 'pr_open', label: CHANGE_STATE_LABEL.pr_open, tone: 'info', icon: 'arrow' },
  merged: { key: 'merged', label: CHANGE_STATE_LABEL.merged, tone: 'info', icon: 'check' },
  deploying: { key: 'deploying', label: CHANGE_STATE_LABEL.deploying, tone: 'info', icon: 'arrow' },
  deployed: { key: 'deployed', label: CHANGE_STATE_LABEL.deployed, tone: 'good', icon: 'check' },
  verified: { key: 'verified', label: CHANGE_STATE_LABEL.verified, tone: 'good', icon: 'check' },
  verification_failed: { key: 'verification_failed', label: CHANGE_STATE_LABEL.verification_failed, tone: 'bad', icon: 'octagon' },
  deploy_not_detected: { key: 'deploy_not_detected', label: CHANGE_STATE_LABEL.deploy_not_detected, tone: 'warn', icon: 'clock' },
  closed: { key: 'closed', label: CHANGE_STATE_LABEL.closed, tone: 'neutral', icon: 'square' },
  stale: { key: 'stale', label: CHANGE_STATE_LABEL.stale, tone: 'warn', icon: 'clock' },
  rolled_back: { key: 'rolled_back', label: CHANGE_STATE_LABEL.rolled_back, tone: 'neutral', icon: 'square' },
  superseded: { key: 'superseded', label: CHANGE_STATE_LABEL.superseded, tone: 'neutral', icon: 'square' },
  failed: { key: 'failed', label: CHANGE_STATE_LABEL.failed, tone: 'bad', icon: 'octagon' },
};

/** The state a change set is in, in its own words. */
export const changeStateLabel = (state: string) => CHANGE[state as ChangeState]?.label ?? state;

/** A change set's state. */
export function ChangeStatePill({ state }: { state: string }) {
  return <OperationalPill state={CHANGE[state as ChangeState] ?? unknownState(state)} />;
}

export type RecommendationStatus = 'proposed' | 'accepted' | 'implemented' | 'rejected' | 'measured';

const RECOMMENDATION: Record<RecommendationStatus, OperationalState> = {
  proposed: { key: 'proposed', label: 'Proposed', tone: 'warn', icon: 'dot' },
  accepted: { key: 'accepted', label: 'Accepted', tone: 'good', icon: 'check' },
  implemented: { key: 'implemented', label: 'Implemented', tone: 'good', icon: 'arrow' },
  rejected: { key: 'rejected', label: 'Rejected', tone: 'bad', icon: 'octagon' },
  measured: { key: 'measured', label: 'Measured', tone: 'info', icon: 'check' },
};

/** A recommendation's derived status: the artifact lifecycle plus the change sets that name it. */
export function RecommendationStatusPill({ status }: { status: string }) {
  return <OperationalPill state={RECOMMENDATION[status as RecommendationStatus] ?? unknownState(status)} />;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

const APPROVAL: Record<ApprovalStatus, OperationalState> = {
  pending: { key: 'pending', label: 'Waiting for a decision', tone: 'warn', icon: 'clock' },
  approved: { key: 'approved', label: 'Approved', tone: 'good', icon: 'check' },
  rejected: { key: 'rejected', label: 'Rejected', tone: 'bad', icon: 'octagon' },
  withdrawn: { key: 'withdrawn', label: 'Withdrawn', tone: 'neutral', icon: 'square' },
};

/** An approval request's state. */
export function ApprovalStatePill({ status }: { status: string }) {
  return <OperationalPill state={APPROVAL[status as ApprovalStatus] ?? unknownState(status)} />;
}
