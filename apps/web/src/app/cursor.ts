import { useCallback, useEffect, useState } from 'react';

// Cursor paging for the list screens. The server returns an opaque cursor for the next page; the
// hook keeps the trail of cursors so Previous is exact, and resets whenever the filters or the site
// change, so a cursor from one filter can never fetch a page of another.

export interface Cursor {
  /** The cursor to read with, or null for the first page. */
  cursor: string | null;
  /** 1-based position in the trail, for the footer. */
  page: number;
  canPrevious: boolean;
  next: (nextCursor: string) => void;
  previous: () => void;
  reset: () => void;
}

export function useCursor(resetKey: string): Cursor {
  const [state, setState] = useState<{ trail: (string | null)[]; index: number }>({ trail: [null], index: 0 });

  // A filter or site change starts a new list: the old cursor would name a row that is not in it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the trigger, not a value the reset reads
  useEffect(() => {
    setState({ trail: [null], index: 0 });
  }, [resetKey]);

  const next = useCallback((nextCursor: string) => {
    setState((current) => ({ trail: [...current.trail.slice(0, current.index + 1), nextCursor], index: current.index + 1 }));
  }, []);
  const previous = useCallback(() => setState((current) => ({ ...current, index: Math.max(0, current.index - 1) })), []);
  const reset = useCallback(() => setState({ trail: [null], index: 0 }), []);

  return {
    cursor: state.trail[state.index] ?? null,
    page: state.index + 1,
    canPrevious: state.index > 0,
    next,
    previous,
    reset,
  };
}
