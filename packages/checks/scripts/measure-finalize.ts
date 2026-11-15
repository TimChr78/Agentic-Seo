// A benchmark for finalize's bounded-memory design (crawler-and-audits.md §1), run by hand:
//
//   node --import tsx packages/checks/scripts/measure-finalize.ts
//   PAGES=20000 LINKS=30 node --import tsx packages/checks/scripts/measure-finalize.ts
//
// It seeds a link-heavy, failure-heavy synthetic audit straight into the crawl tables (no network),
// finalizes it through `finalizeAudit` with the real check hooks registered, and reports wall time
// and peak process memory. The numbers in the PR come from this script; CI runs the smaller
// assertion in test/bulk-finalize.test.ts.

import { finalizeAudit } from '@agentic-seo/crawl';
import { addSite, createAuditTestContext, goodPage, type SeedAuditInput, seedAudit } from '../test/support';

const PAGES = Number(process.env.PAGES ?? 10_000);
const LINKS = Number(process.env.LINKS ?? 30);
const BROKEN = Math.max(1, Math.round(PAGES * 0.05));
const REDIRECTING = Math.max(1, Math.round(PAGES * 0.05));
const url = (path: string): string => `https://benchmark.example${path}`;

function syntheticAudit(): SeedAuditInput {
  const pages: SeedAuditInput['pages'][number][] = [];
  for (let index = 0; index < PAGES; index += 1) {
    const links = Array.from({ length: LINKS }, (_, linkIndex) => {
      const target = (index * (LINKS + 1) + linkIndex) % PAGES;
      return { href: url(`/p${target}`), rawHref: `/p${target}`, rel: [], text: `Link ${linkIndex}`, internal: true };
    });
    pages.push(
      goodPage(url(`/p${index}`), {
        inSitemap: index % 50 === 0,
        depth: index % 20,
        html: {
          // Half the audit sits in duplicate-title groups of 20.
          title: index % 100 < 20 ? `A shared guide to example topic ${index % 10}` : `Page ${index}: a specific guide to its own topic`,
          metaDescription: `A description for page ${index}, written for this page alone and long enough to be useful.`,
          contentHash: index.toString(16).padStart(64, '0'),
          wordCount: 300 + (index % 200),
          links,
        },
      }),
    );
  }
  for (let index = 0; index < BROKEN; index += 1)
    pages.push(goodPage(url(`/broken${index}`), { status: 404, html: null, inSitemap: false }));
  for (let index = 0; index < REDIRECTING; index += 1) {
    const destination = (index * 7) % PAGES;
    pages.push(
      goodPage(url(`/moved${index}`), {
        finalUrl: url(`/p${destination}`),
        inSitemap: false,
        redirects: [{ url: url(`/moved${index}`), status: 301, location: url(`/p${destination}`) }],
      }),
    );
  }

  const edges: { from: string; to: string }[] = [];
  for (let index = 0; index < PAGES; index += 1) {
    for (let linkIndex = 0; linkIndex < LINKS; linkIndex += 1) {
      edges.push({ from: url(`/p${index}`), to: url(`/p${(index * (LINKS + 1) + linkIndex) % PAGES}`) });
    }
    if (index % 10 === 0) edges.push({ from: url(`/p${index}`), to: url(`/broken${index % BROKEN}`) });
    if (index % 10 === 1) edges.push({ from: url(`/p${index}`), to: url(`/moved${index % REDIRECTING}`) });
  }
  return { pages, edges, bulk: true };
}

async function main(): Promise<void> {
  const ctx = await createAuditTestContext('checks_benchmark');
  try {
    const workspaceId = ctx.disposable.workspace;
    const siteId = await addSite(ctx.db, workspaceId, 'benchmark.example');
    let audit: SeedAuditInput | undefined = syntheticAudit();
    const pageCount = audit.pages.length;
    const edgeCount = audit.edges?.length ?? 0;
    console.log(`seeding ${pageCount} pages, ${edgeCount} edges…`);
    const auditId = await seedAudit(ctx.db, workspaceId, siteId, { ...audit, finalize: false });
    // Release the fixture before measuring: its 300,000 edge objects are the benchmark's own data,
    // not finalize's working set.
    audit = undefined;

    // Run with --expose-gc for a stable baseline: without it the seeding phase's garbage is still
    // uncollected when finalize starts, and the sampler measures that as well.
    const collect = (globalThis as { gc?: () => void }).gc;
    if (collect) collect();
    const before = process.memoryUsage();
    let peakHeap = before.heapUsed;
    let peakRss = before.rss;
    const sampler = setInterval(() => {
      const usage = process.memoryUsage();
      peakHeap = Math.max(peakHeap, usage.heapUsed);
      peakRss = Math.max(peakRss, usage.rss);
    }, 20);

    const started = performance.now();
    try {
      await finalizeAudit(ctx.db, { workspaceId, auditId });
    } finally {
      clearInterval(sampler);
    }
    const finalizeMs = performance.now() - started;

    const { rows } = await ctx.db.admin.query<{
      findings: string;
      issues: string;
      pages_evaluated: string;
      score: number | null;
    }>(
      `SELECT (SELECT count(*)::text FROM findings WHERE workspace_id = $1 AND audit_id = $2) AS findings,
              (SELECT count(*)::text FROM issues WHERE workspace_id = $1 AND site_id = $3) AS issues,
              (SELECT pages_evaluated::text FROM audit_scores WHERE workspace_id = $1 AND audit_id = $2) AS pages_evaluated,
              (SELECT score FROM audit_scores WHERE workspace_id = $1 AND audit_id = $2) AS score`,
      [workspaceId, auditId, siteId],
    );
    const row = rows[0];
    console.log(
      JSON.stringify(
        {
          pages: pageCount,
          edges: edgeCount,
          findings: Number(row?.findings ?? 0),
          issues: Number(row?.issues ?? 0),
          pagesEvaluated: Number(row?.pages_evaluated ?? 0),
          score: row?.score ?? null,
          finalizeMs: Math.round(finalizeMs),
          peakHeapGrowthMb: Number(((peakHeap - before.heapUsed) / (1024 * 1024)).toFixed(1)),
          peakRssGrowthMb: Number(((peakRss - before.rss) / (1024 * 1024)).toFixed(1)),
          peakHeapMb: Number((peakHeap / (1024 * 1024)).toFixed(1)),
          peakRssMb: Number((peakRss / (1024 * 1024)).toFixed(1)),
        },
        null,
        2,
      ),
    );
  } finally {
    ctx.dispose();
    await ctx.disposable.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
