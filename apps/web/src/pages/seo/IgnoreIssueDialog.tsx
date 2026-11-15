import { useState } from 'react';
import { api, errText } from '../../app/api';
import { Alert, Button, Field, Textarea } from '../../ui';
import { Modal } from '../../ui/overlay';

// Ignoring an issue is a judgement about the site's work queue, so it needs a reason: what a
// reviewer and a future agent read instead of re-checking the same finding. The server refuses an
// agent's call, and the field refuses fewer than ten characters before the request is sent.

export function IgnoreIssueDialog({
  open,
  onClose,
  issueId,
  onIgnored,
}: {
  open: boolean;
  onClose: () => void;
  issueId: string;
  onIgnored: () => void;
}) {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooShort = reason.trim().length < 10;

  const submit = async () => {
    if (tooShort) return;
    setPending(true);
    setError(null);
    try {
      await api.ignoreIssue(issueId, reason.trim());
      onIgnored();
      onClose();
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
      title="Ignore this issue"
      footer={
        <>
          <Button variant="primary" disabled={tooShort} loading={pending} onClick={() => void submit()}>
            Ignore issue
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <p>
        An ignored issue stays visible with its state, keeps recording that it was seen, and is never resolved by a later audit. Use it for
        a deliberate exception, such as a noindex on a staging host.
      </p>
      {error && (
        <Alert tone="bad" title="The issue was not ignored" className="mt-3">
          {error}
        </Alert>
      )}
      <form
        className="mt-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Why is this accepted rather than fixed?" required hint="At least 10 characters. This is what reviewers read.">
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={1000} autoFocus />
        </Field>
      </form>
    </Modal>
  );
}
