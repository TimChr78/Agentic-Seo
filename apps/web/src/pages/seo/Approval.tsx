import { useState } from 'react';
import { type ApprovalDetail, api, errText } from '../../app/api';
import { useSession } from '../../app/session';
import { useApi, useKeyedApi } from '../../app/useApi';
import { Actor, Alert, Button, Field, Meta, StatusPill, Textarea } from '../../ui';
import { DiffView } from '../../ui/diff';
import { Drawer } from '../../ui/overlay';
import { ApprovalStatePill } from '../../ui/seo/pills';
import { formatDateTime, timeAgo } from '../../ui/time';
import { useToast } from '../../ui/toast';

// The approval flow, ported from the sister product (DESIGN.md §3, §4.3): one drawer shows the
// version under review, its diff from the live version, who asked and why, and the two decisions.
// Only a person with artifacts:approve may decide; anyone else sees the request read-only.

/** The pending request for one artifact, or null. Keyed by the artifact so a stale answer never shows. */
export function usePendingApproval(artifactId: string | undefined) {
  return useApi(
    async () => {
      if (!artifactId) return null;
      const page = await api.listApprovals({ status: 'pending', artifactId, limit: 1 });
      return page.approvals[0] ?? null;
    },
    [artifactId],
    { skip: !artifactId },
  );
}

export function ApprovalBar({ artifactId, onDecided }: { artifactId: string; onDecided?: () => void }) {
  const { can, agent, workspace } = useSession();
  const pending = usePendingApproval(artifactId);
  const [open, setOpen] = useState<string | null>(null);
  const approval = pending.data;
  if (!approval) return null;
  const canDecide = can('artifacts:approve') && !agent;
  const policy = workspace?.approvalPolicy;

  return (
    <div className="sticky bottom-0 z-10 -mx-4 mt-6 border-t border-line bg-surface px-4 py-3 md:-mx-0 md:rounded-lg md:border md:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-[13px] leading-5 font-medium">
            <ApprovalStatePill status={approval.status} />
            <span>
              {policy === 'all_publishes'
                ? 'Policy: every publish needs a person’s approval.'
                : policy === 'agent_changes'
                  ? 'Policy: an agent’s change needs a person’s approval.'
                  : 'Policy: this version is waiting for a decision.'}
            </span>
          </p>
          <p className="mt-1 text-[12px] leading-[18px] text-muted">
            Requested {timeAgo(approval.createdAt)} by {approval.requester.displayName} · version {approval.version} of{' '}
            {approval.artifactLatestVersion}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setOpen(approval.id)}>Review</Button>
          <Button
            variant="danger"
            disabled={!canDecide}
            title={!canDecide ? 'Only approvers can reject; an agent cannot decide.' : undefined}
            onClick={() => setOpen(approval.id)}
          >
            Reject
          </Button>
          <Button
            variant="primary"
            disabled={!canDecide}
            title={!canDecide ? 'Only approvers can approve; an agent cannot decide.' : undefined}
            onClick={() => setOpen(approval.id)}
          >
            Approve
          </Button>
        </div>
      </div>
      <ApprovalDrawer
        approvalId={open}
        onClose={() => setOpen(null)}
        onDecided={() => {
          void pending.reload();
          onDecided?.();
        }}
      />
    </div>
  );
}

/**
 * The request under review: what the version changes against the live one, who asked and why, and
 * the two decisions. The reject reason is required because the author has to know what to change.
 */
