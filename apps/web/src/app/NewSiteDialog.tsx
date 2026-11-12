import { useState } from 'react';
import { Button, Field, Input, Modal, useToast } from '../ui';
import { errText, type Site } from './api';
import { useSession } from './session';

/**
 * New site: name and primary domain. It is a dialog rather than a page so a person can create the
 * next site from the switcher without losing the screen they are on. The server verifies ownership
 * later; the checker on Home says so.
 */
export function NewSiteDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: (site: Site) => void }) {
  const { createSite } = useSession();
  const toast = useToast();
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setName('');
    setDomain('');
    setError(null);
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const site = await createSite({ name, domain });
      toast.success(`${site.name} is ready. Verify ownership to start collecting data.`);
      reset();
      onCreated?.(site);
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (busy) return;
        reset();
        onClose();
      }}
      title="New site"
      footer={
        <>
          <Button
            onClick={() => {
              reset();
              onClose();
            }}
            disabled={busy}
          >
            Cancel
          </Button>
          {/* A submit control for the form above, so required fields and Enter both work. */}
          <Button type="submit" form="new-site-form" variant="primary" loading={busy}>
            Add site
          </Button>
        </>
      }
    >
      <form
        id="new-site-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="text-[13px] leading-5 text-muted">
          The primary domain is the canonical host for reports and recommendations. Ownership verification comes next.
        </p>
        <Field label="Site name" hint="How this site appears in the switcher.">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="MartechSignal" required data-autofocus />
        </Field>
        <Field label="Primary domain" hint="The host people search for, without a path.">
          <Input
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            placeholder="martechsignal.com"
            inputMode="url"
            autoComplete="off"
            required
          />
        </Field>
        {error && (
          <p role="alert" className="text-[12px] leading-[18px] text-bad">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
