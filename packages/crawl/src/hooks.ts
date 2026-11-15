import type { Tx } from '@agentic-seo/db';
import type { PageFacts, SiteFacts } from './facts';

// How later packages plug into an audit without the crawler depending on them (overview.md §3:
// packages talk through exported interfaces). The check catalogue registers `onPage` to record
// page findings inside the chunk that crawled the page, and `onFinalize` to run site-level checks,
// update issues and compute the health score inside the transaction that completes the audit.
//
// Both run inside the crawler's tenant transaction (RLS scoped to the audit's workspace). A hook
// that throws rolls back that step: the chunk is retried, or the finalize is retried, so hooks must
// be idempotent (upsert by deterministic ids, never append blindly).

export type AuditScope = 'site' | 'section' | 'list' | 'page';

export type TruncationReason =
  | 'page_limit'
  | 'depth_limit'
  | 'time_limit'
  | 'robots'
  | 'errors'
  | 'cancelled'
  | 'section_quota'
  /**
   * A crawled page had more links than the extractor keeps, so the graph is missing edges (and
   * possibly pages). Additive in round 2 of review.
   */
  | 'links_truncated'
  /**
   * Sitemap seeding stopped at a cap (documents, queued sitemaps, bytes or wall time), so the
   * sitemap list — which orphan detection relies on — is not the whole list. Additive in round 2.
   */
  | 'sitemaps_truncated';

/**
 * Whether the audit saw the whole link graph (crawler-and-audits.md §2 "Coverage"). Graph checks
 * (orphans, depth, internal PageRank) are suppressed when `graph` is `truncated`, and an issue is
 * only resolved by an audit whose coverage includes the affected URL.
 */
export interface Coverage {
  scope: AuditScope;
  graph: 'complete' | 'truncated';
  reasons: TruncationReason[];
  pagesCrawled: number;
  /** Distinct URLs discovered, crawled or not. */
  pagesDiscovered: number;
  /** For `section` scope: the path prefix; for `list`/`page`: the URLs. */
  section?: string;
  urls?: string[];
}

export interface AuditRef {
  workspaceId: string;
  siteId: string;
  auditId: string;
}

export interface AuditHooks {
  /** After a page snapshot is stored, in the same transaction. */
  onPage?(tx: Tx, audit: AuditRef, page: PageFacts & { snapshotId: string }): Promise<void>;
  /** After the crawl is complete and site facts are stored, in the transaction that finalizes. */
  onFinalize?(tx: Tx, audit: AuditRef & { coverage: Coverage; site: SiteFacts }): Promise<void>;
}
