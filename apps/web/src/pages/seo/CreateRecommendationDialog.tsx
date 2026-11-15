import { useState } from 'react';
import { ApiError, api, errText } from '../../app/api';
import { Alert, Button, Field, Input, Select, Textarea } from '../../ui';
import { fieldErrors } from '../../ui/form';
import { Drawer } from '../../ui/overlay';

// The recommendation form (DESIGN.md §4.3). A person and an agent write the same fields: a
// hypothesis, an estimate, how the result will be measured and what would prove it wrong. The
// traffic at stake is not a field — the server computes it from the evidence pages.

export interface RecommendationPrefill {
  title?: string;
  rationale?: string;
  hypothesis?: string;
  /** The issue this recommendation answers; it becomes the first evidence item. */
  evidence: { kind: 'issue' | 'finding' | 'search_fact' | 'audit'; id: string; note: string };
}

/** A proposed change is a hint for the change-set form: which edit, on which page, and why. */
type ChangeType = 'meta.title' | 'meta.description' | 'image.alt' | 'schema.jsonld' | 'redirect';
type ProposedChange = { type: ChangeType; url: string; summary: string };

const CHANGE_TYPES: readonly ChangeType[] = ['meta.title', 'meta.description', 'image.alt', 'schema.jsonld', 'redirect'];

const BLANK_CHANGE: ProposedChange = { type: 'meta.title', url: '', summary: '' };

