import { Copy } from 'lucide-react';
import { useState } from 'react';
import { IconButton } from '../Button';
import { cx } from '../cx';

// UrlCell (DESIGN.md §5): a page shown path-first, with the host only when it differs from the
// site's own. The full URL is in the tooltip and the copy button's name, never invented text.

/** The path and query of a URL, or the URL itself when it does not parse. */
function pathOf(url: string): { path: string; host: string | null } {
  try {
    const parsed = new URL(url);
    return { path: `${parsed.pathname}${parsed.search}` || '/', host: parsed.host };
  } catch {
    return { path: url, host: null };
  }
}

/** Middle truncation: the start and the end of a long path stay readable. */
function middle(text: string, max = 64): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

export function UrlCell({ url, siteHost, className }: { url: string; siteHost?: string; className?: string }) {
  const { path, host } = pathOf(url);
  const [copied, setCopied] = useState(false);
  const differs = host !== null && siteHost !== undefined && host !== siteHost;
  return (
    <span className={cx('inline-flex min-w-0 max-w-full items-center gap-1', className)}>
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        title={url}
        className="min-w-0 truncate font-mono text-[12px] leading-[18px] text-fg hover:text-accent hover:underline"
      >
        {middle(differs ? `${host}${path}` : path)}
      </a>
      <IconButton
        size="sm"
        label={copied ? 'Page URL copied' : `Copy the page URL ${url}`}
        icon={<Copy size={12} />}
        onClick={async () => {
          await navigator.clipboard?.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      />
    </span>
  );
}

export interface EvidenceRow {
  /** The page or subject the evidence is about. */
  subject: string;
  value?: string | null;
  expected?: string | null;
  detail?: string | null;
  /** Where the value came from, e.g. "Crawl 12 Nov" or "Search Console". */
  source?: string | null;
  /** An in-app link to the snapshot or record behind it. */
  href?: string;
}

/**
 * EvidenceList (DESIGN.md §5): what was found, what was expected, and where it came from. A value
 * and its expectation sit side by side so a reader can see the difference without a chart.
 */
export function EvidenceList({ rows, siteHost, className }: { rows: EvidenceRow[]; siteHost?: string; className?: string }) {
  if (rows.length === 0)
    return (
      <p className="text-[13px] leading-5 text-muted">This finding carries no page-level evidence; its detail is in the explanation.</p>
    );
  return (
    <div className={cx('min-w-0 rounded-lg border border-line', className)}>
      <table className="w-full border-collapse text-left text-[13px] leading-5">
        <caption className="sr-only">What was found and what was expected, page by page</caption>
        <thead className="bg-surface-2 text-[12px] leading-[18px] text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Page
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Found
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Expected
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: these rows have no identity of their own; the index is their position in an ordered list that never reorders
            <tr key={`${row.subject}:${index}`} className="border-t border-line align-top">
              <td className="max-w-[280px] px-3 py-2.5">
                <UrlCell url={row.href ?? row.subject} siteHost={siteHost} />
                {row.source && <p className="mt-0.5 text-[12px] leading-[18px] text-muted">{row.source}</p>}
              </td>
              <td className="px-3 py-2.5 break-words text-fg-2">
                {row.value ? row.value : <span className="text-muted">Not recorded</span>}
              </td>
              <td className="px-3 py-2.5 break-words text-fg-2">{row.expected ? row.expected : <span className="text-muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.some((row) => row.detail) && (
        <ul className="divide-y divide-line border-t border-line">
          {rows
            .filter((row) => row.detail)
            .map((row, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: these rows have no identity of their own; the index is their position in an ordered list that never reorders
              <li key={`${row.subject}:detail:${index}`} className="px-3 py-2 text-[12px] leading-[18px] text-muted break-words">
                {row.detail}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
