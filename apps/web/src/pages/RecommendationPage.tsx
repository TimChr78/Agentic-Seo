import { ArrowRight, FileDiff } from 'lucide-react';
import { useState } from 'react';
import { api, type RecommendationDetail, type VersionSummary } from '../app/api';
import { ButtonLink, TextLink } from '../app/links';
import { useCrumbs } from '../app/page';
import { navigate } from '../app/router';
import { effortLabel } from '../app/seoLabels';
import { useSession, useSite } from '../app/session';
import { useTab } from '../app/tab';
import { useApi } from '../app/useApi';
import { Actor, Alert, Button, Card, Meta, Mono } from '../ui';
import { DetailPage } from '../ui/DetailPage';
import { Identifier } from '../ui/Identifier';
import { UrlCell } from '../ui/seo/evidence';
import { ChangeStatePill, RecommendationStatusPill } from '../ui/seo/pills';
import { type Reach, TrafficAtRisk } from '../ui/seo/reach';
import { formatDateTime, timeAgo } from '../ui/time';
import { useToast } from '../ui/toast';
import { ApprovalBar, usePendingApproval } from './seo/Approval';
import { DraftChangeSetDialog } from './seo/DraftChangeSetDialog';

// Recommendation detail (DESIGN.md §4.3): the heart of the product. The consequence comes before the
// tabs — what it touches, what is at stake, what we expect and what happens next — then the proposal,
// its evidence, the change sets that implement it, the verification plan and the version history.

const TABS = ['proposal', 'evidence', 'change-set', 'verification', 'activity'] as const;
type Tab = (typeof TABS)[number];

interface Content {
  rationale: string;
  hypothesis: string;
  evidence: { kind: string; id: string; note: string }[];
  expectedImpact: { summary: string; confidence: string; trafficAtStake: Reach };
  effort: string;
  dependsOn: string[];
  verificationPlan: { recheck: string; when: string };
  falsificationCheck: string;
  leadingIndicator: string;
  proposedChanges: { type: string; url: string; summary: string }[];
  author: { kind: string; specialist?: string | null };
}

const specialistName = (specialist?: string | null) => (specialist === 'technical' ? 'Technical specialist' : 'Strategist');

