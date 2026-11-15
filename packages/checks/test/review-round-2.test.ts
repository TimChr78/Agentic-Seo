import v8 from 'node:v8';
import vm from 'node:vm';
import { finalizeAudit } from '@agentic-seo/crawl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDatabase } from '../../db/test/disposable';
import { pageFacts } from './fixtures';
import { type AuditTestContext, addSite, createAuditTestContext, findingsOf, goodPage, issueRows, scoreRow, seedAudit } from './support';

// Review round 2 on PR #21, one public-entry-point test per finding. Each test fails against the
// implementation before this round (see the pull request's "Review round 2" section).

/**
 * A `gc` that works without `--expose-gc`: Node exposes the collector once the flag is set at
 * runtime (v8.setFlagsFromString + a fresh VM context), which is enough to measure live heap.
 */
function forceGc(): () => void {
  const existing = (globalThis as { gc?: () => void }).gc;
  if (existing) return existing;
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc') as () => void;
}

type IssueRow = {
  check_id: string;
  subject_key: string;
  state: string;
  last_seen_audit_id: string;
  last_checked_audit_id: string;
  affected_urls: string[];
};

/** The open issues of a site, which is also the score's unchecked count when none failed. */
async function openIssueCount(ctx: AuditTestContext, ws: string, siteId: string): Promise<number> {
  const issues = (await issueRows(ctx.db, ws, siteId)) as unknown as IssueRow[];
  return issues.filter((issue) => issue.state === 'open').length;
}

/** The historical backlog of a large site: open issues on pages one small audit never touches. */
const BACKLOG = 40_000;

