import { artifactTypes, publishValidators } from '@agentic-seo/artifacts';
import { schema } from '@agentic-seo/db';
import { and, eq } from 'drizzle-orm';
import { dependencyProblems } from './dependencies';
import { problemsText, resolveEvidence } from './evidence';

// Recommendations: the artifact content schema lives in packages/artifacts (the type's prefix is
// reserved there, and only recommendations.create/update may write the content — it is
// `serverOwned` there), the work lives here.
//
// Publishing a recommendation is possible only while its evidence still resolves for the site and
// its stored traffic at stake is a well-formed estimate that says when it was computed: an audit can
// be deleted with its crawl, and a finding disappears with it, so a recommendation that was true
// when it was drafted can name an id nobody can check any more. The dependencies are re-read too,
// so a graph that lost a node cannot go live. A person may still draft one (the validator runs on
// publish, not on save), but it cannot go live on evidence that is gone.
//
// The estimate is deliberately not recomputed and compared. `recommendation` is serverOwned, so the
// only writers are recommendations.create/update, which compute it; and Search Console data moves
// every day, so refusing a publish because the same evidence pages now add up differently would
// refuse an unchanged, honest recommendation for a reason nobody can fix. `recommendations.get`
// returns the computation date so a reviewer sees how fresh the number is.

publishValidators.set('recommendation', async (content, tx, artifact) => {
  const parsed = artifactTypes.recommendation.content.safeParse(content);
  if (!parsed.success)
    return [
      'The recommendation content is not well formed: update it with recommendations.update, which validates the evidence and recomputes the traffic at stake.',
    ];
  if (!artifact) return [];
  const [row] = await tx
    .select({ siteId: schema.artifacts.siteId })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.workspaceId, artifact.workspaceId), eq(schema.artifacts.id, artifact.id)));
  if (!row?.siteId)
    return [
      'A recommendation must belong to a site. Create it with recommendations.create, which checks its evidence and computes the traffic at stake for that site.',
    ];
  const reach = parsed.data.expectedImpact.trafficAtStake;
  // The schema requires the date; this catches a value that parses but has no usable instant, and
  // names the field the person can fix by updating the recommendation.
  if (Number.isNaN(Date.parse(reach.computedAt)))
    return [
      'The traffic at stake carries no readable computation date, so nobody can tell how fresh it is. Update the recommendation with recommendations.update, then publish it.',
    ];
  const resolution = await resolveEvidence(tx, { workspaceId: artifact.workspaceId, siteId: row.siteId, items: parsed.data.evidence });
  if (!resolution.ok)
    return [
      `The evidence no longer resolves for this site: ${problemsText(resolution.problems)}. Update the recommendation, then publish it.`,
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
