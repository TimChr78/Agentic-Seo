import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, expect, request, test } from '@playwright/test';
import { checkById } from '../packages/checks/src/catalogue';
import { BASE, call, PASSWORD, PEOPLE, settle, signIn } from './helpers';
import { buildMatrix, matrixNames } from './routes.mjs';
import { e2eDb, seedThinLoop, THIN_LOOP_IDS } from './seed';

// Accessibility: axe-core over every Phase 0 screen (Phase 0 done criteria and DESIGN.md §7), light
// and dark at 1440 px, with the WCAG 2.1/2.2 A and AA rules. The spec fails on any violation that is
// not in e2e/axe-known-issues.json, and prints what it found by rule so the allowlist can shrink.
//
//   corepack pnpm e2e --project axe     # just this spec
//   corepack pnpm e2e                   # the functional suite and this spec
//
// It runs against the built UI on the real server, like the rest of the suite. The seeded thin loop
// (e2e/seed.ts) is written first, so the detail routes are the populated screens and not their
// "couldn't open this" states, and each detail screen's tabs (plus the open approval drawer) are
// scanned too: the content behind a tab is part of the screen.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const THEMES = ['light', 'dark'] as const;

type KnownIssue = { rule: string; route: string; reason: string };
const known = (JSON.parse(readFileSync(join(process.cwd(), 'e2e/axe-known-issues.json'), 'utf8')) as { issues: KnownIssue[] }).issues;

type Route = { name: string; path: string; signedOut?: boolean; person?: keyof typeof PEOPLE };
const matrix = buildMatrix(THIN_LOOP_IDS) as Route[];

/** What the run found, by rule, so the summary names the remaining work. */
const summary = new Map<string, { impact: string; routes: Set<string>; nodes: number; known: boolean }>();

const isKnown = (rule: string, route: string) =>
  known.some((issue) => issue.rule === rule && (issue.route === '*' || issue.route === route));

/**
 * The seeded rows the scanned detail screens show. Read from the catalogue where the UI reads it
 * from the catalogue, so a copy change never turns the assertion into a false negative.
 */
const issueTitle = checkById('title.too_long')?.title ?? 'title.too_long';
const SEEDED = 'Rewrite the pricing page title';

/** Content that proves a detail screen is populated rather than its error state. */
const EXPECTED: Record<string, string> = {
  audits: THIN_LOOP_IDS.auditId,
  'audit-detail': 'Site audit of 3 pages',
  issues: issueTitle,
  'issue-detail': issueTitle,
  recommendations: SEEDED,
  'recommendation-detail': SEEDED,
  changes: SEEDED,
  'change-detail': SEEDED,
  inbox: SEEDED,
};

/** The tabs each detail screen has; every panel is scanned, not only the default one. */
const TABS: Record<string, string[]> = {
  'audit-detail': ['Overview', 'Issues', 'Pages', 'Settings'],
  'issue-detail': ['Pages', 'Explanation', 'History', 'Activity'],
  'recommendation-detail': ['Proposal', 'Evidence', 'Change set', 'Verification plan', 'Activity'],
  'change-detail': ['Changes', 'Files', 'Verification', 'Activity'],
};

let db: Awaited<ReturnType<typeof e2eDb>>;

test.beforeAll(async () => {
  db = await e2eDb();
  // The owner's workspace and site, as the server seeded them. The seed is idempotent, so the axe
  // project works alone as well as after the functional project.
  const context = await request.newContext({ baseURL: BASE });
  try {
    const response = await context.post('/api/auth/sign-in/email', {
      data: { email: PEOPLE.owner, password: PASSWORD },
      headers: { origin: BASE },
    });
    expect(response.ok(), `sign-in for ${PEOPLE.owner}: ${await response.text()}`).toBeTruthy();
    const membership = await call<{ workspaces: { id: string }[] }>(context, 'workspace.memberships', {});
    const sites = await call<{ sites: { id: string; domain: string }[] }>(context, 'sites.list', {});
    const ownerId = await me(context);
    expect(ownerId, 'the signed-in owner has an id').toBeTruthy();
    await seedThinLoop(db, {
      workspaceId: membership.workspaces[0]!.id,
      siteId: sites.sites[0]!.id,
      userId: ownerId!,
      domain: sites.sites[0]!.domain,
    });
  } finally {
    await context.dispose();
  }
});

