import { ArrowRight, Inbox as InboxIcon } from 'lucide-react';
import { useState } from 'react';
import { type Approval, api } from '../app/api';
import { ButtonLink, TextLink } from '../app/links';
import { useCrumbs } from '../app/page';
import { useSession, useSite } from '../app/session';
import { useApi } from '../app/useApi';
import { Alert, Button, EmptyState } from '../ui';
import { pageWidth } from '../ui/layout';
import { RecommendationStatusPill } from '../ui/seo/pills';
import { TrafficAtRisk } from '../ui/seo/reach';
import { timeAgo } from '../ui/time';
import { ApprovalDrawer } from './seo/Approval';

// Inbox (DESIGN.md §3, §4.3): the decisions waiting for this person, newest first — a change set that
// needs approval, a recommendation waiting for a decision — each one line of consequence and a way
// to open it. An empty Inbox says what will arrive rather than nothing at all.

export default function InboxPage({ approvalId = null }: { approvalId?: string | null }) {
  useCrumbs([{ label: 'Inbox' }]);
  const { site } = useSite();
  const { can } = useSession();
  const approvals = useApi(() => api.listApprovals({ status: 'pending', limit: 50 }), []);
  const decisions = useApi(() => api.listRecommendations({ siteId: site.id, status: 'proposed', limit: 5 }), [site.id]);
  const [open, setOpen] = useState<string | null>(approvalId);

  const pending = approvals.data?.approvals ?? [];
  const proposed = decisions.data?.recommendations ?? [];
  const error = approvals.error ?? decisions.error;
  const loading = approvals.data === undefined && !approvals.error;

  return (
    <div className={pageWidth('default')}>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3 lg:mb-8">
        <div className="min-w-0">
          <h1 className="text-[24px] leading-8 font-semibold tracking-[-0.02em]">Inbox</h1>
          <p className="mt-1 max-w-[760px] text-[14px] leading-[22px] text-muted">
            Every decision waiting for you: a version that needs a person, a change set held for review, a recommendation waiting for a
            decision. Newest first.
          </p>
        </div>
        {approvals.data && approvals.data.total > 0 && (
          <p className="num text-[12px] leading-[18px] text-muted">
            {approvals.data.total} {approvals.data.total === 1 ? 'request' : 'requests'} waiting
          </p>
        )}
      </div>

      {error && (
        <Alert tone="bad" title="Couldn’t load the inbox" onRetry={() => void Promise.all([approvals.reload(), decisions.reload()])}>
          {error}
        </Alert>
      )}
      {loading && <p className="text-[13px] text-muted">Loading the decisions…</p>}

      {!loading && !error && pending.length === 0 && proposed.length === 0 && (
        <div className="rounded-lg border border-line bg-surface">
          <EmptyState
            icon={<InboxIcon size={24} />}
            title="Nothing is waiting for you"
            action={
              <ButtonLink to="/recommendations" variant="secondary" icon={<ArrowRight size={14} />}>
                Browse recommendations
              </ButtonLink>
            }
          >
            When a change set is submitted for approval, or a recommendation needs a decision, it arrives here with what it would change and
            what is at stake. An approval you request yourself appears in the reviewers’ inboxes, not yours.
          </EmptyState>
        </div>
      )}

      {pending.length > 0 && (
        <section aria-labelledby="inbox-approvals" className="mb-6">
          <h2 id="inbox-approvals" className="mb-2 text-[16px] leading-6 font-semibold">
            Waiting for a decision
          </h2>
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {pending.map((approval) => (
              <ApprovalRow key={approval.id} approval={approval} onOpen={() => setOpen(approval.id)} />
            ))}
          </ul>
        </section>
      )}

      {proposed.length > 0 && (
        <section aria-labelledby="inbox-recommendations">
          <h2 id="inbox-recommendations" className="mb-2 text-[16px] leading-6 font-semibold">
            Recommendations waiting for a decision
          </h2>
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {proposed.map((recommendation) => (
              <li key={recommendation.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <TextLink to={`/recommendations/${recommendation.id}`} className="text-[14px]">
                    {recommendation.title}
                  </TextLink>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-[12px] leading-[18px] text-muted">
                    <RecommendationStatusPill status={recommendation.status} />
                    <span className="capitalize">{recommendation.effort} effort</span>
                    <span aria-hidden>·</span>
                    <span className="capitalize">{recommendation.confidence} confidence</span>
                    <span aria-hidden>·</span>
                    <span>updated {timeAgo(recommendation.updatedAt)}</span>
                  </p>
                  <TrafficAtRisk reach={recommendation.trafficAtStake} className="mt-1 text-[12px]" />
                </div>
                {can('artifacts:read') && (
                  <ButtonLink to={`/recommendations/${recommendation.id}`} size="sm">
                    Open
                  </ButtonLink>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <ApprovalDrawer
        approvalId={open}
        onClose={() => setOpen(null)}
        onDecided={() => {
          void approvals.reload();
          void decisions.reload();
        }}
      />
    </div>
  );
}

function ApprovalRow({ approval, onOpen }: { approval: Approval; onOpen: () => void }) {
  const isChangeSet = approval.artifactType === 'change_set';
  const href = isChangeSet ? `/changes/${approval.artifactId}` : `/recommendations/${approval.artifactId}`;
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-2">
          <span className="text-[12px] leading-[18px] text-muted">{isChangeSet ? 'Change set' : 'Recommendation'}</span>
          <TextLink to={href} className="text-[14px]">
            {approval.artifactName}
          </TextLink>
        </p>
        <p className="mt-1 text-[12px] leading-[18px] text-muted">
          Version {approval.version} of {approval.artifactLatestVersion} · requested {timeAgo(approval.createdAt)} by{' '}
          {approval.requester.displayName}
          {approval.bundle && approval.bundle.members.length > 1 ? ` · reviewed with ${approval.bundle.members.length - 1} other` : ''}
        </p>
        <p className="mt-1 max-w-[640px] text-[12px] leading-[18px] text-fg-2">{firstLines(approval.note)}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" onClick={onOpen}>
          Review
        </Button>
        <ButtonLink to={href} size="sm">
          {isChangeSet ? 'Open change set' : 'Open recommendation'}
        </ButtonLink>
      </div>
    </li>
  );
}

/** Two lines of the submitter's note: enough to know what it is, without the whole diff. */
function firstLines(note: string) {
  const [head] = note.split('\n\n');
  const text = head.trim();
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}
