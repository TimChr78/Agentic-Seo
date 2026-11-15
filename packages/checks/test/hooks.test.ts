import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDatabase } from '../../db/test/disposable';
import { checkAuditHooks } from '../src';
import { type AuditTestContext, addSite, createAuditTestContext, goodPage } from './support';

// The page hook is idempotent (a retried chunk must not duplicate evidence) and exact (a page that
// stops failing loses the finding, not just gains no new one).

const url = (path: string): string => `https://example.com${path}`;

describe.skipIf(!hasTestDatabase())('the page hook', () => {
  let ctx: AuditTestContext;
  let ws = '';
  let siteId = '';
  let auditId = '';

  beforeAll(async () => {
    ctx = await createAuditTestContext('checks_hooks');
    ws = ctx.disposable.workspace;
    siteId = await addSite(ctx.db, ws);
    auditId = 'adt_p1e_hooks';
    await ctx.db.admin.query(
      `INSERT INTO audits (workspace_id, id, site_id, scope, state, requested_by_type, requested_by_id)
       VALUES ($1, $2, $3, 'site', 'running', 'user', 'seed-user')`,
      [ws, auditId, siteId],
    );
  }, 120_000);

  afterAll(async () => {
    ctx?.dispose();
    await ctx?.disposable.close();
  });

  const store = (facts: ReturnType<typeof goodPage>) =>
    ctx.db.withWorkspace(ws, (tx) =>
      checkAuditHooks().onPage!(tx, { workspaceId: ws, siteId, auditId }, { ...facts, snapshotId: 'snp_test' }),
    );

  const count = async (subject: string) => {
    const { rows } = await ctx.db.admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM findings WHERE workspace_id = $1 AND audit_id = $2 AND subject_key = $3',
      [ws, auditId, subject],
    );
    return Number(rows[0]?.n ?? 0);
  };

  it('stores one finding per failing check, however many times the page is stored', async () => {
    const page = goodPage(url('/retry'), { html: { title: null } });
    await store(page);
    await store(page);
    await store(page);
    expect(await count(url('/retry'))).toBe(1);
    const { rows } = await ctx.db.admin.query<{ id: string; check_id: string }>(
      'SELECT id, check_id FROM findings WHERE workspace_id = $1 AND audit_id = $2 AND subject_key = $3',
      [ws, auditId, url('/retry')],
    );
    expect(rows).toEqual([expect.objectContaining({ check_id: 'title.missing' })]);
    expect(rows[0]?.id).toMatch(/^fnd_[0-9a-f]{32}$/);
  });

  it('removes the finding when a later store of the same page passes', async () => {
    const subject = url('/fixed');
    await store(goodPage(subject, { html: { title: null } }));
    expect(await count(subject)).toBe(1);
    await store(goodPage(subject, { html: { title: 'A title that says what the page is' } }));
    expect(await count(subject)).toBe(0);
  });
});