test.afterAll(async () => {
  await db.close();
});

test.afterAll(() => {
  const rows = [...summary.entries()].sort((a, b) => b[1].nodes - a[1].nodes || a[0].localeCompare(b[0]));
  console.log(`\naxe: ${rows.reduce((total, [, found]) => total + found.nodes, 0)} violation node(s) in ${rows.length} rule(s)`);
  if (!rows.length) console.log('  none');
  for (const [rule, found] of rows)
    console.log(
      `  ${found.known ? 'known ' : 'FAIL  '}${rule} (${found.impact}) — ${found.nodes} node(s) on ${[...found.routes].sort().join(', ')}`,
    );
  console.log(`  allowlist: ${known.length} entr${known.length === 1 ? 'y' : 'ies'} in e2e/axe-known-issues.json\n`);
});

for (const name of matrixNames(THIN_LOOP_IDS)) {
  test(`${name} has no accessibility violations`, async ({ browser }) => {
    const route = matrix.find((candidate) => candidate.name === name);
    test.skip(!route, `${name} is not in the matrix`);
    if (!route) return;

    for (const theme of THEMES) {
      // A fresh context per theme: the theme preference is read before first paint, and the cookie
      // jar of a signed-in route must not leak into the signed-out screen.
      const context = await browser.newContext({
        baseURL: BASE,
        viewport: { width: 1440, height: 900 },
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      await context.addInitScript((value) => {
        try {
          localStorage.setItem('as.theme', value);
        } catch {
          // Storage can be unavailable; the emulated colour scheme still picks the theme.
        }
      }, theme);
      if (route.signedOut) await context.clearCookies();
      else await signIn(context, PEOPLE[route.person ?? 'owner']);

      const page = await context.newPage();
      await page.goto(route.path);
      await settle(page);
      // A signed-out route must show its form, not the app.
      if (route.signedOut) await expect(page.getByLabel('E-mail')).toBeVisible();
      // A populated screen must show its seeded content before it is scanned: an error state is not
      // a valid accessibility result for a detail screen.
      const expected = EXPECTED[name];
      if (expected) await expect(page.getByText(expected, { exact: false }).first()).toBeVisible({ timeout: 20_000 });

      const scan = async (label: string) => {
        const { violations } = await new AxeBuilder({ page }).withTags(TAGS).options({ iframes: false }).analyze();
        for (const violation of violations) {
          const found = summary.get(violation.id) ?? {
            impact: violation.impact ?? 'unknown',
            routes: new Set<string>(),
            nodes: 0,
            known: true,
          };
          found.routes.add(name);
          found.nodes += violation.nodes.length;
          found.known = found.known && isKnown(violation.id, name);
          summary.set(violation.id, found);
        }

        const unexpected = violations.filter((violation) => !isKnown(violation.id, name));
        const details = unexpected.map((violation) => {
          const nodes = violation.nodes
            .slice(0, 3)
            .map((node) => `    ${node.target.join(' ')} — ${(node.failureSummary ?? '').split('\n')[0]}`);
          return `  ${violation.id} (${violation.impact}): ${violation.help}\n${nodes.join('\n')}`;
        });
        console.log(
          violations.length
            ? `axe ${label} (${theme}): ${violations.map((violation) => `${violation.id} ×${violation.nodes.length}${isKnown(violation.id, name) ? ' (known)' : ''}`).join(', ')}`
            : `axe ${label} (${theme}): clean`,
        );
        expect(details, `${label} (${theme}): ${unexpected.length} axe violation(s) not in the allowlist`).toEqual([]);
      };

      await scan(name);

      for (const tab of TABS[name] ?? []) {
        await page.getByRole('tab', { name: tab }).click();
        await expect(page.getByRole('tabpanel')).toBeVisible();
        await scan(`${name} ${tab}`);
      }

      // The approval drawer is its own surface and has never been scanned: open the seeded request.
      if (name === 'recommendation-detail') {
        await page.getByRole('button', { name: 'Review' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await scan(`${name} approval drawer`);
        await page.getByRole('button', { name: 'Close' }).click();
      }

      await context.close();
    }
  });
}

/** The signed-in person's own id. */
async function me(context: APIRequestContext) {
  const response = await context.get('/api/auth/get-session');
  const body = (await response.json()) as { user?: { id: string } };
  return body.user?.id ?? null;
}
