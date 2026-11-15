import { randomBytes } from 'node:crypto';
import { type AnyCommand, userPrincipal } from '@agentic-seo/commands';
import { estimateReach, normalizePageUrl } from '@agentic-seo/search-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { hasTestDatabase } from '../../db/test/disposable';
import { createRecommendation, getRecommendation } from '../src/commands';
import { gatherFacts } from '../src/facts';
import { addSite, createRecommendationTestContext, type RecommendationTestContext, seedAudit, seedIssue } from './support';

// Which Search Console numbers a recommendation may state. A site can carry several properties over
// its life (a URL-prefix property, then a domain property, or a property kept after a migration), and
// `gsc_page_aggregates` keeps every one of them. Reach already reads only the live connection's
// selected property; evidence and the facts payload must read the same rows, and only the web search
// type Phase 1 syncs, or two histories are added together and the recommendation states a number no
// single property ever had.

const PAGE = 'https://example.com/pricing/';
const ACTIVE = 'sc-domain:example.com';
const HISTORICAL = 'https://example.com/';

describe.skipIf(!hasTestDatabase())('Search Console property scope in recommendation evidence', () => {
  let ctx: RecommendationTestContext;
  let ws = '';
  let siteId = '';
  let auditId = '';
  let issueId = '';

  const owner = () => userPrincipal('user_owner', ws, 'owner');
  const call = <C extends AnyCommand>(command: C, input: unknown): Promise<z.output<C['output']>> =>
    ctx.executor.execute(command, input, owner(), { surface: 'rest' });

  /** A page row as the sync writes it: the URL, its normalised key, property and search type. */
  async function page(property: string, clicks: number, searchType = 'web') {
    await ctx.db.admin.query(
      `INSERT INTO gsc_page_aggregates
         (workspace_id, site_id, property, date, search_type, page, page_key, country, device, clicks, impressions, ctr, position, is_final)
       VALUES ($1, $2, $3, current_date, $4, $5, $6, '', '', $7, $8, 0.1, 3, true)`,
      [ws, siteId, property, searchType, PAGE, normalizePageUrl(PAGE), clicks, clicks * 10],
    );
  }

  beforeAll(async () => {
    ctx = await createRecommendationTestContext('recommendation_gsc_scope');
    ws = ctx.disposable.workspace;
    siteId = await addSite(ctx.db, ws, 'example.com');
    auditId = await seedAudit(ctx.db, ws, siteId, { score: 74, pagesCrawled: 40 });
    issueId = await seedIssue(ctx.db, ws, siteId, auditId, { urls: [PAGE] });
    // The live connection selects the domain property; the URL-prefix property is the history beside
    // it, and the image rows are a search type Phase 1 does not use.
    await ctx.db.admin.query(
      `INSERT INTO connections (workspace_id, id, site_id, connector, label, settings, state)
       VALUES ($1, $2, $3, 'google-search-console', 'Search Console', $4::jsonb, 'active')`,
      [ws, `con_${randomBytes(16).toString('hex')}`, siteId, JSON.stringify({ property: ACTIVE })],
    );
    await page(ACTIVE, 100);
    await page(HISTORICAL, 100);
    await page(ACTIVE, 50, 'image');
  });

  afterAll(async () => {
    await ctx?.db.close();
    await ctx?.disposable.close();
  });

  it('sums a page’s clicks from the selected property only, matching estimateReach', async () => {
    const created = await call(createRecommendation, {
      siteId,
      title: 'Rewrite the pricing page title',
      rationale: 'The pricing page title is generic, so the snippet does not say what the page costs.',
      evidence: [{ kind: 'search_fact', id: PAGE, note: 'Clicks over 28 days' }],
      hypothesis: 'A specific title wins more clicks at the same position.',
      expectedImpact: { summary: 'More clicks on the pricing page', confidence: 'medium' },
      effort: 'small',
      verificationPlan: { recheck: 'Re-fetch the page: the title names the pricing', when: '7 days after the deploy' },
      falsificationCheck: 'We will know this failed if clicks do not move within 28 days.',
      leadingIndicator: 'Clicks on the pricing page, daily',
    });

    const detail = await call(getRecommendation, { recommendationId: created.recommendationId });
    expect(detail.evidence[0]?.searchFact).toMatchObject({ url: PAGE, clicks: 100, impressions: 1_000 });

    // The same number reach reports for the page, so the evidence and the traffic at stake agree.
    const reach = await ctx.db.withWorkspace(ws, (tx) => estimateReach(tx, { workspaceId: ws, siteId, urls: [PAGE], now: new Date() }));
    expect(reach).toMatchObject({ kind: 'known', clicksAtRisk: 100 });
  });

  it('gives the facts payload the same property-scoped clicks', async () => {
    const facts = await ctx.db.withWorkspace(ws, (tx) => gatherFacts(tx, { workspaceId: ws, siteId, maxRecommendations: 10 }));
    expect(facts.searchConsole).toMatchObject({ connected: true });
    expect(facts.issues.find((issue) => issue.id === issueId)?.clicks28d).toBe(100);
  });
});
