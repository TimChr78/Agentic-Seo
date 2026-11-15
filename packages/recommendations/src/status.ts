import type { Tx } from '@agentic-seo/db';
import { sql } from 'drizzle-orm';

// A recommendation's status is derived, never stored (the brief left the choice open): the artifact's
// own lifecycle supplies proposed / accepted / rejected, and the change sets whose content names the
// recommendation supply implemented. A stored status would be a second truth that goes stale the
// moment an approval or a pull request moves, and the design's "In review · Agent" header is read
// from exactly these facts.
//
// `measured` is reserved for the outcome (Phase 4): Phase 1 has no measurement, so nothing is
// measured and the status is never returned. The filter still accepts it, with no results, so a
// client written against the full enum does not have to special-case the phase.

export const RECOMMENDATION_STATUSES = ['proposed', 'accepted', 'implemented', 'rejected', 'measured'] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

/** The change-set states that mean somebody acted on the recommendation. */
export const IMPLEMENTED_STATES = [
  'approved',
  'applying',
  'pr_open',
  'merged',
  'deploying',
  'deployed',
  'verified',
  'verification_failed',
  'deploy_not_detected',
] as const;

export interface LinkedChangeSet {
  id: string;
  name: string;
  state: string;
  prUrl: string | null;
  updatedAt: string;
}

/** The change sets whose content names this recommendation (task F's `recommendationId`). */
export async function linkedChangeSets(
  tx: Tx,
  input: { workspaceId: string; siteId: string; recommendationId: string },
): Promise<LinkedChangeSet[]> {
  const { rows } = await tx.execute<{
    id: string;
    name: string;
    state: string;
    pr_url: string | null;
    updated_at: Date | string;
  }>(sql`
    SELECT cs.id, cs.name, csr.state, csr.pr_url, cs.updated_at
      FROM artifacts cs
      JOIN artifact_versions csv
        ON csv.workspace_id = cs.workspace_id AND csv.artifact_id = cs.id AND csv.number = cs.latest_version
      JOIN change_set_runs csr ON csr.workspace_id = cs.workspace_id AND csr.artifact_id = cs.id
     WHERE cs.workspace_id = ${input.workspaceId}
       AND cs.site_id = ${input.siteId}
       AND cs.type = 'change_set'
       AND csv.content ->> 'recommendationId' = ${input.recommendationId}
     ORDER BY cs.updated_at DESC
     LIMIT 20`);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    state: row.state,
    prUrl: row.pr_url,
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

/** The status of one recommendation from its version state, publication and linked change sets. */
export function deriveStatus(input: {
  versionState: string;
  published: boolean;
  archived: boolean;
  linked: readonly LinkedChangeSet[];
}): RecommendationStatus {
  if (input.archived || input.versionState === 'rejected') return 'rejected';
  if (!input.published) return 'proposed';
  if (input.linked.some((changeSet) => (IMPLEMENTED_STATES as readonly string[]).includes(changeSet.state))) return 'implemented';
  return 'accepted';
}

/** Whether any change set of this site that names the row has moved past drafting. */
const implementedSql = sql`EXISTS (
  SELECT 1
    FROM artifacts cs
    JOIN artifact_versions csv
      ON csv.workspace_id = cs.workspace_id AND csv.artifact_id = cs.id AND csv.number = cs.latest_version
    JOIN change_set_runs csr ON csr.workspace_id = cs.workspace_id AND csr.artifact_id = cs.id
   WHERE cs.workspace_id = a.workspace_id
     AND cs.type = 'change_set'
     AND cs.site_id = a.site_id
     AND csv.content ->> 'recommendationId' = a.id
     AND csr.state IN ('approved', 'applying', 'pr_open', 'merged', 'deploying', 'deployed', 'verified', 'verification_failed', 'deploy_not_detected')
)`;

/** The SQL predicate a list filter uses, so filtering and the returned status cannot disagree. */
export const statusSql = (status: RecommendationStatus) => {
  if (status === 'rejected') return sql`(a.archived OR v.state = 'rejected')`;
  if (status === 'proposed') return sql`(NOT a.archived AND v.state <> 'rejected' AND a.published_version IS NULL)`;
  if (status === 'accepted')
    return sql`(NOT a.archived AND v.state <> 'rejected' AND a.published_version IS NOT NULL AND NOT ${implementedSql})`;
  if (status === 'implemented')
    return sql`(NOT a.archived AND v.state <> 'rejected' AND a.published_version IS NOT NULL AND ${implementedSql})`;
  // measured: no outcome exists in Phase 1.
  return sql`false`;
};

/** The status expression for a list row (aliases `a` for artifacts and `v` for its latest version). */
export const statusCaseSql = sql`CASE
  WHEN a.archived OR v.state = 'rejected' THEN 'rejected'
  WHEN a.published_version IS NULL THEN 'proposed'
  WHEN ${implementedSql} THEN 'implemented'
  ELSE 'accepted'
END`;
