import { artifactTypes, publishValidators } from '@agentic-seo/artifacts';
import { schema } from '@agentic-seo/db';
import { estimateReach } from '@agentic-seo/search-data';
import { and, eq } from 'drizzle-orm';
import { dependencyProblems } from './dependencies';
import { pagesOf, problemsText, resolveEvidence } from './evidence';

// Recommendations: the artifact content schema lives in packages/artifacts (the type's prefix is
// reserved there, and only recommendations.create/update may write the content — it is
// `serverOwned` there), the work lives here.
//
// Publishing a recommendation is possible only while its evidence still resolves for the site and
// its computed traffic at stake still matches what the evidence pages yield: an audit can be deleted
// with its crawl, and a finding disappears with it, so a recommendation that was true when it was
// drafted can name an id nobody can check any more. The dependencies are re-read too, so a graph
// that lost a node cannot go live. A person may still draft one (the validator runs on publish, not
// on save), but it cannot go live on evidence that is gone.

publishValidators.set('recommendation', async (content, tx, artifact) => {
  const parsed = artifactTypes.recommendation.content.safeParse(content);
  if (!parsed.success || !artifact) return [];
  const [row] = await tx
    .select({ siteId: schema.artifacts.siteId })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.workspaceId, artifact.workspaceId), eq(schema.artifacts.id, artifact.id)));
  if (!row?.siteId)
    return [
      'A recommendation must belong to a site. Create it with recommendations.create, which checks its evidence and computes the traffic at stake for that site.',
    ];
  const resolution = await resolveEvidence(tx, { workspaceId: artifact.workspaceId, siteId: row.siteId, items: parsed.data.evidence });
  if (!resolution.ok)
    return [
      `The evidence no longer resolves for this site: ${problemsText(resolution.problems)}. Update the recommendation, then publish it.`,
    ];
  // The traffic at stake is derived, so it is re-derived: a stored number a command did not compute
  // (a database write, a bug) must not go live. Update recomputes it, which is the fix a person gets.
  const reach = await estimateReach(tx, { workspaceId: artifact.workspaceId, siteId: row.siteId, urls: pagesOf(resolution.items) });
  if (JSON.stringify(reach) !== JSON.stringify(parsed.data.expectedImpact.trafficAtStake))
    return [
      'The traffic at stake no longer matches what this recommendation’s evidence pages yield now. Update it with recommendations.update, which recomputes the estimate, then publish it.',
    ];
  const dependencies = await dependencyProblems(tx, {
    workspaceId: artifact.workspaceId,
    siteId: row.siteId,
    recommendationId: artifact.id,
    dependsOn: parsed.data.dependsOn,
  });
  if (dependencies.length)
    return [`The dependencies no longer resolve: ${dependencies.join(' ')} Update the recommendation, then publish it.`];
  return [];
});

export * from './commands';
export * from './dependencies';
export * from './enqueue';
export * from './evidence';
export * from './facts';
export * from './model';
export * from './runner';
export * from './specialists';
export * from './status';
export * from './validation';
