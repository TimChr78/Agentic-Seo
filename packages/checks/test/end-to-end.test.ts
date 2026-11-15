import { userPrincipal } from '@agentic-seo/commands';
import { runAudit } from '@agentic-seo/crawl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FixtureSite, startFixture } from '../../crawl/test/fixture';
import { hasTestDatabase } from '../../db/test/disposable';
import { auditFindings, auditIssue, auditIssues, auditScore } from '../src';
import { clearFixture, drainAudit, limiterFor, useFixture } from './crawl-fixture';
import { type AuditTestContext, addSite, createAuditTestContext, scoreRow } from './support';

// End to end: crawl the crawl package's local "bad SEO" fixture site, let the page hooks write
// findings and the finalize hook run the site and cross-page checks, and assert the issues and the
// score the commands return. No test reaches the public internet: the fixture runs on 127.0.0.1
// with the crawler's test seams.

describe.skipIf(!hasTestDatabase())('a crawl end to end', () => {
  let ctx: AuditTestContext;
  let fixture: FixtureSite;
  let ws = '';
  let siteId = '';

  beforeAll(async () => {
    fixture = await startFixture();
    ctx = await createAuditTestContext('checks_e2e');
    ws = ctx.disposable.workspace;
    useFixture(fixture);
    siteId = await addSite(ctx.db, ws, 'fixture.test');
  }, 180_000);

  afterAll(async () => {
    clearFixture();
    ctx?.dispose();
    await fixture?.close();
    await ctx?.disposable.close();
  });

  it('finds issues across categories and computes a score for the fixture site', async () => {
    const principal = userPrincipal('user_owner', ws, 'owner');
    const { audit } = await ctx.executor.execute(runAudit, { siteId }, principal, { surface: 'rest' });
    await drainAudit(ctx.db, ws, audit.id, { limiter: limiterFor(ctx.db) });

    const { rows: auditRows } = await ctx.db.admin.query<{ state: string }>(
      'SELECT state FROM audits WHERE workspace_id = $1 AND id = $2',
      [ws, audit.id],
    );
    expect(auditRows[0]?.state).toBe('completed');

    const { rows: findings } = await ctx.db.admin.query<{ check_id: string; category: string }>(
      'SELECT DISTINCT check_id, category FROM findings WHERE workspace_id = $1 AND audit_id = $2',
      [ws, audit.id],
    );
    const checkIds = new Set(findings.map((row) => row.check_id));
    expect(checkIds.size).toBeGreaterThanOrEqual(15);
    expect(new Set(findings.map((row) => row.category)).size).toBeGreaterThanOrEqual(4);
    // Both the page checks and the cross-page SQL checks ran on real crawl data.
    for (const id of ['title.too_short', 'links.broken_internal', 'page.blocked_by_robots', 'status.client_error']) {
      expect([...checkIds], id).toContain(id);
    }

    const scored = await scoreRow(ctx.db, ws, audit.id);
    expect(scored?.score).not.toBeNull();
    const score = Number(scored?.score);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(scored?.pages_evaluated).toBeGreaterThan(5);
    // The fixture's robots.txt disallows /private, so the crawler marks the graph truncated and the
    // graph checks are suppressed; the score records that rather than pretending they passed.
    expect(scored?.skipped_checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ checkId: 'crawl.orphan_page', reason: expect.stringContaining('truncated') })]),
    );

    const scoreView = await ctx.executor.execute(auditScore, { siteId, auditId: audit.id }, principal, { surface: 'rest' });
    expect(scoreView.categories).toHaveLength(8);
    expect(scoreView.notEvaluated.map((entry) => entry.category)).toContain('performance');

    const issues = await ctx.executor.execute(auditIssues, { siteId, limit: 200 }, principal, { surface: 'rest' });
    expect(issues.summary.open).toBeGreaterThan(0);
    expect(issues.issues.length).toBe(issues.summary.open);
    expect(issues.issues.every((issue) => issue.title !== issue.checkId)).toBe(true);
    expect(issues.issues.some((issue) => issue.category === 'crawlability' && issue.checkId === 'page.blocked_by_robots')).toBe(true);

    const one = issues.issues[0];
    expect(one).toBeDefined();
    const detail = await ctx.executor.execute(auditIssue, { issueId: one!.id }, principal, { surface: 'rest' });
    expect(detail.history.length).toBeGreaterThan(0);
    expect(detail.issue.evidence.length).toBeGreaterThan(0);

    const auditFindingsView = await ctx.executor.execute(auditFindings, { auditId: audit.id, limit: 200 }, principal, { surface: 'rest' });
    expect(auditFindingsView.findings.length).toBeGreaterThan(0);
  }, 120_000);
});