export function ApprovalDrawer({
  approvalId,
  onClose,
  onDecided,
}: {
  approvalId: string | null;
  onClose: () => void;
  onDecided?: () => void;
}) {
  const { can, agent } = useSession();
  const toast = useToast();
  // Keyed by the request: switching from A to B withholds A's detail until B's own read answers, so
  // a decision button can never send B's id with the diff of A on screen.
  const read = useKeyedApi<ApprovalDetail | null>(approvalId ?? '', () => api.getApproval(approvalId as string), { skip: !approvalId });
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The id is checked as well as the key: a read that answered for another request is never shown.
  const detail: ApprovalDetail | null = approvalId !== null && read.data?.id === approvalId ? read.data : null;
  const canDecide = can('artifacts:approve') && !agent && detail !== null;

  const decide = async (approve: boolean) => {
    if (!approvalId) return;
    setPending(true);
    setError(null);
    try {
      if (approve) await api.approve(approvalId, note.trim() || undefined);
      else await api.reject(approvalId, note.trim());
      toast.success(approve ? 'Approved. The change is published and moves on.' : 'Rejected. The author is told why.');
      onDecided?.();
      onClose();
      setNote('');
      setRejecting(false);
    } catch (caught) {
      setError(errText(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <Drawer
      open={approvalId !== null}
      onClose={onClose}
      width="xl"
      title={detail ? detail.artifactName : 'Approval request'}
      meta={
        detail ? (
          <>
            {detail.artifactType.replace('_', ' ')} · version {detail.version} · requested by {detail.requester.displayName}
          </>
        ) : undefined
      }
      footer={
        detail && detail.status === 'pending' ? (
          rejecting ? (
            <>
              <Button
                variant="danger-solid"
                loading={pending}
                disabled={!canDecide || note.trim().length === 0}
                onClick={() => void decide(false)}
              >
                Reject version {detail.version}
              </Button>
              <Button
                onClick={() => {
                  setRejecting(false);
                  setNote('');
                }}
              >
                Back
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="primary"
                loading={pending}
                disabled={!canDecide}
                title={!canDecide ? 'Only approvers can approve.' : undefined}
                onClick={() => void decide(true)}
              >
                Approve and publish
              </Button>
              <Button variant="danger" disabled={!canDecide} onClick={() => setRejecting(true)}>
                Reject
              </Button>
            </>
          )
        ) : undefined
      }
    >
      <div className="space-y-4 p-4 md:p-5">
        {error && (
          <Alert tone="bad" title="The decision did not go through">
            {error}
          </Alert>
        )}
        {!detail && !read.error && <p className="text-[13px] text-muted">Loading the request…</p>}
        {read.error && (
          <Alert tone="bad" title="Couldn’t open this request" onRetry={() => void read.reload()}>
            {read.error}
          </Alert>
        )}
        {detail && (
          <>
            <Meta
              items={[
                ['State', <ApprovalStatePill key="state" status={detail.status} />],
                ['Version', `${detail.version} of ${detail.artifactLatestVersion}`],
                ['Requested', `${formatDateTime(detail.createdAt, { zone: true })} by ${detail.requester.displayName}`],
                [
                  'Requester',
                  <Actor
                    key="requester"
                    kind={detail.requestedBy.type === 'agent' ? 'agent' : 'person'}
                    name={detail.requester.personName ?? detail.requester.displayName}
                  />,
                ],
                ['Live version', detail.artifactPublishedVersion ? `v${detail.artifactPublishedVersion}` : 'Nothing is published yet'],
              ]}
            />
            <section aria-labelledby="approval-note">
              <h3 id="approval-note" className="text-[13px] leading-5 font-semibold">
                Why it was submitted
              </h3>
              <p className="mt-1 whitespace-pre-wrap text-[13px] leading-5 text-fg-2">{detail.note}</p>
            </section>
            {detail.bundle && detail.bundle.members.length > 1 && (
              <section aria-labelledby="bundle">
                <h3 id="bundle" className="text-[13px] leading-5 font-semibold">
                  Reviewed together
                </h3>
                <p className="mt-1 text-[12px] leading-[18px] text-muted">
                  Deciding this request decides the whole bundle: {detail.bundle.members.map((member) => member.artifactName).join(', ')}.
                </p>
              </section>
            )}
            <section aria-labelledby="approval-diff">
              <h3 id="approval-diff" className="mb-2 text-[13px] leading-5 font-semibold">
                What changes
              </h3>
              <DiffView changes={detail.diff.changes} from={detail.diff.from} to={detail.diff.to} />
            </section>
            {detail.history.length > 0 && (
              <section aria-labelledby="approval-history">
                <h3 id="approval-history" className="text-[13px] leading-5 font-semibold">
                  Decision history
                </h3>
                <ul className="mt-1 space-y-1 text-[12px] leading-[18px] text-fg-2">
                  {detail.history.map((entry) => (
                    <li key={`${entry.at}:${entry.status}`}>
                      {entry.status === 'approved' ? 'Approved' : 'Rejected'} by {entry.by.name} ·{' '}
                      {formatDateTime(entry.at, { zone: true })}
                      {entry.note ? ` · ${entry.note}` : ''}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {detail.status === 'pending' && (
              <div className="space-y-2">
                <Field
                  label={rejecting ? 'Why are you rejecting it?' : 'Note for the author'}
                  required={rejecting}
                  hint={rejecting ? 'Say what to change; it is the only thing the author reads.' : 'Optional when approving.'}
                  error={rejecting && note.trim().length === 0 ? 'A rejection needs a reason.' : null}
                >
                  <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={1000} />
                </Field>
                {!canDecide && (
                  <p className="flex items-center gap-2 text-[12px] leading-[18px] text-muted">
                    <StatusPill tone="neutral">Read only</StatusPill>
                    {agent ? 'An agent cannot approve or reject a change.' : 'Your role cannot approve; an approver decides this.'}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}
