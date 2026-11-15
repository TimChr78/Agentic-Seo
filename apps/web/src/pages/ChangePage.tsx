import { ExternalLink, GitPullRequestArrow, RotateCcw, Send } from 'lucide-react';
import { useState } from 'react';
import { api, type ChangeSetDetail, type ChangeSetDiff, type ChangeSetStatus } from '../app/api';
import { useCrumbs } from '../app/page';
import { useSession, useSite } from '../app/session';
import { useTab } from '../app/tab';
import { useApi } from '../app/useApi';
import { Button, CodeView, EmptyState, Meta, Mono } from '../ui';
import { DetailPage } from '../ui/DetailPage';
import { DiffView } from '../ui/diff';
import { Identifier } from '../ui/Identifier';
import { type PipelineStep, PipelineStrip } from '../ui/seo/PipelineStrip';
import { ChangeStatePill, changeStateLabel } from '../ui/seo/pills';
import { formatDate, formatDateTime } from '../ui/time';
import { useToast } from '../ui/toast';
import { ApprovalBar } from './seo/Approval';
import { RequestApplyDialog, RollbackDialog } from './seo/ChangeActions';

// Change set detail (DESIGN.md §4.4): the pipeline with a time and an actor per step, the diff per
// page, the source files it edits, what the deployed site answered, and the connector that carried
// it. Applying is a person's decision: this page submits, and the approval drawer decides.

const TABS = ['changes', 'files', 'verification', 'activity'] as const;
type Tab = (typeof TABS)[number];

const PIPELINE = [
  { key: 'draft', label: 'Draft' },
  { key: 'in_review', label: 'In review' },
  { key: 'approved', label: 'Approved' },
  { key: 'applying', label: 'Applying' },
  { key: 'pr_open', label: 'PR open' },
  { key: 'merged', label: 'Merged' },
  { key: 'deploying', label: 'Deploying' },
  { key: 'deployed', label: 'Deployed' },
  { key: 'verified', label: 'Verified' },
] as const;

/** Where a terminal state diverges from the happy path. */
const DIVERGES: Record<string, { at: string; label: string }> = {
  verification_failed: { at: 'verified', label: 'Verification failed' },
  deploy_not_detected: { at: 'deployed', label: 'Deploy not detected' },
  failed: { at: 'applying', label: 'Failed' },
  rolled_back: { at: 'verified', label: 'Rolled back' },
  closed: { at: 'verified', label: 'Closed' },
  stale: { at: 'verified', label: 'Stale' },
  superseded: { at: 'verified', label: 'Superseded' },
};