export function CreateRecommendationDialog({
  open,
  onClose,
  siteId,
  prefill,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  siteId: string;
  prefill: RecommendationPrefill;
  onCreated: (recommendationId: string) => void;
}) {
  const [title, setTitle] = useState(prefill.title ?? '');
  const [rationale, setRationale] = useState(prefill.rationale ?? '');
  const [hypothesis, setHypothesis] = useState(prefill.hypothesis ?? '');
  const [summary, setSummary] = useState('');
  const [confidence, setConfidence] = useState<'low' | 'medium' | 'high'>('medium');
  const [effort, setEffort] = useState<'small' | 'medium' | 'large'>('small');
  const [recheck, setRecheck] = useState('');
  const [when, setWhen] = useState('28 days after the deploy');
  const [falsification, setFalsification] = useState('We will know this failed if ');
  const [indicator, setIndicator] = useState('');
  const [evidenceNote, setEvidenceNote] = useState(prefill.evidence.note);
  const [changes, setChanges] = useState<ProposedChange[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async () => {
    setPending(true);
    setError(null);
    setErrors({});
    try {
      const created = await api.createRecommendation({
        siteId,
        title: title.trim(),
        rationale: rationale.trim(),
        evidence: [{ ...prefill.evidence, note: evidenceNote.trim() }],
        hypothesis: hypothesis.trim(),
        expectedImpact: { summary: summary.trim(), confidence },
        effort,
        dependsOn: [],
        // Optional: a recommendation written from an issue names no page yet. When the person does
        // name one, the change-set form starts from it instead of an empty list.
        proposedChanges: changes
          .filter((change) => change.url.trim() && change.summary.trim())
          .map((change) => ({ type: change.type, url: change.url.trim(), summary: change.summary.trim() })),
        verificationPlan: { recheck: recheck.trim(), when: when.trim() },
        falsificationCheck: falsification.trim(),
        leadingIndicator: indicator.trim(),
      });
      onCreated(created.recommendationId);
      onClose();
    } catch (caught) {
      setError(errText(caught));
      if (caught instanceof ApiError && caught.details) setErrors(fieldErrors(caught.details));
    } finally {
      setPending(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="lg"
      title="Create recommendation"
      meta="What to do, why, and how we will know it worked. The traffic at stake is computed from the evidence."
      footer={
        <>
          <Button variant="primary" loading={pending} onClick={() => void submit()}>
            Create recommendation
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <form
        className="space-y-4 p-4 md:p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {error && (
          <Alert tone="bad" title="The recommendation was not created">
            {error}
          </Alert>
        )}

        <Field label="What to do" required error={errors.title} hint="One line, e.g. “Point the canonical at the preferred URL”.">
          <Input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} />
        </Field>

        <Field
          label="Rationale"
          required
          error={errors.rationale}
          hint="Why this, why now. Cite the evidence by its id; never a number the evidence does not carry."
        >
          <Textarea value={rationale} onChange={(event) => setRationale(event.target.value)} rows={4} required maxLength={4000} />
        </Field>

        <Field label="Hypothesis" required error={errors.hypothesis} hint="If we do this, then that, because …">
          <Textarea value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} rows={3} required maxLength={2000} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Expected impact"
            required
            error={errors['expectedImpact.summary']}
            hint="An estimate, e.g. “CTR +10–20% on 34 queries”."
          >
            <Input value={summary} onChange={(event) => setSummary(event.target.value)} required maxLength={1000} />
          </Field>
          <Field label="Confidence" required hint="How sure we are, given this evidence.">
            <Select value={confidence} onChange={(event) => setConfidence(event.target.value as typeof confidence)} aria-label="Confidence">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </Select>
          </Field>
        </div>

        <Field label="Effort" required hint="How much work this is for a person or an agent.">
          <Select value={effort} onChange={(event) => setEffort(event.target.value as typeof effort)} aria-label="Effort">
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </Select>
        </Field>

        <fieldset className="space-y-3 rounded-lg border border-line p-3">
          <legend className="px-1 text-[12px] font-medium text-fg-2">Verification plan</legend>
          <Field
            label="What a re-fetch must show"
            required
            error={errors['verificationPlan.recheck']}
            hint="Re-crawl which pages, and what must be true afterwards."
          >
            <Textarea value={recheck} onChange={(event) => setRecheck(event.target.value)} rows={3} required maxLength={2000} />
          </Field>
          <Field label="When" required error={errors['verificationPlan.when']}>
            <Input value={when} onChange={(event) => setWhen(event.target.value)} required maxLength={500} />
          </Field>
        </fieldset>

        <Field
          label="Falsification check"
          required
          error={errors.falsificationCheck}
          hint="Start with “We will know this failed if…”. This is what turns the estimate into a test."
        >
          <Textarea value={falsification} onChange={(event) => setFalsification(event.target.value)} rows={3} required maxLength={1000} />
        </Field>

        <Field
          label="Leading indicator"
          required
          error={errors.leadingIndicator}
          hint="The earliest signal that it is working or not, e.g. “impressions-weighted CTR, daily”."
        >
          <Input value={indicator} onChange={(event) => setIndicator(event.target.value)} required maxLength={500} />
        </Field>

        <fieldset className="space-y-3 rounded-lg border border-line p-3">
          <legend className="px-1 text-[12px] font-medium text-fg-2">Proposed changes</legend>
          <p className="text-[12px] leading-[18px] text-muted">
            Optional. Name a page and the edit if the recommendation already knows them; Draft change set starts from these. Leave it empty
            when the work is a direction, and describe each change when drafting.
          </p>
          {changes.map((change, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: these rows have no identity of their own; the index is their position in an ordered list that never reorders
            <div key={index} className="grid gap-2 sm:grid-cols-[150px_minmax(0,1fr)]">
              <Select
                aria-label={`Change ${index + 1} type`}
                value={change.type}
                onChange={(event) =>
                  setChanges((current) =>
                    current.map((row, position) => (position === index ? { ...row, type: event.target.value as ChangeType } : row)),
                  )
                }
              >
                {CHANGE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </Select>
              <Input
                aria-label={`Change ${index + 1} page URL`}
                placeholder="https://example.com/page"
                value={change.url}
                onChange={(event) =>
                  setChanges((current) => current.map((row, position) => (position === index ? { ...row, url: event.target.value } : row)))
                }
              />
              <Input
                aria-label={`Change ${index + 1} summary`}
                placeholder="What to change on that page"
                className="sm:col-span-2"
                value={change.summary}
                onChange={(event) =>
                  setChanges((current) =>
                    current.map((row, position) => (position === index ? { ...row, summary: event.target.value } : row)),
                  )
                }
              />
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => setChanges((current) => [...current, { ...BLANK_CHANGE }])}>
            Add a proposed change
          </Button>
        </fieldset>

        <fieldset className="space-y-3 rounded-lg border border-line p-3">
          <legend className="px-1 text-[12px] font-medium text-fg-2">Evidence</legend>
          <Field
            label={`What this evidence shows (${prefill.evidence.kind.replace('_', ' ')} ${prefill.evidence.id})`}
            required
            error={errors['evidence.0.note']}
            hint="One line a reviewer can check against the evidence itself."
          >
            <Textarea value={evidenceNote} onChange={(event) => setEvidenceNote(event.target.value)} rows={2} required maxLength={500} />
          </Field>
        </fieldset>

        <p className="text-[12px] leading-[18px] text-muted">
          A recommendation states a hypothesis, not a promise. The traffic at stake comes from Search Console clicks on the evidence pages
          over 28 days, or says it is unknown when there is no connection.
        </p>
      </form>
    </Drawer>
  );
}
