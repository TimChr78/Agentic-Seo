import type { ReactNode } from 'react';
import { cx } from '../cx';

// Health score (DESIGN.md §5): a KPI tile variant, never a gauge or ring. It shows the value out of
// 100, the category bars, and every category that was not evaluated in words. A score is not a
// verdict on what was skipped: "Not evaluated" rows stay visible even when a score exists.

export interface HealthCategory {
  key: string;
  label: string;
  score: number | null;
}

export interface HealthScoreProps {
  score: number | null;
  delta?: number | null;
  pagesEvaluated?: number | null;
  categories: HealthCategory[];
  /** Categories the last audit could not evaluate, listed explicitly. */
  notEvaluated: string[];
  /** e.g. "Last audit · 12 Nov 2026". */
  period?: ReactNode;
  updatedAt?: ReactNode;
  className?: string;
}

function Delta({ delta }: { delta: number }) {
  const points = Math.abs(delta);
  return (
    <p className="text-[12px] leading-[18px] text-fg-2">
      {delta > 0 ? '↑' : '↓'} <span className="font-medium">{points}</span> points {delta > 0 ? 'higher' : 'lower'}
    </p>
  );
}

export function HealthScore({ score, delta, pagesEvaluated, categories, notEvaluated, period, updatedAt, className }: HealthScoreProps) {
  const missing = score === null;
  return (
    <section className={cx('flex min-h-[204px] flex-col rounded-lg bg-surface p-5', className)}>
      <p className="text-[13px] leading-5 font-medium text-fg-2">Health score</p>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="num text-[28px] leading-9 font-semibold tracking-[-0.02em] text-fg md:text-[32px] md:leading-10">
          {missing ? '—' : score}
        </span>
        <span className="text-[14px] leading-[22px] text-fg-2">{missing ? 'Not evaluated' : '/100'}</span>
      </div>
      <div className="mt-2 min-h-[32px]">
        {missing ? (
          <p className="text-[12px] leading-[18px] text-fg-2">No audit has evaluated this site yet.</p>
        ) : delta !== null && delta !== undefined && delta !== 0 ? (
          <Delta delta={delta} />
        ) : (
          <p className="text-[12px] leading-[18px] text-fg-2">No previous audit to compare.</p>
        )}
      </div>

      {categories.length > 0 && (
        <ul className="mt-3 space-y-2" aria-label="Score by category">
          {categories.map((category) => {
            const value = category.score;
            return (
              <li key={category.key} className="grid grid-cols-[minmax(0,1fr)_72px_auto] items-center gap-2 text-[12px] leading-[18px]">
                <span className="truncate text-fg-2">{category.label}</span>
                <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                  {value !== null && (
                    <span className="block h-full rounded-full bg-viz-2" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
                  )}
                </span>
                <span className={cx('num w-8 text-right', value === null ? 'text-muted' : 'text-fg')}>{value === null ? '—' : value}</span>
              </li>
            );
          })}
        </ul>
      )}

      {notEvaluated.length > 0 && <p className="mt-3 text-[12px] leading-[18px] text-fg-2">Not evaluated: {notEvaluated.join(', ')}.</p>}

      <div className="mt-auto pt-3">
        {pagesEvaluated !== null && pagesEvaluated !== undefined && (
          <p className="num text-[12px] leading-[18px] text-fg-2">{pagesEvaluated.toLocaleString()} pages evaluated</p>
        )}
        {period && <p className="text-[12px] leading-[18px] text-muted">{period}</p>}
        {updatedAt && <p className="text-[12px] leading-[18px] text-muted">{updatedAt}</p>}
      </div>
    </section>
  );
}
