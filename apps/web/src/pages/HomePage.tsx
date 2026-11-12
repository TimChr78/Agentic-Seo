import { ArrowRight, Check, Plus } from 'lucide-react';
import { api, type ChecklistFacts } from '../app/api';
import { ButtonLink } from '../app/links';
import { canOpenPath } from '../app/nav';
import { useCrumbs } from '../app/page';
import { Link } from '../app/router';
import { useSession, useSite } from '../app/session';
import { useKeyedApi } from '../app/useApi';
import { Alert, Card, EmptyState, KpiTile, LineChart, LoadingBlock, PageHeader, StatusPill, Tag } from '../ui';
import { Button } from '../ui/Button';
import { cx } from '../ui/cx';
import { pageWidth } from '../ui/layout';
import { HealthScore } from '../ui/seo/HealthScore';
import { formatDateTime } from '../ui/time';

// Home (DESIGN.md §4.1): consequence first, then the KPI tiles, the clicks chart, recommendations
// and agent activity, with the setup checklist last. Every number names its period and source. In
// Phase 0 no source is connected yet, so the tiles show "No data" and the health score "Not
// evaluated" rather than a healthy-looking zero.

export default function HomePage() {
  useCrumbs([{ label: 'Home' }]);
  const { site } = useSite();
  const { can } = useSession();
  // Keyed by site: while the new site loads, or if it fails, the previous site's numbers are never
  // shown under the new site's name.
  const home = useKeyedApi(site.id, () => api.getHome(site.id));

  const header = (
    <PageHeader
      title="Home"
      meta={
        <>
          <span className="font-medium text-fg-2">{site.name}</span>
          <span aria-hidden>·</span>
          <span>{site.domain}</span>
          {!site.verified && <StatusPill tone="warn">Not verified</StatusPill>}
        </>
      }
      description="What needs attention on this site, and how search is performing."
      actions={
        <>
          <Tag>Phase 1</Tag>
          <Button variant="primary" disabled title="Audits arrive in Phase 1." aria-description="Audits arrive in Phase 1.">
            Run audit
          </Button>
        </>
      }
    />
  );

  if (home.data === undefined) {
    return (
      <div className={pageWidth('default')}>
        {header}
        {home.error ? (
          <Alert tone="bad" title="Couldn't load the site overview" onRetry={() => void home.reload()}>
            {home.error}
          </Alert>
        ) : (
          <LoadingBlock lines={8} label="Loading the site overview" />
        )}
      </div>
    );
  }

  const data = home.data;
  const categories = data.health.categories;
  return (
    <div className={pageWidth('default')}>
      {header}

      <div className="space-y-6 lg:space-y-8">
        <section aria-labelledby="consequence" className="rounded-lg bg-surface-2 p-4 md:p-5">
          <h2 id="consequence" className="text-[14px] leading-[22px] font-semibold">
            No audit has run for this site
          </h2>
          <p className="mt-1 text-[13px] leading-5 text-fg-2">
            Without an audit there are no issues, change sets or agent holds to review, so this summary stays empty rather than showing a
            zero.
          </p>
          <p className="mt-2 text-[13px] leading-5 text-fg-2">
            {canOpenPath('/settings/connections', can) ? (
              <>
                Next:{' '}
                <Link to="/settings/connections" className="font-medium text-accent hover:underline">
                  verify ownership and connect Search Console
                </Link>
                . The first audit follows in Phase 1.
              </>
            ) : (
              <>Next: an admin verifies ownership and connects Search Console. The first audit follows in Phase 1.</>
            )}
          </p>
        </section>

        <section aria-label="Key metrics" className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4 lg:gap-4">
          <HealthScore
            className="border border-line"
            score={data.health.score}
            delta={data.health.delta}
            pagesEvaluated={data.health.pagesEvaluated}
            categories={categories}
            notEvaluated={data.health.notEvaluated}
            period="Last completed audit"
            updatedAt={data.health.score === null ? 'Updated time not available' : undefined}
          />
          <KpiTile
            className="border border-line"
            label="Clicks"
            value={data.clicks.value}
            previousValue={data.clicks.previousValue}
            dataState={data.clicks.value === null ? 'no-data' : 'populated'}
            explanation={data.clicks.noDataReason}
            period={`Last ${data.clicks.periodDays} days · Search Console`}
            updatedAt={data.clicks.updatedAt}
            freshnessLabel="Updated"
          />
          <KpiTile
            className="border border-line"
            label="Avg position"
            value={data.averagePosition.value}
            previousValue={data.averagePosition.previousValue}
            precision={1}
            favourableDirection="down"
            dataState={data.averagePosition.value === null ? 'no-data' : 'populated'}
            explanation={data.averagePosition.noDataReason}
            period={`Last ${data.averagePosition.periodDays} days · Search Console`}
            updatedAt={data.averagePosition.updatedAt}
            freshnessLabel="Updated"
          />
          <KpiTile
            className="border border-line"
            label="AI citations"
            value={data.aiCitations.value}
            numerator={data.aiCitations.cited ?? undefined}
            denominator={data.aiCitations.prompts ?? undefined}
            dataState={data.aiCitations.value === null ? 'no-data' : 'populated'}
            explanation={data.aiCitations.noDataReason}
            period={`Last ${data.aiCitations.periodDays} days · AI visibility`}
            updatedAt={data.aiCitations.updatedAt}
            freshnessLabel="Updated"
          />
        </section>

        <Card padded>
          <LineChart
            title="How many clicks did organic search bring?"
            subtitle={`Last ${data.clicks.periodDays} days · Search Console · daily. The previous period is dashed when there is one.`}
            labels={data.clicksSeries.labels}
            series={[{ label: 'Clicks', values: data.clicksSeries.values }]}
            dataState={data.clicksSeries.values.length ? 'populated' : 'no-data'}
            stateMessage="Connect Search Console to answer this."
          />
        </Card>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 lg:gap-4">
          <Card title="Top recommendations" description="Impact × confidence, with the pages and queries behind them.">
            <EmptyState
              title="No recommendations yet"
              action={
                <ButtonLink to="/inbox" variant="secondary" icon={<ArrowRight size={14} />}>
                  Open Inbox
                </ButtonLink>
              }
            >
              Recommendations come from the first audit in Phase 1. They state a hypothesis and how the result will be measured, not a
              promise.
            </EmptyState>
          </Card>
          <Card title="What agents did this week" description="The activity ledger, with traffic at risk for every site change.">
            <EmptyState
              title="No agent has run yet"
              action={
                <ButtonLink to="/agents" variant="secondary" icon={<ArrowRight size={14} />}>
                  Open Agents
                </ButtonLink>
              }
            >
              Agents act only under a mandate at L1 in Phase 1. Their programme and outcomes arrive in Phase 6.
            </EmptyState>
          </Card>
        </div>

        <SetupChecklist data={data} siteName={site.name} />
      </div>

      <p className="mt-6 text-[12px] leading-[18px] text-muted lg:mt-8">
        {home.refreshing && home.error ? 'Refresh failed. ' : ''}
        Fetched {formatDateTime(data.fetchedAt, { zone: true })}
      </p>
    </div>
  );
}

