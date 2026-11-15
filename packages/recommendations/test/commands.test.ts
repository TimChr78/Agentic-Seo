import { randomUUID } from 'node:crypto';
import { type AnyCommand, userPrincipal } from '@agentic-seo/commands';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { hasTestDatabase } from '../../db/test/disposable';
import {
  createRecommendation,
  getRecommendation,
  listRecommendations,
  prioritiseRecommendations,
  recommendationDependencies,
  updateRecommendation,
} from '../src/commands';
import {
  addSite,
  createRecommendationTestContext,
  type RecommendationTestContext,
  seedAudit,
  seedChangeSet,
  seedFinding,
  seedIssue,
  seedSearchConsole,
} from './support';

// The recommendation commands at their public entry point (the command, through the executor):
// evidence is resolved against the site, the traffic at stake is computed and never supplied,
// dependencies are a checked graph, and the status is derived from what actually happened to the
// artifact and its change sets.

describe.skipIf(!hasTestDatabase())('recommendation commands', () => {
  let ctx: RecommendationTestContext;
  let ws = '';
  let siteId = '';
  let auditId = '';
  let issueId = '';

  const draft = (overrides: Record<string, unknown> = {}) => ({
    title: 'Rewrite the titles of 12 pages',
    rationale: 'The 12 pages this issue affects have no title, so the search snippet shows the URL.',
    evidence: [{ kind: 'issue', id: issueId, note: 'Titles are missing on 12 pages' }],
    hypothesis: 'A specific title wins more clicks at the same position.',
    expectedImpact: { summary: 'Expected: more clicks on the 12 pages', confidence: 'medium' },
    effort: 'small',
    verificationPlan: { recheck: 'Re-fetch the 12 pages: each has a non-empty title', when: '7 days after the deploy' },
    falsificationCheck: 'We will know this failed if clicks do not move within 28 days.',
    leadingIndicator: 'Clicks on the 12 pages, daily',
    ...overrides,
  });

  const owner = () => userPrincipal('user_owner', ws, 'owner');
  const call = <C extends AnyCommand>(command: C, input: unknown, principal = owner()): Promise<z.output<C['output']>> =>
    ctx.executor.execute(command, input, principal, { surface: 'rest' });
  const create = (overrides: Record<string, unknown> = {}, principal = owner()) =>
    call(createRecommendation, { siteId, ...draft(overrides) }, principal);

  beforeAll(async () => {
    ctx = await createRecommendationTestContext('recommendation_commands');
    ws = ctx.disposable.workspace;
    siteId = await addSite(ctx.db, ws, 'example.com');
    auditId = await seedAudit(ctx.db, ws, siteId, { score: 74, pagesCrawled: 40 });
    issueId = await seedIssue(ctx.db, ws, siteId, auditId, { urls: ['https://example.com/pricing/'] });
    await seedSearchConsole(ctx.db, ws, siteId, [
      { url: 'https://example.com/pricing/', clicks: 120, impressions: 1_200, daysAgo: 1 },
      { url: 'https://example.com/pricing/', clicks: 30, impressions: 300, daysAgo: 3 },
    ]);
  }, 120_000);

  afterAll(async () => {
    await ctx?.db.close();
    await ctx?.disposable.close();
  });

  it('computes the traffic at stake from the evidence pages and ignores a supplied one', async () => {
    const created = await create({
      evidence: [{ kind: 'issue', id: issueId, note: 'Titles are missing on 12 pages' }],
      // A caller cannot supply the number: the input has no field for it, so it is stripped.
      expectedImpact: {
        summary: 'Expected: more clicks on the 12 pages',
        confidence: 'medium',
        trafficAtStake: { kind: 'known', clicksAtRisk: 999_999, affectedUrls: 1, criticalPages: [] },
      },
    });
    expect(created).toMatchObject({ version: 1, state: 'draft', status: 'proposed' });
    expect(created.trafficAtStake).toMatchObject({ kind: 'known', affectedUrls: 1, clicksAtRisk: 150, impressionsAtRisk: 1_500 });

    const stored = await call(getRecommendation, { recommendationId: created.recommendationId });
    expect((stored.content as { expectedImpact: { trafficAtStake: unknown } }).expectedImpact.trafficAtStake).toMatchObject({
      kind: 'known',
      clicksAtRisk: 150,
    });
    expect(stored.status).toBe('proposed');
    expect(stored.evidence[0]).toMatchObject({ kind: 'issue', issue: { severity: 'high', affectedPages: 12, fixChange: 'meta.title' } });
  });

  it('refuses an evidence id that does not exist, one from another site, and one from another workspace', async () => {
    const otherSite = await addSite(ctx.db, ws, 'other.example');
    const otherAudit = await seedAudit(ctx.db, ws, otherSite);
    const foreignIssue = await seedIssue(ctx.db, ws, otherSite, otherAudit);

    const elsewhere = randomUUID();
    await ctx.db.admin.query('INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, $2, $3)', [elsewhere, 'Elsewhere', 'none']);
    const elsewhereSite = await addSite(ctx.db, elsewhere, 'elsewhere.example');
    const elsewhereAudit = await seedAudit(ctx.db, elsewhere, elsewhereSite);
    const elsewhereIssue = await seedIssue(ctx.db, elsewhere, elsewhereSite, elsewhereAudit);

    for (const testCase of [
      { label: 'unknown', id: `iss_${'f'.repeat(32)}` },
      { label: 'another site', id: foreignIssue },
      { label: 'another workspace', id: elsewhereIssue },
    ]) {
      const error = await create({ evidence: [{ kind: 'issue', id: testCase.id, note: 'Evidence' }] }).then(
        () => null,
        (err: Error) => err,
      );
      expect({ label: testCase.label, message: error?.message ?? '' }).toMatchObject({
        label: testCase.label,
        message: expect.stringContaining('not valid for this site'),
      });
    }
  });

  it('accepts a finding and Search Console page data as evidence, and refuses a page with no data', async () => {
    const findingId = await seedFinding(ctx.db, ws, siteId, auditId, { issueId });
    const created = await create({
      evidence: [
        { kind: 'finding', id: findingId, note: 'The finding itself' },
        { kind: 'search_fact', id: 'https://example.com/pricing/', note: 'Clicks over 28 days' },
      ],
    });
    const detail = await call(getRecommendation, { recommendationId: created.recommendationId });
    expect(detail.evidence.map((item) => item.kind)).toEqual(['finding', 'search_fact']);
    expect(detail.evidence[1]?.searchFact).toMatchObject({ clicks: 150, impressions: 1_500 });

    const error = await create({ evidence: [{ kind: 'search_fact', id: 'https://example.com/never', note: 'x' }] }).then(
      () => null,
      (err: Error) => err,
    );
    expect(error?.message).toContain('has no Search Console data');
  });

  it('refuses an unknown dependency and a dependency cycle', async () => {
    const first = await create({ title: 'First' });
    const second = await create({ title: 'Second', dependsOn: [first.recommendationId] });

    const unknown = await create({ title: 'Third', dependsOn: [`rcm_${'a'.repeat(32)}`] }).then(
      () => null,
      (err: Error) => err,
    );
    expect(unknown?.message).toContain('is not a recommendation on this site');

    const cycle = await call(updateRecommendation, {
      recommendationId: second.recommendationId,
      ...draft({ title: 'Second', dependsOn: [second.recommendationId] }),
    }).then(
      () => null,
      (err: Error) => err,
    );
    expect(cycle?.message).toContain('cycle');

    const graph = await call(recommendationDependencies, { recommendationId: second.recommendationId });
    expect(graph.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([second.recommendationId, first.recommendationId]));
    expect(graph.cycle).toBeNull();
  });

  it('derives the status from publication and the change sets that name it', async () => {
    const created = await create({ title: 'Status case' });
    expect((await call(getRecommendation, { recommendationId: created.recommendationId })).status).toBe('proposed');

    // Publishing runs the same checks as artifacts.requestPublish; the state is what status reads.
    await ctx.db.admin.query(
      `UPDATE artifact_versions SET state = 'published' WHERE workspace_id = $1 AND artifact_id = $2 AND number = 1`,
      [ws, created.recommendationId],
    );
    await ctx.db.admin.query('UPDATE artifacts SET published_version = 1 WHERE workspace_id = $1 AND id = $2', [
      ws,
      created.recommendationId,
    ]);
    expect((await call(getRecommendation, { recommendationId: created.recommendationId })).status).toBe('accepted');

    const changeSetId = await seedChangeSet(ctx.db, ws, siteId, created.recommendationId, 'pr_open');
    const implemented = await call(getRecommendation, { recommendationId: created.recommendationId });
    expect(implemented.status).toBe('implemented');
    expect(implemented.changeSets).toMatchObject([{ id: changeSetId, state: 'pr_open' }]);

    const listed = await call(listRecommendations, { siteId, status: 'implemented', limit: 50 });
    expect(listed.recommendations.map((item) => item.id)).toContain(created.recommendationId);

    await ctx.db.admin.query(
      `UPDATE artifact_versions SET state = 'rejected' WHERE workspace_id = $1 AND artifact_id = $2 AND number = 1`,
      [ws, created.recommendationId],
    );
    expect((await call(getRecommendation, { recommendationId: created.recommendationId })).status).toBe('rejected');
  });

  it('filters by author and by the issue the recommendation addresses, and pages with a cursor', async () => {
    const authored = await create({ title: 'Filterable one' });
    const byIssue = await call(listRecommendations, { siteId, issueId, limit: 50 });
    expect(byIssue.recommendations.map((item) => item.id)).toContain(authored.recommendationId);

    const people = await call(listRecommendations, { siteId, author: 'person', limit: 50 });
    expect(people.recommendations.map((item) => item.id)).toContain(authored.recommendationId);
    const specialists = await call(listRecommendations, { siteId, author: 'specialist', limit: 50 });
    expect(specialists.recommendations).toEqual([]);

    const firstPage = await call(listRecommendations, { siteId, limit: 1 });
    expect(firstPage.recommendations).toHaveLength(1);
    expect(firstPage.total).toBeGreaterThan(1);
    expect(firstPage.nextCursor).toBeTypeOf('string');
    const secondPage = await call(listRecommendations, { siteId, limit: 1, cursor: firstPage.nextCursor as string });
    expect(secondPage.recommendations[0]?.id).not.toBe(firstPage.recommendations[0]?.id);
  });

  it('writes a new draft version when the latest one is published, and keeps the author', async () => {
    const created = await create({ title: 'Versioned' });
    await ctx.db.admin.query(
      `UPDATE artifact_versions SET state = 'published' WHERE workspace_id = $1 AND artifact_id = $2 AND number = 1`,
      [ws, created.recommendationId],
    );
    await ctx.db.admin.query('UPDATE artifacts SET published_version = 1 WHERE workspace_id = $1 AND id = $2', [
      ws,
      created.recommendationId,
    ]);
    const updated = await call(updateRecommendation, {
      recommendationId: created.recommendationId,
      ...draft({ title: 'Versioned, tightened' }),
    });
    expect(updated).toMatchObject({ version: 2, state: 'draft' });
    const detail = await call(getRecommendation, { recommendationId: created.recommendationId });
    expect(detail.publishedVersion).toBe(1);
    expect(detail.latestVersion).toBe(2);
    expect((detail.content as { author: { kind: string } }).author.kind).toBe('person');
  });

  it('orders by a person’s priority', async () => {
    const site = await addSite(ctx.db, ws, 'ordered.example');
    const audit = await seedAudit(ctx.db, ws, site);
    const issue = await seedIssue(ctx.db, ws, site, audit, { urls: ['https://ordered.example/a/'] });
    const evidence = [{ kind: 'issue', id: issue, note: 'n' }];
    const one = await call(createRecommendation, { siteId: site, ...draft({ title: 'One', evidence }) });
    const two = await call(createRecommendation, { siteId: site, ...draft({ title: 'Two', evidence }) });

    await call(prioritiseRecommendations, { siteId: site, order: [two.recommendationId, one.recommendationId] });
    const listed = await call(listRecommendations, { siteId: site, limit: 10 });
    expect(listed.recommendations.map((item) => item.id)).toEqual([two.recommendationId, one.recommendationId]);
    expect(listed.recommendations[0]?.priority).toBe(0);
  });

  it('refuses a viewer the write', async () => {
    const viewer = userPrincipal('user_viewer', ws, 'viewer');
    const error = await create({ title: 'Viewer' }, viewer).then(
      () => null,
      (err: Error) => err,
    );
    expect(error?.message).toMatch(/artifacts:write|permission/i);
  });
});
