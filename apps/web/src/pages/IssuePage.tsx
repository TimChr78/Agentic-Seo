import { ArrowRight, MessageSquareWarning } from 'lucide-react';
import { useState } from 'react';
import { api, errText, type IssueDetail } from '../app/api';
import { isNotRechecked, useLatestFinishedAudit } from '../app/auditFreshness';
import { ButtonLink, TextLink } from '../app/links';
import { useCrumbs } from '../app/page';
import { navigate } from '../app/router';
import { categoryLabel } from '../app/seoLabels';
import { useSession, useSite } from '../app/session';
import { useTab } from '../app/tab';
import { useApi } from '../app/useApi';
import { Actor, Button, Card, Meta, Mono } from '../ui';
import { cx } from '../ui/cx';
import { DetailPage } from '../ui/DetailPage';
import { Identifier } from '../ui/Identifier';
import { EvidenceList } from '../ui/seo/evidence';
import { IssueStatePill, SeverityPill } from '../ui/seo/pills';
import { formatDate, formatDateTime } from '../ui/time';
import { useToast } from '../ui/toast';
import { CreateRecommendationDialog } from './seo/CreateRecommendationDialog';
import { IgnoreIssueDialog } from './seo/IgnoreIssueDialog';

// Issue detail (DESIGN.md §4.2). The consequence first: what is broken, on how many pages, how much
// traffic it touches and since when. Then the pages with value versus expected, the check's own
// explanation and references, its history across audits, and the decisions taken about it.

const TABS = ['pages', 'explanation', 'history', 'activity'] as const;
type Tab = (typeof TABS)[number];