type ChecklistKey = 'verify' | 'searchConsole' | 'competitors' | 'audit' | 'dataForSeo' | 'connector';

interface ChecklistRow {
  key: ChecklistKey;
  label: string;
  detail: string;
  done: boolean;
  optional?: boolean;
  to: string;
  action: string;
}

function SetupChecklist({ data, siteName }: { data: { checklist: ChecklistFacts }; siteName: string }) {
  const { can } = useSession();
  const facts = data.checklist;
  const rows: ChecklistRow[] = [
    {
      key: 'verify',
      label: 'Verify site',
      detail: 'Confirm ownership of the primary domain.',
      done: facts.siteVerified,
      to: '/settings/site',
      action: 'Verify site',
    },
    {
      key: 'searchConsole',
      label: 'Connect Search Console',
      detail: 'Clicks, impressions, CTR and position for the property.',
      done: facts.searchConsole,
      to: '/settings/connections',
      action: 'Connect Search Console',
    },
    {
      key: 'competitors',
      label: 'Add competitors',
      detail: facts.competitors > 0 ? `${facts.competitors} added` : 'Markets and competitors for gap analysis.',
      done: facts.competitors > 0,
      to: '/research/competitors',
      action: 'Add competitors',
    },
    {
      key: 'audit',
      label: 'Run first audit',
      detail: 'Crawl the site and evaluate the core checks.',
      done: facts.audits > 0,
      to: '/audits',
      action: 'Run first audit',
    },
    {
      key: 'dataForSeo',
      label: 'Add DataForSEO key',
      detail: 'Paid market data: keyword, SERP and backlink research.',
      done: facts.dataForSeoKey,
      optional: true,
      to: '/settings/providers',
      action: 'Add key',
    },
    {
      key: 'connector',
      label: 'Connect a site connector',
      detail: 'GitHub pull requests, or another connector that can apply a change.',
      done: facts.siteConnector,
      to: '/settings/connections',
      action: 'Connect a connector',
    },
  ];
  const required = rows.filter((row) => !row.optional);
  const confirmed = required.filter((row) => row.done).length;

  return (
    <Card
      title={`Set up ${siteName}`}
      description={`${confirmed} of ${required.length} required steps confirmed · based on current configuration`}
    >
      <ul className="divide-y divide-line">
        {rows.map((row) => (
          <li key={row.key} className="flex min-h-16 flex-wrap items-start justify-between gap-3 px-4 py-3 md:px-5">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-[13px] leading-5 font-medium">
                {row.done ? (
                  <>
                    <Check size={16} strokeWidth={1.75} className="shrink-0 text-good" aria-hidden />
                    <span>{row.label}</span>
                  </>
                ) : canOpenPath(row.to, can) ? (
                  <Link to={row.to} className="text-accent hover:underline">
                    {row.label}
                  </Link>
                ) : (
                  <span>{row.label}</span>
                )}
                {row.optional && (
                  <span className="rounded-sm border border-line px-1.5 text-[11px] leading-4 font-normal text-muted">Optional</span>
                )}
              </p>
              <p className="mt-1 text-[12px] leading-[18px] text-muted">{row.detail}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {row.done ? (
                <StatusPill tone="good">Confirmed</StatusPill>
              ) : (
                <>
                  <StatusPill tone="neutral">{row.optional ? 'Optional' : 'To do'}</StatusPill>
                  {canOpenPath(row.to, can) ? (
                    <Link
                      to={row.to}
                      className={cx(
                        'inline-flex min-h-10 items-center gap-1 text-[12px] font-medium text-accent hover:underline md:min-h-0',
                      )}
                      aria-label={`${row.action}: ${row.label}`}
                    >
                      {row.action}
                      <Plus size={12} aria-hidden />
                    </Link>
                  ) : (
                    <span className="text-[12px] text-muted">Needs an admin</span>
                  )}
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
