import { randomBytes, randomUUID } from 'node:crypto';
import { createExecutor } from '@agentic-seo/commands';
import { finalizeAudit, type PageFacts, snapshotId, urlHash } from '@agentic-seo/crawl';
import { createDb, type Db } from '@agentic-seo/db';
import { APP_ROLE, createDisposableDb, type DisposableDb } from '../../db/test/disposable';
import { checkAuditHooks, registerCheckAuditHooks } from '../src';
import { type PageFactsOverrides, pageFacts, siteFacts } from './fixtures';

// Shared setup for the audit integration tests: a disposable migrated database, an executor, a
// verified site, and `seedAudit`, which arranges one audit's crawl tables exactly as a crawl would
// have left them and then calls the real `finalizeAudit` — the public entry point of the hooks.

export const services = { serverVersion: 'test', strictInputs: false, keyProvider: {} as never };

const appUrl = (url: URL): string => {
  const copy = new URL(url.toString());
  copy.username = APP_ROLE.appRole;
  copy.password = APP_ROLE.appRolePassword;
  return copy.toString();
};

export interface AuditTestContext {
  disposable: DisposableDb;
  db: Db;
  executor: ReturnType<typeof createExecutor>;
  /** Unregisters the check hooks; call in afterAll. */
  dispose: () => void;
}

export async function createAuditTestContext(prefix: string): Promise<AuditTestContext> {
  const disposable = await createDisposableDb(prefix);
  const db = createDb({ adminUrl: disposable.url.toString(), appUrl: appUrl(disposable.url), poolSize: 4 });
  const dispose = registerCheckAuditHooks();
  return { disposable, db, executor: createExecutor(db, services), dispose };
}

export async function addSite(db: Db, workspaceId: string, domain = 'example.com'): Promise<string> {
  const id = randomUUID();
  await db.admin.query(
    `INSERT INTO sites (workspace_id, id, name, primary_domain, hosts, verification_token, verified_at, archived)
     VALUES ($1, $2, $3, $4, '{}', 'test-token', now(), false)`,
    [workspaceId, id, domain, domain],
  );
  return id;
}

export interface SeedEdge {
  from: string;
  to: string;
  anchor?: string;
  internal?: boolean;
}

/** A frontier row the test adds beside the crawled pages, e.g. a robots skip or a truncation. */
export interface SeedFrontier {
  url: string;
  state: 'pending' | 'leased' | 'crawled' | 'skipped';
  skipReason?: string;
  depth?: number | null;
  inSitemap?: boolean;
  discoveredBy?: 'seed' | 'link' | 'sitemap' | 'redirect' | 'list';
  discoveredFrom?: string | null;
}

export interface SeedAuditInput {
  pages: readonly PageFacts[];
  edges?: readonly SeedEdge[];
  frontier?: readonly SeedFrontier[];
  scope?: 'site' | 'section' | 'list' | 'page';
  section?: string;
  urls?: string[];
  /** Run the page checks the way a chunk does; off only when a test seeds its own findings. */
  pageChecks?: boolean;
  /** Insert the snapshots and frontier rows in one statement each (thousands of pages). */
  bulk?: boolean;
  /** A site facts object to store, overriding the good default for the site's origin. */
  site?: ReturnType<typeof siteFacts>;
  limits?: { maxPages: number; maxDepth: number; maxDurationMs: number };
  /** Leave the audit running (the caller finalizes) so a test can time or measure that step. */
  finalize?: boolean;
}

let auditSequence = 0;

