import { finalizeAudit } from '@agentic-seo/crawl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDatabase } from '../../db/test/disposable';
import {
  type AuditTestContext,
  addSite,
  createAuditTestContext,
  forceGc,
  goodPage,
  type SeedAuditInput,
  scoreRow,
  seedAudit,
} from './support';

// Finalize is bounded (crawler-and-audits.md §1 "Bounded memory"): the crawl tables are aggregated in
// SQL and per-page work runs in keyset batches, so peak heap is a function of the batch size, not of
// the crawl. A 5,000-page, 150,000-edge audit may cost more time than a small one; it must not cost
// memory proportional to the crawl.
//
// The first test reports the 2,000-page timing the earlier round used. The second builds the
// link-heavy, failure-heavy audit the review asked for (30 internal links a page, broken and
// redirecting targets, duplicate-title groups, page checks on) and asserts peak *live* heap growth:
// the collector runs before the baseline and before every sample, so garbage from an earlier batch
// cannot be counted as retained memory and make the bound flaky.

const PAGES = 5_000;
const LINKS_PER_PAGE = 30;
const BROKEN = 250;
const REDIRECTING = 250;

const url = (path: string): string => `https://example.com${path}`;

/** A link-heavy, failure-heavy audit: 10% of targets broken or redirecting, duplicate title groups. */
function heavyAudit(): SeedAuditInput {
  const pageUrl = (index: number): string => url(`/p${index}`);
  const brokenUrl = (index: number): string => url(`/broken${index}`);
  const redirectingUrl = (index: number): string => url(`/moved${index}`);
  const pages = [];

  for (let index = 0; index < PAGES; index += 1) {
    // Every hundredth page shares one of ten titles, so half the audit sits in duplicate groups.
    const duplicateTitle =
      index % 100 < 20 ? `A shared guide to example topic ${index % 10}` : `Page ${index}: a specific guide to its own topic`;
    pages.push(
      goodPage(pageUrl(index), {
        inSitemap: index % 50 === 0,
        depth: index % 20,
        html: {
          title: duplicateTitle,
          metaDescription: `A description for page ${index}, written for this page alone and long enough to be useful.`,
          contentHash: index.toString(16).padStart(64, '0'),
          wordCount: 300 + (index % 200),
          links: Array.from({ length: LINKS_PER_PAGE }, (_, linkIndex) => {
            const target = (index * (LINKS_PER_PAGE + 1) + linkIndex) % PAGES;
            return { href: pageUrl(target), rawHref: `/p${target}`, rel: [], text: `Link ${linkIndex}`, internal: true };
          }),
        },
      }),
    );
  }
  for (let index = 0; index < BROKEN; index += 1) {
    pages.push(goodPage(brokenUrl(index), { status: 404, html: null, inSitemap: false }));
  }
  for (let index = 0; index < REDIRECTING; index += 1) {
    const destination = (index * 7) % PAGES;
    pages.push(
      goodPage(redirectingUrl(index), {
        finalUrl: pageUrl(destination),
        inSitemap: false,
        redirects: [{ url: redirectingUrl(index), status: 301, location: pageUrl(destination) }],
      }),
    );
  }

  const edges = [];
  for (let index = 0; index < PAGES; index += 1) {
    for (let linkIndex = 0; linkIndex < LINKS_PER_PAGE; linkIndex += 1) {
      const target = (index * (LINKS_PER_PAGE + 1) + linkIndex) % PAGES;
      edges.push({ from: pageUrl(index), to: pageUrl(target) });
    }
    // Ten percent of the audit's pages link to a broken or a redirecting target.
    if (index % 10 === 0) edges.push({ from: pageUrl(index), to: brokenUrl(index % BROKEN) });
    if (index % 10 === 1) edges.push({ from: pageUrl(index), to: redirectingUrl(index % REDIRECTING) });
  }

  return { pages, edges, bulk: true };
}

