import { ArrowRight, Check, Clock, Hand, OctagonX, Pause, Square } from 'lucide-react';
import { cx } from './cx';
import { StatusPill, type Tone } from './display';

// Operational state pills (DESIGN.md → Operational state pills). 20 px high, neutral dot or a
// 14 px marker shape, and the state's own words. Noninteractive; a filter wraps a larger control
// rather than making the pill the hit target. Families (issues, changes, audits) map their own
// states onto this shape; the marker is never the only signal.

export type OperationalIcon = 'dot' | 'clock' | 'arrow' | 'check' | 'pause' | 'octagon' | 'square' | 'hand';

export interface OperationalState {
  key: string;
  label: string;
  tone: Tone;
  icon: OperationalIcon;
  /** A qualifying sentence for the pill's tooltip or the line below it. */
  detail?: string;
}

const MARKER = {
  clock: Clock,
  arrow: ArrowRight,
  check: Check,
  pause: Pause,
  octagon: OctagonX,
  square: Square,
  hand: Hand,
} as const;

function Marker({ icon }: { icon: OperationalIcon }) {
  if (icon === 'dot') return null;
  const Icon = MARKER[icon];
  return <Icon size={14} strokeWidth={1.75} aria-hidden />;
}

export function OperationalPill({ state, className }: { state: OperationalState; className?: string }) {
  return (
    <StatusPill tone={state.tone} className={className} dot={state.icon === 'dot'}>
      <Marker icon={state.icon} />
      {state.label}
      {state.detail && <span className="sr-only">. {state.detail}</span>}
    </StatusPill>
  );
}

/** A noninteractive pill for a metric's data state, with a title for the qualifying sentence. */
export function DataStatePill({ state, detail, className }: { state: { label: string; tone: Tone }; detail?: string; className?: string }) {
  return (
    <span className={cx('inline-flex min-w-0 items-center', className)} title={detail}>
      <StatusPill tone={state.tone}>{state.label}</StatusPill>
    </span>
  );
}
