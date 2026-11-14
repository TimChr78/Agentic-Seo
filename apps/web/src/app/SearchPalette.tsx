import { Globe, Search, Settings2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Badge, cx } from '../ui';
import { useFocusTrap } from '../ui/focus';
import { visibleNav } from './nav';
import { navigate } from './router';
import { useSession } from './session';

interface Result {
  key: string;
  label: string;
  hint: string;
  search: string;
  run: () => void;
  icon: typeof Globe;
  kind: 'page' | 'site';
}

interface Section {
  label: string;
  results: Result[];
}

/**
 * Global search: ⌘K or `/` opens one labelled combobox. It finds every destination the role can open
 * and every site in the workspace; selecting a site switches to it. No query shows the full list, so
 * the palette doubles as a jump menu. Phase 0 has no artifacts to search yet.
 */
export function SearchPalette({ onClose }: { onClose: () => void }) {
  const { can, sites, site, switchSite } = useSession();
  const ref = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  useFocusTrap(ref, true, onClose);

  const pages = useMemo<Result[]>(() => {
    const items = visibleNav(can, { localBusiness: site?.isLocalBusiness }).flatMap((group) =>
      group.items.map((item) => ({
        key: `page:${item.path}`,
        label: item.label,
        hint: group.label,
        search: `${item.label} ${group.label} ${item.path}`.toLowerCase(),
        run: () => navigate(item.path),
        icon: item.icon,
        kind: 'page' as const,
      })),
    );
    return [
      ...items,
      {
        key: 'page:/settings',
        label: 'Settings',
        hint: 'Settings',
        search: 'settings /settings',
        run: () => navigate('/settings'),
        icon: Settings2,
        kind: 'page' as const,
      },
    ];
  }, [can, site?.isLocalBusiness]);

  const siteResults = useMemo<Result[]>(
    () =>
      sites.map((candidate) => ({
        key: `site:${candidate.id}`,
        label: candidate.name,
        hint: candidate.domain,
        search: `${candidate.name} ${candidate.domain} site`.toLowerCase(),
        run: () => {
          if (candidate.id !== site?.id) {
            navigate('/');
            void switchSite(candidate.id);
          }
        },
        icon: Globe,
        kind: 'site' as const,
      })),
    [sites, site?.id, switchSite],
  );

  const sections = useMemo<Section[]>(() => {
    const needle = query.trim().toLowerCase();
    if (!needle)
      return [
        { label: 'Go to', results: pages },
        { label: 'Sites', results: siteResults },
      ];
    const hit = (result: Result) => result.search.includes(needle);
    return [
      { label: 'Go to', results: pages.filter(hit) },
      { label: 'Sites', results: siteResults.filter(hit) },
    ].filter((section) => section.results.length > 0);
  }, [query, pages, siteResults]);

  const flat = useMemo(() => sections.flatMap((section) => section.results), [sections]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the active result resets on every new query, which the body does not read
  useEffect(() => setActive(0), [query]);

  const go = (result: Result | undefined) => {
    if (!result) return;
    onClose();
    result.run();
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]">
      <div className="as-fade-in absolute inset-0 bg-[var(--scrim)]" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="as-rise relative w-full max-w-[600px] overflow-hidden rounded-xl border border-line bg-surface shadow-2"
      >
        <div className="flex items-center gap-2 border-b border-line px-3.5">
          <Search size={16} className="text-muted" aria-hidden />
          <input
            data-autofocus
            role="combobox"
            aria-expanded="true"
            aria-controls="search-results"
            aria-activedescendant={flat[active] ? `sr-${active}` : undefined}
            aria-label="Search or go to"
            placeholder="Search a page or site…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((current) => Math.min(current + 1, flat.length - 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((current) => Math.max(current - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                go(flat[active]);
              }
            }}
            className="h-12 min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-muted md:text-[14px]"
          />
        </div>
        <div id="search-results" role="listbox" aria-label="Results" className="max-h-[52vh] overflow-y-auto p-1.5">
          {query.trim() && flat.length === 0 && (
            <div className="px-3 py-6 text-center text-[13px] text-muted">No matches. Try a page name or a domain.</div>
          )}
          {sections.map((section) => (
            <div key={section.label}>
              <div className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted">{section.label}</div>
              {section.results.map((result) => {
                const index = flat.indexOf(result);
                const Icon = result.icon;
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: the search input handles arrow keys and Enter; options use the active-descendant pattern
                  <div
                    key={result.key}
                    id={`sr-${index}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === active}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => go(result)}
                    className={cx(
                      'flex min-h-10 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[13px]',
                      index === active && 'bg-surface-2',
                    )}
                  >
                    <Icon size={16} className="shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-fg">{result.label}</span>
                    <Badge tone="neutral">{result.hint}</Badge>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 border-t border-line px-3.5 py-2 text-[11px] text-muted">
          <span>↑ ↓ Move</span>
          <span>↵ Open</span>
          <span>Esc Close</span>
          <span className="ml-auto">
            {flat.length} result{flat.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
