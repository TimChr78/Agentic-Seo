import { artifactTypes, publishValidators } from '@agentic-seo/artifacts';
import { schema } from '@agentic-seo/db';
import { and, eq } from 'drizzle-orm';
import { problemsText, resolveEvidence } from './evidence';

// Recommendations: the artifact content schema lives in packages/artifacts (the type's prefix is
// reserved there), the work lives here.
//
// Publishing a recommendation is possible only while its evidence still resolves for the site: an
// audit can be deleted with its crawl, and a finding disappears with it, so a recommendation that
// was true when it was drafted can name an id nobody can check any more. A person may still draft
// one (the validator runs on publish, not on save), but it cannot go live on evidence that is gone.

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
  return [];
});

export * from './commands';
export * from './enqueue';
export * from './evidence';
export * from './facts';
export * from './model';
export * from './runner';
export * from './specialists';
export * from './status';
export * from './validation';