export default function ChangePage({ changeSetId }: { changeSetId: string }) {
  const { site } = useSite();
  const { can, agent } = useSession();
  const toast = useToast();
  const [tab, setTab] = useTab<Tab>('tab', TABS, 'changes');
  const read = useApi(() => api.getChangeSet(changeSetId), [changeSetId]);
  const status = useApi(() => api.getChangeSetStatus(changeSetId), [changeSetId]);
  const diff = useApi(() => api.getChangeSetDiff(changeSetId), [changeSetId]);
  const github = useApi(() => api.getGithubStatus(site.id), [site.id]);
  const [applying, setApplying] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [redrafting, setRedrafting] = useState(false);
  const detail = read.data;
  useCrumbs([{ label: 'Changes', to: '/changes' }, { label: detail?.name ?? 'Change set' }]);

  if (!detail) {
    return (
      <DetailPage
        title="Change set"
        kind="Change set"
        metadata={null}
        consequence={null}
        state={read.error ? 'error' : 'loading'}
        tabs={[]}
        activeTab="changes"
        onTabChange={() => {}}
        notice={
          read.error
            ? {
                title: 'Couldn’t open this change set',
                body: read.error,
                action: <Button onClick={() => void read.reload()}>Retry</Button>,
              }
            : undefined
        }
      />
    );
  }

  const run = detail.run;
  const events = status.data?.events ?? [];
  const canWrite = can('artifacts:write') && !agent;
  const canApply = can('changes:apply') && !agent;
  const submittable = run.state === 'draft' || run.state === 'stale';
  const redraftable = run.state === 'stale' && canWrite;
  const rollbackable = Boolean(run.mergeCommitSha) && run.state !== 'rolled_back' && canApply;

  const steps = buildSteps(run.state, events, run);

  const reloadAll = () => {
    void read.reload();
    void status.reload();
    void diff.reload();
  };

  const consequence = (
    <div className="rounded-lg bg-surface-2 p-4 md:p-5">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[14px] leading-[22px] font-medium text-fg">
        <span>
          {detail.changes.length} {detail.changes.length === 1 ? 'page' : 'pages'} touched
        </span>
        <span className="font-normal text-fg-2">·</span>
        <span className="font-normal text-fg-2">
          {run.prUrl ? `pull request #${run.prNumber}` : 'no pull request yet'}
          {run.deployedSha ? ` · deployed ${run.deployedSha.slice(0, 7)}` : ''}
        </span>
      </p>
      <p className="mt-1 text-[13px] leading-5 text-fg-2">
        {run.lastError
          ? run.lastError
          : run.state === 'draft'
            ? 'Next: submit it for approval. A person decides, and approving opens the pull request.'
            : run.state === 'in_review'
              ? 'Next: a person decides the approval request below.'
              : run.state === 'verification_failed'
                ? 'Next: read what the deployed page answered, then redraft or roll back.'
                : run.state === 'stale'
                  ? 'Next: the source moved after drafting. Redraft it against the current files.'
                  : 'Next: follow the pull request and the deployment.'}
      </p>
    </div>
  );

  return (
    <>
      <DetailPage
        title={detail.name}
        kind="Change set"
        statePill={<ChangeStatePill state={run.state} />}
        metadata={
          <>
            <span className="font-mono text-[12px]">{changeSetId}</span>
            <span aria-hidden>·</span>
            <span>v{detail.version}</span>
            <span aria-hidden>·</span>
            <span>{site.name}</span>
          </>
        }
        primaryAction={
          submittable ? (
            <Button
              variant="primary"
              icon={<Send size={14} />}
              disabled={!canApply}
              title={!canApply ? 'Only editors can submit a change set.' : undefined}
              onClick={() => setApplying(true)}
            >
              Request apply
            </Button>
          ) : run.prUrl ? (
            <a
              href={run.prUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-10 items-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg hover:bg-accent-hover md:h-8"
            >
              <ExternalLink size={14} aria-hidden />
              Open pull request
            </a>
          ) : undefined
        }
        secondaryActions={
          <>
            {redraftable && (
              <Button
                disabled={!canWrite || redrafting}
                loading={redrafting}
                title={!canWrite ? 'Only editors can redraft.' : undefined}
                onClick={async () => {
                  setRedrafting(true);
                  try {
                    const result = await api.redraftChangeSet(run.artifactId);
                    toast.success(`Redrafted as version ${result.version} against the current files.`);
                    reloadAll();
                  } catch (error) {
                    toast.error(String(error instanceof Error ? error.message : error));
                  } finally {
                    setRedrafting(false);
                  }
                }}
              >
                Redraft
              </Button>
            )}
            {rollbackable && (
              <Button icon={<RotateCcw size={14} />} disabled={!canApply} onClick={() => setRollingBack(true)}>
                Roll back
              </Button>
            )}
          </>
        }
        consequence={consequence}
        state="ready"
        activeTab={tab}
        onTabChange={setTab}
        tabs={[
          { key: 'changes', label: `Changes (${detail.changes.length})`, panel: <DiffsTab diff={diff.data} /> },
          { key: 'files', label: `Files (${diff.data?.files.length ?? 0})`, panel: <FilesTab diff={diff.data} /> },
          { key: 'verification', label: 'Verification', panel: <VerificationTab status={status.data} /> },
          { key: 'activity', label: 'Activity', panel: <ActivityTab status={status.data} /> },
        ]}
        context={
          <div className="space-y-5">
            <div>
              <h2 className="text-[13px] leading-5 font-semibold">Pipeline</h2>
              <PipelineStrip className="mt-3" label="Change set pipeline" steps={steps} />
            </div>
            <div>
              <h2 className="text-[13px] leading-5 font-semibold">Connector</h2>
              {github.data?.repository ? (
                <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] leading-[18px]">
                  <GitPullRequestArrow size={14} className="text-muted" aria-hidden />
                  <span>GitHub · {github.data.repository}</span>
                  {run.prUrl && (
                    <>
                      <span aria-hidden>·</span>
                      <a href={run.prUrl} target="_blank" rel="noreferrer noopener" className="font-medium text-accent hover:underline">
                        PR #{run.prNumber}
                      </a>
                    </>
                  )}
                </p>
              ) : (
                <p className="mt-2 text-[12px] leading-[18px] text-muted">
                  No GitHub connection for this site, so the pull request cannot be read.{' '}
                  <a href="/settings/connections" className="text-accent hover:underline">
                    Connect GitHub
                  </a>
                </p>
              )}
              <Meta
                className="mt-2"
                items={[
                  ['Base branch', github.data?.baseBranch ?? 'Unknown'],
                  ['Deployed', run.deployedSha ? <Mono key="sha">{run.deployedSha.slice(0, 12)}</Mono> : 'Not yet'],
                  ['Merge commit', run.mergeCommitSha ? <Mono key="merge">{run.mergeCommitSha.slice(0, 12)}</Mono> : 'Not merged'],
                  ['Verification', `${run.verificationAttempts} ${run.verificationAttempts === 1 ? 'attempt' : 'attempts'}`],
                ]}
              />
            </div>
            <div>
              <h2 className="text-[13px] leading-5 font-semibold">Identity</h2>
              <Identifier value={changeSetId} label="Change set ID" className="mt-2" />
            </div>
          </div>
        }
      />

      <ApprovalBar artifactId={changeSetId} onDecided={reloadAll} />

      <RequestApplyDialog open={applying} onClose={() => setApplying(false)} changeSetId={changeSetId} onSubmitted={reloadAll} />
      <RollbackDialog open={rollingBack} onClose={() => setRollingBack(false)} changeSetId={changeSetId} onProposed={reloadAll} />
    </>
  );
}