describe.skipIf(!hasTestDatabase())('finalize at scale', () => {
  let ctx: AuditTestContext;
  let ws = '';
  let siteId = '';

  beforeAll(async () => {
    ctx = await createAuditTestContext('checks_bulk');
    ws = ctx.disposable.workspace;
    siteId = await addSite(ctx.db, ws);
  }, 180_000);

  afterAll(async () => {
    ctx?.dispose();
    await ctx?.disposable.close();
  });

  it('finalizes 2,000 pages without per-row round trips', async () => {
    const pages = Array.from({ length: 2_000 }, (_, index) =>
      goodPage(`https://example.com/plain${index}`, {
        inSitemap: false,
        html: {
          title: `Page number ${index} about a specific topic`,
          metaDescription: `A description for page ${index}, written for this page alone and long enough to be useful.`,
          contentHash: index.toString(16).padStart(64, '0'),
          wordCount: 300 + index,
        },
      }),
    );
    const started = performance.now();
    const auditId = await seedAudit(ctx.db, ws, siteId, { pages, bulk: true, pageChecks: false });
    const durationMs = performance.now() - started;
    console.log(`finalize with 2,000 pages: ${Math.round(durationMs)} ms`);

    const score = await scoreRow(ctx.db, ws, auditId);
    expect(score?.pages_evaluated).toBe(2_000);
    expect(score?.score).toBe(100);
    expect(score?.categories).toHaveLength(8);
    expect(durationMs).toBeLessThan(15_000);
  }, 180_000);

  it('bounds peak heap growth on a 5,000-page, 150,000-edge audit', async () => {
    const auditId = await seedAudit(ctx.db, ws, siteId, { ...heavyAudit(), finalize: false });
    // Live heap, not `heapUsed`: collect before the baseline and before every sample, so parsing
    // garbage from the batches does not read as memory finalize holds (CI once saw 63.5 MB against a
    // 60 MB bound for that reason). 100 ms is often enough to catch the peak and cheap enough to
    // leave the measured work the dominant cost.
    const collect = forceGc();
    collect();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const sampler = setInterval(() => {
      collect();
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }, 100);

    const started = performance.now();
    try {
      expect(await finalizeAudit(ctx.db, { workspaceId: ws, auditId })).toBe(true);
    } finally {
      clearInterval(sampler);
      collect();
    }
    const durationMs = performance.now() - started;
    const growthMb = (peak - before) / (1024 * 1024);
    console.log(`finalize with 5,000 link-heavy pages: ${Math.round(durationMs)} ms, peak heap growth ${growthMb.toFixed(1)} MB`);

    // The work was real: every page evaluated, duplicate groups and broken links found.
    const score = await scoreRow(ctx.db, ws, auditId);
    // The 250 redirecting targets share their final URL with a good page, so 5,000 pages evaluate.
    expect(score?.pages_evaluated).toBe(PAGES);
    expect(score?.score).not.toBeNull();
    expect(Number(score?.score)).toBeLessThan(100);
    const { rows: duplicates } = await ctx.db.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM findings WHERE workspace_id = $1 AND audit_id = $2 AND check_id = 'title.duplicate'`,
      [ws, auditId],
    );
    expect(Number(duplicates[0]?.n ?? 0)).toBeGreaterThan(500);
    const { rows: broken } = await ctx.db.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM findings WHERE workspace_id = $1 AND audit_id = $2 AND check_id = 'links.broken_internal'`,
      [ws, auditId],
    );
    expect(Number(broken[0]?.n ?? 0)).toBeGreaterThan(0);

    // Bounded by the batch, not by the crawl: before the SQL rewrite this audit held every page's
    // full PageFacts and all 150,000 edges at once (well over 150 MB on this machine).
    expect(growthMb).toBeLessThan(60);
    expect(durationMs).toBeLessThan(90_000);
  }, 300_000);
});
