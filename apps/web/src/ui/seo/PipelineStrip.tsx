import { Check, CircleDot, Minus, X } from 'lucide-react';
import { cx } from '../cx';
import { formatDateTime } from '../time';

// PipelineStrip (DESIGN.md §5): the change-set pipeline as horizontal steps with state, timestamp
// and actor; vertical below 768 px. A step that has not happened yet says so with a dash rather
// than an invented time, and a failed step keeps its reason beside it.

export type StepState = 'done' | 'current' | 'upcoming' | 'failed' | 'skipped';

export interface PipelineStep {
  key: string;
  label: string;
  state: StepState;
  /** When the step was reached, ISO 8601. */
  at?: string | null;
  /** Who moved it: a person, an agent or the system. */
  actor?: string | null;
  /** Why it failed, or why it was skipped. */
  detail?: string | null;
  /** Alternative steps at the same place in the pipeline, e.g. "In review / Held". */
  alternate?: boolean;
}

const MARKER = { done: Check, current: CircleDot, upcoming: Minus, failed: X, skipped: Minus } as const;

function Step({ step, last }: { step: PipelineStep; last: boolean }) {
  const Icon = MARKER[step.state];
  return (
    <li className="relative flex min-w-0 gap-2.5 pb-4 last:pb-0 md:flex-1 md:pb-0">
      <span
        aria-hidden
        className={cx(
          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border',
          step.state === 'done' && 'border-good bg-good-soft text-good',
          step.state === 'current' && 'border-accent bg-accent-soft text-accent',
          step.state === 'failed' && 'border-bad bg-bad-soft text-bad',
          (step.state === 'upcoming' || step.state === 'skipped') && 'border-line-strong bg-surface-2 text-muted',
        )}
      >
        <Icon size={12} strokeWidth={2} />
      </span>
      {/* The connector between steps: vertical below 768, horizontal above. */}
      {!last && (
        <span aria-hidden className="absolute top-5 left-2.5 h-[calc(100%-20px)] w-px bg-line md:top-2.5 md:left-5 md:h-px md:w-full" />
      )}
      <div className="min-w-0 md:pr-3">
        <p
          className={cx(
            'text-[12px] leading-[18px] font-medium',
            step.state === 'upcoming' && 'text-muted',
            step.state === 'failed' && 'text-bad',
            (step.state === 'done' || step.state === 'current') && 'text-fg',
          )}
        >
          {step.label}
          {step.state === 'current' && <span className="sr-only"> (current step)</span>}
          {step.alternate && <span className="ml-1 font-normal text-muted">or held</span>}
        </p>
        <p className="text-[12px] leading-[18px] text-muted">
          {step.at ? formatDateTime(step.at, { zone: true }) : step.state === 'upcoming' ? 'Not yet' : 'No time recorded'}
          {step.actor ? ` · ${step.actor}` : ''}
        </p>
        {step.detail && <p className="mt-0.5 text-[12px] leading-[18px] text-fg-2 break-words">{step.detail}</p>}
      </div>
    </li>
  );
}

export function PipelineStrip({ steps, label, className }: { steps: PipelineStep[]; label: string; className?: string }) {
  return (
    <ol aria-label={label} className={cx('min-w-0 md:flex md:items-start md:gap-0', className)}>
      {steps.map((step, index) => (
        <Step key={step.key} step={step} last={index === steps.length - 1} />
      ))}
    </ol>
  );
}
