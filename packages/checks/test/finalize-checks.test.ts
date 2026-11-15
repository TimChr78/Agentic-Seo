import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDatabase } from '../../db/test/disposable';
import { type AuditTestContext, addSite, createAuditTestContext, findingsOf, goodPage, type SeedAuditInput, seedAudit } from './support';

// Every `evaluator: 'finalize'` check, its pass and fail scenario from packages/checks/test/fixtures.ts
// `finalizeFixtures`, run against the real crawl tables through `finalizeAudit`. Each case seeds
// page snapshots, the frontier and link edges exactly as a crawl leaves them, then asserts the check
// either produced a finding or did not.

const A = 'https://example.com/a';
const B = 'https://example.com/b';
const C = 'https://example.com/c';

interface Case {
  id: string;
  fail: SeedAuditInput;
  pass: SeedAuditInput;
}

const page = (url: string, overrides: Parameters<typeof goodPage>[1] = {}) => goodPage(url, overrides);

const CASES: Case[] = [
  {
    id: 'sitemap.non_indexable_url',
    fail: { pages: [page(A, { html: { metaRobots: ['noindex'] } })] },
    pass: { pages: [page(A)] },
  },
  {
    id: 'page.blocked_by_robots',
    fail: {
      pages: [page(A)],
      frontier: [{ url: B, state: 'skipped', skipReason: 'robots', discoveredBy: 'link', discoveredFrom: A }],
    },
    pass: { pages: [page(A)] },
  },
  {
    id: 'crawl.deep_page',
    fail: { pages: [page(A, { depth: 5 })] },
    pass: { pages: [page(A, { depth: 4 })] },
  },
  {
    id: 'crawl.orphan_page',
    fail: { pages: [page(A, { inSitemap: true })] },
    pass: {
      pages: [page(A, { inSitemap: true }), page(B, { inSitemap: false })],
      edges: [{ from: B, to: A }],
    },
  },
  {
    id: 'indexability.noindex_in_sitemap',
    fail: { pages: [page(A, { html: { metaRobots: ['noindex'] }, headers: { xRobotsTag: 'googlebot: noindex' } })] },
    pass: { pages: [page(A)] },
  },
  {
    id: 'canonical.to_non_200',
    fail: {
      pages: [page(A, { html: { canonical: B } }), page(B, { status: 404, html: null })],
    },
    pass: { pages: [page(A, { html: { canonical: B } }), page(B)] },
  },
  {
    id: 'canonical.to_redirect',
    fail: {
      pages: [page(A, { html: { canonical: B } }), page(B, { redirects: [{ url: B, status: 301, location: C }] }), page(C)],
    },
    pass: { pages: [page(A, { html: { canonical: B } }), page(B)] },
  },
  {
    id: 'canonical.to_noindex',
    fail: {
      pages: [page(A, { html: { canonical: B } }), page(B, { html: { metaRobots: ['noindex'] } })],
    },
    pass: { pages: [page(A, { html: { canonical: B } }), page(B)] },
  },
  {
    id: 'canonical.chain_or_cycle',
    fail: {
      pages: [page(A, { html: { canonical: B } }), page(B, { html: { canonical: C } }), page(C, { html: { canonical: A } })],
    },
    pass: { pages: [page(A, { html: { canonical: B } }), page(B)] },
  },
  {
    id: 'links.broken_internal',
    fail: {
      pages: [page(A), page(B, { status: 404, html: null })],
      edges: [{ from: A, to: B, anchor: 'Broken' }],
    },
    pass: { pages: [page(A), page(B)], edges: [{ from: A, to: B }] },
  },
  {
    id: 'links.to_redirect',
    fail: {
      pages: [page(A), page(B, { redirects: [{ url: B, status: 301, location: C }] }), page(C)],
      edges: [{ from: A, to: B }],
    },
    pass: { pages: [page(A), page(B)], edges: [{ from: A, to: B }] },
  },
  {
    id: 'title.duplicate',
    fail: { pages: [page(A, { html: { title: 'Guide' } }), page(B, { html: { title: 'Guide' } })] },
    pass: { pages: [page(A, { html: { title: 'Guide one' } }), page(B, { html: { title: 'Guide two' } })] },
  },
  {
    id: 'description.duplicate',
    fail: {
      pages: [
        page(A, { html: { metaDescription: 'A guide to the same topic, with the details a reader needs.' } }),
        page(B, { html: { metaDescription: 'A guide to the same topic, with the details a reader needs.' } }),
      ],
    },
    pass: {
      pages: [
        page(A, { html: { metaDescription: 'A guide to the first topic, with the details a reader needs.' } }),
        page(B, { html: { metaDescription: 'A guide to the second topic, with the details a reader needs.' } }),
      ],
    },
  },
  {
    id: 'content.duplicate',
    fail: {
      pages: [
        page(A, { html: { contentHash: 'b'.repeat(64), wordCount: 120 } }),
        page(B, { html: { contentHash: 'b'.repeat(64), wordCount: 120 } }),
      ],
    },
    pass: {
      pages: [
        page(A, { html: { contentHash: 'b'.repeat(64), wordCount: 120 } }),
        page(B, { html: { contentHash: 'c'.repeat(64), wordCount: 120 } }),
      ],
    },
  },
  {
    id: 'hreflang.missing_return',
    fail: {
      pages: [page(A, { html: { hreflang: [{ lang: 'fr-FR', href: B }] } }), page(B)],
    },
    pass: {
      pages: [
        page(A, { html: { lang: 'en', hreflang: [{ lang: 'fr-FR', href: B }] } }),
        page(B, { html: { lang: 'fr', hreflang: [{ lang: 'en', href: A }] } }),
      ],
    },
  },
  {
    id: 'hreflang.to_non_canonical',
    fail: {
      pages: [page(A, { html: { hreflang: [{ lang: 'fr-FR', href: B }] } }), page(B, { html: { canonical: C }, finalUrl: B })],
    },
    pass: {
      pages: [page(A, { html: { hreflang: [{ lang: 'fr-FR', href: B }] } }), page(B)],
    },
  },
];

describe.skipIf(!hasTestDatabase())('finalize checks', () => {
  let ctx: AuditTestContext;
  let ws = '';
  let siteId = '';

  beforeAll(async () => {
    ctx = await createAuditTestContext('checks_finalize');
    ws = ctx.disposable.workspace;
    siteId = await addSite(ctx.db, ws);
  }, 120_000);

  afterAll(async () => {
    ctx?.dispose();
    await ctx?.disposable.close();
  });

  it('covers every evaluator: finalize check in the catalogue', async () => {
    const { finalizeChecks } = await import('../src');
    expect(CASES.map((item) => item.id).sort()).toEqual(finalizeChecks.map((check) => check.id).sort());
  });

  for (const item of CASES) {
    it(`${item.id}: fails the fixture's fail scenario and passes its pass scenario`, async () => {
      const failedAudit = await seedAudit(ctx.db, ws, siteId, item.fail);
      const failed = await findingsOf(ctx.db, ws, failedAudit, item.id);
      expect(failed.length, `${item.id} should fail`).toBeGreaterThan(0);

      const passedAudit = await seedAudit(ctx.db, ws, siteId, item.pass);
      const passed = await findingsOf(ctx.db, ws, passedAudit, item.id);
      expect(
        passed.map((row) => row.subject_key),
        `${item.id} should pass`,
      ).toEqual([]);
    });
  }
});
