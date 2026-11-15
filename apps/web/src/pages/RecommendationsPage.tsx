import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errText, type RecommendationRun } from '../app/api';
import { useCursor } from '../app/cursor';
import { useCrumbs } from '../app/page';
import { Link } from '../app/router';
import { authorLabel, RECOMMENDATION_AUTHORS, RECOMMENDATION_STATUSES } from '../app/seoLabels';
import { useSession, useSite } from '../app/session';
import { useApi } from '../app/useApi';
import { Alert, Button, Field, Select } from '../ui';
import { ListPage, type PageReadState } from '../ui/ListPage';
import { Drawer } from '../ui/overlay';
import { Pager } from '../ui/Pager';
import { RecommendationStatusPill } from '../ui/seo/pills';
import { TrafficAtRisk } from '../ui/seo/reach';
import { Td, THead, Th } from '../ui/table';
import { formatDateTime, timeAgo } from '../ui/time';
import { useToast } from '../ui/toast';

// Recommendations (DESIGN.md §4.3): what the specialists and people propose for this site, ordered
// by a person's priority and then newest first. A recommendation is a hypothesis with an expected
// effect and a way to disprove it, so the list leads with status, traffic at stake and effort.

export default function RecommendationsPage() {
  useCrumbs([{ label: 'Recommendations', to: '/recommendations' }]);
  const { site } = useSite();
  const { can, agent } = useSession();
  const [status, setStatus] = useState('');
  const [author, setAuthor] = useState('');
  const cursor = useCursor(`${site.id}:${status}:${author}`);
  const read = useApi(
    () =>
      api.listRecommendations({
        siteId: site.id,
        ...(status ? { status: status as (typeof RECOMMENDATION_STATUSES)[number] } : {}),
        ...(author ? { author: author as (typeof RECOMMENDATION_AUTHORS)[number] } : {}),
        ...(cursor.cursor ? { cursor: cursor.cursor } : {}),
        limit: 25,
      }),
    [site.id, status, author, cursor.cursor],
  );
  const [generating, setGenerating] = useState(false);
  const rows = read.data?.recommendations ?? [];
  const filtered = Boolean(status || author);
  const canGenerate = can('artifacts:write') && !agent;
  const pageState: PageReadState = read.data === undefined ? (read.error ? 'error' : 'loading') : rows.length ? 'ready' : 'empty';

  return (
    <>
      <ListPage
        title="Recommendations"
        description="What to do next, why, and how the result will be measured. A recommendation is a hypothesis with an estimate and a falsification check, never a promise."
        primaryAction={
          <Button
            variant="primary"
            icon={<Sparkles size={14} />}
            disabled={!canGenerate}
            title={!canGenerate ? 'Only editors can generate recommendations.' : undefined}
            onClick={() => setGenerating(true)}
          >
            Generate recommendations
          </Button>
        }
        filters={
          <>
            <Field label="Status" hideLabel>
              <Select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Status" className="w-auto">
                <option value="">All statuses</option>
                {RECOMMENDATION_STATUSES.map((option) => (
                  <option key={option} value={option}>
                    {option.charAt(0).toUpperCase() + option.slice(1)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Author" hideLabel>
              <Select value={author} onChange={(event) => setAuthor(event.target.value)} aria-label="Author" className="w-auto">
                <option value="">Any author</option>
                {RECOMMENDATION_AUTHORS.map((option) => (
                  <option key={option} value={option}>
                    {authorLabel(option)}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        }
        countLabel={read.data ? `${rows.length} shown · ${read.data.total} total` : undefined}
        state={pageState}
        notice={
          pageState === 'error'
            ? {
                title: 'Couldn’t load the recommendations',
                body: read.error ?? undefined,
                action: <Button onClick={() => void read.reload()}>Retry</Button>,
              }
            : pageState === 'empty'
              ? {
                  title: filtered ? 'No recommendation matches these filters' : 'No recommendation yet',
                  body: filtered
                    ? 'Change the filters to see the site’s recommendations.'
                    : 'An audit finds issues; a synthesis run turns the worst of them into recommendations with evidence, an estimate and a verification plan. If no audit has finished, run one first.',
                  action:
                    !filtered && canGenerate ? (
                      <Button variant="primary" onClick={() => setGenerating(true)}>
                        Generate recommendations
                      </Button>
                    ) : undefined,
                }
              : undefined
        }
        desktopTable={
          <table className="w-full border-collapse text-left text-[13px] leading-5">
            <caption className="sr-only">Recommendations for this site, in working order</caption>
            <THead>
              <tr>
                <Th>Recommendation</Th>
                <Th>Status</Th>
                <Th>Author</Th>
                <Th>Traffic at stake</Th>
                <Th>Effort</Th>
                <Th align="right">Confidence</Th>
                <Th>Updated</Th>
              </tr>
            </THead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-line align-top hover:bg-surface-2">
                  <Td className="max-w-[420px]">
                    <Link to={`/recommendations/${row.id}`} className="font-medium text-fg hover:text-accent hover:underline">
                      {row.title}
                    </Link>
                    <p className="mt-0.5 text-[12px] leading-[18px] text-muted">
                      {row.evidenceCount} evidence {row.evidenceCount === 1 ? 'item' : 'items'}
                      {row.dependsOn.length ? ` · waits on ${row.dependsOn.length}` : ''}
                      {row.priority !== null ? ` · priority ${row.priority + 1}` : ''}
                    </p>
                  </Td>
                  <Td>
                    <RecommendationStatusPill status={row.status} />
                  </Td>
                  <Td className="whitespace-nowrap">
                    {row.author.kind === 'specialist'
                      ? `${row.author.specialist === 'technical' ? 'Technical specialist' : 'Strategist'}`
                      : row.author.kind === 'agent'
                        ? 'Agent'
                        : 'A person'}
                  </Td>
                  <Td className="max-w-[220px]">
                    <TrafficAtRisk reach={row.trafficAtStake} />
                  </Td>
                  <Td className="capitalize">{row.effort}</Td>
                  <Td align="right" className="capitalize">
                    {row.confidence}
                  </Td>
                  <Td className="whitespace-nowrap">{formatDateTime(row.updatedAt, { zone: true })}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        }
        mobileList={
          <ul className="divide-y divide-line">
            {rows.map((row) => (
              <li key={row.id}>
                <Link to={`/recommendations/${row.id}`} className="block min-h-[72px] px-4 py-3 hover:bg-surface-2">
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 text-[13px] leading-5 font-medium">{row.title}</p>
                    <RecommendationStatusPill status={row.status} />
                  </div>
                  <p className="mt-1 text-[12px] leading-[18px] text-muted">
                    {row.effort} effort · {row.confidence} confidence · {row.evidenceCount} evidence
                  </p>
                  <TrafficAtRisk reach={row.trafficAtStake} className="mt-1 text-[12px]" />
                </Link>
              </li>
            ))}
          </ul>
        }
        pagination={
          <Pager
            noun="recommendations"
            page={cursor.page}
            canPrevious={cursor.canPrevious}
            canNext={Boolean(read.data?.nextCursor)}
            onPrevious={cursor.previous}
            onNext={() => read.data?.nextCursor && cursor.next(read.data.nextCursor)}
            loading={read.refreshing}
          />
        }
      />
      <GenerateDrawer open={generating} onClose={() => setGenerating(false)} siteId={site.id} onFinished={() => void read.reload()} />
    </>
  );
}

/**
 * A synthesis run, watched to its end. The drawer says what the run does and what it costs before
 * it starts, then shows the specialists' counts, every recommendation it created and every item it
 * dropped with the validation error that dropped it.
 */
function GenerateDrawer({
  open,
  onClose,
  siteId,
  onFinished,
}: {
  open: boolean;
  onClose: () => void;
  siteId: string;
  onFinished: () => void;
}) {
  const toast = useToast();
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RecommendationRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const runs = useApi(() => api.listRecommendationRuns(siteId), [siteId], { skip: !open });

  // Poll the run until it ends: the worker owns it, so there is nothing to await locally.
  useEffect(() => {
    if (!runId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const next = await api.getRecommendationRun(runId);
        if (stopped) return;
        setRun(next);
        if (next.state === 'completed' || next.state === 'failed') {
          onFinished();
          return;
        }
        setTimeout(tick, 3000);
      } catch (caught) {
        if (!stopped) setError(errText(caught));
      }
    };
    void tick();
    return () => {
      stopped = true;
    };
  }, [runId, onFinished]);

  const start = async () => {
    setStarting(true);
    setError(null);
    setRun(null);
    try {
      const started = await api.generateRecommendations(siteId);
      setRunId(started.runId);
      toast.info('Run queued. It reads the latest completed audit and costs tokens against the agents budget.');
      void runs.reload();
    } catch (caught) {
      setError(errText(caught));
    } finally {
      setStarting(false);
    }
  };

  const finished = run?.state === 'completed' || run?.state === 'failed';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="lg"
      title="Generate recommendations"
      meta="A technical specialist reads the site’s open issues, a strategist writes falsifiable recommendations, and every item is validated before it is stored."
      footer={
        <>
          <Button variant="primary" loading={starting} disabled={Boolean(runId) && !finished} onClick={() => void start()}>
            {runId && !finished ? 'Running…' : 'Start a run'}
          </Button>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="space-y-4 p-4 md:p-5">
        <p className="text-[13px] leading-5 text-fg-2">
          The run reads the site’s latest completed audit. It costs tokens against the agents provider’s budget, and it needs an AI provider
          set up for the agents use. Nothing is published: each recommendation arrives as a draft.
        </p>
        {error && (
          <Alert tone="bad" title="The run did not start">
            {error}
          </Alert>
        )}
        {run && (
          <section aria-labelledby="run-state" className="rounded-lg border border-line p-3">
            <h3 id="run-state" className="text-[13px] leading-5 font-semibold">
              {run.state === 'queued'
                ? 'Waiting for a worker'
                : run.state === 'running'
                  ? 'Reading the issues and writing'
                  : run.state === 'failed'
                    ? 'The run failed'
                    : 'The run finished'}
            </h3>
            <p className="mt-1 text-[12px] leading-[18px] text-muted">
              {run.candidates} candidates · {run.derived} written · {run.created} created · {run.dropped} dropped
              {run.inputTokens || run.outputTokens ? ` · ${(run.inputTokens + run.outputTokens).toLocaleString()} tokens` : ''}
            </p>
            {run.error && <p className="mt-2 text-[13px] leading-5 text-bad">{run.error}</p>}
            {run.createdIds.length > 0 && (
              <ul className="mt-2 space-y-1 text-[13px] leading-5">
                {run.createdIds.map((id) => (
                  <li key={id}>
                    <Link to={`/recommendations/${id}`} className="text-accent hover:underline">
                      Open the draft recommendation
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {run.droppedItems.length > 0 && (
              <div className="mt-3">
                <h4 className="text-[12px] leading-[18px] font-medium text-fg-2">Dropped, with the reason</h4>
                <ul className="mt-1 space-y-1.5">
                  {run.droppedItems.map((item, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: these rows have no identity of their own; the index is their position in an ordered list that never reorders
                    <li key={`${item.title}:${index}`} className="text-[12px] leading-[18px]">
                      <span className="font-medium text-fg">{item.title}</span>
                      <span className="text-muted"> · {item.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}
        <section aria-labelledby="run-history">
          <h3 id="run-history" className="text-[13px] leading-5 font-semibold">
            Earlier runs
          </h3>
          {runs.error && <p className="mt-1 text-[12px] text-bad">{runs.error}</p>}
          {!runs.data && !runs.error && <p className="mt-1 text-[12px] text-muted">Loading the runs…</p>}
          {runs.data && runs.data.runs.length === 0 && (
            <p className="mt-1 text-[12px] text-muted">No run has been started for this site.</p>
          )}
          {runs.data && runs.data.runs.length > 0 && (
            <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
              {runs.data.runs.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2 text-[12px] leading-[18px]">
                  <span>
                    <span className="capitalize">{entry.state}</span> · {entry.created} created · {entry.dropped} dropped
                    {entry.error ? <span className="text-bad"> · {entry.error}</span> : ''}
                  </span>
                  <span className="text-muted">{timeAgo(entry.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Drawer>
  );
}
