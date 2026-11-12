import { describe, expect, it } from 'vitest';
import { NAV, navFor, SETTINGS_GROUP, SETTINGS_ITEMS, settingsPath, visibleNav, visibleSettings } from '../src/app/nav';
import { PLANNED } from '../src/app/planned';
import { redirectTarget } from '../src/app/redirects';

const can = () => true;

// docs/design/DESIGN.md §3, verbatim: each group, its entries and the Settings secondary nav. When
// the design changes, this table and nav.ts change together; a missing or duplicate path fails here.
const DESIGN: Record<string, [string, string][]> = {
  Work: [
    ['/', 'Home'],
    ['/inbox', 'Inbox'],
    ['/agents', 'Agents'],
  ],
  'Site health': [
    ['/audits', 'Audits'],
    ['/issues', 'Issues'],
    ['/performance', 'Performance'],
    ['/changes', 'Changes'],
  ],
  Search: [
    ['/search/performance', 'Search performance'],
    ['/search/opportunities', 'Opportunities'],
    ['/search/rankings', 'Rankings'],
    ['/search/ai-visibility', 'AI visibility'],
    ['/search/local', 'Local'],
  ],
  Research: [
    ['/research/keywords', 'Keywords'],
    ['/research/competitors', 'Competitors'],
    ['/research/serp', 'SERP explorer'],
    ['/research/backlinks', 'Backlinks'],
  ],
  Content: [
    ['/content/briefs', 'Briefs'],
    ['/content/clusters', 'Clusters'],
    ['/content/reports', 'Reports'],
  ],
};

const SETTINGS: [string, string][] = [
  ['/settings/site', 'Site'],
  ['/settings/connections', 'Connections'],
  ['/settings/providers', 'Providers and budgets'],
  ['/settings/crawler-access', 'Crawler access'],
  ['/settings/users', 'Users and roles'],
  ['/settings/api-tokens', 'API tokens'],
  ['/settings/approval-policy', 'Approval policy and agent autonomy'],
  ['/settings/usage', 'Usage'],
];

describe('navigation', () => {
  it('matches DESIGN.md §3 group by group, including the Settings secondary nav', () => {
    const visible = visibleNav(can, { localBusiness: true });
    expect(visible.map((group) => group.label)).toEqual(Object.keys(DESIGN));
    for (const group of visible) {
      expect(group.items.map((item) => [item.path, item.label])).toEqual(DESIGN[group.label]);
    }
    expect(SETTINGS_GROUP.items.map((item) => [item.path, item.label])).toEqual(SETTINGS);
  });

  it('gives every destination a unique canonical path', () => {
    const paths = [...NAV.flatMap((group) => group.items.map((item) => item.path)), ...SETTINGS_ITEMS.map((item) => item.path)];
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('hides Local unless the site is a local business', () => {
    const labels = () => visibleNav(can).flatMap((group) => group.items.map((item) => item.label));
    expect(labels()).not.toContain('Local');
    expect(visibleNav(can, { localBusiness: true }).flatMap((group) => group.items.map((item) => item.label))).toContain('Local');
  });

  it('has a real page for every destination: Home is built, the rest names its phase', () => {
    for (const path of [...NAV.flatMap((group) => group.items.map((item) => item.path)), ...SETTINGS_ITEMS.map((item) => item.path)]) {
      if (path === '/') continue;
      expect(PLANNED[path], `${path} needs a planned page`).toBeTruthy();
      expect(PLANNED[path].phase).toMatch(/^Phase \d$/);
    }
  });

  it('opens Settings at Site and keeps its children under Settings', () => {
    expect(settingsPath(can)).toBe('/settings/site');
    expect(visibleSettings(can).map((item) => item.path)).toEqual(SETTINGS.map(([path]) => path));
    expect(navFor('/settings')?.group?.label).toBe('Settings');
    expect(navFor('/settings/providers')?.item?.label).toBe('Providers and budgets');
    expect(navFor('/settings/providers/123')?.item?.label).toBe('Providers and budgets');
  });

  it('matches Home exactly and chooses the longest item path', () => {
    expect(navFor('/')?.item?.label).toBe('Home');
    expect(navFor('/search/performance')?.item?.label).toBe('Search performance');
    expect(navFor('/search/performance/2026-11')?.item?.label).toBe('Search performance');
    expect(navFor('/not-a-page')).toEqual({});
  });

  it('leaves canonical and unknown addresses alone', () => {
    expect(redirectTarget('/inbox', new URLSearchParams())).toBeNull();
    expect(redirectTarget('/settings/site', new URLSearchParams('tab=domains'))).toBeNull();
    expect(redirectTarget('/not-a-page', new URLSearchParams())).toBeNull();
  });
});
