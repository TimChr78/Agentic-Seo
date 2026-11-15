import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDatabase } from '../../db/test/disposable';
import { type AuditTestContext, addSite, createAuditTestContext, findingsOf, goodPage, issueRows, scoreRow, seedAudit } from './support';

// The coverage-aware issue lifecycle (crawler-and-audits.md §2 "Coverage", brief task E item 3):
// open → resolved by an audit that evaluated the subject; "Not re-checked" when it did not;
// regression; ignore survives audits; a section audit resolves only what it saw; graph checks are
// suppressed on a truncated graph; no evaluated page means no score.

const url = (path: string): string => `https://example.com${path}`;

const missingTitle = (subject: string) => goodPage(subject, { html: { title: null } });

type IssueRow = {
  id: string;
  check_id: string;
  subject_key: string;
  state: string;
  regressed: number;
  last_seen_audit_id: string;
  last_checked_audit_id: string;
  resolved_audit_id: string | null;
  ignored_reason: string | null;
  last_regressed_at: Date | null;
};

async function issueOf(ctx: AuditTestContext, ws: string, siteId: string, checkId: string, subject: string) {
  const rows = (await issueRows(ctx.db, ws, siteId)) as unknown as IssueRow[];
  return rows.find((row) => row.check_id === checkId && row.subject_key === subject);
}

