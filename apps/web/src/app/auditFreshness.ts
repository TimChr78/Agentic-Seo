import { type Audit, api, type Issue } from './api';
import { useApi } from './useApi';

// "Not re-checked" is a comparison with the site's audits, not with the issue's own row: an issue is
// stale when the newest audit that finished is not the one that last checked it. The list and the
// detail read the same audit list, newest first, so the answer agrees between them.

const FINISHED = new Set(['completed', 'partial']);

/**
 * The newest audit that finished (completed or partial). Read by state, one row each, so any number
 * of later failed, cancelled or running audits cannot push the finished one out of a page.
 */
export function useLatestFinishedAudit(siteId: string) {
  const read = useApi(async () => {
    const [completed, partial] = await Promise.all(
      [...FINISHED].map((state) => api.listAudits({ siteId, state: state as 'completed' | 'partial', limit: 1 })),
    );
    return [...(completed?.rows ?? []), ...(partial?.rows ?? [])]
      .filter((audit) => FINISHED.has(audit.state))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }, [siteId]);
  return { latest: read.data ?? undefined, error: read.error, reload: read.reload };
}

/** True when an open issue's last check predates the site's newest finished audit. */
export function isNotRechecked(issue: Pick<Issue, 'state' | 'lastCheckedAuditId'>, latest: Audit | undefined): boolean {
  return issue.state === 'open' && latest !== undefined && latest.id !== issue.lastCheckedAuditId;
}
