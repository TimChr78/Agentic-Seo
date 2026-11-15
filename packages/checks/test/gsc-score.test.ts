import { randomUUID } from 'node:crypto';
import { userPrincipal } from '@agentic-seo/commands';
import { normalizePageUrl } from '@agentic-seo/search-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDatabase } from '../../db/test/disposable';
import { auditIssues, auditScore } from '../src';
import { type AuditTestContext, addSite, createAuditTestContext, goodPage, scoreRow, seedAudit } from './support';

// The score's Search Console weighting (crawler-and-audits.md §6): with page aggregates, a page's
// share is weighted by its clicks over the last 28 days, so an issue on a low-traffic page costs
// less than the same issue on a page that earns the traffic. Without a connection the score is
// unweighted and says so.

const url = (path: string): string => `https://example.com${path}`;

describe.skipIf(!hasTestDatabase())('GSC-weighted score', () => {
  let ctx: AuditTestContext;
  let ws = '';
  let siteId = '';

  beforeAll(async () => {
    ctx = await createAuditTestContext('checks_gsc_score');
    ws = ctx.disposable.workspace;
    siteId = await addSite(ctx.db, ws);
  }, 120_000);

  afterAll(async () => {
    ctx?.dispose();
    await ctx?.disposable.close();
  });

  it('lowers the penalty of an issue on a page with little traffic, and reports the clicks', async () => {
    const pages = [
      goodPage(url('/low'), {
        inSitemap: true,
        html: { title: null, metaDescription: 'Low traffic page.', contentHash: 'b'.repeat(64), wordCount: 200 },
      }),
      goodPage(url('/high'), {
        inSitemap: false,
        html: { title: 'High traffic page', metaDescription: 'High traffic page.', contentHash: 'c'.repeat(64), wordCount: 300 },
      }),
    ];
    const edges = [{ from: url('/high'), to: url('/low') }];
    const unweighted = await seedAudit(ctx.db, ws, siteId, { pages, edges });
    const before = await scoreRow(ctx.db, ws, unweighted);
    expect(before?.gsc_weighted).toBe(false);

    await ctx.db.admin.query(
      `INSERT INTO connections (workspace_id, id, site_id, connector, label, settings, state)
       VALUES ($1, $2, $3, 'google-search-console', 'Search Console', '{"property":"sc-domain:example.com"}'::jsonb, 'active')`,
      [ws, `con_${randomUUID().replaceAll('-', '')}`, siteId],
    );
    for (const [path, clicks] of [
      ['/low', 5],
      ['/high', 500],
    ] as const) {
      const page = url(path);
      await ctx.db.admin.query(
        `INSERT INTO gsc_page_aggregates
           (workspace_id, site_id, property, date, page, page_key, clicks, impressions, ctr, position)
         VALUES ($1, $2, 'sc-domain:example.com', CURRENT_DATE, $3, $4, $5, $6, 0.1, 3)`,
        [ws, siteId, page, normalizePageUrl(page), clicks, clicks * 10],
      );
    }

    const weighted = await seedAudit(ctx.db, ws, siteId, { pages, edges });
    const after = await scoreRow(ctx.db, ws, weighted);
    expect(after?.gsc_weighted).toBe(true);
    expect(Number(after?.score)).toBeGreaterThan(Number(before?.score));

    const principal = userPrincipal('user_owner', ws, 'owner');
    const score = await ctx.executor.execute(auditScore, { siteId, auditId: weighted }, principal, { surface: 'rest' });
    expect(score.gscWeighted).toBe(true);
    const issues = await ctx.executor.execute(auditIssues, { siteId, checkId: 'title.missing' }, principal, { surface: 'rest' });
    expect(issues.hasGsc).toBe(true);
    expect(issues.issues.find((issue) => issue.subject === url('/low'))?.clicks28d).toBe(5);
  });
});