/** Seeds one running audit with its crawl tables, runs the page hooks, then finalizes it. */
export async function seedAudit(db: Db, workspaceId: string, siteId: string, input: SeedAuditInput): Promise<string> {
  auditSequence += 1;
  const auditId = `adt_p1e${Date.now().toString(36)}${auditSequence.toString(36)}${randomBytes(3).toString('hex')}`;
  const origin = input.site?.origin ?? 'https://example.com';
  const facts = input.site ?? siteFacts({ origin });
  await db.admin.query(
    `INSERT INTO audits (workspace_id, id, site_id, scope, section, urls, limits, state, requested_by_type, requested_by_id,
                         site_facts, seeded_at, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', 'user', 'seed-user', $8::jsonb, now(), now())`,
    [
      workspaceId,
      auditId,
      siteId,
      input.scope ?? 'site',
      input.section ?? null,
      input.urls ?? null,
      JSON.stringify(input.limits ?? { maxPages: 500, maxDepth: 10, maxDurationMs: 30 * 60 * 1000 }),
      JSON.stringify(facts),
    ],
  );
  for (const page of input.pages) {
    const hash = urlHash(page.url);
    if (input.bulk) continue;
    await db.admin.query(
      `INSERT INTO page_snapshots (workspace_id, id, site_id, audit_id, url, final_url, status, facts, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        workspaceId,
        snapshotId(auditId, hash),
        siteId,
        auditId,
        page.url,
        page.finalUrl,
        page.status,
        JSON.stringify(page),
        page.html?.contentHash ?? null,
      ],
    );
  }
  if (input.bulk && input.pages.length) {
    await db.admin.query(
      `INSERT INTO page_snapshots (workspace_id, id, site_id, audit_id, url, final_url, status, facts, content_hash)
       SELECT $1, unnest($2::text[]), $3, $4, unnest($5::text[]), unnest($6::text[]), unnest($7::int[]),
              unnest($8::jsonb[]), unnest($9::text[])`,
      [
        workspaceId,
        input.pages.map((page) => snapshotId(auditId, urlHash(page.url))),
        siteId,
        auditId,
        input.pages.map((page) => page.url),
        input.pages.map((page) => page.finalUrl),
        input.pages.map((page) => page.status),
        input.pages.map((page) => JSON.stringify(page)),
        input.pages.map((page) => page.html?.contentHash ?? null),
      ],
    );
  }
  const frontierRows: SeedFrontier[] = [
    ...input.pages.map((page) => ({
      url: page.url,
      state: 'crawled' as const,
      depth: page.depth,
      inSitemap: page.inSitemap,
      discoveredBy: page.discoveredBy,
      discoveredFrom: null,
    })),
    ...(input.frontier ?? []),
  ];
  if (input.bulk && frontierRows.length) {
    await db.admin.query(
      `INSERT INTO crawl_frontier (workspace_id, audit_id, url_hash, url, state, skip_reason, depth, discovered_by,
                                   discovered_from, in_sitemap, section)
       SELECT $1, $2, unnest($3::text[]), unnest($4::text[]), unnest($5::text[]), unnest($6::text[]), unnest($7::int[]),
              unnest($8::text[]), unnest($9::text[]), unnest($10::boolean[]), '/'
       ON CONFLICT (workspace_id, audit_id, url_hash) DO UPDATE SET in_sitemap = excluded.in_sitemap`,
      [
        workspaceId,
        auditId,
        frontierRows.map((row) => urlHash(row.url)),
        frontierRows.map((row) => row.url),
        frontierRows.map((row) => row.state),
        frontierRows.map((row) => row.skipReason ?? null),
        frontierRows.map((row) => (row.depth === undefined ? 1 : (row.depth ?? 1))),
        frontierRows.map((row) => row.discoveredBy ?? 'link'),
        frontierRows.map((row) => row.discoveredFrom ?? null),
        frontierRows.map((row) => row.inSitemap ?? false),
      ],
    );
  }
  for (const row of input.bulk ? [] : frontierRows) {
    await db.admin.query(
      `INSERT INTO crawl_frontier (workspace_id, audit_id, url_hash, url, state, skip_reason, depth, discovered_by,
                                   discovered_from, in_sitemap, section)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '/')
       ON CONFLICT (workspace_id, audit_id, url_hash) DO UPDATE SET in_sitemap = excluded.in_sitemap`,
      [
        workspaceId,
        auditId,
        urlHash(row.url),
        row.url,
        row.state,
        row.skipReason ?? null,
        row.depth === undefined ? 1 : row.depth,
        row.discoveredBy ?? 'link',
        row.discoveredFrom ?? null,
        row.inSitemap ?? false,
      ],
    );
  }
  for (const edge of input.bulk ? [] : (input.edges ?? [])) {
    await db.admin.query(
      `INSERT INTO link_edges (workspace_id, audit_id, from_url_hash, to_url_hash, to_url, rel, anchor, internal)
       VALUES ($1, $2, $3, $4, $5, '{}', $6, $7)
       ON CONFLICT (workspace_id, audit_id, from_url_hash, to_url_hash) DO NOTHING`,
      [workspaceId, auditId, urlHash(edge.from), urlHash(edge.to), edge.to, edge.anchor ?? 'link', edge.internal ?? true],
    );
  }
  if (input.bulk && input.edges?.length) {
    await db.admin.query(
      `INSERT INTO link_edges (workspace_id, audit_id, from_url_hash, to_url_hash, to_url, rel, anchor, internal)
       SELECT $1, $2, unnest($3::text[]), unnest($4::text[]), unnest($5::text[]), '{}', unnest($6::text[]),
              unnest($7::boolean[])
       ON CONFLICT (workspace_id, audit_id, from_url_hash, to_url_hash) DO NOTHING`,
      [
        workspaceId,
        auditId,
        input.edges.map((edge) => urlHash(edge.from)),
        input.edges.map((edge) => urlHash(edge.to)),
        input.edges.map((edge) => edge.to),
        input.edges.map((edge) => edge.anchor ?? 'link'),
        input.edges.map((edge) => edge.internal ?? true),
      ],
    );
  }

  if (input.pageChecks !== false) {
    // The page hooks run where a chunk would run them: inside the tenant transaction, against the
    // stored facts. That is what makes the noindex findings available to the finalize checks.
    const hook = checkAuditHooks();
    for (const page of input.pages) {
      await db.withWorkspace(workspaceId, (tx) =>
        hook.onPage!(tx, { workspaceId, siteId, auditId }, { ...page, snapshotId: snapshotId(auditId, urlHash(page.url)) }),
      );
    }
  }
  if (input.finalize !== false) await finalizeAudit(db, { workspaceId, auditId });
  return auditId;
}

/** The findings of one audit, filtered by check id. */
export async function findingsOf(db: Db, workspaceId: string, auditId: string, checkId?: string) {
  const { rows } = await db.admin.query<{ check_id: string; subject_key: string; evidence: unknown; issue_id: string | null }>(
    `SELECT check_id, subject_key, evidence, issue_id FROM findings
     WHERE workspace_id = $1 AND audit_id = $2 ${checkId ? 'AND check_id = $3' : ''} ORDER BY check_id, subject_key`,
    checkId ? [workspaceId, auditId, checkId] : [workspaceId, auditId],
  );
  return rows;
}

export async function issueRows(db: Db, workspaceId: string, siteId: string) {
  const { rows } = await db.admin.query<Record<string, unknown>>(
    `SELECT * FROM issues WHERE workspace_id = $1 AND site_id = $2 ORDER BY check_id, subject_key`,
    [workspaceId, siteId],
  );
  return rows;
}

export async function scoreRow(db: Db, workspaceId: string, auditId: string) {
  const { rows } = await db.admin.query<Record<string, unknown>>('SELECT * FROM audit_scores WHERE workspace_id = $1 AND audit_id = $2', [
    workspaceId,
    auditId,
  ]);
  return rows[0];
}

/** A page that passes every page check by default, at `url`. */
export function goodPage(url: string, overrides: PageFactsOverrides = {}): PageFacts {
  return pageFacts({ url, finalUrl: url, ...overrides, html: { canonical: url, ...(overrides.html ?? {}) } });
}
