import { randomUUID } from 'node:crypto';
import { normalizePageUrl } from '@agentic-seo/search-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDatabase } from '../../db/test/disposable';
import { type AuditTestContext, addSite, createAuditTestContext, goodPage, issueRows, scoreRow, seedAudit } from './support';

// Review round 3 on PR #21, one public-entry-point test per finding.

describe.skipIf(!hasTestDatabase())('review round 3', () => {
  let ctx: AuditTestContext;
  let ws = '';

  beforeAll(async () => {
    ctx = await createAuditTestContext('checks_review3');
    ws = ctx.disposable.workspace;
  }, 180_000);

  afterAll(async () => {
    ctx?.dispose();
    await ctx?.disposable.close();
  });

  it('finalizes when two stored GSC page keys collapse to one page', async () => {
    const siteId = await addSite(ctx.db, ws, 'gsc-collide.example');
    await ctx.db.admin.query(
      `INSERT INTO connections (workspace_id, id, site_id, connector, label, settings, state)
       VALUES ($1, $2, $3, 'google-search-console', 'Search Console', '{"property":"sc-domain:gsc-collide.example"}'::jsonb, 'active')`,
      [ws, `con_${randomUUID().replaceAll('-', '')}`, siteId],
    );
    for (const page of ['https://gsc-collide.example/a', 'https://gsc-collide.example/a//']) {
      await ctx.db.admin.query(
        `INSERT INTO gsc_page_aggregates
           (workspace_id, site_id, property, date, page, page_key, clicks, impressions, ctr, position)
         VALUES ($1, $2, 'sc-domain:gsc-collide.example', CURRENT_DATE, $3, $4, 10, 100, 0.1, 3)`,
        [ws, siteId, page, normalizePageUrl(page)],
      );
    }
    const audit = await seedAudit(ctx.db, ws, siteId, { pages: [goodPage('https://gsc-collide.example/a', { inSitemap: false })] });
    const score = await scoreRow(ctx.db, ws, audit);
    expect(score?.gsc_weighted).toBe(true);
    expect(Number(score?.score)).toBe(100);
  });

  it('counts a failure this audit proved as judged, on a first audit too', async () => {
    const siteId = await addSite(ctx.db, ws, 'first-fail.example');
    const audit = await seedAudit(ctx.db, ws, siteId, {
      pages: [goodPage('https://first-fail.example/a', { inSitemap: false, html: { title: null, titleCount: 0 } })],
    });
    const issues = (await issueRows(ctx.db, ws, siteId)) as unknown as { check_id: string; state: string }[];
    expect(issues.find((issue) => issue.check_id === 'title.missing')?.state).toBe('open');
    const score = await scoreRow(ctx.db, ws, audit);
    expect(Number(score?.score)).toBeLessThan(100);
    expect(Number(score?.unchecked_issues)).toBe(0);
  });

  it('reports unchecked coverage when an audit evaluated no pages', async () => {
    const siteId = await addSite(ctx.db, ws, 'zero-pages.example');
    await seedAudit(ctx.db, ws, siteId, {
      pages: [goodPage('https://zero-pages.example/a', { inSitemap: false, html: { title: null, titleCount: 0 } })],
    });
    const empty = await seedAudit(ctx.db, ws, siteId, { pages: [] });
    const score = await scoreRow(ctx.db, ws, empty);
    expect(score?.score).toBeNull();
    expect(Number(score?.unchecked_issues)).toBeGreaterThan(0);
  });
});
