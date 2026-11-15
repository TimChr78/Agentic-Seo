import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDatabase } from '../../db/test/disposable';
import { checkAuditHooks, checks, PAGE_CHECK_GATES } from '../src';
import { pageFacts } from './fixtures';
import { type AuditTestContext, addSite, createAuditTestContext, findingsOf, goodPage, issueRows, scoreRow, seedAudit } from './support';

// Review round 1 on PR #21, one public-entry-point test per finding. Each test fails against the
// implementation before this round (see the pull request's "Review round 1" section).

type IssueRow = {
  check_id: string;
  subject_key: string;
  state: string;
  last_seen_audit_id: string;
  last_checked_audit_id: string;
  affected_pages: number;
  affected_urls: string[];
  evidence: { items?: unknown[]; total?: number };
};

describe.skipIf(!hasTestDatabase())('review round 1', () => {
  let ctx: AuditTestContext;
  let ws = '';

  const newSite = (domain: string): Promise<string> => addSite(ctx.db, ws, domain);

  const issueOf = async (siteId: string, checkId: string, subject: string): Promise<IssueRow | undefined> =>
    (await issueRows(ctx.db, ws, siteId)).find((row) => row.check_id === checkId && row.subject_key === subject) as IssueRow | undefined;

  beforeAll(async () => {
    ctx = await createAuditTestContext('checks_review1');
    ws = ctx.disposable.workspace;
  }, 180_000);

  afterAll(async () => {
    ctx?.dispose();
    await ctx?.disposable.close();
  });

  it('keeps a canonical issue open when this audit did not fetch the canonical target', async () => {
    const siteId = await newSite('canonical-target.example');
    const a = 'https://canonical-target.example/a';
    const b = 'https://canonical-target.example/b';
    const first = await seedAudit(ctx.db, ws, siteId, {
      pages: [goodPage(a, { html: { canonical: b } }), goodPage(b, { status: 404, html: null })],
    });
    expect((await issueOf(siteId, 'canonical.to_non_200', a))?.state).toBe('open');

    // The next audit crawls /a only: /b was skipped (page limit), so /a's canonical was not judged.
    const second = await seedAudit(ctx.db, ws, siteId, { pages: [goodPage(a, { html: { canonical: b } })] });
    const issue = await issueOf(siteId, 'canonical.to_non_200', a);
    expect(issue).toMatchObject({ state: 'open', last_checked_audit_id: first });
    expect(issue?.last_checked_audit_id).not.toBe(second);
  });

  it('keeps an hreflang issue open when this audit did not fetch the target page', async () => {
    const siteId = await newSite('hreflang-target.example');
    const a = 'https://hreflang-target.example/a';
    const b = 'https://hreflang-target.example/b';
    const first = await seedAudit(ctx.db, ws, siteId, {
      pages: [goodPage(a, { html: { lang: 'en', hreflang: [{ lang: 'fr-FR', href: b }] } }), goodPage(b, { html: { lang: 'fr' } })],
    });
    expect((await issueOf(siteId, 'hreflang.missing_return', a))?.state).toBe('open');

    await seedAudit(ctx.db, ws, siteId, {
      pages: [goodPage(a, { html: { lang: 'en', hreflang: [{ lang: 'fr-FR', href: b }] } })],
    });
    const issue = await issueOf(siteId, 'hreflang.missing_return', a);
    expect(issue).toMatchObject({ state: 'open', last_checked_audit_id: first });
  });

  it('keeps a sitemap issue open when a complete sitemap still lists an unchecked URL', async () => {
    const siteId = await newSite('sitemap-listed.example');
    const listed = 'https://sitemap-listed.example/listed';
    const other = 'https://sitemap-listed.example/other';
    const first = await seedAudit(ctx.db, ws, siteId, {
      pages: [goodPage(listed, { inSitemap: true, html: { metaRobots: ['noindex'] } })],
    });
    expect((await issueOf(siteId, 'indexability.noindex_in_sitemap', listed))?.state).toBe('open');

    // The sitemap was read completely and still lists the URL, but the crawl skipped it for its page
    // limit: nothing evaluated it, so the issue is not resolved.
    await seedAudit(ctx.db, ws, siteId, {
      pages: [goodPage(other, { inSitemap: false })],
      frontier: [{ url: listed, state: 'skipped', skipReason: 'page_limit', inSitemap: true, discoveredBy: 'sitemap' }],
    });
    expect(await issueOf(siteId, 'indexability.noindex_in_sitemap', listed)).toMatchObject({
      state: 'open',
      last_checked_audit_id: first,
    });
  });

  it('produces the same findings in either crawl order for a redirecting page and its destination', async () => {
    const siteId = await newSite('crawl-order.example');
    const alias = 'https://crawl-order.example/alias';
    const destination = 'https://crawl-order.example/destination';
    const hop = 'https://crawl-order.example/hop';
    const redirecting = pageFacts({
      url: alias,
      finalUrl: destination,
      redirects: [
        { url: alias, status: 301, location: hop },
        { url: hop, status: 301, location: destination },
      ],
    });
    const target = goodPage(destination);

    const first = await seedAudit(ctx.db, ws, siteId, { pages: [redirecting, target] });
    const second = await seedAudit(ctx.db, ws, siteId, { pages: [target, redirecting] });
    const stored = async (auditId: string) =>
      (await findingsOf(ctx.db, ws, auditId)).map((row) => `${row.check_id} ${row.subject_key}`).sort();

    expect(await stored(first)).toEqual(await stored(second));
    // The redirect check belongs to the URL that redirects, and the destination's hook cannot erase it.
    expect(await stored(first)).toEqual(expect.arrayContaining([`redirect.chain ${alias}`]));
  });

  it('removes the old finding when the same request redirects somewhere else', async () => {
    const siteId = await newSite('destination-change.example');
    const auditId = 'adt_p1e_destination_change';
    await ctx.db.admin.query(
      `INSERT INTO audits (workspace_id, id, site_id, scope, state, requested_by_type, requested_by_id)
       VALUES ($1, $2, $3, 'site', 'running', 'user', 'seed-user')`,
      [ws, auditId, siteId],
    );
    const source = 'https://destination-change.example/source';
    const oldTarget = 'https://destination-change.example/old';
    const newTarget = 'https://destination-change.example/new';
    const store = (finalUrl: string) =>
      ctx.db.withWorkspace(ws, (tx) =>
        checkAuditHooks().onPage!(
          tx,
          { workspaceId: ws, siteId, auditId },
          {
            ...pageFacts({
              url: source,
              finalUrl,
              redirects: [
                { url: source, status: 301, location: `${finalUrl}/hop` },
                { url: `${finalUrl}/hop`, status: 301, location: finalUrl },
              ],
            }),
            snapshotId: 'snp_destination_change',
          },
        ),
      );

    await store(oldTarget);
    expect((await findingsOf(ctx.db, ws, auditId, 'redirect.chain')).map((row) => row.subject_key)).toEqual([source]);
    await store(newTarget);
    const findings = await findingsOf(ctx.db, ws, auditId, 'redirect.chain');
    expect(findings.map((row) => row.subject_key)).toEqual([source]);
    expect(JSON.stringify(findings)).not.toContain(oldTarget);
  });

  it('fails both links.to_redirect and links.broken_internal for a redirect to a missing target', async () => {
    const siteId = await newSite('redirect-missing.example');
    const a = 'https://redirect-missing.example/a';
    const b = 'https://redirect-missing.example/b';
    const c = 'https://redirect-missing.example/c';
    const auditId = await seedAudit(ctx.db, ws, siteId, {
      pages: [
        goodPage(a),
        pageFacts({ url: b, finalUrl: c, status: 404, html: null, redirects: [{ url: b, status: 301, location: c }] }),
        pageFacts({ url: c, finalUrl: c, status: 404, html: null }),
      ],
      edges: [{ from: a, to: b }],
    });
    expect((await findingsOf(ctx.db, ws, auditId, 'links.to_redirect')).map((row) => row.subject_key)).toEqual([b]);
    expect((await findingsOf(ctx.db, ws, auditId, 'links.broken_internal')).map((row) => row.subject_key)).toEqual([b]);
  });

  it('keeps an issue’s affected pages separate from its capped evidence', async () => {
    const siteId = await newSite('duplicate-identity.example');
    const shared = 'A practical guide to example topics and the steps to take';
    const pages = [0, 1, 2].map((index) =>
      goodPage(`https://duplicate-identity.example/p${index}`, {
        inSitemap: false,
        html: {
          title: shared,
          metaDescription: `A description written for page ${index} alone, with enough detail to be useful.`,
          contentHash: `${index}`.repeat(64),
          wordCount: 400 + index,
        },
      }),
    );
    const auditId = await seedAudit(ctx.db, ws, siteId, { pages });
    const issues = ((await issueRows(ctx.db, ws, siteId)) as unknown as IssueRow[]).filter((row) => row.check_id === 'title.duplicate');
    expect(issues).toHaveLength(3);
    // Each issue is about one page; the group's three URLs are evidence, not three affected pages.
    for (const issue of issues) {
      expect(issue.affected_pages).toBe(1);
      expect(issue.affected_urls).toEqual([issue.subject_key]);
      expect(issue.evidence.total).toBe(3);
    }
    const score = await scoreRow(ctx.db, ws, auditId);
    const categories = (score?.categories ?? []) as { category: string; issues: number; affectedPages: number }[];
    const onPage = categories.find((entry) => entry.category === 'on_page');
    expect(onPage).toMatchObject({ issues: 3, affectedPages: 3 });
    // Three medium issues, each on one of the three evaluated pages: 100 − 0.15 × 45.53 ≈ 93. The
    // group's evidence must not make each issue cover every page (that scored 86).
    expect(score?.score).toBe(93);
  });

  it('excludes an open issue on a page the audit never evaluated and reports it as unchecked', async () => {
    const siteId = await newSite('unchecked-issue.example');
    const other = 'https://unchecked-issue.example/other';
    const clean = 'https://unchecked-issue.example/clean';
    await seedAudit(ctx.db, ws, siteId, { pages: [goodPage(other, { inSitemap: false, html: { title: null } })] });
    const audited = await seedAudit(ctx.db, ws, siteId, { pages: [goodPage(clean, { inSitemap: false })] });

    const score = await scoreRow(ctx.db, ws, audited);
    expect(score?.score).toBe(100);
    expect(score?.unchecked_issues).toBe(1);
  });

  it('gives every page check an evaluation gate', () => {
    const pageChecks = checks.filter((check) => check.evaluator === 'page').map((check) => check.id);
    expect(Object.keys(PAGE_CHECK_GATES).sort()).toEqual(pageChecks.sort());
  });
});