export default function IssuePage({ issueId }: { issueId: string }) {
  const { site } = useSite();
  const { can, agent } = useSession();
  const toast = useToast();
  const [tab, setTab] = useTab<Tab>('tab', TABS, 'pages');
  const read = useApi(() => api.getIssue(issueId), [issueId]);
  const latestAudit = useLatestFinishedAudit(site.id).latest;
  const linked = useApi(() => api.listRecommendations({ siteId: site.id, issueId, limit: 1 }), [site.id, issueId], {
    skip: read.data === undefined,
  });
  const [creating, setCreating] = useState(false);
  const [ignoring, setIgnoring] = useState(false);

  const detail = read.data;
  useCrumbs([{ label: 'Issues', to: '/issues' }, { label: detail?.issue.title ?? 'Issue' }]);

  if (!detail) {
    return (
      <DetailPage
        title="Issue"
        kind="Issue"
        metadata={null}
        consequence={null}
        tabs={[]}
        activeTab="pages"
        onTabChange={() => {}}
        state={read.error ? 'error' : 'loading'}
        notice={
          read.error
            ? { title: 'Couldn’t open this issue', body: read.error, action: <Button onClick={() => void read.reload()}>Retry</Button> }
            : undefined
        }
      />
    );
  }

  const { issue, check, history, pages } = detail;
  const recommendation = linked.data?.recommendations[0];
  const canRecommend = can('artifacts:write') && !agent;
  const canIgnore = can('sites:write') && !agent;
  const alreadyIgnored = issue.state === 'ignored';
  const clicks = issue.clicks28d;

  const consequence = (
    <div className="rounded-lg bg-surface-2 p-4 md:p-5">
      <p className="text-[14px] leading-[22px] font-medium text-fg">
        {issue.title} on {issue.affectedPages} of {issue.evaluatedPages} pages
        <span className="font-normal text-fg-2"> · </span>
        {clicks === null ? (
          <span className="font-normal text-warn">traffic unknown: Search Console is not connected</span>
        ) : (
          <span className="num">{clicks.toLocaleString()} clicks/28d at stake</span>
        )}
        <span className="font-normal text-fg-2"> · since {formatDate(issue.createdAt)}</span>
      </p>
      <p className="mt-1 text-[13px] leading-5 text-fg-2">
        {alreadyIgnored
          ? 'This issue is ignored: it stays listed, and later audits do not resolve it.'
          : recommendation
            ? `A recommendation cites this issue: “${recommendation.title}”.`
            : issue.regressed > 0
              ? `It has come back ${issue.regressed} ${issue.regressed === 1 ? 'time' : 'times'} after an audit resolved it.`
              : 'Next: create a recommendation that states a hypothesis and how the result will be measured, or ignore it with a reason.'}
      </p>
    </div>
  );

  return (
    <>
      <DetailPage
        title={issue.title}
        kind="Issue"
        statePill={<IssueStatePill state={issue.state} regressed={issue.regressed} unchecked={isNotRechecked(issue, latestAudit)} />}
        metadata={
          <>
            <span className="font-mono text-[12px]">{check.id}</span>
            <span aria-hidden>·</span>
            <span>{categoryLabel(issue.category)}</span>
            <span aria-hidden>·</span>
            <SeverityPill severity={issue.severity} />
          </>
        }
        primaryAction={
          recommendation ? (
            <ButtonLink to={`/recommendations/${recommendation.id}`} variant="primary" icon={<ArrowRight size={14} />}>
              Open recommendation
            </ButtonLink>
          ) : (
            <Button
              variant="primary"
              icon={<MessageSquareWarning size={14} />}
              disabled={!canRecommend}
              title={!canRecommend ? 'Only editors can create a recommendation.' : undefined}
              onClick={() => setCreating(true)}
            >
              Create recommendation
            </Button>
          )
        }
        secondaryActions={
          alreadyIgnored ? (
            <Button
              disabled={!canIgnore}
              title={!canIgnore ? 'Only editors can unignore an issue.' : undefined}
              onClick={async () => {
                try {
                  await api.unignoreIssue(issue.id);
                  await read.reload();
                  toast.success('Issue returned to the open list.');
                } catch (error) {
                  toast.error(errText(error));
                }
              }}
            >
              Unignore
            </Button>
          ) : (
            <Button
              disabled={!canIgnore}
              title={!canIgnore ? 'Only editors can ignore an issue.' : undefined}
              onClick={() => setIgnoring(true)}
            >
              Ignore
            </Button>
          )
        }
        consequence={consequence}
        state="ready"
        activeTab={tab}
        onTabChange={setTab}
        tabs={[
          { key: 'pages', label: `Pages (${pages.length})`, panel: <PagesTab detail={detail} siteHost={site.domain} /> },
          { key: 'explanation', label: 'Explanation', panel: <ExplanationTab detail={detail} /> },
          { key: 'history', label: `History (${history.length})`, panel: <HistoryTab detail={detail} /> },
          { key: 'activity', label: 'Activity', panel: <ActivityTab detail={detail} /> },
        ]}
        context={
          <div className="space-y-5">
            <div>
              <h2 className="text-[13px] leading-5 font-semibold">Check</h2>
              <Meta
                className="mt-2"
                items={[
                  ['Id', <Mono key="id">{check.id}</Mono>],
                  ['Scope', check.scope === 'cross_page' ? 'Across pages' : check.scope === 'site' ? 'Whole site' : 'One page'],
                  ['Evaluated', check.evaluator === 'finalize' ? 'After the crawl' : 'Per page'],
                  ['Fix', check.fix ? check.fix.change.replace('.', ' ') : 'Needs a decision'],
                ]}
              />
            </div>
            <div>
              <h2 className="text-[13px] leading-5 font-semibold">Decision</h2>
              {issue.ignored ? (
                <div className="mt-2 space-y-1 text-[12px] leading-[18px] text-fg-2">
                  <p className="flex items-center gap-2">
                    <Actor kind="person" name={issue.ignored.by} />
                  </p>
                  <p className="text-fg">{issue.ignored.reason}</p>
                  <p className="text-muted">{formatDateTime(issue.ignored.at, { zone: true })}</p>
                </div>
              ) : (
                <p className="mt-2 text-[12px] leading-[18px] text-muted">No decision recorded. The issue is {issue.state}.</p>
              )}
            </div>
            <div>
              <h2 className="text-[13px] leading-5 font-semibold">Issue</h2>
              <Identifier value={issue.id} label="Issue ID" className="mt-2" />
            </div>
          </div>
        }
      />

      <CreateRecommendationDialog
        open={creating}
        onClose={() => setCreating(false)}
        siteId={site.id}
        prefill={{
          title: issue.title,
          rationale: `Found by the ${check.title} check on ${issue.affectedPages} of ${issue.evaluatedPages} pages (issue ${issue.id}).`,
          evidence: { kind: 'issue', id: issue.id, note: `${issue.title} on ${issue.affectedPages} pages.` },
        }}
        onCreated={(recommendationId) => {
          navigate(`/recommendations/${recommendationId}`);
        }}
      />

      <IgnoreIssueDialog
        open={ignoring}
        onClose={() => setIgnoring(false)}
        issueId={issue.id}
        onIgnored={() => {
          void read.reload();
          toast.success('Issue ignored.');
        }}
      />
    </>
  );
}

function PagesTab({ detail, siteHost }: { detail: IssueDetail; siteHost: string }) {
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-5 text-fg-2">
        {detail.issue.evidenceTruncated
          ? `Showing ${detail.pages.length} of ${detail.issue.evidenceTotal.toLocaleString()} affected pages. The rest are the same check on the same subject.`
          : `${detail.pages.length} ${detail.pages.length === 1 ? 'page' : 'pages'}, with what the last audit found and what the check expects.`}
      </p>
      <EvidenceList
        siteHost={siteHost}
        rows={detail.pages.map((page) => ({
          subject: page.url,
          value: page.value,
          expected: page.expected,
          detail: page.detail,
          source: 'Latest audit',
        }))}
      />
    </div>
  );
}

