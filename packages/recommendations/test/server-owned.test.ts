import { randomBytes } from 'node:crypto';
// The package entry registers the recommendation publish validator; `requestPublish` reads it.
import '../src/index';
import { createArtifact, importConfig, requestPublish, updateDraft } from '@agentic-seo/artifacts';
import { type AnyCommand, type Principal, userPrincipal } from '@agentic-seo/commands';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { hasTestDatabase } from '../../db/test/disposable';
import { createRecommendation, getRecommendation } from '../src/commands';
import { addSite, createRecommendationTestContext, type RecommendationTestContext, seedAudit, seedIssue } from './support';

// The recommendation content carries a computed field (the traffic at stake) and evidence that only
// resolves inside this workspace and site. The generic artifact commands would let a caller write a
// number nobody computed, so the type is server-owned: artifacts.create, artifacts.updateDraft and
// config.import refuse it, and only recommendations.create/update write it. As defence in depth the
// publish validator re-checks the evidence, the reach and the dependency graph of the stored content.
//
// Finding (review round 1): "P1 Generic artifact writes publish invented traffic estimates."

describe.skipIf(!hasTestDatabase())('the recommendation artifact is server-owned', () => {
  let ctx: RecommendationTestContext;
  let ws = '';
  let siteId = '';
  let auditId = '';
  let issueId = '';

  const owner = (): Principal => userPrincipal('user_owner', ws, 'owner');
  const call = <C extends AnyCommand>(command: C, input: unknown, principal = owner()): Promise<z.output<C['output']>> =>
    ctx.executor.execute(command, input, principal, { surface: 'rest' });

  const body = (overrides: Record<string, unknown> = {}) => ({
    siteId,
    title: 'Add titles to the 12 pages that have none',
    rationale: 'The 12 pages this issue affects have no title, out of the 40 the audit evaluated.',
    evidence: [{ kind: 'issue', id: issueId, note: 'Titles are missing on 12 pages' }],
    hypothesis: 'A specific title wins more clicks at the same position.',
    expectedImpact: { summary: 'Expected: more clicks on the 12 pages', confidence: 'medium' },
    effort: 'small',
    verificationPlan: { recheck: 'Re-fetch the 12 pages: each has a non-empty title', when: '7 days after the deploy' },
    falsificationCheck: 'We will know this failed if clicks do not move within 28 days.',
    leadingIndicator: 'Clicks on the 12 pages, daily',
    proposedChanges: [{ type: 'meta.title', url: 'https://example.com/pricing/', summary: 'Write a title' }],
    ...overrides,
  });

  const create = async (overrides: Record<string, unknown> = {}) => call(createRecommendation, body(overrides));

  beforeAll(async () => {
    ctx = await createRecommendationTestContext('recommendation_server_owned');
    ws = ctx.disposable.workspace;
    siteId = await addSite(ctx.db, ws, 'example.com');
    auditId = await seedAudit(ctx.db, ws, siteId, { score: 74, pagesCrawled: 40 });
    issueId = await seedIssue(ctx.db, ws, siteId, auditId, { urls: ['https://example.com/pricing/'] });
  }, 120_000);

  afterAll(async () => {
    await ctx?.db.close();
    await ctx?.disposable.close();
  });

  it('refuses artifacts.create, artifacts.updateDraft and config.import for a recommendation', async () => {
    const rcmId = `rcm_${randomBytes(16).toString('hex')}`;
    await expect(
      call(createArtifact, {
        type: 'recommendation',
        name: 'Forged recommendation',
        siteId,
        content: {
          title: 'Forged',
          expectedImpact: { trafficAtStake: { kind: 'known', affectedUrls: 1, clicksAtRisk: 999_999, criticalPages: [] } },
        },
      }),
    ).rejects.toThrow(/recommendations\.create/);

    const created = await create();
    const stored = await call(getRecommendation, { recommendationId: created.recommendationId });
    await expect(call(updateDraft, { artifactId: created.recommendationId, content: stored.content })).rejects.toThrow(
      /recommendations\.create/,
    );

    await expect(
      call(importConfig, {
        dryRun: false,
        bundle: {
          format: 'agentic-seo/artifacts@1',
          artifacts: [{ id: rcmId, type: 'recommendation', name: 'Imported recommendation', siteId, content: {} }],
        },
      }),
    ).rejects.toThrow(/recommendations\.create/);

    // The doors a caller should use still work, and are what computed the reach.
    expect(created.trafficAtStake.kind).toBe('unknown');
  }, 60_000);

  it('publishes while the evidence resolves, and refuses once it is gone', async () => {
    const good = await create({ title: 'Publishable recommendation' });
    await expect(call(requestPublish, { artifactId: good.recommendationId, note: 'Ready.' })).resolves.toMatchObject({
      status: 'published',
    });

    const orphan = await create({ title: 'Recommendation with evidence that will vanish' });
    const gone = await seedIssue(ctx.db, ws, siteId, auditId, { urls: ['https://example.com/orphan/'] });
    const orphan2 = await create({
      title: 'Recommendation on a deleted issue',
      evidence: [{ kind: 'issue', id: gone, note: 'Titles are missing here too' }],
    });
    await ctx.db.admin.query('DELETE FROM issues WHERE workspace_id = $1 AND id = $2', [ws, gone]);

    await expect(call(requestPublish, { artifactId: orphan2.recommendationId, note: 'Ready.' })).rejects.toThrow(
      /evidence no longer resolves/,
    );
    // The untouched one still publishes: the validator refuses the broken item, not the type.
    await expect(call(requestPublish, { artifactId: orphan.recommendationId, note: 'Ready.' })).resolves.toMatchObject({
      status: 'published',
    });
  }, 60_000);

  it('refuses a stored recommendation whose traffic at stake no longer matches its evidence pages', async () => {
    const created = await create({ title: 'Recommendation with an invented estimate' });
    const [row] = await ctx.db.admin
      .query<{ content: { expectedImpact: { trafficAtStake: unknown } } }>(
        'SELECT content FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2 AND number = 1',
        [ws, created.recommendationId],
      )
      .then((result) => result.rows);
    const tampered = row?.content ?? { expectedImpact: { trafficAtStake: {} } };
    // A plausible but invented estimate: the validator re-derives it from the evidence pages.
    tampered.expectedImpact.trafficAtStake = { kind: 'known', affectedUrls: 1, clicksAtRisk: 999_999, criticalPages: [] };
    await ctx.db.admin.query(
      'UPDATE artifact_versions SET content = $3::jsonb WHERE workspace_id = $1 AND artifact_id = $2 AND number = 1',
      [ws, created.recommendationId, JSON.stringify(tampered)],
    );
    await expect(call(requestPublish, { artifactId: created.recommendationId, note: 'Ready.' })).rejects.toThrow(
      /traffic at stake no longer matches/,
    );
  }, 60_000);

  it('refuses a stored recommendation whose dependency no longer resolves', async () => {
    const dependency = await create({ title: 'The dependency' });
    const dependent = await create({ title: 'The dependent', dependsOn: [dependency.recommendationId] });
    const [row] = await ctx.db.admin
      .query<{ content: { dependsOn: string[] } }>(
        'SELECT content FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2 AND number = 1',
        [ws, dependent.recommendationId],
      )
      .then((result) => result.rows);
    const tampered = row?.content ?? { dependsOn: [] };
    tampered.dependsOn = [`rcm_${'f'.repeat(32)}`];
    await ctx.db.admin.query(
      'UPDATE artifact_versions SET content = $3::jsonb WHERE workspace_id = $1 AND artifact_id = $2 AND number = 1',
      [ws, dependent.recommendationId, JSON.stringify(tampered)],
    );
    await expect(call(requestPublish, { artifactId: dependent.recommendationId, note: 'Ready.' })).rejects.toThrow(
      /dependencies no longer resolve/,
    );
  }, 60_000);
});
