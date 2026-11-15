import { useEffect, useState } from 'react';
import { api, type ChangeSetRun } from '../app/api';
import { useCursor } from '../app/cursor';
import { useCrumbs } from '../app/page';
import { Link } from '../app/router';
import { CHANGE_STATES } from '../app/seoLabels';
import { useSite } from '../app/session';
import { useApi } from '../app/useApi';
import { Button, Field, Select } from '../ui';
import { ListPage, type PageReadState } from '../ui/ListPage';
import { Pager } from '../ui/Pager';
import { ChangeStatePill, changeStateLabel } from '../ui/seo/pills';
import { Td, THead, Th } from '../ui/table';
import { formatDateTime } from '../ui/time';

// Changes (DESIGN.md §4.4): the site's change sets, from draft to the deployment that carried them.
// The list answers "what is waiting, what is in flight, what failed" and links to the one place that
// shows the diff, the pull request and the verification results.

export default function ChangesPage() {
  useCrumbs([{ label: 'Changes' }]);
  const { site } = useSite();
  const [state, setState] = useState('');
  const cursor = useCursor(`${site.id}:${state}`);
  const read = useApi(
    () =>
      api.listChangeSets({
        siteId: site.id,
        ...(state ? { state: state as (typeof CHANGE_STATES)[number] } : {}),
        ...(cursor.cursor ? { cursor: cursor.cursor } : {}),
        limit: 25,
      }),
    [site.id, state, cursor.cursor],
  );
  const rows = read.data?.changes ?? [];
  // The list command carries the lifecycle row, not the name: names are read per row from the same
  // artifact. One page is at most 25 reads, and each is free.
  const names = useNames(rows);
  const pageState: PageReadState = read.data === undefined ? (read.error ? 'error' : 'loading') : rows.length ? 'ready' : 'empty';

  return (
    <ListPage
      title="Changes"
      description="Change sets and their way through GitHub: what is a draft, what waits for a person, what is in review and what the deployed page showed when it was read back."
      primaryAction={undefined}
      filters={
        <Field label="State" hideLabel>
          <Select value={state} onChange={(event) => setState(event.target.value)} aria-label="Change set state" className="w-auto">
            <option value="">All states</option>
            {CHANGE_STATES.map((option) => (
              <option key={option} value={option}>
                {changeStateLabel(option)}
              </option>
            ))}
          </Select>
        </Field>
      }
      countLabel={read.data ? `${rows.length} shown · ${read.data.total} total` : undefined}
      state={pageState}
      notice={
        pageState === 'error'
          ? {
              title: 'Couldn’t load the change sets',
              body: read.error ?? undefined,
              action: <Button onClick={() => void read.reload()}>Retry</Button>,
            }
          : pageState === 'empty'
            ? {
                title: state ? 'No change set is in this state' : 'No change set yet',
                body: state
                  ? 'Choose another state, or clear the filter, to see the site’s change sets.'
                  : 'A change set starts from a recommendation: draft it there, then submit it for approval. Nothing is written to the site before that.',
              }
            : undefined
      }
      desktopTable={
        <table className="w-full border-collapse text-left text-[13px] leading-5">
          <caption className="sr-only">Change sets for this site</caption>
          <THead>
            <tr>
              <Th>Change set</Th>
              <Th>State</Th>
              <Th>Pull request</Th>
              <Th>Deployed</Th>
              <Th>Drafted</Th>
            </tr>
          </THead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.artifactId} className="border-t border-line align-top hover:bg-surface-2">
                <Td className="max-w-[360px]">
                  <Link to={`/changes/${row.artifactId}`} className="font-medium text-fg hover:text-accent hover:underline">
                    {names.get(row.artifactId) ?? 'Change set'}
                  </Link>
                  <p className="mt-0.5 font-mono text-[12px] leading-[18px] text-muted">{row.artifactId}</p>
                </Td>
                <Td>
                  <ChangeStatePill state={row.state} />
                  {row.lastError && <p className="mt-1 max-w-[280px] text-[12px] leading-[18px] text-bad">{row.lastError}</p>}
                </Td>
                <Td>
                  {row.prUrl ? (
                    <a href={row.prUrl} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
                      #{row.prNumber}
                    </a>
                  ) : (
                    <span className="text-muted">None</span>
                  )}
                </Td>
                <Td>
                  <span className="font-mono text-[12px] text-fg-2">{row.deployedSha ? row.deployedSha.slice(0, 7) : '—'}</span>
                </Td>
                <Td>{formatDateTime(row.draftedAt, { zone: true })}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      }
      mobileList={
        <ul className="divide-y divide-line">
          {rows.map((row) => (
            <li key={row.artifactId}>
              <Link to={`/changes/${row.artifactId}`} className="block min-h-[72px] px-4 py-3 hover:bg-surface-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 text-[13px] leading-5 font-medium">{names.get(row.artifactId) ?? row.artifactId}</p>
                  <ChangeStatePill state={row.state} />
                </div>
                <p className="mt-1 text-[12px] leading-[18px] text-muted">
                  {row.prUrl ? `PR #${row.prNumber} · ` : ''}
                  Drafted {formatDateTime(row.draftedAt, { zone: true })}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      }
      pagination={
        <Pager
          noun="change sets"
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

/** Reads the name of each visible change set once; a failed read leaves the row with its id. */
function useNames(rows: ChangeSetRun[]) {
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const ids = rows.map((row) => row.artifactId).join(',');
  useEffect(() => {
    if (!ids) return;
    let live = true;
    void Promise.all(
      ids.split(',').map(async (id) => {
        try {
          const detail = await api.getChangeSet(id);
          return [id, detail.name] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (!live) return;
      setNames(new Map(entries.filter((entry): entry is readonly [string, string] => entry !== null)));
    });
    return () => {
      live = false;
    };
  }, [ids]);
  return names;
}