type Run = ChangeSetDetail['run'];
type Event = ChangeSetStatus['events'][number];

/** The nine pipeline steps, with the timestamps and actors the run and its events recorded. */
function buildSteps(state: string, events: Event[], run: Run): PipelineStep[] {
  const at = (eventState: string) => events.find((event) => event.toState === eventState)?.at ?? null;
  const actor = (eventState: string) => {
    const event = events.find((candidate) => candidate.toState === eventState);
    if (!event) return null;
    return event.actor.type === 'person' ? 'a person' : event.actor.type === 'agent' ? 'an agent' : 'the system';
  };
  const times: Record<string, string | null> = {
    draft: run.draftedAt,
    in_review: run.submittedAt,
    approved: run.approvedAt,
    applying: run.appliedAt,
    pr_open: at('pr_open'),
    merged: run.mergedAt,
    deploying: at('deploying'),
    deployed: run.deployedAt,
    verified: run.verifiedAt,
  };
  const divergence = DIVERGES[state];
  const reached = state === 'verified' ? PIPELINE.length - 1 : PIPELINE.findIndex((step) => step.key === state);
  const current = divergence ? PIPELINE.findIndex((step) => step.key === divergence.at) : reached < 0 ? 0 : reached;

  return PIPELINE.map((step, index) => {
    const failed = divergence !== undefined && index === current;
    const done = index < current;
    return {
      key: step.key,
      label: failed ? divergence.label : step.label,
      state: failed ? 'failed' : done ? 'done' : index === current ? 'current' : 'upcoming',
      at: failed ? (divergence.at === 'verified' ? run.stateChangedAt : times[step.key]) : (times[step.key] ?? null),
      actor: failed ? null : (actor(step.key) ?? (times[step.key] ? 'the system' : null)),
      detail: failed ? run.lastError : null,
      alternate: step.key === 'in_review',
    };
  });
}

