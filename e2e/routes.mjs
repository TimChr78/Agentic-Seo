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
 * Every screen Phase 0 has: the sign-in screen (signed out), the first-run screen (a workspace with
 * no site yet) and every destination in the navigation, signed in as the owner.
 */
export function allRoutes() {
  return [
    { name: 'signin', path: '/', signedOut: true },
    { name: 'no-site', path: '/', person: 'noSites' },
    { name: 'no-workspace', path: '/', person: 'noWorkspace' },
    ...navPaths().map((path) => ({ name: nameOf(path), path, person: 'owner' })),
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
