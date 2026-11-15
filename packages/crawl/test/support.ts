import { type AnyCommand, createExecutor, userPrincipal } from '@agentic-seo/commands';
import { newUuid } from '@agentic-seo/core';
import { createDb, type Db } from '@agentic-seo/db';
import { APP_ROLE, createDisposableDb, type DisposableDb } from '../../db/test/disposable';
import {
  type CrawlChunkResult,
  nextChunkNumber,
  PgHostLimiter,
  resetRobotsCache,
  resetSeedRobotsCache,
  runCrawlChunk,
  sectionOf,
  setCrawlFetchSeams,
  urlHash,
} from '../src';
import type { FixtureSite } from './fixture';

// Shared setup for the crawl integration tests: a disposable migrated database, an executor for the
// commands, a verified site, and a `drainAudit` helper that runs chunks until the audit is finished.

export const appUrl = (url: URL): string => {
  const copy = new URL(url.toString());
  copy.username = APP_ROLE.appRole;
  copy.password = APP_ROLE.appRolePassword;
  return copy.toString();
};

export const services = { serverVersion: 'test', strictInputs: false };

export interface CrawlTestContext {
  disposable: DisposableDb;
  db: Db;
  executor: ReturnType<typeof createExecutor>;
}

export async function createCrawlTestContext(prefix: string): Promise<CrawlTestContext> {
  const disposable = await createDisposableDb(prefix);
  const db = createDb({ adminUrl: disposable.url.toString(), appUrl: appUrl(disposable.url), poolSize: 4 });
  const executor = createExecutor(db, services);
  return { disposable, db, executor };
}

/** Installs the fixture's fetch seams; call `useFixture` in `beforeAll` and reset in `afterEach`. */
export function useFixture(fixture: FixtureSite, httpPort = true): void {
  setCrawlFetchSeams({
    resolver: fixture.resolver,
    allow: fixture.allow,
    ca: fixture.certificate,
    sitePort: fixture.port,
    ...(httpPort ? { httpPort: fixture.httpPort } : {}),
  });
  resetRobotsCache();
  resetSeedRobotsCache();
}

/** Removes the fixture seams and both robots caches. */
export function clearFixture(): void {
  setCrawlFetchSeams(null);
  resetRobotsCache();
  resetSeedRobotsCache();
}

/** A verified site row, inserted as the owner (tests only; the command path is exercised elsewhere). */
export async function addSite(
  db: Db,
  workspaceId: string,
  options: { domain: string; hosts?: string[]; verified?: boolean; archived?: boolean } = { domain: 'example.com' },
): Promise<string> {
  const id = newUuid();
  await db.admin.query(
    `INSERT INTO sites (workspace_id, id, name, primary_domain, hosts, verification_token, verified_at, archived)
     VALUES ($1, $2, $3, $4, $5, 'test-token', $6, $7)`,
    [
      workspaceId,
      id,
      options.domain,
      options.domain,
      options.hosts ?? [],
      options.verified === false ? null : new Date(),
      options.archived ?? false,
    ],
  );
  return id;
}

export async function auditRow(db: Db, workspaceId: string, auditId: string) {
  const { rows } = await db.admin.query('SELECT * FROM audits WHERE workspace_id = $1 AND id = $2', [workspaceId, auditId]);
  return rows[0] as Record<string, unknown> | undefined;
}

export async function frontierRows(db: Db, workspaceId: string, auditId: string) {
  const { rows } = await db.admin.query<{
    url: string;
    url_hash: string;
    state: string;
    skip_reason: string | null;
    depth: number | null;
    discovered_by: string;
    in_sitemap: boolean;
    attempts: number;
  }>(
    `SELECT url, url_hash, state, skip_reason, depth, discovered_by, in_sitemap, attempts
     FROM crawl_frontier WHERE workspace_id = $1 AND audit_id = $2 ORDER BY url`,
    [workspaceId, auditId],
  );
  return rows;
}