function DiffsTab({ diff }: { diff: ChangeSetDiff | undefined }) {
  if (!diff) return <p className="text-[13px] text-muted">Loading the diff…</p>;
  if (!diff.urls.length) return <EmptyState title="No page changes in this version">This draft carries no rendered change.</EmptyState>;
  return (
    <div className="space-y-6">
      {diff.urls.map((url) => (
        <section key={url.url} aria-label={url.url}>
          <h3 className="mb-2 font-mono text-[12px] leading-[18px] break-all text-fg-2">{url.url}</h3>
          {url.changes.map((change, index) =>
            change.type === 'redirect' ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: these rows have no identity of their own; the index is their position in an ordered list that never reorders
              <RedirectDiff key={`${change.type}:${index}`} before={change.before} after={change.after} />
            ) : (
              <DiffView
                // biome-ignore lint/suspicious/noArrayIndexKey: these rows have no identity of their own; the index is their position in an ordered list that never reorders
                key={`${change.type}:${index}`}
                changes={[
                  {
                    path:
                      change.type === 'schema.jsonld'
                        ? 'Structured data'
                        : change.type === 'image.alt'
                          ? 'Image alt text'
                          : change.type === 'meta.title'
                            ? 'Title'
                            : 'Description',
                    kind: 'changed',
                    before: change.before ?? undefined,
                    after: change.after ?? undefined,
                  },
                ]}
              />
            ),
          )}
        </section>
      ))}
    </div>
  );
}

function RedirectDiff({ before, after }: { before: unknown; after: unknown }) {
  const read = (value: unknown) => {
    if (value === null || value === undefined) return { to: '—', status: '—' };
    const entry = value as { to?: string | null; status?: number | null };
    return { to: entry.to ?? '—', status: entry.status ? String(entry.status) : '—' };
  };
  const from = read(before);
  const to = read(after);
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <table className="w-full border-collapse text-left text-[13px] leading-5">
        <caption className="sr-only">Redirect before and after</caption>
        <thead className="bg-surface-2 text-[12px] leading-[18px] text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Rule
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Target
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-line">
            <td className="px-3 py-2 text-fg-2">Now</td>
            <td className="px-3 py-2 font-mono text-[12px] break-all">{from.to}</td>
            <td className="num px-3 py-2 text-right">{from.status}</td>
          </tr>
          <tr className="border-t border-line">
            <td className="px-3 py-2 text-fg">After</td>
            <td className="px-3 py-2 font-mono text-[12px] break-all">{to.to}</td>
            <td className="num px-3 py-2 text-right">{to.status}</td>
          </tr>
        </tbody>
      </table>
      <p className="border-t border-line px-3 py-2 text-[12px] leading-[18px] text-muted">
        A redirect change is checked for a chain: the deployment is verified by fetching the source path and reading where it lands.
      </p>
    </div>
  );
}

function FilesTab({ diff }: { diff: ChangeSetDiff | undefined }) {
  if (!diff) return <p className="text-[13px] text-muted">Loading the files…</p>;
  if (!diff.files.length) return <EmptyState title="No source file in this version">This draft carries no file change.</EmptyState>;
  return (
    <div className="space-y-4">
      {diff.files.map((file) => (
        <div key={file.path}>
          <p className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-[12px] leading-[18px]">
            <span className="font-mono break-all text-fg-2">{file.path}</span>
            <span className="num text-muted">
              {file.status} · +{file.additions} −{file.deletions}
            </span>
          </p>
          <CodeView value={file.unified} label="Unified diff" maxHeight={320} />
        </div>
      ))}
    </div>
  );
}

