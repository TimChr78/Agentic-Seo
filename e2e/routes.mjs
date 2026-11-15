// The Phase 0 route matrix for the axe scan. Plain ESM with no dependencies, so the spec can import
// it and a future screenshot script can reuse it.
//
// The signed-in paths are read from `apps/web/src/app/nav.ts` (the information architecture is the
// source), so a new destination is scanned without editing this file. The signed-out screen and the
// first-run screen are the two states no navigation entry reaches.
//
// The detail routes take the ids the seed writes (`THIN_LOOP_IDS` in e2e/seed.ts), so the scan sees
// populated screens rather than "couldn't open this" states.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The nav paths, read from `nav.ts` so the information architecture stays the one source. */
export function navPaths() {
  const source = readFileSync(join(process.cwd(), 'apps/web/src/app/nav.ts'), 'utf8');
  return [...new Set([...source.matchAll(/\bpath:\s*'([^']+)'/g)].map((match) => match[1]))];
}

const NAMES = { '/': 'home', '/settings': 'settings', '/settings/site': 'site' };
const slug = (path) => path.replace(/^\//, '').replaceAll('/', '-');

export function nameOf(path) {
  return NAMES[path] ?? slug(path);
}

/**
 * The detail screens a navigation entry does not reach. The ids come from the seed, so a run after
 * it scans the populated screens — including the recommendation's pending approval drawer.
 */
export function detailRoutes(ids) {
  return [
    { name: 'recommendations', path: '/recommendations' },
    { name: 'audit-detail', path: `/audits/${ids.auditId}` },
    { name: 'issue-detail', path: `/issues/${ids.issueId}` },
    { name: 'recommendation-detail', path: `/recommendations/${ids.recommendationId}` },
    { name: 'change-detail', path: `/changes/${ids.changeSetId}` },
  ];
}

/**
 * Every screen the app has: the sign-in screen (signed out), the first-run screens (a workspace with
 * no site, an account with no workspace), every destination in the navigation, and the detail and
 * list screens no navigation entry names, signed in as the owner.
 */
export function allRoutes(ids) {
  return [
    { name: 'signin', path: '/', signedOut: true },
    { name: 'no-site', path: '/', person: 'noSites' },
    { name: 'no-workspace', path: '/', person: 'noWorkspace' },
    ...navPaths().map((path) => ({ name: nameOf(path), path, person: 'owner' })),
    ...detailRoutes(ids).map((route) => ({ ...route, person: 'owner' })),
  ];
}

/** The same list, deduplicated by route name: `/` appears as three states. */
export function buildMatrix(ids) {
  const seen = new Set();
  return allRoutes(ids).filter((route) => !seen.has(route.name) && seen.add(route.name));
}

/** The route names, so the spec can declare one test per route before anything is loaded. */
export function matrixNames(ids) {
  return buildMatrix(ids).map((route) => route.name);
}
