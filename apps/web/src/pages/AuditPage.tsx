import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type Audit, type AuditPageRow, type AuditProgress, type AuditScore, api, type Finding } from '../app/api';
import { useCursor } from '../app/cursor';
import { useCrumbs } from '../app/page';
import { Link } from '../app/router';
import { categoryLabel } from '../app/seoLabels';
import { useSite } from '../app/session';
import { useTab } from '../app/tab';
import { useApi } from '../app/useApi';
import { Alert, Button, Card, CodeView, EmptyState, Meta, Mono } from '../ui';
import { DetailPage } from '../ui/DetailPage';
import { Select } from '../ui/form';
import { Identifier } from '../ui/Identifier';
import { Drawer } from '../ui/overlay';
import { Pager } from '../ui/Pager';
import { HealthScore } from '../ui/seo/HealthScore';
import { AuditStatePill, SeverityPill } from '../ui/seo/pills';
import { formatDateTime } from '../ui/time';

// Audit detail (DESIGN.md §4.5). While the crawl runs the header says how far it got, in pages — no
// percentage and no estimate. Once it finishes, the overview says what the score covered and what
// it could not judge; the issues are the findings of this run, and the pages are what it read.

const TABS = ['overview', 'issues', 'pages', 'settings'] as const;
type Tab = (typeof TABS)[number];

const PAGE_STATUSES = ['all', 'ok', 'redirect', 'client_error', 'server_error', 'failed', 'robots'] as const;

export default function AuditPage({ auditId, pollMs = 5000 }: { auditId: string; pollMs?: number }) {
  const { site } = useSite();
  const [tab, setTab] = useTab<Tab>('tab', TABS, 'overview');
  const read = useApi(() => api.getAuditProgress(auditId), [auditId]);
  const audit = read.data?.audit;
  useCrumbs([{ label: 'Audits', to: '/audits' }, { label: audit ? audit.id : 'Audit' }]);

  const live = audit ? ['queued', 'running', 'finalizing'].includes(audit.state) : false;
  // A live crawl changes its counters: poll while it runs, and stop when it has finished.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void read.reload(), pollMs);
    return () => clearInterval(timer);
  }, [live, read.reload, pollMs]);

  if (!read.data) {
    return (
      <DetailPage
        title="Audit"
        kind="Audit"
        metadata={null}
        consequence={null}
        tabs={[]}
        activeTab="overview"
        onTabChange={() => {}}
        state={read.error ? 'error' : 'loading'}
        notice={
          read.error
            ? { title: 'Couldn’t open this audit', body: read.error, action: <Button onClick={() => void read.reload()}>Retry</Button> }
            : undefined
        }
      />
    );
  }

  return (
    <DetailPage
      title={auditName(audit!)}
      kind="Audit"
      statePill={<AuditStatePill state={audit!.state} />}
      metadata={
        <>
          <span className="font-mono text-[12px]">{audit!.id}</span>
          <span aria-hidden>·</span>
          <span>{site.name}</span>
          <span aria-hidden>·</span>
          <span>{formatDateTime(audit!.startedAt ?? audit!.createdAt, { zone: true })}</span>
        </>
      }
      consequence={<AuditConsequence audit={audit!} progress={read.data.progress} />}
      state="ready"
      activeTab={tab}
      onTabChange={setTab}
      tabs={[
        { key: 'overview', label: 'Overview', panel: <OverviewTab audit={audit!} siteId={site.id} /> },
        { key: 'issues', label: 'Issues', panel: <IssuesTab audit={audit!} /> },
        {
          key: 'pages',
          label: `Pages (${audit!.pagesCrawled.toLocaleString()})`,
          panel: <PagesTab auditId={audit!.id} siteHost={site.domain} />,
        },
        { key: 'settings', label: 'Settings', panel: <SettingsTab audit={audit!} /> },
      ]}
      context={
        <div className="space-y-5">
          <div>
            <h2 className="text-[13px] leading-5 font-semibold">Run</h2>
            <Meta
              className="mt-2"
              items={[
                ['State', <AuditStatePill key="state" state={audit!.state} />],
                ['Started', audit!.startedAt ? formatDateTime(audit!.startedAt, { zone: true }) : 'Not yet'],
                [
                  'Finished',
                  audit!.finishedAt ? formatDateTime(audit!.finishedAt, { zone: true }) : live ? 'Still running' : 'Not recorded',
                ],
                [
                  'Pages read',
                  <span key="pages" className="num">
                    {audit!.pagesCrawled.toLocaleString()}
                  </span>,
                ],
                [
                  'Pages failed',
                  <span key="failed" className="num">
                    {audit!.pagesFailed.toLocaleString()}
                  </span>,
                ],
              ]}
            />
          </div>
          <div>
            <h2 className="text-[13px] leading-5 font-semibold">Identity</h2>
            <Identifier value={audit!.id} label="Audit ID" className="mt-2" />
          </div>
          <div>
            <h2 className="text-[13px] leading-5 font-semibold">Elsewhere</h2>
            <p className="mt-2 text-[12px] leading-[18px]">
              <Link to="/issues" className="text-accent hover:underline">
                All issues on this site
              </Link>
            </p>
            <p className="mt-1 text-[12px] leading-[18px]">
              <Link to={`/issues?audit=${audit!.id}`} className="text-accent hover:underline">
                Issues this run found
              </Link>
            </p>
          </div>
        </div>
      }
    />
  );
}