export default function RecommendationPage({ recommendationId }: { recommendationId: string }) {
  const { site } = useSite();
  const { can, agent } = useSession();
  const toast = useToast();
  const [tab, setTab] = useTab<Tab>('tab', TABS, 'proposal');
  const [drafting, setDrafting] = useState(false);
  const read = useApi(() => api.getRecommendation(recommendationId), [recommendationId]);
  const pending = usePendingApproval(recommendationId);
  const detail = read.data;
  useCrumbs([{ label: 'Recommendations', to: '/recommendations' }, { label: detail?.title ?? 'Recommendation' }]);

  if (!detail) {
    return (
      <DetailPage
        title="Recommendation"
        kind="Recommendation"
        metadata={null}
        consequence={null}
        state={read.error ? 'error' : 'loading'}
        tabs={[]}
        activeTab="proposal"
        onTabChange={() => {}}
        notice={
          read.error
            ? {
                title: 'Couldn’t open this recommendation',
                body: read.error,
                action: <Button onClick={() => void read.reload()}>Retry</Button>,
              }
            : undefined
        }
      />
    );
  }

  const content = detail.content as Content;
  const reach = content.expectedImpact?.trafficAtStake;
  const author = content.author;
  const authorName = author?.kind === 'specialist' ? specialistName(author.specialist) : author?.kind === 'agent' ? 'Agent' : 'A person';
  const canWrite = can('artifacts:write') && !agent;
  const canDraft = canWrite && detail.status !== 'rejected';
  const draftable = (content.proposedChanges ?? []).length > 0;

  const consequence = (
    <div className="rounded-lg bg-surface-2 p-4 md:p-5">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[14px] leading-[22px] font-medium text-fg">
        <span>
          Touches {reach?.kind === 'known' ? reach.affectedUrls : (content.evidence?.length ?? 0)}{' '}
          {reach?.kind === 'known' && reach.affectedUrls === 1 ? 'page' : 'pages'}
        </span>
        <span className="font-normal text-fg-2">·</span>
        <TrafficAtRisk reach={reach ?? { kind: 'unknown', reason: 'The recommendation has no reach estimate.' }} />
        <span className="font-normal text-fg-2">·</span>
        <span className="font-normal text-fg-2">reversible through a GitHub pull request</span>
      </p>
      <p className="mt-1 text-[13px] leading-5 text-fg-2">
        <span className="font-medium text-fg">Expected:</span> {content.expectedImpact?.summary}
      </p>
      <p className="mt-1 text-[13px] leading-5 text-fg-2">
        <span className="font-medium text-fg">Next:</span>{' '}
        {pending.data
          ? 'a person decides the approval request below; approving publishes the version that opens the pull request.'
          : detail.changeSets.length
            ? `the change set is ${detail.changeSets[0]!.state.replace('_', ' ')}; follow it in Changes.`
            : draftable
              ? 'draft a change set from the proposed changes, then submit it for approval.'
              : 'this is a direction rather than an edit: describe the work and attach the change set when it exists.'}
      </p>
    </div>
  );

  return (
    <>
      <DetailPage
        title={detail.title}
        kind="Recommendation"
        statePill={<RecommendationStatusPill status={detail.status} />}
        metadata={
          <>
            <span>v{detail.latestVersion}</span>
            <span aria-hidden>·</span>
            {author?.kind === 'specialist' || author?.kind === 'agent' ? (
              <Actor kind="agent" name={authorName} />
            ) : (
              <Actor kind="person" name={authorName} />
            )}
            <span aria-hidden>·</span>
            <span>Updated {timeAgo(detail.updatedAt)}</span>
          </>
        }
        primaryAction={
          draftable && !detail.changeSets.length ? (
            <Button
              variant="primary"
              icon={<FileDiff size={14} />}
              disabled={!canDraft}
              title={!canDraft ? 'Only editors can draft a change set.' : undefined}
              onClick={() => setDrafting(true)}
            >
              Draft change set
            </Button>
          ) : detail.changeSets.length ? (
            <ButtonLink to={`/changes/${detail.changeSets[0]!.id}`} variant="primary" icon={<ArrowRight size={14} />}>
              Open change set
            </ButtonLink>
          ) : undefined
        }
        secondaryActions={
          detail.changeSets.length > 0 && draftable ? (
            <Button disabled={!canDraft} onClick={() => setDrafting(true)}>
              Draft another
            </Button>
          ) : undefined
        }
        consequence={consequence}
        state="ready"
        activeTab={tab}
        onTabChange={setTab}
        tabs={[
          { key: 'proposal', label: 'Proposal', panel: <ProposalTab detail={detail} content={content} /> },
          { key: 'evidence', label: `Evidence (${detail.evidence.length})`, panel: <EvidenceTab detail={detail} siteHost={site.domain} /> },
          { key: 'change-set', label: `Change set (${detail.changeSets.length})`, panel: <ChangeSetTab detail={detail} /> },
          { key: 'verification', label: 'Verification plan', panel: <VerificationTab content={content} /> },
          { key: 'activity', label: 'Activity', panel: <ActivityTab recommendationId={detail.id} /> },
        ]}
        context={
          <div className="space-y-5">
            <div>
              <h2 className="text-[13px] leading-5 font-semibold">At a glance</h2>
              <Meta
                className="mt-2"
                items={[
                  ['Status', <RecommendationStatusPill key="status" status={detail.status} />],
                  ['Effort', effortLabel(content.effort)],
                  ['Confidence', content.expectedImpact?.confidence ?? 'Not stated'],
                  [
                    'Version',
                    `v${detail.latestVersion}${detail.publishedVersion ? `, live v${detail.publishedVersion}` : ', not published'}`,
                  ],
                  ['Priority', detail.priority === null ? 'Not set' : `#${detail.priority + 1}`],
                ]}
              />
            </div>
            <div>
              <h2 className="text-[13px] leading-5 font-semibold">Identity</h2>
              <Identifier value={detail.id} label="Recommendation ID" className="mt-2" />
            </div>
            <div>
              <h2 className="text-[13px] leading-5 font-semibold">Related</h2>
              <p className="mt-1 text-[12px] leading-[18px]">
                <TextLink to="/issues">Issues behind it</TextLink>
              </p>
              <p className="mt-1 text-[12px] leading-[18px]">
                <TextLink to="/changes">Every change set</TextLink>
              </p>
            </div>
          </div>
        }
      />

      {pending.data && <ApprovalBar artifactId={detail.id} onDecided={() => void read.reload()} />}

      <DraftChangeSetDialog
        open={drafting}
        onClose={() => setDrafting(false)}
        siteId={site.id}
        recommendation={detail}
        onDrafted={(changeSetId) => {
          toast.success('Change set drafted. It is not on the site until a person approves it.');
          void read.reload();
          if (changeSetId) navigate(`/changes/${changeSetId}`);
        }}
      />
    </>
  );
}

