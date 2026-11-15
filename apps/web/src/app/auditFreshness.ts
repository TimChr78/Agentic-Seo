import { type Audit, api, type Issue } from './api';
import { useApi } from './useApi';

// "Not re-checked" is a comparison with the site's audits, not with the issue's own row: an issue is
// stale when the newest audit that finished is not the one that last checked it. The list and the
// detail read the same audit list, newest first, so the answer agrees between them.

const FINISHED = new Set(['completed', 'partial']);

/** The newest audit that finished (completed or partial), among the newest reads. */
export function useLatestFinishedAudit(siteId: string) {
  const read = useApi(() => api.listAudits({ siteId, limit: 20 }), [siteId]);
  return {
    latest: read.data?.rows.find((audit) => FINISHED.has(audit.state)),
    error: read.error,
    reload: read.reload,
  };
}

/** True when an open issue's last check predates the site's newest finished audit. */
export function isNotRechecked(issue: Pick<Issue, 'state' | 'lastCheckedAuditId'>, latest: Audit | undefined): boolean {
  return issue.state === 'open' && latest !== undefined && latest.id !== issue.lastCheckedAuditId;
}
