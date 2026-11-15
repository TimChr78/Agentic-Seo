import { Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type Audit, api } from '../app/api';
import { useCursor } from '../app/cursor';
import { useCrumbs } from '../app/page';
import { Link } from '../app/router';
import { AUDIT_STATES } from '../app/seoLabels';
import { useSession, useSite } from '../app/session';
import { useApi } from '../app/useApi';
import { Button, Field, Select } from '../ui';
import { ListPage, type PageReadState } from '../ui/ListPage';
import { Pager } from '../ui/Pager';
import { AuditStatePill } from '../ui/seo/pills';
import { Td, THead, Th } from '../ui/table';
import { formatDateTime } from '../ui/time';
import { useToast } from '../ui/toast';

// Audits (DESIGN.md §4.1/§4.5): the site's crawl runs, with what each one covered and how it ended.
// A running audit says how many pages of the discovered set it has crawled — never a percentage or
// an estimate of time left. A partial or failed run carries the server's reason beside its state.

const LIVE = new Set(['queued', 'running', 'finalizing']);

export default function AuditsPage() {
  useCrumbs([{ label: 'Audits' }]);
  const { site } = useSite();
  const { can, agent } = useSession();
  const toast = useToast();
  const [state, setState] = useState('');
  const cursor = useCursor(`${site.id}:${state}`);
  const read = useApi(
    () =>
      api.listAudits({
        siteId: site.id,
        ...(state ? { state: state as (typeof AUDIT_STATES)[number] } : {}),
        ...(cursor.cursor ? { cursor: cursor.cursor } : {}),
        limit: 20,
      }),
    [site.id, state, cursor.cursor],
  );
  // The site's latest scored audit, once: the list column shows the score the server published,
  // and each audit's own score is on its detail page.
  const score = useApi(() => api.getAuditScore(site.id), [site.id]);
  const [running, setRunning] = useState(false);

  const audits = read.data?.rows ?? [];
  const live = audits.some((audit) => LIVE.has(audit.state));

  // A live run changes the list: poll while one is in flight, and stop as soon as none is. The page
  // has no spinner; the state pill and the page counter are the progress.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void read.reload(), 5000);
    return () => clearInterval(timer);
  }, [live, read.reload]);

  const canRun = can('audits:run') && !agent;
  const runBlockedReason = !site.verified
    ? 'Verify ownership of this site before running an audit.'
    : agent
      ? 'An agent starts an audit through its mandate, not from this screen.'
      : 'Only editors, admins and owners can run an audit.';

  const run = async () => {
    setRunning(true);
    try {
      await api.runAudit(site.id);
      await read.reload();
      toast.success('Audit queued. It starts crawling in a few seconds.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };

  const pageState: PageReadState = read.data === undefined ? (read.error ? 'error' : 'loading') : audits.length ? 'ready' : 'empty';

  return (
    <ListPage
      title="Audits"
      description="Every crawl of this site, with what it covered, how it ended and the pages it read. A partial run says what it missed; a failed run says why."
      primaryAction={
        <Button
          variant="primary"
          icon={<Play size={14} />}
          loading={running}
          disabled={!canRun || !site.verified}
          title={!canRun || !site.verified ? runBlockedReason : undefined}
          aria-description={!canRun || !site.verified ? runBlockedReason : undefined}
          onClick={() => void run()}
        >
          Run audit
        </Button>
      }
      filters={
        <Field label="State" hideLabel>
          <Select value={state} onChange={(event) => setState(event.target.value)} aria-label="Audit state" className="w-auto">
            <option value="">All states</option>
            {AUDIT_STATES.map((option) => (
              <option key={option} value={option}>
                {option.charAt(0).toUpperCase() + option.slice(1)}
              </option>
            ))}
          </Select>
        </Field>
      }
      countLabel={
        read.data ? `${audits.length} ${audits.length === 1 ? 'run' : 'runs'}${read.data.nextCursor ? ' · more pages' : ''}` : undefined
      }
      state={pageState}
      notice={
        pageState === 'error'
          ? {
              title: 'Couldn’t load the audits',
              body: read.error ?? undefined,
              action: <Button onClick={() => void read.reload()}>Retry</Button>,
            }
          : pageState === 'empty'
            ? {
                title: state ? 'No audit is in this state' : 'No audit has run for this site yet',
                body: state
                  ? 'Choose another state, or clear the filter to see every run.'
                  : `${site.name} has not been crawled. An audit reads the pages, evaluates the checks and turns what fails into issues.`,
                action:
                  !state && canRun && site.verified ? (
                    <Button variant="primary" icon={<Play size={14} />} loading={running} onClick={() => void run()}>
                      Run the first audit
                    </Button>
                  ) : undefined,
              }
            : undefined
      }
      desktopTable={
        <table className="w-full border-collapse text-left text-[13px] leading-5">
          <caption className="sr-only">Audit runs for this site, newest first</caption>
          <THead>
            <tr>
              <Th>Run</Th>
              <Th>State</Th>
              <Th align="right">Score</Th>
              <Th align="right">Pages</Th>
              <Th>Started</Th>
            </tr>
          </THead>
          <tbody>
            {audits.map((audit) => (
              <AuditRow key={audit.id} audit={audit} score={score.data?.auditId === audit.id ? score.data.score : undefined} />
            ))}
          </tbody>
        </table>
      }
      mobileList={
        <ul className="divide-y divide-line">
          {audits.map((audit) => (
            <li key={audit.id}>
              <Link to={`/audits/${audit.id}`} className="block min-h-[72px] px-4 py-3 hover:bg-surface-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-mono text-[12px] leading-[18px] text-fg">{audit.id}</p>
                  <AuditStatePill state={audit.state} />
                </div>
                <p className="mt-1 text-[12px] leading-[18px] text-muted">
                  {progressLine(audit)} · {formatDateTime(audit.startedAt ?? audit.createdAt, { zone: true })}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      }
      pagination={
        <Pager
          noun="audits"
          page={cursor.page}
          canPrevious={cursor.canPrevious}
          canNext={Boolean(read.data?.nextCursor)}
          onPrevious={cursor.previous}
          onNext={() => read.data?.nextCursor && cursor.next(read.data.nextCursor)}
          loading={read.refreshing}
        />
      }
    />
  );
}

function AuditRow({ audit, score }: { audit: Audit; score?: number | null }) {
  const live = LIVE.has(audit.state);
  return (
    <tr className="border-t border-line align-top hover:bg-surface-2">
      <Td>
        <Link to={`/audits/${audit.id}`} className="font-mono text-[12px] font-medium text-fg hover:text-accent hover:underline">
          {audit.id}
        </Link>
        <p className="mt-0.5 text-[12px] leading-[18px] text-muted">
          {audit.scope === 'site'
            ? 'Whole site'
            : audit.scope === 'section'
              ? `Section ${audit.section ?? ''}`
              : `${audit.urls?.length ?? 0} URLs`}
          {audit.requestedByType === 'agent' ? ' · requested by an agent' : ''}
        </p>
      </Td>
      <Td>
        <AuditStatePill state={audit.state} detail={audit.stateReason} />
        <p className="mt-1 text-[12px] leading-[18px] text-fg-2">
          {live
            ? audit.state === 'queued'
              ? 'Waiting to start'
              : `Crawling · ${audit.pagesCrawled.toLocaleString()} of ≈ ${audit.pagesDiscovered.toLocaleString()} pages`
            : `${audit.pagesCrawled.toLocaleString()} pages crawled${audit.pagesFailed ? ` · ${audit.pagesFailed.toLocaleString()} failed` : ''}`}
        </p>
        {audit.stateReason && !live && <p className="mt-1 max-w-[320px] text-[12px] leading-[18px] text-muted">{audit.stateReason}</p>}
      </Td>
      <Td align="right" title="The score this audit published; an audit without one is shown on its own page.">
        {score === undefined ? (
          <span className="text-muted">—</span>
        ) : score === null ? (
          <span className="text-muted">Not evaluated</span>
        ) : (
          score
        )}
      </Td>
      <Td align="right">{audit.pagesCrawled.toLocaleString()}</Td>
      <Td>{formatDateTime(audit.startedAt ?? audit.createdAt, { zone: true })}</Td>
    </tr>
  );
}

/** The one line a run's progress gets: pages read of pages found, or what it ended with. */
function progressLine(audit: Audit) {
  if (audit.state === 'queued') return 'Waiting to start';
  if (audit.state === 'running' || audit.state === 'finalizing')
    return audit.pagesDiscovered > 0
      ? `Crawling · ${audit.pagesCrawled.toLocaleString()} of ≈ ${audit.pagesDiscovered.toLocaleString()} pages`
      : `Crawling · ${audit.pagesCrawled.toLocaleString()} pages so far`;
  return `${audit.pagesCrawled.toLocaleString()} pages crawled${audit.pagesFailed ? ` · ${audit.pagesFailed} failed` : ''}`;
}
