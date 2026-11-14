import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { BASE, PEOPLE, settle, signIn } from './helpers';
import { buildMatrix, matrixNames } from './routes.mjs';

// Accessibility: axe-core over every Phase 0 screen (Phase 0 done criteria and DESIGN.md §7), light
// and dark at 1440 px, with the WCAG 2.1/2.2 A and AA rules. The spec fails on any violation that is
// not in e2e/axe-known-issues.json, and prints what it found by rule so the allowlist can shrink.
//
//   corepack pnpm e2e --project axe     # just this spec
//   corepack pnpm e2e                   # the functional suite and this spec
//
// It runs against the built UI on the real server, like the rest of the suite.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const THEMES = ['light', 'dark'] as const;

type KnownIssue = { rule: string; route: string; reason: string };
const known = (JSON.parse(readFileSync(join(process.cwd(), 'e2e/axe-known-issues.json'), 'utf8')) as { issues: KnownIssue[] }).issues;

type Route = { name: string; path: string; signedOut?: boolean; person?: keyof typeof PEOPLE };
const matrix = buildMatrix() as Route[];

/** What the run found, by rule, so the summary names the remaining work. */
const summary = new Map<string, { impact: string; routes: Set<string>; nodes: number; known: boolean }>();

const isKnown = (rule: string, route: string) =>
  known.some((issue) => issue.rule === rule && (issue.route === '*' || issue.route === route));

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

for (const name of matrixNames()) {
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
          ? `axe ${name} (${theme}): ${violations.map((violation) => `${violation.id} ×${violation.nodes.length}${isKnown(violation.id, name) ? ' (known)' : ''}`).join(', ')}`
          : `axe ${name} (${theme}): clean`,
      );
      expect(details, `${name} (${theme}): ${unexpected.length} axe violation(s) not in the allowlist`).toEqual([]);

      await context.close();
    }
  });
}
