import type { CheckCategory, Severity } from '../check';
import type { Evidence } from '../outcome';

/** One finding the audit produced, before it is stored. */
export interface FindingDraft {
  checkId: string;
  category: CheckCategory;
  severity: Severity;
  /**
   * The snapshot that produced the finding: the requested URL of the page the hook judged. A retry
   * or a re-crawl replaces that snapshot's findings by this key, so two snapshots that end at the
   * same final URL never overwrite each other.
   */
  sourceKey: string;
  /**
   * The issue's identity: the final URL for a content check, the requested URL for a redirect or
   * status check (the URL people link to), the site's origin for a site check.
   */
  subjectKey: string;
  /** What evidence names: a URL, or `url#selector` when the check points at a fragment. */
  subject: string;
  /** The catalogue's capped evidence plus the true count; explanation, never page identity. */
  evidence: { items: Evidence[]; total: number; truncated: boolean };
  /** How many pages the issue itself covers, and which ones (normalised URLs, none for a site). */
  affectedPages: number;
  affectedUrls: string[];
}
