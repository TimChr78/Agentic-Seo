import { cx } from '../cx';
import { formatDate } from '../time';

// Traffic at risk (DESIGN.md §5): the one place that renders "what could be lost" from a
// ReachEstimate. Unknown is a first-class answer with its own reason, never a zero: a site without
// Search Console has not measured zero clicks.

export interface Reach {
  kind: 'unknown' | 'known';
  /** Why the estimate is unknown (kind "unknown"). */
  reason?: string;
  affectedUrls?: number;
  clicksAtRisk?: number | null;
  impressionsAtRisk?: number | null;
  /** The newest day of page data the estimate used, YYYY-MM-DD. */
  dataThrough?: string;
  criticalPages?: string[];
}

const count = (value: number) => value.toLocaleString();

/** "1,240 clicks/28d · Search Console" — the numerator, its period and its source, in one line. */
export function TrafficAtRisk({ reach, prefix, className }: { reach: Reach; prefix?: string; className?: string }) {
  if (reach.kind === 'unknown' || reach.clicksAtRisk === undefined) {
    return (
      <span className={cx('inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-warn', className)}>
        {prefix && <span className="text-fg-2">{prefix}</span>}
        <span className="font-medium">Unknown</span>
        {reach.reason && <span className="text-[12px] leading-[18px] text-muted">{reach.reason}</span>}
      </span>
    );
  }
  if (reach.clicksAtRisk === null) {
    return (
      <span className={cx('inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5', className)}>
        {prefix && <span className="text-fg-2">{prefix}</span>}
        <span className="font-medium text-warn">No Search Console clicks</span>
        <span className="text-[12px] leading-[18px] text-muted">for these pages over 28 days</span>
      </span>
    );
  }
  return (
    <span className={cx('inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5', className)}>
      {prefix && <span className="text-fg-2">{prefix}</span>}
      <span className="num font-medium text-fg">
        {count(reach.clicksAtRisk)} {reach.clicksAtRisk === 1 ? 'click' : 'clicks'}/28d
      </span>
      <span className="text-[12px] leading-[18px] text-muted">
        Search Console
        {reach.dataThrough ? ` · data through ${formatDate(reach.dataThrough)}` : ''}
        {reach.affectedUrls !== undefined ? ` · ${count(reach.affectedUrls)} ${reach.affectedUrls === 1 ? 'page' : 'pages'}` : ''}
      </span>
    </span>
  );
}