function auditName(audit: Audit) {
  switch (audit.scope) {
    case 'section':
      return `Section audit ${audit.section ?? ''}`;
    case 'list':
      return `Audit of ${audit.urls?.length ?? 0} listed pages`;
    case 'page':
      return 'Single-page audit';
    default:
      return `Site audit of ${audit.pagesCrawled.toLocaleString()} pages`;
  }
}

function AuditConsequence({ audit, progress }: { audit: Audit; progress: AuditProgress['progress'] }) {
  const live = ['queued', 'running', 'finalizing'].includes(audit.state);
  return (
    <div className="rounded-lg bg-surface-2 p-4 md:p-5">
      <p className="flex flex-wrap items-center gap-2 text-[14px] leading-[22px] font-medium">
        {live ? (
          <>
            <span>
              Crawling · {progress.crawled.toLocaleString()} of ≈ {Math.max(progress.discovered, progress.crawled).toLocaleString()} pages
            </span>
            <span className="num rounded-full bg-surface px-2 text-[11px] font-medium text-fg-2">
              {progress.pending.toLocaleString()} pending · {progress.leased.toLocaleString()} in flight
            </span>
          </>
        ) : (
          <span>
            {audit.pagesCrawled.toLocaleString()} pages read
            {audit.pagesFailed ? ` · ${audit.pagesFailed.toLocaleString()} failed to load` : ''}
          </span>
        )}
      </p>
      <p className="mt-1 text-[13px] leading-5 text-fg-2">
        {audit.state === 'partial' || audit.state === 'failed'
          ? (audit.stateReason ?? 'The audit ended without a reason recorded; its coverage below says what it read.')
          : audit.state === 'cancelled'
            ? 'This audit was cancelled. The pages it read are still here; a later run replaces it as the current picture.'
            : live
              ? 'There is no time estimate; this page refreshes every five seconds.'
              : audit.coverage?.graph === 'truncated'
                ? `The crawl did not reach the whole link graph: ${coverageReasons(audit)}.`
                : 'The crawl reached the whole link graph it could find from the seed.'}
      </p>
    </div>
  );
}

const COVERAGE_REASONS: Record<string, string> = {
  page_limit: 'it stopped at the page limit',
  depth_limit: 'it stopped at the click-depth limit',
  time_limit: 'it stopped at the time budget',
  robots: 'robots.txt kept it out of some paths',
  errors: 'some pages failed to load',
  cancelled: 'it was cancelled',
  section_quota: 'the section quota was reached',
  links_truncated: 'a page had more links than one extraction keeps',
  sitemaps_truncated: 'the sitemap list was cut short',
};

const coverageReasons = (audit: Audit) =>
  (audit.coverage?.reasons ?? []).map((reason) => COVERAGE_REASONS[reason] ?? reason).join('; ') || 'the reason was not recorded';

