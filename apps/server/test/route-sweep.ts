import type { Hono } from 'hono';
import { BODY_LIMIT_BYTES } from '../src/http/body-limit';

// #932: an app-wide check that every route which can read a request body is guarded by a bodyLimit.
// `ALL` registrations (app.all and app.use) count as body readers: a middleware that parses JSON is
// as dangerous as an endpoint that does. The only exception is the app-wide `/*` chain, which is
// observability/security/static middleware rather than a request handler; it is listed with its
// reason below so a new global middleware still needs a deliberate decision here.
//
// Ported from Agentic Marketing's `apps/server/test/route-sweep.ts`; the allow-list is ours, because
// the marketing product's ingest, webhook, SCIM and confirmation routes are not ported.

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'ALL']);

/** Registrations that never read a request body, with the reason. */
export const NO_BODY_READ = new Map([
  ['ALL /oauth', 'API-root 404 for unknown OAuth paths: it answers from the URL and never reads a body (#751)'],
  ['ALL /oauth/*', 'API-root 404 for unknown OAuth paths: it answers from the URL and never reads a body (#751)'],
  [
    'ALL /*',
    'the app-wide middleware chain (metrics, security headers, static files): it observes or rejects requests and never parses a body; every endpoint below still needs its own guard',
  ],
]);

/**
 * A body guard's limit, unwrapping Hono's composed handler. A sub-app with its own onError
 * handler keeps the original handler on __COMPOSED_HANDLER, so walk that chain first.
 */
export function routeLimitOf(handler: unknown): number | undefined {
  let current = handler as (Record<PropertyKey, unknown> & { __COMPOSED_HANDLER?: unknown }) | undefined;
  for (let i = 0; current && i < 10; i += 1) {
    const limit = current[BODY_LIMIT_BYTES] as number | undefined;
    if (limit !== undefined) return limit;
    current = current.__COMPOSED_HANDLER as typeof current;
  }
  return undefined;
}

/** Whether a guard registered on `guardPath` also runs for `routePath` (Hono's trailing `*`). */
function covers(guardPath: string, routePath: string): boolean {
  if (guardPath === routePath || guardPath === '*' || guardPath === '/*') return true;
  if (guardPath.endsWith('/*')) return routePath.startsWith(guardPath.slice(0, -1));
  if (guardPath.endsWith('*')) return routePath.startsWith(guardPath.slice(0, -1));
  return false;
}

/** Route registrations (method + path) that accept a body but have no guard before them. */
export function findUnboundedRoutes(app: Hono): string[] {
  const guards: { method: string; path: string }[] = [];
  const unbounded = new Set<string>();
  for (const route of app.routes) {
    if (routeLimitOf(route.handler) !== undefined) {
      guards.push({ method: route.method, path: route.path });
      continue;
    }
    if (!BODY_METHODS.has(route.method)) continue;
    const guarded = guards.some(
      (guard) =>
        guard.path !== '*' &&
        guard.path !== '/*' &&
        (guard.method === 'ALL' || guard.method === route.method) &&
        covers(guard.path, route.path),
    );
    const key = `${route.method} ${route.path}`;
    if (!guarded && !NO_BODY_READ.has(key)) unbounded.add(key);
  }
  return [...unbounded];
}