function ExplanationTab({ detail }: { detail: IssueDetail }) {
  const { check } = detail;
  return (
    <div className="max-w-[760px] space-y-5">
      <Card title="Why it matters" padded>
        <p className="text-[14px] leading-[22px] text-fg-2">{check.explain}</p>
      </Card>
      <Card title="What to do" padded>
        <p className="text-[14px] leading-[22px] text-fg-2">
          {check.fix
            ? `This is a ${check.fix.change.replace('.', ' ')} change. A recommendation turns it into a draft change set.`
            : 'This needs a decision rather than an edit; describe the fix in the recommendation.'}
        </p>
        {check.definition && (
          <p className="mt-3 rounded-md bg-surface-2 p-3 font-mono text-[12px] leading-[18px] text-fg-2">{check.definition}</p>
        )}
      </Card>
      <Card title="References" padded>
        {check.references.length ? (
          <ul className="list-disc space-y-1 pl-5 text-[13px] leading-5">
            {check.references.map((reference) => (
              <li key={reference} className="break-words">
                <a href={reference} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
                  {reference}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] leading-5 text-muted">This check has no external reference.</p>
        )}
      </Card>
      <Card title="Freshness rules" description="What the check depends on, and when each rule was last reviewed." padded>
        {check.rules.length ? (
          <ul className="space-y-3">
            {check.rules.map((rule) => (
              <li key={rule.id}>
                <p className="text-[13px] leading-5 font-medium">{rule.statement}</p>
                <p className="mt-0.5 text-[12px] leading-[18px] text-muted">
                  {rule.source} · reviewed {formatDate(rule.reviewedAt)}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] leading-5 text-muted">This check does not depend on an external rule.</p>
        )}
      </Card>
    </div>
  );
}

function HistoryTab({ detail }: { detail: IssueDetail }) {
  if (!detail.history.length)
    return <p className="text-[13px] leading-5 text-muted">No audit has produced a finding for this issue yet.</p>;
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <table className="w-full border-collapse text-left text-[13px] leading-5">
        <caption className="sr-only">Audits that found this issue, newest first</caption>
        <thead className="bg-surface-2 text-[12px] leading-[18px] text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Audit
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              When
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Items found
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Items kept
            </th>
          </tr>
        </thead>
        <tbody>
          {detail.history.map((entry) => (
            <tr key={entry.auditId} className="border-t border-line">
              <td className="px-3 py-2.5">
                <TextLink to={`/audits/${entry.auditId}`} className="font-mono text-[12px]">
                  {entry.auditId}
                </TextLink>
              </td>
              <td className="px-3 py-2.5 text-fg-2">{formatDateTime(entry.at, { zone: true })}</td>
              <td className="num px-3 py-2.5 text-right">{entry.evidenceTotal.toLocaleString()}</td>
              <td className="num px-3 py-2.5 text-right text-muted">{entry.evidenceItems.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActivityTab({ detail }: { detail: IssueDetail }) {
  const { issue } = detail;
  const events: { at: string | null; title: string; body?: string }[] = [
    { at: issue.createdAt, title: 'First found', body: `Audit ${issue.firstSeenAuditId}` },
    ...(issue.regressed > 0 && issue.lastRegressedAt
      ? [{ at: issue.lastRegressedAt, title: 'Came back after a later audit resolved it', body: `Audit ${issue.lastSeenAuditId}` }]
      : []),
    { at: issue.updatedAt, title: 'Last updated', body: `Last checked by audit ${issue.lastCheckedAuditId}` },
    ...(issue.ignored ? [{ at: issue.ignored.at, title: `Ignored by ${issue.ignored.by}`, body: issue.ignored.reason }] : []),
  ];
  return (
    <ol className="space-y-4">
      {events.map((event, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: these rows have no identity of their own; the index is their position in an ordered list that never reorders
        <li key={`${event.title}:${index}`} className="flex gap-3">
          <span aria-hidden className={cx('mt-1.5 size-2 shrink-0 rounded-full', index === 0 ? 'bg-accent' : 'bg-line-strong')} />
          <div className="min-w-0">
            <p className="text-[13px] leading-5 font-medium">{event.title}</p>
            <p className="text-[12px] leading-[18px] text-muted">
              {event.at ? formatDateTime(event.at, { zone: true }) : 'Time not recorded'}
            </p>
            {event.body && <p className="mt-0.5 text-[12px] leading-[18px] text-fg-2">{event.body}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