function OverviewTab({ audit, siteId }: { audit: Audit; siteId: string }) {
  // The score is its own read: a run that has not finalized has none, and the command says why.
  // The state is a dependency, so the poll that moves a run to completed (or failed) refetches the
  // score instead of leaving the pre-completion answer on screen.
  const score = useApi(() => api.getAuditScore(siteId, audit.id), [siteId, audit.id, audit.state]);
  if (score.error && !score.data)
    return (
      <Alert tone="warn" title="No score yet" onRetry={() => void score.reload()}>
        {score.error}
      </Alert>
    );
  if (!score.data)
    return (
      <div aria-busy="true" className="h-40 rounded-lg border border-line bg-surface p-4">
        <p className="text-[13px] text-muted">Loading the score…</p>
      </div>
    );
  return <ScoreOverview score={score.data} />;
}

function ScoreOverview({ score }: { score: AuditScore }) {
  const evaluated = score.categories.filter((category) => category.affectedPages > 0);
  return (
    <div className="space-y-5">
      <div className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
        <HealthScore
          className="border border-line"
          score={score.score}
          pagesEvaluated={score.pagesEvaluated}
          // The server publishes a weight and a penalty per category, not a per-category score, so
          // no bar is invented; the table beside this tile carries those numbers as they are.
          categories={[]}
          notEvaluated={score.notEvaluated.map((entry) => categoryLabel(entry.category))}
          period={`Audit ${score.auditId} · pages read ${score.pagesCrawled.toLocaleString()}`}
          updatedAt={formatDateTime(score.computedAt, { zone: true })}
        />
        <div className="space-y-4">
          <Card title="How this score was reached" description="Each category's weight and the penalty its issues earned.">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-[13px] leading-5">
                <caption className="sr-only">Category weights and penalties</caption>
                <thead className="bg-surface-2 text-[12px] leading-[18px] text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Category
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Weight
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Issues
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Pages affected
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Penalty
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Contribution
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {score.categories.map((category) => (
                    <tr key={category.category} className="border-t border-line">
                      <td className="px-3 py-2">{categoryLabel(category.category)}</td>
                      <td className="num px-3 py-2 text-right">{Math.round(category.weight * 100)}%</td>
                      <td className="num px-3 py-2 text-right">{category.issues}</td>
                      <td className="num px-3 py-2 text-right">{category.affectedPages}</td>
                      <td className="num px-3 py-2 text-right">{category.penalty.toFixed(1)}</td>
                      <td className="num px-3 py-2 text-right">{category.contribution.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {evaluated.length === 0 && (
              <p className="px-4 py-3 text-[12px] text-muted">No category had a failing issue, so nothing was penalized.</p>
            )}
          </Card>
          <Card title="Coverage" description="What this run could and could not judge." padded>
            <ul className="space-y-2 text-[13px] leading-5">
              <li className="flex items-start gap-2">
                {score.uncheckedIssues === 0 ? (
                  <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-good" aria-hidden />
                ) : (
                  <AlertCircle size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden />
                )}
                <span>
                  <span className="num">{score.uncheckedIssues.toLocaleString()}</span> open{' '}
                  {score.uncheckedIssues === 1 ? 'issue was' : 'issues were'} outside this audit, so they are excluded from the score rather
                  than counted as healthy.
                </span>
              </li>
              <li className="text-muted">
                {score.gscWeighted
                  ? 'Search Console clicks weighted the page shares, so pages with traffic count for more.'
                  : 'Search Console is not connected, so every page counted equally.'}
              </li>
              {score.reason && <li className="text-warn">{score.reason}</li>}
            </ul>
          </Card>
          {score.skippedChecks.length > 0 && (
            <Card title="Checks this run skipped" description="Each one names why, so a gap is never read as healthy.">
              <ul className="divide-y divide-line">
                {score.skippedChecks.map((check) => (
                  <li key={check.checkId} className="flex flex-wrap items-baseline gap-2 px-4 py-2.5 text-[12px] leading-[18px]">
                    <Mono>{check.checkId}</Mono>
                    <span className="min-w-0 flex-1 text-fg-2">{check.reason}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {score.notEvaluated.length > 0 && (
            <Card title="Not evaluated" description="Categories this run could not judge, with the reason." padded>
              <ul className="space-y-2 text-[13px] leading-5">
                {score.notEvaluated.map((entry) => (
                  <li key={entry.category}>
                    <span className="font-medium">{categoryLabel(entry.category)}</span>
                    <span className="text-fg-2"> · {entry.reason}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

const RUNNING_STATES = new Set(['queued', 'running', 'finalizing']);
const UNFINISHED_REASON: Record<string, string> = {
  failed: 'the run failed',
  partial: 'the run is partial',
  cancelled: 'the run was cancelled',
};

function IssuesTab({ audit }: { audit: Audit }) {
  // The state is a dependency: when the poll finishes the crawl, the findings are read again.
  const read = useApi(() => api.listAuditFindings({ auditId: audit.id, limit: 200 }), [audit.id, audit.state]);
  if (read.error && !read.data)
    return (
      <Alert tone="bad" title="Couldn’t load this run’s findings" onRetry={() => void read.reload()}>
        {read.error}
      </Alert>
    );
  if (!read.data) return <p className="text-[13px] text-muted">Loading the findings…</p>;
  const findings: Finding[] = read.data.rows;
  if (!findings.length) {
    // An empty list only means "nothing to fix" for a run that actually evaluated pages. Anything
    // else is pending or unavailable, and saying otherwise would read as a clean bill of health.
    if (RUNNING_STATES.has(audit.state))
      return (
        <EmptyState title="No findings yet">
          This run is still {audit.state === 'finalizing' ? 'finalizing' : 'crawling'}. Findings appear when it finishes.
        </EmptyState>
      );
    if (audit.state === 'completed' && audit.pagesCrawled > 0)
      return (
        <EmptyState title="This run found nothing to fix">
          Every check it evaluated passed on the pages it read. Pages outside the run are not covered by that statement.
        </EmptyState>
      );
    return (
      <EmptyState title="Findings are unavailable">
        {audit.state === 'completed'
          ? 'This run read no page, so no check could evaluate anything.'
          : `This run ${UNFINISHED_REASON[audit.state] ?? 'did not complete'}, so its findings cannot be read${
              audit.state === 'partial' ? ' as a complete result' : ''
            }.`}
        {audit.stateReason ? ` ${audit.stateReason}` : ''} A later completed run replaces it.
      </EmptyState>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-5 text-fg-2">
        {findings.length} {findings.length === 1 ? 'finding' : 'findings'} from this run. Each groups into an issue that tracks it across
        audits.{read.data.nextCursor ? ' Showing the first 200; narrow by check to see a specific problem.' : ''}
      </p>
      <div className="overflow-hidden rounded-lg border border-line">
        <table className="w-full border-collapse text-left text-[13px] leading-5">
          <caption className="sr-only">Findings this audit produced</caption>
          <thead className="bg-surface-2 text-[12px] leading-[18px] text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Finding
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Severity
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Subject
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Items
              </th>
            </tr>
          </thead>
          <tbody>
            {findings.map((finding) => (
              <tr key={finding.id} className="border-t border-line">
                <td className="px-3 py-2.5">
                  {finding.issueId ? (
                    <Link to={`/issues/${finding.issueId}`} className="font-medium text-fg hover:text-accent hover:underline">
                      {finding.title}
                    </Link>
                  ) : (
                    <span className="font-medium">{finding.title}</span>
                  )}
                  <p className="font-mono text-[12px] text-muted">{finding.checkId}</p>
                </td>
                <td className="px-3 py-2.5">
                  <SeverityPill severity={finding.severity} />
                </td>
                <td className="max-w-[320px] px-3 py-2.5 font-mono text-[12px] break-all text-fg-2">{finding.subject}</td>
                <td className="num px-3 py-2.5 text-right">{finding.evidenceTotal.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PagesTab({ auditId, siteHost }: { auditId: string; siteHost: string }) {
  const [status, setStatus] = useState<(typeof PAGE_STATUSES)[number]>('all');
  const cursor = useCursor(`${auditId}:${status}`);
  const [open, setOpen] = useState<AuditPageRow | null>(null);
  const read = useApi(
    () => api.listAuditPages({ auditId, status, limit: 50, ...(cursor.cursor ? { cursor: cursor.cursor } : {}) }),
    [auditId, status, cursor.cursor],
  );
  const rows = read.data?.rows ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <Select
          aria-label="Page status"
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof status)}
          className="w-auto"
        >
          {PAGE_STATUSES.map((option) => (
            <option key={option} value={option}>
              {option === 'all'
                ? 'All pages'
                : option === 'ok'
                  ? '200 OK'
                  : option === 'redirect'
                    ? 'Redirects'
                    : option === 'client_error'
                      ? '4xx'
                      : option === 'server_error'
                        ? '5xx'
                        : option === 'failed'
                          ? 'Failed to load'
                          : 'Blocked by robots.txt'}
            </option>
          ))}
        </Select>
        <p className="num text-[12px] leading-[18px] text-muted">
          {rows.length} {rows.length === 1 ? 'page' : 'pages'} on this page
        </p>
      </div>

      {read.error && !read.data && (
        <Alert tone="bad" title="Couldn’t load the pages" onRetry={() => void read.reload()}>
          {read.error}
        </Alert>
      )}
      {!read.data && !read.error && <p className="text-[13px] text-muted">Loading the pages…</p>}
      {read.data && rows.length === 0 && (
        <EmptyState title="No page has this status">Choose another status, or All pages, to see what this run read.</EmptyState>
      )}
      {rows.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-line">
          <table className="w-full border-collapse text-left text-[13px] leading-5">
            <caption className="sr-only">Pages this audit read</caption>
            <thead className="bg-surface-2 text-[12px] leading-[18px] text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Page
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Title
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Depth
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((page) => (
                <tr key={page.snapshotId} className="border-t border-line hover:bg-surface-2">
                  <td className="max-w-[360px] px-3 py-2.5">
                    <button
                      type="button"
                      onClick={() => setOpen(page)}
                      className="min-w-0 truncate text-left font-mono text-[12px] text-fg hover:text-accent hover:underline"
                    >
                      {page.url.replace(/^https?:\/\/[^/]+/, '') || '/'}
                    </button>
                    {page.finalUrl !== page.url && <p className="text-[12px] text-muted">→ {page.finalUrl}</p>}
                  </td>
                  <td className="max-w-[320px] truncate px-3 py-2.5 text-fg-2">{page.title ?? '—'}</td>
                  <td className="num px-3 py-2.5 text-right">{page.status || '—'}</td>
                  <td className="num px-3 py-2.5 text-right">{page.depth ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {read.data && (cursor.canPrevious || read.data.nextCursor) && (
        <Pager
          noun="pages"
          page={cursor.page}
          canPrevious={cursor.canPrevious}
          canNext={Boolean(read.data.nextCursor)}
          onPrevious={cursor.previous}
          onNext={() => read.data?.nextCursor && cursor.next(read.data.nextCursor)}
          loading={read.refreshing}
        />
      )}

      <PageFactsDrawer auditId={auditId} page={open} siteHost={siteHost} onClose={() => setOpen(null)} />
    </div>
  );
}

function PageFactsDrawer({
  auditId,
  page,
  siteHost,
  onClose,
}: {
  auditId: string;
  page: AuditPageRow | null;
  siteHost: string;
  onClose: () => void;
}) {
  const read = useApi(() => (page ? api.getAuditPage(auditId, page.snapshotId) : Promise.resolve(null)), [auditId, page?.snapshotId], {
    skip: page === null,
  });
  const facts = read.data as
    | {
        html?: {
          title?: string | null;
          metaDescription?: string | null;
          canonical?: string | null;
          metaRobots?: string[];
          wordCount?: number;
        } | null;
      }
    | null
    | undefined;
  const html = facts?.html ?? null;
  return (
    <Drawer
      open={page !== null}
      onClose={onClose}
      width="lg"
      title={page?.url ?? 'Page'}
      meta={page ? `${page.status || 'No response'} · ${siteHost}` : undefined}
    >
      <div className="space-y-4 p-4 md:p-5">
        {read.error && (
          <Alert tone="bad" title="Couldn’t load this page’s facts">
            {read.error}
          </Alert>
        )}
        {!read.data && !read.error && <p className="text-[13px] text-muted">Loading the page’s facts…</p>}
        {read.data && (
          <>
            <Meta
              items={[
                [
                  'Requested',
                  <span key="url" className="font-mono text-[12px] break-all">
                    {page?.url ?? ''}
                  </span>,
                ],
                [
                  'Answered as',
                  <span key="final" className="font-mono text-[12px] break-all">
                    {page?.finalUrl ?? ''}
                  </span>,
                ],
                ['Title', html?.title ?? 'No title'],
                ['Description', html?.metaDescription ?? 'None'],
                ['Canonical', html?.canonical ?? 'None'],
                ['Robots', html?.metaRobots?.length ? html.metaRobots.join(', ') : 'None'],
                ['Words', html?.wordCount !== undefined ? html.wordCount.toLocaleString() : 'Not HTML'],
                ['Depth', page?.depth === null || page?.depth === undefined ? 'Sitemap or listed URL' : String(page.depth)],
                ['Found by', page?.discoveredBy ?? '—'],
                ['In sitemap', page?.inSitemap ? 'Yes' : 'No'],
                ['robots.txt', page?.robotsAllowed ? 'Allowed' : 'Disallowed'],
              ]}
            />
            <CodeView label="All extracted facts (read-only)" value={JSON.stringify(read.data, null, 2)} maxHeight={420} />
          </>
        )}
      </div>
    </Drawer>
  );
}

function SettingsTab({ audit }: { audit: Audit }) {
  return (
    <div className="max-w-[760px] space-y-5">
      <Card title="Scope and limits" padded>
        <Meta
          items={[
            [
              'Scope',
              audit.scope === 'site'
                ? 'Whole site'
                : audit.scope === 'section'
                  ? `Section ${audit.section ?? ''}`
                  : `${audit.urls?.length ?? 0} URLs`,
            ],
            [
              'Page limit',
              <span key="pages" className="num">
                {audit.limits.maxPages.toLocaleString()}
              </span>,
            ],
            [
              'Click depth limit',
              <span key="depth" className="num">
                {audit.limits.maxDepth}
              </span>,
            ],
            [
              'Time budget',
              <span key="time" className="num">
                {Math.round(audit.limits.maxDurationMs / 60000)} minutes
              </span>,
            ],
            ['Render mode', audit.renderMode === 'never' ? 'Raw HTML only (no renderer in Phase 1)' : audit.renderMode],
            ['Requested by', audit.requestedByType === 'agent' ? 'An agent' : 'A person'],
            ['Created', formatDateTime(audit.createdAt, { zone: true })],
          ]}
        />
      </Card>
      <Card title="Coverage" description="Whether the crawl saw the whole link graph, and why not." padded>
        {audit.coverage ? (
          <Meta
            items={[
              ['Link graph', audit.coverage.graph === 'complete' ? 'Complete' : 'Truncated'],
              ['Reasons', audit.coverage.reasons.length ? coverageReasons(audit) : 'None'],
              [
                'Pages discovered',
                <span key="discovered" className="num">
                  {audit.coverage.pagesDiscovered.toLocaleString()}
                </span>,
              ],
              [
                'Pages read',
                <span key="read" className="num">
                  {audit.coverage.pagesCrawled.toLocaleString()}
                </span>,
              ],
            ]}
          />
        ) : (
          <p className="text-[13px] leading-5 text-muted">Coverage is recorded when the audit finalizes.</p>
        )}
      </Card>
      {audit.stateReason && (
        <Card title="Why this run ended this way" padded>
          <p className="text-[13px] leading-5 text-fg-2">{audit.stateReason}</p>
        </Card>
      )}
    </div>
  );
}