function VerificationTab({ status }: { status: ChangeSetStatus | undefined }) {
  if (!status) return <p className="text-[13px] text-muted">Loading the verification…</p>;
  const results = status.verification.results;
  if (!results.length)
    return (
      <EmptyState title="No verification has run yet">
        Verification reads the deployed page back after the merge and compares it with what the change set said would be true. It runs once
        the deployment is detected.
      </EmptyState>
    );
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-5 text-fg-2">
        Attempt {status.verification.attempt ?? 1}, read from the deployed site. A change that is unknown could not be checked: the page did
        not answer as expected, and the evidence says what it returned.
      </p>
      <div className="overflow-hidden rounded-lg border border-line">
        <table className="w-full border-collapse text-left text-[13px] leading-5">
          <caption className="sr-only">Verification results per change</caption>
          <thead className="bg-surface-2 text-[12px] leading-[18px] text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Page
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Change
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Result
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                What the page showed
              </th>
            </tr>
          </thead>
          <tbody>
            {results.map((result) => (
              <tr key={`${result.changeIndex}:${result.url}`} className="border-t border-line align-top">
                <td className="max-w-[240px] px-3 py-2.5 font-mono text-[12px] break-all text-fg-2">{result.url}</td>
                <td className="px-3 py-2.5 text-fg-2">{result.changeType}</td>
                <td className="px-3 py-2.5">
                  <span className={result.result === 'pass' ? 'text-good' : result.result === 'fail' ? 'text-bad' : 'text-muted'}>
                    {result.result === 'pass' ? 'Passed' : result.result === 'fail' ? 'Failed' : 'Unknown'}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-[12px] leading-[18px] text-fg-2">{result.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ActivityTab({ status }: { status: ChangeSetStatus | undefined }) {
  if (!status) return <p className="text-[13px] text-muted">Loading the activity…</p>;
  if (!status.events.length) return <EmptyState title="No transition recorded">The change set has not moved yet.</EmptyState>;
  return (
    <ol className="space-y-4">
      {status.events.map((event, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: these rows have no identity of their own; the index is their position in an ordered list that never reorders
        <li key={`${event.at}:${index}`} className="flex gap-3">
          <span
            aria-hidden
            className={index === 0 ? 'mt-1.5 size-2 shrink-0 rounded-full bg-accent' : 'mt-1.5 size-2 shrink-0 rounded-full bg-line-strong'}
          />
          <div className="min-w-0">
            <p className="text-[13px] leading-5 font-medium">
              {event.fromState ? `${changeStateLabel(event.fromState)} → ` : ''}
              {changeStateLabel(event.toState)}
            </p>
            <p className="text-[12px] leading-[18px] text-muted">
              {formatDateTime(event.at, { zone: true })} ·{' '}
              {event.actor.type === 'person' ? 'a person' : event.actor.type === 'agent' ? 'an agent' : 'the system'}
            </p>
            <p className="mt-0.5 text-[12px] leading-[18px] text-fg-2">{event.reason}</p>
          </div>
        </li>
      ))}
      <li className="rounded-lg border border-line p-4">
        <p className="text-[12px] leading-[18px] font-medium text-fg-2">Times</p>
        <Meta
          className="mt-2"
          items={[
            ['Drafted', formatDate(status.run.draftedAt)],
            ['Submitted', status.run.submittedAt ? formatDateTime(status.run.submittedAt, { zone: true }) : 'Not yet'],
            ['Merged', status.run.mergedAt ? formatDateTime(status.run.mergedAt, { zone: true }) : 'Not yet'],
            ['Verified', status.run.verifiedAt ? formatDateTime(status.run.verifiedAt, { zone: true }) : 'Not yet'],
          ]}
        />
      </li>
    </ol>
  );
}
