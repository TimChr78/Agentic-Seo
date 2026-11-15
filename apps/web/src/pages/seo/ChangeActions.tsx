import { useState } from 'react';
import { api, errText } from '../../app/api';
import { navigate } from '../../app/router';
import { Alert, Button, Field, Meta, Textarea } from '../../ui';
import { Modal } from '../../ui/overlay';
import { type Reach, TrafficAtRisk } from '../../ui/seo/reach';

// The two change-set decisions that are not approvals (DESIGN.md §4.4): submit for approval, and
// propose a rollback. Both show the consequence the server computed — the policy outcome and the
// traffic at risk, or the exactness and gaps of a rollback — before anything is written.

type Applied = {
  status: 'published' | 'in_review';
  policy: string;
  actionClass: string;
  reach: Reach;
  heldBecause: string[];
  next: string;
};

export function RequestApplyDialog({
  open,
  onClose,
  changeSetId,
  onSubmitted,
}: {
  open: boolean;
  onClose: () => void;
  changeSetId: string;
  onSubmitted: () => void;
}) {
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<Applied | null>(null);

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await api.requestApply(changeSetId, note.trim());
      setApplied(result);
      onSubmitted();
    } catch (caught) {
      setError(errText(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Submit this change set"
      footer={
        applied ? (
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="primary" loading={pending} disabled={note.trim().length === 0} onClick={() => void submit()}>
              Submit for approval
            </Button>
            <Button onClick={onClose}>Cancel</Button>
          </>
        )
      }
    >
      {applied ? (
        <div className="space-y-3">
          <Alert
            tone={applied.status === 'published' ? 'good' : 'info'}
            title={applied.status === 'published' ? 'Published' : 'Waiting for a person'}
          >
            {applied.next}
          </Alert>
          <Meta
            items={[
              [
                'Policy',
                applied.policy === 'all_publishes'
                  ? 'Every publish needs approval'
                  : applied.policy === 'agent_changes'
                    ? 'Agent changes need approval'
                    : 'No approval required',
              ],
              ['Action class', applied.actionClass],
              ['Traffic at risk', <TrafficAtRisk key="reach" reach={applied.reach} />],
            ]}
          />
          {applied.heldBecause.length > 0 && (
            <div>
              <p className="text-[12px] leading-[18px] font-medium text-fg-2">Why a person must approve it</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-[12px] leading-[18px] text-fg-2">
                {applied.heldBecause.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <>
          <p>
            This publishes the latest draft through the approval flow. Nothing is written to the site: approving it opens the pull request,
            and the deployed page is read back afterwards.
          </p>
          {error && (
            <Alert tone="bad" title="The change set was not submitted" className="mt-3">
              {error}
            </Alert>
          )}
          <form
            className="mt-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (note.trim()) void submit();
            }}
          >
            <Field label="What changed and why" required hint="The reviewer reads this instead of the whole diff.">
              <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={1000} autoFocus />
            </Field>
          </form>
        </>
      )}
    </Modal>
  );
}

type RolledBack = {
  changeSetId: string;
  mode: 'exact' | 'proposed';
  filesUnchanged: boolean;
  uncoveredChanges: { index: number; reason: string }[];
  reach: Reach;
  next: string;
};

export function RollbackDialog({
  open,
  onClose,
  changeSetId,
  onProposed,
}: {
  open: boolean;
  onClose: () => void;
  changeSetId: string;
  onProposed: () => void;
}) {
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RolledBack | null>(null);

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const created = await api.rollbackChangeSet(changeSetId, note.trim());
      setResult(created);
      onProposed();
    } catch (caught) {
      setError(errText(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Propose a rollback"
      footer={
        result ? (
          <>
            <Button variant="primary" onClick={() => navigate(`/changes/${result.changeSetId}`)}>
              Open the rollback
            </Button>
            <Button onClick={onClose}>Close</Button>
          </>
        ) : (
          <>
            <Button variant="danger" loading={pending} disabled={note.trim().length === 0} onClick={() => void submit()}>
              Propose rollback
            </Button>
            <Button onClick={onClose}>Cancel</Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3">
          <Alert
            tone={result.mode === 'exact' ? 'good' : 'warn'}
            title={result.mode === 'exact' ? 'An exact revert is possible' : 'This rollback is a proposal, not an exact revert'}
          >
            {result.next}
          </Alert>
          <Meta
            items={[
              [
                'Mode',
                result.mode === 'exact'
                  ? 'Exact: every touched file still matches the merge'
                  : 'Proposed: a file moved or a change cannot be inverted',
              ],
              ['Files unchanged', result.filesUnchanged ? 'Yes' : 'No'],
              ['Traffic at risk', <TrafficAtRisk key="reach" reach={result.reach} />],
            ]}
          />
          {result.uncoveredChanges.length > 0 && (
            <div>
              <p className="text-[12px] leading-[18px] font-medium text-fg-2">Changes this rollback cannot reverse</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-[12px] leading-[18px] text-fg-2">
                {result.uncoveredChanges.map((entry) => (
                  <li key={entry.index}>
                    Change {entry.index + 1}: {entry.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <>
          <p>
            A rollback is a new change set that reverses this one. It also needs approval and its own pull request, and it never marks the
            original as rolled back by itself.
          </p>
          {error && (
            <Alert tone="bad" title="No rollback was proposed" className="mt-3">
              {error}
            </Alert>
          )}
          <form
            className="mt-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (note.trim()) void submit();
            }}
          >
            <Field label="Why roll it back" required hint="What went wrong, for the reviewer of the revert.">
              <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={1000} autoFocus />
            </Field>
          </form>
        </>
      )}
    </Modal>
  );
}
