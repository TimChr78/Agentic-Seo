import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './Button';

// Paging for a cursored list. The server hands back an opaque cursor, so the footer only offers the
// moves it actually has: no page numbers, no "of N" it cannot count.

export interface PagerProps {
  /** What the list holds, e.g. "issues" — used in the button names. */
  noun: string;
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  /** 1-based position of the page being read. */
  page: number;
  /** True while the next page is loading: the buttons stay, disabled, so the layout holds. */
  loading?: boolean;
}

export function Pager({ noun, canPrevious, canNext, onPrevious, onNext, page, loading }: PagerProps) {
  return (
    <nav aria-label={`${noun} pages`} className="flex min-h-10 flex-wrap items-center justify-between gap-2">
      <p className="num text-[12px] leading-[18px] text-muted">Page {page}</p>
      <div className="flex items-center gap-2">
        <Button size="sm" icon={<ChevronLeft size={14} />} disabled={!canPrevious || loading} onClick={onPrevious}>
          Previous
        </Button>
        <Button size="sm" disabled={!canNext || loading} onClick={onNext}>
          Next
          <ChevronRight size={14} />
        </Button>
      </div>
    </nav>
  );
}