function ProposalTab({ detail, content }: { detail: RecommendationDetail; content: Content }) {
  const dependencies = useApi(() => api.listRecommendations({ siteId: detail.siteId, limit: 100 }), [detail.siteId]);
  const titles = new Map((dependencies.data?.recommendations ?? []).map((row) => [row.id, row.title]));
  return (
    <div className="max-w-[800px] space-y-5">
      <Card title="Hypothesis" padded>
        <p className="text-[14px] leading-[22px] text-fg">{content.hypothesis}</p>
      </Card>
      <Card title="Why this, why now" padded>
        <p className="whitespace-pre-wrap text-[14px] leading-[22px] text-fg-2">{content.rationale}</p>
      </Card>
      <Card title="Expected effect" padded>
        <Meta
          items={[
            ['Expected', content.expectedImpact?.summary ?? 'Not stated'],
            ['Confidence', content.expectedImpact?.confidence ?? 'Not stated'],
            [
              'Traffic at stake',
              <TrafficAtRisk key="reach" reach={content.expectedImpact?.trafficAtStake ?? { kind: 'unknown', reason: 'No estimate.' }} />,
            ],
            ['Effort', effortLabel(content.effort)],
          ]}
        />
      </Card>
      <Card title="Dependencies" description="What should land first, and what this blocks." padded>
        {content.dependsOn?.length ? (
          <ul className="space-y-1.5 text-[13px] leading-5">
            {content.dependsOn.map((id) => (
              <li key={id}>
                <TextLink to={`/recommendations/${id}`}>{titles.get(id) ?? id}</TextLink>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] leading-5 text-muted">Nothing has to land before this one.</p>
        )}
      </Card>
      {(content.proposedChanges?.length ?? 0) > 0 && (
        <Card title="Proposed changes" description="What a change set would do, as a hint for whoever drafts it.">
          <ul className="divide-y divide-line">
            {content.proposedChanges.map((change, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: these rows have no identity of their own; the index is their position in an ordered list that never reorders
              <li key={`${change.url}:${index}`} className="px-4 py-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <UrlCell url={change.url} />
                  <Mono>{change.type}</Mono>
                </div>
                <p className="mt-1 text-[12px] leading-[18px] text-fg-2">{change.summary}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function EvidenceTab({ detail, siteHost }: { detail: RecommendationDetail; siteHost: string }) {
  if (!detail.evidence.length) return <p className="text-[13px] leading-5 text-muted">This recommendation carries no evidence.</p>;
  return (
    <ul className="space-y-3">
      {detail.evidence.map((item) => (
        <li key={`${item.kind}:${item.id}`} className="rounded-lg border border-line p-4">
          <p className="text-[12px] leading-[18px] text-muted">
            {item.kind === 'issue'
              ? 'Issue'
              : item.kind === 'finding'
                ? 'Audit finding'
                : item.kind === 'search_fact'
                  ? 'Search Console page'
                  : 'Audit'}{' '}
            · {item.note}
          </p>
          {item.issue && (
            <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
              <TextLink to={`/issues/${item.id}`} className="text-[14px]">
                {item.issue.title}
              </TextLink>
              <p className="num text-[12px] leading-[18px] text-muted">
                {item.issue.severity} · {item.issue.affectedPages} of {item.issue.evaluatedPages} pages · {item.issue.state}
              </p>
            </div>
          )}
          {item.finding && (
            <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
              <TextLink to={`/audits/${item.finding.auditId}`} className="font-mono text-[12px]">
                {item.finding.checkId}
              </TextLink>
              <p className="num text-[12px] leading-[18px] text-muted">
                {item.finding.severity} · {item.finding.subject}
              </p>
            </div>
          )}
          {item.searchFact && (
            <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
              <UrlCell url={item.searchFact.url} siteHost={siteHost} />
              <p className="num text-[12px] leading-[18px] text-muted">
                {item.searchFact.clicks === null ? 'No clicks recorded' : `${item.searchFact.clicks.toLocaleString()} clicks`}
                {item.searchFact.position !== null ? ` · position ${item.searchFact.position.toFixed(1)}` : ''}
                {item.searchFact.dataThrough ? ` · through ${item.searchFact.dataThrough}` : ''}
              </p>
            </div>
          )}
          {item.audit && (
            <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
              <TextLink to={`/audits/${item.id}`} className="font-mono text-[12px]">
                {item.id}
              </TextLink>
              <p className="num text-[12px] leading-[18px] text-muted">
                {item.audit.pagesCrawled.toLocaleString()} pages · {item.audit.score === null ? 'no score' : `score ${item.audit.score}`}
              </p>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function ChangeSetTab({ detail }: { detail: RecommendationDetail }) {
  if (!detail.changeSets.length)
    return (
      <div className="space-y-2">
        <p className="text-[13px] leading-5 text-fg-2">
          No change set names this recommendation yet. Drafting one records the recommendation as its source, so the outcome can be read
          back here.
        </p>
      </div>
    );
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
      {detail.changeSets.map((changeSet) => (
        <li key={changeSet.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
          <div className="min-w-0">
            <TextLink to={`/changes/${changeSet.id}`} className="text-[13px]">
              {changeSet.name}
            </TextLink>
            <p className="mt-0.5 text-[12px] leading-[18px] text-muted">
              Updated {timeAgo(changeSet.updatedAt)}
              {changeSet.prUrl ? ' · pull request open' : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ChangeStatePill state={changeSet.state} />
            {changeSet.prUrl && (
              <a
                href={changeSet.prUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-[12px] font-medium text-accent hover:underline"
              >
                Open PR
              </a>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function VerificationTab({ content }: { content: Content }) {
  return (
    <div className="max-w-[800px] space-y-5">
      <Card title="Verification plan" padded>
        <Meta
          items={[
            ['Re-check', content.verificationPlan?.recheck ?? 'Not stated'],
            ['When', content.verificationPlan?.when ?? 'Not stated'],
            ['Leading indicator', content.leadingIndicator ?? 'Not stated'],
          ]}
        />
      </Card>
      <Card title="How we would know this failed" padded>
        <p className="text-[14px] leading-[22px] text-fg">{content.falsificationCheck}</p>
        <p className="mt-2 text-[12px] leading-[18px] text-muted">
          A recommendation that cannot be falsified is not a test. This sentence is what the outcome is measured against.
        </p>
      </Card>
    </div>
  );
}

function ActivityTab({ recommendationId }: { recommendationId: string }) {
  const read = useApi(() => api.getArtifactHistory(recommendationId), [recommendationId]);
  if (read.error && !read.data)
    return (
      <Alert tone="bad" title="Couldn’t load the versions" onRetry={() => void read.reload()}>
        {read.error}
      </Alert>
    );
  if (!read.data) return <p className="text-[13px] text-muted">Loading the versions…</p>;
  const versions: VersionSummary[] = read.data;
  return (
    <ol className="space-y-4">
      {versions.map((version) => (
        <li key={version.number} className="rounded-lg border border-line p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[13px] leading-5 font-medium">
              v{version.number} · {version.state === 'published' ? 'Live' : version.state.replace('_', ' ')}
            </p>
            <p className="text-[12px] leading-[18px] text-muted">{formatDateTime(version.createdAt, { zone: true })}</p>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[12px] leading-[18px] text-fg-2">
            <Actor kind={version.author.type === 'agent' ? 'agent' : 'person'} name={version.by?.displayName ?? version.author.id} />
            {version.basedOn !== null && <span className="text-muted">· based on v{version.basedOn}</span>}
          </p>
          {version.note && <p className="mt-1 whitespace-pre-wrap text-[12px] leading-[18px] text-fg-2">{version.note}</p>}
          <p className="mt-1 font-mono text-[11px] text-muted">sha256 {version.contentHash.slice(0, 16)}…</p>
        </li>
      ))}
    </ol>
  );
}
