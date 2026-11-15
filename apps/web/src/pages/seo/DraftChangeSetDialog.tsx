import { useState } from 'react';
import { api, errText, type RecommendationDetail } from '../../app/api';
import { Alert, Button, Field, Input, Select, Textarea } from '../../ui';
import { Drawer } from '../../ui/overlay';
import { UrlCell } from '../../ui/seo/evidence';

// Draft a change set from a recommendation (DESIGN.md §4.3, §4.4). The recommendation says what to
// change and why; this form says how, field by field, because a change set is not prose: every edit
// names the value the page shows now and the value to write. The server resolves each one to a
// source file and refuses anything the repository disagrees with.

type Row = {
  type: string;
  url: string;
  summary: string;
  /** meta.title, meta.description, image.alt, redirect */
  before: string;
  after: string;
  /** image.alt only */
  src: string;
  /** redirect only */
  to: string;
  status: '301' | '302' | '307' | '308';
  /** Entered here rather than proposed by the recommendation: its type and page are editable. */
  manual: boolean;
};

const DRAFTABLE = new Set(['meta.title', 'meta.description', 'image.alt', 'redirect']);

const blankRow = (): Row => ({
  type: 'meta.title',
  url: '',
  summary: '',
  before: '',
  after: '',
  src: '',
  to: '',
  status: '301',
  manual: true,
});

