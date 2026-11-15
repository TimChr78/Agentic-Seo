import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, type Issue } from '../app/api';
import { isNotRechecked, useLatestFinishedAudit } from '../app/auditFreshness';
import { useCursor } from '../app/cursor';
import { useCrumbs } from '../app/page';
import { Link } from '../app/router';
import { categoryLabel, ISSUE_CATEGORIES, ISSUE_STATES, SEVERITIES } from '../app/seoLabels';
import { useSite } from '../app/session';
import { useApi } from '../app/useApi';
import { Field, Input, Select } from '../ui';
import { ListPage, type PageReadState } from '../ui/ListPage';
import { Pager } from '../ui/Pager';
import { IssueStatePill, SeverityPill } from '../ui/seo/pills';
import { Td, THead, Th } from '../ui/table';
import { formatDate } from '../ui/time';

// Issues (DESIGN.md §4.2): every issue the site's audits found, worst first. Search Console clicks
// weight the traffic column; without a connection it says "No GSC" rather than showing a zero. The
// filters are the command's own, so the count and the rows always agree.

type Filters = { checkId: string; category: string; severity: string; state: string };

const EMPTY: Filters = { checkId: '', category: '', severity: '', state: '' };

export default function IssuesPage() {
  useCrumbs([{ label: 'Issues' }]);
  const { site } = useSite();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [draft, setDraft] = useState('');
  const key = `${site.id}:${filters.checkId}:${filters.category}:${filters.severity}:${filters.state}`;
  const cursor = useCursor(key);

  const read = useApi(
    () =>
      api.listIssues({
        siteId: site.id,
        ...(filters.checkId ? { checkId: filters.checkId } : {}),
        ...(filters.category ? { category: filters.category as (typeof ISSUE_CATEGORIES)[number] } : {}),
        ...(filters.severity ? { severity: filters.severity as (typeof SEVERITIES)[number] } : {}),
        ...(filters.state ? { state: filters.state as (typeof ISSUE_STATES)[number] } : {}),
        ...(cursor.cursor ? { cursor: cursor.cursor } : {}),
        limit: 25,
      }),
    [key, cursor.cursor],
  );

  const filtered = useMemo(() => Object.values(filters).some(Boolean), [filters]);
  const latestAudit = useLatestFinishedAudit(site.id).latest;
  const data = read.data;
  const rows = data?.issues ?? [];
  const state: PageReadState = read.data === undefined ? (read.error ? 'error' : 'loading') : rows.length ? 'ready' : 'empty';

  const filter = (patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  };

  const filtersRow = (
    <>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          filter({ checkId: draft.trim() });
        }}
      >
        <Field label="Search by check" hideLabel>
          <div className="relative">
            <Search size={14} aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => filter({ checkId: draft.trim() })}
              placeholder="Check id, e.g. title.too_long"
              aria-label="Search by check id"
              className="w-[240px] pl-8"
            />
          </div>
        </Field>
      </form>
      <Field label="Category" hideLabel>
        <Select
          value={filters.category}
          onChange={(event) => filter({ category: event.target.value })}
          aria-label="Category"
          className="w-auto"
        >
          <option value="">All categories</option>
          {ISSUE_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {categoryLabel(category)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Severity" hideLabel>
        <Select
          value={filters.severity}
          onChange={(event) => filter({ severity: event.target.value })}
          aria-label="Severity"
          className="w-auto"
        >
          <option value="">All severities</option>
          {SEVERITIES.map((severity) => (
            <option key={severity} value={severity}>
              {severity.charAt(0).toUpperCase() + severity.slice(1)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="State" hideLabel>
        <Select value={filters.state} onChange={(event) => filter({ state: event.target.value })} aria-label="State" className="w-auto">
          <option value="">All states</option>
          {ISSUE_STATES.map((issueState) => (
            <option key={issueState} value={issueState}>
              {issueState.charAt(0).toUpperCase() + issueState.slice(1)}
            </option>
          ))}
        </Select>
      </Field>
    </>
  );

  const countLabel = data
    ? filtered
      ? `${rows.length} matching${data.nextCursor ? ' · more pages' : ''}`
      : `${data.summary.total} total · ${data.summary.open} open`
    : undefined;

  return (
    <ListPage
      title="Issues"
      description={`What this site's audits found, worst first. Traffic is Search Console clicks over 28 days on the pages each issue names.${
        data && !data.hasGsc ? ' Search Console is not connected, so no issue shows clicks.' : ''
      }`}
      filters={filtersRow}
      countLabel={countLabel}
      state={state}
      notice={
        state === 'error'
          ? {
              title: 'Couldn’t load the issues',
              body: read.error ?? undefined,
              action: (
                <button
                  type="button"
                  className="inline-flex h-10 items-center px-3 text-[13px] font-medium text-accent hover:underline md:h-8"
                  onClick={() => void read.reload()}
                >
                  Retry
                </button>
              ),
            }
          : state === 'empty'
            ? {
                title: filtered ? 'No issue matches these filters' : 'No issue has been found yet',
                body: filtered
                  ? 'Change or clear the filters to see the issues this site has.'
                  : 'An audit turns failing checks into issues here, with the pages they affect. Run one from Audits.',
                action: filtered ? (
                  <button
                    type="button"
                    className="inline-flex h-10 items-center px-3 text-[13px] font-medium text-accent hover:underline md:h-8"
                    onClick={() => {
                      setFilters(EMPTY);
                      setDraft('');
                    }}
                  >
                    Clear the filters
                  </button>
                ) : undefined,
              }
            : undefined
      }
      desktopTable={
        <table className="w-full border-collapse text-left text-[13px] leading-5">
          <caption className="sr-only">Issues found on this site, with severity, affected pages and search traffic</caption>
          <THead>
            <tr>
              <Th>Issue</Th>
              <Th>Severity</Th>
              <Th align="right">Pages</Th>
              <Th align="right">Traffic touched</Th>
              <Th>First seen</Th>
              <Th>State</Th>
            </tr>
          </THead>
          <tbody>
            {rows.map((issue) => (
              <IssueRow key={issue.id} issue={issue} hasGsc={data?.hasGsc ?? false} unchecked={isNotRechecked(issue, latestAudit)} />
            ))}
          </tbody>
        </table>
      }
      mobileList={
        <ul className="divide-y divide-line">
          {rows.map((issue) => (
            <li key={issue.id}>
              <Link to={`/issues/${issue.id}`} className="block min-h-[72px] px-4 py-3 hover:bg-surface-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 text-[13px] leading-5 font-medium">
                    {issue.title}
                    <span className="ml-1 font-mono text-[12px] font-normal text-muted">{issue.checkId}</span>
                  </p>
                  <IssueStatePill state={issue.state} regressed={issue.regressed} unchecked={isNotRechecked(issue, latestAudit)} />
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-[12px] leading-[18px] text-muted">
                  <SeverityPill severity={issue.severity} />
                  <span className="num">
                    {issue.affectedPages} of {issue.evaluatedPages} pages
                  </span>
                  <span aria-hidden>·</span>
                  <span className="num">{trafficText(issue, data?.hasGsc ?? false)}</span>
                  <span aria-hidden>·</span>
                  <span>First seen {formatDate(issue.createdAt)}</span>
                </p>
              </Link>
            </li>
          ))}
        </ul>
      }
      pagination={
        <Pager
          noun="issues"
          page={cursor.page}
          canPrevious={cursor.canPrevious}
          canNext={data?.nextCursor !== null && data?.nextCursor !== undefined}
          onPrevious={cursor.previous}
          onNext={() => data?.nextCursor && cursor.next(data.nextCursor)}
          loading={read.refreshing}
        />
      }
    />
  );
}

const trafficText = (issue: Issue, hasGsc: boolean) =>
  !hasGsc || issue.clicks28d === null ? 'No GSC' : `${issue.clicks28d.toLocaleString()} clicks/28d`;

function IssueRow({ issue, hasGsc, unchecked }: { issue: Issue; hasGsc: boolean; unchecked: boolean }) {
  return (
    <tr className="border-t border-line align-top hover:bg-surface-2">
      <Td className="max-w-[420px]">
        <Link to={`/issues/${issue.id}`} className="font-medium text-fg hover:text-accent hover:underline">
          {issue.title}
        </Link>
        <p className="mt-0.5 font-mono text-[12px] leading-[18px] text-muted">{issue.checkId}</p>
      </Td>
      <Td>
        <SeverityPill severity={issue.severity} />
      </Td>
      <Td align="right">
        {issue.affectedPages} of {issue.evaluatedPages}
      </Td>
      <Td align="right" title={!hasGsc ? 'Search Console is not connected for this site.' : undefined}>
        {!hasGsc ? <span className="text-muted">No GSC</span> : (issue.clicks28d?.toLocaleString() ?? '—')}
      </Td>
      <Td>{formatDate(issue.createdAt)}</Td>
      <Td>
        <IssueStatePill state={issue.state} regressed={issue.regressed} unchecked={unchecked} />
      </Td>
    </tr>
  );
}