export async function snapshotRows(db: Db, workspaceId: string, auditId: string) {
  const { rows } = await db.admin.query<{ id: string; url: string; status: number; facts: Record<string, unknown> }>(
    'SELECT id, url, status, facts FROM page_snapshots WHERE workspace_id = $1 AND audit_id = $2 ORDER BY url',
    [workspaceId, auditId],
  );
  return rows;
}

export interface FrontierSeedRow {
  url: string;
  state?: 'pending' | 'leased' | 'crawled' | 'skipped';
  skipReason?: string | null;
  depth?: number | null;
  section?: string;
  discoveredBy?: 'seed' | 'link' | 'sitemap' | 'redirect' | 'list';
  inSitemap?: boolean;
}

/**
 * Replaces an audit's frontier with the exact rows a test needs. A crawl test that arranges a
 * frontier shape (quota pressure, a specific next URL) does it as the owner, before the chunk under
 * test runs; the chunk itself is still the public entry point.
 */
export async function setFrontier(db: Db, workspaceId: string, auditId: string, rows: readonly FrontierSeedRow[]): Promise<void> {
  await db.admin.query('DELETE FROM crawl_frontier WHERE workspace_id = $1 AND audit_id = $2', [workspaceId, auditId]);
  // The frontier is now exactly what the test arranged: mark the audit seeded so the chunk's
  // crawl_seed step does not add the fixture's sitemap URLs back into it.
  await db.admin.query('UPDATE audits SET seeded_at = coalesce(seeded_at, now()) WHERE workspace_id = $1 AND id = $2', [
    workspaceId,
    auditId,
  ]);
  for (const row of rows) {
    await db.admin.query(
      `INSERT INTO crawl_frontier
         (workspace_id, audit_id, url_hash, url, state, skip_reason, depth, discovered_by, in_sitemap, section)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        workspaceId,
        auditId,
        urlHash(row.url),
        row.url,
        row.state ?? 'pending',
        row.skipReason ?? null,
        row.depth === undefined ? 1 : row.depth,
        row.discoveredBy ?? 'link',
        row.inSitemap ?? false,
        row.section ?? sectionOf(row.url),
      ],
    );
  }
}

export function limiterFor(db: Db, owner = 'crawl-test'): PgHostLimiter {
  return new PgHostLimiter(db, { owner, minDelayMs: 0, pollIntervalMs: 5, leaseTtlMs: 60_000 });
}

const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled']);

/**
 * Runs chunks until the audit reaches a terminal state, or nothing more can happen. The engine
 * enqueues its successor through `enqueueNext`; here the test is the queue, which keeps the loops
 * explicit and lets a test inspect each chunk's result.
 */
export async function drainAudit(
  db: Db,
  workspaceId: string,
  auditId: string,
  options: { limiter?: PgHostLimiter; maxChunks?: number; softDeadlineMs?: number } = {},
): Promise<CrawlChunkResult[]> {
  const limiter = options.limiter ?? limiterFor(db);
  const results: CrawlChunkResult[] = [];
  for (let index = 0; index < (options.maxChunks ?? 60); index += 1) {
    const chunk = await nextChunkNumber(db);
    const result = await runCrawlChunk(
      db,
      { workspaceId, auditId, chunk },
      { limiter, version: 'test', softDeadlineMs: options.softDeadlineMs ?? 120_000 },
    );
    results.push(result);
    const audit = await auditRow(db, workspaceId, auditId);
    if (audit && TERMINAL.has(String(audit.state))) break;
    if (result.leased === 0 && !result.finalized) break;
  }
  return results;
}

export const ownerPrincipal = (workspaceId: string) => userPrincipal('user_owner', workspaceId, 'owner');

export const run = <C extends AnyCommand>(
  executor: ReturnType<typeof createExecutor>,
  command: C,
  input: unknown,
  principal = ownerPrincipal(''),
) => executor.execute(command, input, principal, { surface: 'rest' });