describe.skipIf(!hasTestDatabase())('review round 2', () => {
  let ctx: AuditTestContext;
  let ws = '';

  const newSite = (domain: string): Promise<string> => addSite(ctx.db, ws, domain);

  const issueOf = async (siteId: string, checkId: string, subject: string): Promise<IssueRow | undefined> =>
    ((await issueRows(ctx.db, ws, siteId)) as unknown as IssueRow[]).find((row) => row.check_id === checkId && row.subject_key === subject);

  beforeAll(async () => {
    ctx = await createAuditTestContext('checks_review2');
    ws = ctx.disposable.workspace;
  }, 180_000);

  afterAll(async () => {
    ctx?.dispose();
    await ctx?.disposable.close();
  });

  it('keeps finalize memory small with a large historical issue backlog', async () => {
    const siteId = await newSite('backlog.example');
    const historyAudit = 'adt_review2_history';
    await ctx.db.admin.query(
      `INSERT INTO audits (workspace_id, id, site_id, scope, state, requested_by_type, requested_by_id, finished_at)
       VALUES ($1, $2, $3, 'site', 'completed', 'user', 'seed-user', now())`,
      [ws, historyAudit, siteId],
    );
    // 40,000 open issues on pages this audit will never evaluate: the historical backlog of a site
    // whose last audit is long past. Loading them into Node is what made finalize proportional to
    // the site rather than to the crawl.
    await ctx.db.admin.query(
      `INSERT INTO issues (workspace_id, id, site_id, check_id, subject_key, subject, state, severity, category,
                           first_seen_audit_id, last_seen_audit_id, last_checked_audit_id, affected_urls, affected_pages)
       SELECT $1, 'iss_' || substr(md5('backlog' || n), 1, 32), $2, 'title.missing',
              'https://backlog.example/old/' || n, 'https://backlog.example/old/' || n, 'open', 'medium', 'on_page',
              $3, $3, $3, ARRAY['https://backlog.example/old/' || n], 1
       FROM generate_series(1, ${BACKLOG}) AS n`,
      [ws, siteId, historyAudit],
    );

    const pages = Array.from({ length: 10 }, (_, index) =>
      goodPage(`https://backlog.example/p${index}`, {
        inSitemap: false,
        html: {
          title: `Page ${index} about its own specific topic`,
          metaDescription: `A description written for page ${index} alone, with enough detail to be useful.`,
          contentHash: index.toString(16).padStart(64, '0'),
          wordCount: 300 + index,
        },
      }),
    );
    const auditId = await seedAudit(ctx.db, ws, siteId, { pages, finalize: false });

    // Peak *live* heap: collect before every sample, so parsing garbage from the batches does not
    // masquerade as retained memory (the finding is about what finalize holds at once).
    const collect = forceGc();
    collect();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const sampler = setInterval(() => {
      collect();
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }, 20);
    try {
      expect(await finalizeAudit(ctx.db, { workspaceId: ws, auditId })).toBe(true);
    } finally {
      clearInterval(sampler);
      collect();
    }
    const growthMb = (peak - before) / (1024 * 1024);
    console.log(`finalize with 10 pages and ${BACKLOG} historical issues: peak heap growth ${growthMb.toFixed(1)} MB`);

    const score = await scoreRow(ctx.db, ws, auditId);
    expect(score?.score).toBe(100);
    expect(score?.pages_evaluated).toBe(10);
    // The backlog belongs to pages this audit did not evaluate: coverage, never a penalty.
    expect(score?.unchecked_issues).toBe(BACKLOG);
    // The old path held every open issue (and every evaluated page key) in Node first: tens of MB.
    expect(growthMb).toBeLessThan(4);
  }, 300_000);

  it('keeps an hreflang issue unchecked when one of its targets was not read', async () => {
    const siteId = await newSite('hreflang-pair.example');
    const a = 'https://hreflang-pair.example/a';
    const b = 'https://hreflang-pair.example/b';
    const c = 'https://hreflang-pair.example/c';
    const entry = (lang: string, href: string) => ({ lang, href });
    const first = await seedAudit(ctx.db, ws, siteId, {
      pages: [
        goodPage(a, { inSitemap: false, html: { lang: 'en', hreflang: [entry('fr-FR', b), entry('de-DE', c)] } }),
        goodPage(b, { inSitemap: false, html: { lang: 'fr', hreflang: [entry('en', a)] } }),
        goodPage(c, { inSitemap: false, html: { lang: 'de' } }),
      ],
    });
    expect((await issueOf(siteId, 'hreflang.missing_return', a))?.state).toBe('open');

    // The next audit reads A and the reciprocal B, and skips C. One unresolved relationship is not a
    // pass for the source: C could still be missing its return link.
    const second = await seedAudit(ctx.db, ws, siteId, {
      pages: [
        goodPage(a, { inSitemap: false, html: { lang: 'en', hreflang: [entry('fr-FR', b), entry('de-DE', c)] } }),
        goodPage(b, { inSitemap: false, html: { lang: 'fr', hreflang: [entry('en', a)] } }),
      ],
    });
    const issue = await issueOf(siteId, 'hreflang.missing_return', a);
    expect(issue).toMatchObject({ state: 'open', last_checked_audit_id: first });
    expect(issue?.last_checked_audit_id).not.toBe(second);
  });

  it('reads canonical gates per check: a failed canonical fetch cannot resolve a noindex issue', async () => {
    const siteId = await newSite('canonical-timeout.example');
    const a = 'https://canonical-timeout.example/a';
    const b = 'https://canonical-timeout.example/b';
    const first = await seedAudit(ctx.db, ws, siteId, {
      pages: [
        goodPage(a, { inSitemap: false, html: { canonical: b } }),
        goodPage(b, { inSitemap: false, html: { metaRobots: ['noindex'] } }),
      ],
    });
    expect((await issueOf(siteId, 'canonical.to_noindex', a))?.state).toBe('open');

    // The target timed out this time: the response carries no readable noindex facts, so the noindex
    // check was not re-checked (while to_non_200 reads the recorded fetch failure as its outcome).
    const second = await seedAudit(ctx.db, ws, siteId, {
      pages: [
        goodPage(a, { inSitemap: false, html: { canonical: b } }),
        pageFacts({ url: b, finalUrl: b, status: 0, fetchError: 'timeout', html: null, inSitemap: false }),
      ],
    });

    const noindexIssue = await issueOf(siteId, 'canonical.to_noindex', a);
    expect(noindexIssue).toMatchObject({ state: 'open', last_checked_audit_id: first });
    expect((await findingsOf(ctx.db, ws, second, 'canonical.to_non_200')).map((row) => row.subject_key)).toEqual([a]);
    expect((await issueOf(siteId, 'canonical.to_non_200', a))?.last_checked_audit_id).toBe(second);
  });

  it('resolves a canonical issue when the source is repaired to self-canonical', async () => {
    const siteId = await newSite('canonical-repair.example');
    const a = 'https://canonical-repair.example/a';
    const b = 'https://canonical-repair.example/b';
    await seedAudit(ctx.db, ws, siteId, {
      pages: [
        goodPage(a, { inSitemap: false, html: { canonical: b } }),
        pageFacts({ url: b, finalUrl: b, status: 404, html: null, inSitemap: false }),
      ],
    });
    expect((await issueOf(siteId, 'canonical.to_non_200', a))?.state).toBe('open');

    // A now declares itself canonical. There is no target to judge, which is a pass for every
    // canonical-target check and must resolve the issue the old canonical opened.
    const repaired = await seedAudit(ctx.db, ws, siteId, { pages: [goodPage(a, { inSitemap: false })] });
    const issue = await issueOf(siteId, 'canonical.to_non_200', a);
    expect(issue?.state).toBe('resolved');
    expect(issue?.last_checked_audit_id).toBe(repaired);
  });

  it('scores only the issues this audit judged and counts the rest as unchecked', async () => {
    const siteId = await newSite('canonical-unchecked.example');
    const a = 'https://canonical-unchecked.example/a';
    const b = 'https://canonical-unchecked.example/b';
    const first = await seedAudit(ctx.db, ws, siteId, {
      pages: [
        goodPage(a, { inSitemap: false, html: { canonical: b } }),
        pageFacts({ url: b, finalUrl: b, status: 404, html: null, inSitemap: false }),
      ],
    });
    expect((await issueOf(siteId, 'canonical.to_non_200', a))?.state).toBe('open');

    // A is crawled again, B is not: the broken-canonical issue is not re-checked, so it neither
    // penalises this audit's score nor disappears from the coverage it reports.
    const audited = await seedAudit(ctx.db, ws, siteId, {
      pages: [goodPage(a, { inSitemap: false, html: { canonical: b } })],
    });
    expect((await issueOf(siteId, 'canonical.to_non_200', a))?.last_checked_audit_id).toBe(first);

    const score = await scoreRow(ctx.db, ws, audited);
    expect(score?.score).toBe(100);
    expect(score?.unchecked_issues).toBe(await openIssueCount(ctx, ws, siteId));
    expect(Number(score?.unchecked_issues)).toBeGreaterThan(0);
  });
});