describe.skipIf(!hasTestDatabase())('issue lifecycle', () => {
  let ctx: AuditTestContext;
  let ws = '';
  let siteId = '';

  beforeAll(async () => {
    ctx = await createAuditTestContext('checks_lifecycle');
    ws = ctx.disposable.workspace;
    siteId = await addSite(ctx.db, ws);
  }, 120_000);

  afterAll(async () => {
    ctx?.dispose();
    await ctx?.disposable.close();
  });

  it('opens an issue, then resolves it with an audit that evaluated the page and passed', async () => {
    const subject = url('/resolve');
    const first = await seedAudit(ctx.db, ws, siteId, { pages: [missingTitle(subject)] });
    const opened = await issueOf(ctx, ws, siteId, 'title.missing', subject);
    expect(opened).toMatchObject({
      state: 'open',
      regressed: 0,
      last_seen_audit_id: first,
      last_checked_audit_id: first,
      resolved_audit_id: null,
    });

    const second = await seedAudit(ctx.db, ws, siteId, { pages: [goodPage(subject)] });
    const resolved = await issueOf(ctx, ws, siteId, 'title.missing', subject);
    expect(resolved).toMatchObject({
      state: 'resolved',
      last_checked_audit_id: second,
      resolved_audit_id: second,
      // It was not seen on the second audit; only the last check moved.
      last_seen_audit_id: first,
    });
  });

  it('leaves an issue open as “Not re-checked” when the page was not crawled', async () => {
    const subject = url('/not-crawled');
    const other = url('/other');
    const first = await seedAudit(ctx.db, ws, siteId, { pages: [missingTitle(subject)] });
    await seedAudit(ctx.db, ws, siteId, { pages: [goodPage(other)] });
    const issue = await issueOf(ctx, ws, siteId, 'title.missing', subject);
    expect(issue).toMatchObject({ state: 'open', last_seen_audit_id: first, last_checked_audit_id: first });
  });

  it('leaves an issue open as “Not re-checked” when robots.txt skipped the page', async () => {
    const subject = url('/robots');
    const other = url('/robots-other');
    const first = await seedAudit(ctx.db, ws, siteId, { pages: [missingTitle(subject)] });
    await seedAudit(ctx.db, ws, siteId, {
      pages: [goodPage(other)],
      frontier: [{ url: subject, state: 'skipped', skipReason: 'robots', discoveredBy: 'link', discoveredFrom: other }],
    });
    const issue = await issueOf(ctx, ws, siteId, 'title.missing', subject);
    expect(issue).toMatchObject({ state: 'open', last_checked_audit_id: first });
  });

  it('regresses a resolved issue when a later audit sees it fail again', async () => {
    const subject = url('/regress');
    await seedAudit(ctx.db, ws, siteId, { pages: [missingTitle(subject)] });
    await seedAudit(ctx.db, ws, siteId, { pages: [goodPage(subject)] });
    expect((await issueOf(ctx, ws, siteId, 'title.missing', subject))?.state).toBe('resolved');

    const third = await seedAudit(ctx.db, ws, siteId, { pages: [missingTitle(subject)] });
    const regressed = await issueOf(ctx, ws, siteId, 'title.missing', subject);
    expect(regressed).toMatchObject({
      state: 'open',
      regressed: 1,
      resolved_audit_id: null,
      last_seen_audit_id: third,
      last_checked_audit_id: third,
    });
    expect(regressed?.last_regressed_at).not.toBeNull();
  });

  it('keeps an ignored issue ignored and still records that it was seen', async () => {
    const subject = url('/ignored');
    await seedAudit(ctx.db, ws, siteId, { pages: [missingTitle(subject)] });
    const issue = await issueOf(ctx, ws, siteId, 'title.missing', subject);
    await ctx.db.admin.query(
      `UPDATE issues SET state = 'ignored', ignored_by = 'user_owner', ignored_reason = 'The staging host is noindex on purpose.', ignored_at = now()
       WHERE workspace_id = $1 AND id = $2`,
      [ws, issue?.id],
    );
    const second = await seedAudit(ctx.db, ws, siteId, { pages: [missingTitle(subject)] });
    const ignored = await issueOf(ctx, ws, siteId, 'title.missing', subject);
    expect(ignored).toMatchObject({
      state: 'ignored',
      ignored_reason: 'The staging host is noindex on purpose.',
      last_seen_audit_id: second,
      last_checked_audit_id: second,
    });
    // A passing audit does not resolve an ignored issue either.
    await seedAudit(ctx.db, ws, siteId, { pages: [goodPage(subject)] });
    expect((await issueOf(ctx, ws, siteId, 'title.missing', subject))?.state).toBe('ignored');
  });

  it('resolves only issues inside a section audit’s scope', async () => {
    const inside = url('/blog/post');
    const outside = url('/outside');
    await seedAudit(ctx.db, ws, siteId, { pages: [missingTitle(inside), missingTitle(outside)] });
    const section = await seedAudit(ctx.db, ws, siteId, {
      pages: [goodPage(inside)],
      scope: 'section',
      section: '/blog',
    });
    expect((await issueOf(ctx, ws, siteId, 'title.missing', inside))?.state).toBe('resolved');
    const outOfScope = await issueOf(ctx, ws, siteId, 'title.missing', outside);
    expect(outOfScope).toMatchObject({ state: 'open' });
    expect(outOfScope?.last_checked_audit_id).not.toBe(section);
  });

  it('resolves a sitemap issue when a complete sitemap no longer lists the URL', async () => {
    const subject = url('/sitemap-old');
    await seedAudit(ctx.db, ws, siteId, { pages: [goodPage(subject, { inSitemap: true, html: { metaRobots: ['noindex'] } })] });
    const opened = await issueOf(ctx, ws, siteId, 'indexability.noindex_in_sitemap', subject);
    expect(opened?.state).toBe('open');
    // The next audit still crawls the page but the sitemap does not list it any more; the sitemap
    // was read completely, so the URL is no longer a sitemap problem.
    await seedAudit(ctx.db, ws, siteId, { pages: [goodPage(subject, { inSitemap: false })] });
    expect((await issueOf(ctx, ws, siteId, 'indexability.noindex_in_sitemap', subject))?.state).toBe('resolved');
  });

  it('skips graph checks on a truncated graph and records why', async () => {
    const subject = url('/deep');
    const other = url('/deep-other');
    const deep = goodPage(subject, { depth: 6 });
    const first = await seedAudit(ctx.db, ws, siteId, { pages: [deep] });
    expect((await findingsOf(ctx.db, ws, first, 'crawl.deep_page')).length).toBeGreaterThan(0);

    const second = await seedAudit(ctx.db, ws, siteId, {
      pages: [deep],
      frontier: [{ url: other, state: 'skipped', skipReason: 'depth_limit', discoveredBy: 'link', discoveredFrom: subject }],
    });
    expect(await findingsOf(ctx.db, ws, second, 'crawl.deep_page')).toEqual([]);
    const score = await scoreRow(ctx.db, ws, second);
    expect(score?.skipped_checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: 'crawl.deep_page', reason: expect.stringContaining('truncated') }),
        expect.objectContaining({ checkId: 'crawl.orphan_page', reason: expect.stringContaining('truncated') }),
      ]),
    );
    // The issue stays open: the audit could not judge it.
    const issue = await issueOf(ctx, ws, siteId, 'crawl.deep_page', subject);
    expect(issue).toMatchObject({ state: 'open', last_checked_audit_id: first });
  });

  it('gives no score when the audit evaluated no page, with a reason', async () => {
    const audited = await seedAudit(ctx.db, ws, siteId, {
      pages: [goodPage(url('/gone'), { status: 404, html: null })],
    });
    const score = await scoreRow(ctx.db, ws, audited);
    expect(score?.score).toBeNull();
    expect(String(score?.reason)).toMatch(/No page was evaluated/);
    expect(score?.pages_evaluated).toBe(0);
  });
});
