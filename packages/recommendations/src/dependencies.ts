import type { Tx } from '@agentic-seo/db';
import { sql } from 'drizzle-orm';

// The dependency graph of a site's recommendations. Two doors need the same rule: the create/update
// commands, which refuse a graph that names a foreign or missing id or closes a cycle, and the
// publish validator, which re-checks a stored recommendation so a graph that rotted (a dependency
// archived away) cannot go live. The check returns sentences rather than throwing, so each caller
// can decide how a person hears about it.

/** Every recommendation of the site with the dependencies its latest version declares. */
async function graphOf(tx: Tx, workspaceId: string, siteId: string): Promise<Map<string, string[]>> {
  const { rows } = await tx.execute<{ id: string; depends_on: string[] }>(sql`
    SELECT a.id, COALESCE(ARRAY(SELECT jsonb_array_elements_text(v.content -> 'dependsOn')), '{}') AS depends_on
      FROM artifacts a
      JOIN artifact_versions v ON v.workspace_id = a.workspace_id AND v.artifact_id = a.id AND v.number = a.latest_version
     WHERE a.workspace_id = ${workspaceId} AND a.site_id = ${siteId} AND a.type = 'recommendation'`);
  return new Map(rows.map((row) => [row.id, row.depends_on]));
}

/**
 * What is wrong with one recommendation's dependencies, as sentences; empty when the graph is fine.
 * `recommendationId` is the artifact the edges belong to (absent at create), which is how a cycle
 * that runs through it is named.
 */
export async function dependencyProblems(
  tx: Tx,
  input: { workspaceId: string; siteId: string; recommendationId?: string; dependsOn: readonly string[] },
): Promise<string[]> {
  if (!input.dependsOn.length) return [];
  const graph = await graphOf(tx, input.workspaceId, input.siteId);
  const self = input.recommendationId ?? '(this recommendation)';
  const problems: string[] = [];
  for (const dependency of input.dependsOn)
    if (!graph.has(dependency))
      problems.push(
        `The dependency ${dependency} is not a recommendation on this site. Use recommendations.list to find the ids that exist here.`,
      );
  if (problems.length) return problems;
  // Walk the edges from the new ones: reaching the recommendation itself is a cycle.
  const seen = new Set<string>();
  const stack = [...input.dependsOn];
  while (stack.length) {
    const next = stack.pop() as string;
    if (next === self) {
      problems.push(`These dependencies form a cycle through ${self}. A recommendation cannot wait on itself.`);
      break;
    }
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(graph.get(next) ?? []));
  }
  return problems;
}
