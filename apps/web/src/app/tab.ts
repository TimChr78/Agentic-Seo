import { useEffect, useState } from 'react';

// Tabs that are a page section keep their choice in the URL, so a reload or a shared link opens the
// same panel. `key` names the query parameter ("tab"); an unknown value falls back to the first tab.

export function useTab<T extends string>(key: string, tabs: readonly T[], fallback: T): [T, (next: string) => void] {
  const [value, setValue] = useState<T>(fallback);

  useEffect(() => {
    const read = () => {
      const requested = new URLSearchParams(window.location.search).get(key);
      setValue(requested && (tabs as readonly string[]).includes(requested) ? (requested as T) : fallback);
    };
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, [key, tabs, fallback]);

  const set = (requested: string) => {
    // The shell's tab control hands back a plain string; a value that is not a tab here is ignored
    // rather than opening an empty panel.
    if (!(tabs as readonly string[]).includes(requested)) return;
    const next = requested as T;
    setValue(next);
    const url = new URL(window.location.href);
    if (next === fallback) url.searchParams.delete(key);
    else url.searchParams.set(key, next);
    window.history.replaceState(null, '', url.pathname + url.search);
  };

  return [value, set];
}
