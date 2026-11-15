import { randomUUID } from 'node:crypto';
import { createDb, type Db } from '@agentic-seo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { addDays, dayString, estimateReach } from '../src';

// Reach at its entry point (`estimateReach`): known only with an active connection and fresh page
// aggregates, the 28-day sum with trailing-slash URL variants, last year's window, and an unknown
// reason that names what is missing.

const NOW = new Date('2026-11-15T12:00:00Z');
const TODAY = dayString(NOW);
const PROPERTY = 'sc-domain:example.com';

describe.skipIf(!hasTestDatabase())('reach from Search Console page aggregates', () => {
  let disposable: Awaited<ReturnType<typeof createDisposableDb>>;
  let db: Db;
  let siteId: string;
  let bareSiteId: string;

  beforeAll(async () => {
    disposable = await createDisposableDb('searchreach');
    const appUrl = new URL(disposable.url.toString());
    appUrl.username = APP_ROLE.appRole;
    appUrl.password = APP_ROLE.appRolePassword;
    db = createDb({ adminUrl: disposable.url.toString(), appUrl: appUrl.toString(), poolSize: 6 });
    siteId = randomUUID();
    bareSiteId = randomUUID();
    for (const [id, domain] of [
      [siteId, 'example.com'],
      [bareSiteId, 'bare.example'],
    ] as const)
      await db.admin.query(
        `INSERT INTO sites (workspace_id, id, name, primary_domain, verification_token)
         VALUES ($1, $2, $3, $4, 'verify-token')`,
        [disposable.workspace, id, domain, domain],
      );
    await db.admin.query(
      `INSERT INTO connections (workspace_id, id, site_id, connector, label, settings, state)
       VALUES ($1, $2, $3, 'google-search-console', 'Google Search Console', $4::jsonb, 'active')`,
      [disposable.workspace, `con_${'a'.repeat(32)}`, siteId, JSON.stringify({ property: PROPERTY })],
    );
  });

  afterAll(async () => {
    await db?.close();
    await disposable?.close();
  });

  async function page(day: string, url: string, clicks: number, impressions = clicks * 10) {
    await db.admin.query(
      `INSERT INTO gsc_page_aggregates
         (workspace_id, site_id, property, date, page, country, device, clicks, impressions, ctr, position, is_final)
       VALUES ($1, $2, $3, $4, $5, '', '', $6, $7, 0.1, 3, true)`,
      [disposable.workspace, siteId, PROPERTY, day, url, clicks, impressions],
    );
  }

  const reach = (input: { urls: string[]; siteId?: string }) =>
    db.withWorkspace(disposable.workspace, (tx) =>
      estimateReach(tx, { workspaceId: disposable.workspace, siteId: input.siteId ?? siteId, urls: input.urls, now: NOW }),
    );

  it('is unknown when the site has no connection, naming what is missing', async () => {
    const result = await reach({ urls: ['https://bare.example/a'], siteId: bareSiteId });
    expect(result).toEqual({ kind: 'unknown', reason: 'Search Console is not connected for this site' });
  });

  it('is unknown when the newest page data is older than four days', async () => {
    await page(addDays(TODAY, -6), 'https://example.com/old', 4);
    expect(await reach({ urls: ['https://example.com/old'] })).toEqual({
      kind: 'unknown',
      reason: 'Search Console data is 6 days old',
    });
  });

  it('sums 28 days with trailing-slash variants and last year’s matching window', async () => {
    await page(addDays(TODAY, -1), 'https://example.com/a/', 10);
    await page(addDays(TODAY, -2), 'https://example.com/a', 5);
    // Outside the 28-day window.
    await page(addDays(TODAY, -28), 'https://example.com/a/', 99);
    // Another page: not part of the answer.
    await page(addDays(TODAY, -1), 'https://example.com/b', 3);
    // The same 28 days a year earlier (364 days back, so weekdays align).
    await page(addDays(TODAY, -365), 'https://example.com/a/', 4);

    const result = await reach({ urls: ['https://example.com/a'] });
    expect(result).toMatchObject({
      kind: 'known',
      affectedUrls: 1,
      clicksAtRisk: 15,
      impressionsAtRisk: 150,
      clicksAtRiskLastYear: 4,
      impressionsAtRiskLastYear: 40,
      criticalPages: ['https://example.com/'],
      dataThrough: addDays(TODAY, -1),
    });
  });

  it('reports null clicks, not zero, for a page with no search history', async () => {
    const result = await reach({ urls: ['https://example.com/never-seen'] });
    expect(result).toMatchObject({ kind: 'known', clicksAtRisk: null, impressionsAtRisk: null });
  });

  it('answers an empty URL list with measured zeros', async () => {
    const result = await reach({ urls: [] });
    expect(result).toMatchObject({ kind: 'known', affectedUrls: 0, clicksAtRisk: 0, impressionsAtRisk: 0 });
  });
});