export function DraftChangeSetDialog({
  open,
  onClose,
  siteId,
  recommendation,
  onDrafted,
}: {
  open: boolean;
  onClose: () => void;
  siteId: string;
  recommendation: RecommendationDetail;
  onDrafted: (changeSetId: string) => void;
}) {
  const content = recommendation.content as {
    rationale?: string;
    hypothesis?: string;
    proposedChanges?: { type: string; url: string; summary: string }[];
    verificationPlan?: { recheck?: string; when?: string };
  };
  const proposed = content.proposedChanges ?? [];
  const [title, setTitle] = useState(recommendation.title);
  const [summary, setSummary] = useState(content.hypothesis ?? content.rationale?.slice(0, 1_000) ?? recommendation.title);
  const [verification, setVerification] = useState(
    [content.verificationPlan?.recheck, content.verificationPlan?.when ? `Measured ${content.verificationPlan.when}.` : '']
      .filter(Boolean)
      .join(' '),
  );
  const [rollback, setRollback] = useState('Revert the pull request: every change records the value it replaced, so the revert is exact.');
  // An issue-created recommendation names no page yet: start with one empty row to fill in. A
  // recommendation with proposed changes starts with those, and more can still be added.
  const [rows, setRows] = useState<Row[]>(
    proposed.length
      ? proposed.map((change) => ({
          type: change.type,
          url: change.url,
          summary: change.summary,
          before: '',
          after: '',
          src: '',
          to: '',
          status: '301',
          manual: false,
        }))
      : [blankRow()],
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusals, setRefusals] = useState<{ url: string; reason: string }[]>([]);

  const update = (index: number, patch: Partial<Row>) =>
    setRows((current) => current.map((row, position) => (position === index ? { ...row, ...patch } : row)));

  const draftable = rows.filter((row) => DRAFTABLE.has(row.type));

  const submit = async () => {
    setPending(true);
    setError(null);
    setRefusals([]);
    try {
      const changes = draftable.map((row) => {
        if (row.type === 'meta.title') return { type: 'meta.title' as const, url: row.url, before: row.before, after: row.after };
        if (row.type === 'meta.description')
          return { type: 'meta.description' as const, url: row.url, before: row.before || null, after: row.after };
        if (row.type === 'image.alt')
          return { type: 'image.alt' as const, url: row.url, src: row.src, before: row.before || null, after: row.after };
        return {
          type: 'redirect' as const,
          from: new URL(row.url).pathname,
          to: row.to,
          status: Number(row.status) as 301 | 302 | 307 | 308,
          operation: 'add' as const,
        };
      });
      const result = await api.createChangeSet({
        siteId,
        title: title.trim(),
        summary: summary.trim(),
        changes,
        verificationPlan: verification.trim(),
        rollbackPlan: rollback.trim(),
        recommendationId: recommendation.id as `rcm_${string}`,
      });
      if (!result.created) {
        setRefusals(result.refusals.map((refusal) => ({ url: refusal.url, reason: refusal.reason })));
        setError(result.next);
        return;
      }
      if (result.refusals.length) setRefusals(result.refusals.map((refusal) => ({ url: refusal.url, reason: refusal.reason })));
      onDrafted(result.changeSetId ?? '');
      onClose();
    } catch (caught) {
      setError(errText(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="xl"
      title="Draft a change set"
      meta="Nothing is written to the site here: drafting resolves each edit to its source file, and applying needs a person’s approval."
      footer={
        <>
          <Button variant="primary" loading={pending} disabled={draftable.length === 0} onClick={() => void submit()}>
            Draft change set
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div className="space-y-4 p-4 md:p-5">
        {error && (
          <Alert tone="bad" title="No change set was created">
            {error}
          </Alert>
        )}
        {refusals.length > 0 && (
          <ul className="space-y-1 rounded-lg border border-bad/30 bg-bad-soft p-3 text-[12px] leading-[18px] text-bad">
            {refusals.map((refusal, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: these rows have no identity of their own; the index is their position in an ordered list that never reorders
              <li key={`${refusal.url}:${index}`}>
                <span className="font-mono">{refusal.url}</span> · {refusal.reason}
              </li>
            ))}
          </ul>
        )}

        <Field label="Title" required hint="The pull request title: what this change set does, in one line.">
          <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} required />
        </Field>
        <Field label="Summary" required hint="Why these changes, and what evidence backs them.">
          <Textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={3} maxLength={2000} required />
        </Field>

        <section aria-labelledby="draft-changes">
          <h3 id="draft-changes" className="text-[13px] leading-5 font-semibold">
            The changes
          </h3>
          {proposed.length === 0 && (
            <p className="mt-1 text-[12px] leading-[18px] text-muted">
              This recommendation does not name proposed changes, so name each edit here. The server resolves every row through the site’s
              source mapping and refuses anything the repository disagrees with.
            </p>
          )}
          <ul className="mt-2 space-y-3">
            {rows.map((row, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: these rows have no identity of their own; the index is their position in an ordered list that never reorders (a key built from the URL would remount the input on every keystroke)
              <li key={index} className="rounded-lg border border-line p-3">
                {row.manual ? (
                  <div className="grid gap-2 sm:grid-cols-[170px_minmax(0,1fr)]">
                    <Field label="Change type" required>
                      <Select value={row.type} onChange={(event) => update(index, { type: event.target.value })}>
                        {[...DRAFTABLE].map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Page URL" required hint="The page this edit changes.">
                      <Input type="url" value={row.url} onChange={(event) => update(index, { url: event.target.value })} required />
                    </Field>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <UrlCell url={row.url} />
                      <span className="text-[12px] leading-[18px] text-muted">{row.type}</span>
                    </div>
                    <p className="mt-1 text-[12px] leading-[18px] text-fg-2">{row.summary}</p>
                  </>
                )}
                {!DRAFTABLE.has(row.type) && (
                  <p className="mt-2 text-[12px] leading-[18px] text-warn">
                    A {row.type} change names the block it replaces by its hash, which this form does not read. Draft it with the{' '}
                    <span className="font-mono">changes.create</span> command; it will be left out of this change set.
                  </p>
                )}
                {row.type === 'image.alt' && (
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <Field label="Image source" required hint="The src as the page shows it, or its absolute URL.">
                      <Input value={row.src} onChange={(event) => update(index, { src: event.target.value })} />
                    </Field>
                    <Field label="Alt now" hint="Leave empty when the attribute is missing.">
                      <Input value={row.before} onChange={(event) => update(index, { before: event.target.value })} />
                    </Field>
                    <Field label="Alt to write" required hint="An empty value marks a decorative image." className="sm:col-span-2">
                      <Input value={row.after} onChange={(event) => update(index, { after: event.target.value })} />
                    </Field>
                  </div>
                )}
                {(row.type === 'meta.title' || row.type === 'meta.description') && (
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <Field
                      label="Value now"
                      hint={row.type === 'meta.description' ? 'Leave empty when the page has no description.' : undefined}
                    >
                      <Input value={row.before} onChange={(event) => update(index, { before: event.target.value })} />
                    </Field>
                    <Field label="Value to write" required>
                      <Input value={row.after} onChange={(event) => update(index, { after: event.target.value })} />
                    </Field>
                  </div>
                )}
                {row.type === 'redirect' && (
                  <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_120px]">
                    <Field label="Redirect to" required hint="A path starting with /, or an absolute http(s) URL.">
                      <Input value={row.to} onChange={(event) => update(index, { to: event.target.value })} />
                    </Field>
                    <Field label="Status" required>
                      <Select value={row.status} onChange={(event) => update(index, { status: event.target.value as Row['status'] })}>
                        <option value="301">301</option>
                        <option value="302">302</option>
                        <option value="307">307</option>
                        <option value="308">308</option>
                      </Select>
                    </Field>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => setRows((current) => [...current, blankRow()])}>
            Add another change
          </Button>
        </section>

        <Field label="Verification plan" required hint="What a re-fetch after deployment must show.">
          <Textarea value={verification} onChange={(event) => setVerification(event.target.value)} rows={3} maxLength={2000} required />
        </Field>
        <Field label="Rollback plan" required hint="How to undo this change set.">
          <Textarea value={rollback} onChange={(event) => setRollback(event.target.value)} rows={2} maxLength={2000} required />
        </Field>
      </div>
    </Drawer>
  );
}
