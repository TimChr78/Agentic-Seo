// The Phase 0 route matrix for the axe scan. Plain ESM with no dependencies, so the spec can import
// it and a future screenshot script can reuse it.
//
// The signed-in paths are read from `apps/web/src/app/nav.ts` (the information architecture is the
// source), so a new destination is scanned without editing this file. The signed-out screen and the
// first-run screen are the two states no navigation entry reaches.

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
 * The detail screens a navigation entry does not reach. The ids are the shapes the commands accept,
 * so the screen renders its own "couldn’t open this" state rather than a crash; the seeded thin loop
 * (e2e/seed.ts) uses these same ids, so a run after it scans the populated screens too.
 */
const DETAILS = [
  { name: 'recommendations', path: '/recommendations' },
  { name: 'audit-detail', path: '/audits/adt_0000000000000000000000000000thin' },
  { name: 'issue-detail', path: '/issues/iss_0000000000000000000000000000thin' },
  { name: 'recommendation-detail', path: '/recommendations/rcm_00000000000000000000000000000000' },
  { name: 'change-detail', path: '/changes/chg_00000000000000000000000000000000' },
];

/**
 * Every screen the app has: the sign-in screen (signed out), the first-run screens (a workspace with
 * no site, an account with no workspace), every destination in the navigation, and the detail and
 * list screens no navigation entry names, signed in as the owner.
 */
export function allRoutes() {
  return [
    { name: 'signin', path: '/', signedOut: true },
    { name: 'no-site', path: '/', person: 'noSites' },
    { name: 'no-workspace', path: '/', person: 'noWorkspace' },
    ...navPaths().map((path) => ({ name: nameOf(path), path, person: 'owner' })),
    ...DETAILS.map((route) => ({ ...route, person: 'owner' })),
  ];
}

/** The same list, deduplicated by route name: `/` appears as three states. */
export function buildMatrix() {
  const seen = new Set();
  return allRoutes().filter((route) => !seen.has(route.name) && seen.add(route.name));
}

/** The route names, so the spec can declare one test per route before anything is loaded. */
export function matrixNames() {
  return buildMatrix().map((route) => route.name);
}
