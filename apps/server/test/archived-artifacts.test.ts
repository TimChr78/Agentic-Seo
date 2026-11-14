import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejects, startTestServer, testPort, type User } from './harness';

// #900 and #899: no publish path may put a version live on an archived artifact, an approval that
// names one is closed as rejected with the reason, and archived singletons neither block a new one
// nor resolve as the workspace's current configuration.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let approver: User;

beforeAll(async () => {
  t = await startTestServer('test_archived_artifacts', testPort(3411));
  owner = await t.signUp(`archived-owner-${Date.now()}@example.com`);
  approver = await t.signUp(`archived-approver-${Date.now()}@example.com`);
}, 120_000);
afterAll(() => t?.close());

const note = (title: string) => ({ title, body: 'Written for the archived-artifact test.' });
const archive = (ws: string, id: string) =>
  t.srv.db.admin.query('UPDATE artifacts SET archived = true WHERE workspace_id = $1 AND id = $2', [ws, id]);
const artifactRow = async (ws: string, id: string) =>
  (
    await t.srv.db.admin.query<{ archived: boolean; published_version: number | null }>(
      'SELECT archived, published_version FROM artifacts WHERE workspace_id = $1 AND id = $2',
      [ws, id],
    )
  ).rows[0];

describe('an archived artifact cannot be published (#900)', () => {
  it('requestPublish refuses it and creates no request', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'all_publishes');
    const api = t.api(owner, ws);
    const created = await api.call('artifacts.create', { type: 'note', name: 'Archived note', content: note('Body') });
    await archive(ws, created.artifactId);

    const err = await rejects(api.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'Publish me' }));
    expect(err.code).toBe('conflict');
    expect(err.message).toContain(created.artifactId);
    expect(err.message).toMatch(/archived/);

    const { rows } = await t.srv.db.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM approval_requests WHERE workspace_id = $1 AND artifact_id = $2',
      [ws, created.artifactId],
    );
    expect(rows[0]?.n).toBe(0);
    expect(await artifactRow(ws, created.artifactId)).toMatchObject({ archived: true, published_version: null });
  });

  it('requestPublishBundle refuses a bundle with an archived member', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'all_publishes');
    const api = t.api(owner, ws);
    const first = await api.call('artifacts.create', { type: 'note', name: 'Bundle one', content: note('One') });
    const second = await api.call('artifacts.create', { type: 'note', name: 'Bundle two', content: note('Two') });
    await archive(ws, second.artifactId);

    const err = await rejects(
      api.call('artifacts.requestPublishBundle', { artifactIds: [first.artifactId, second.artifactId], note: 'Both' }),
    );
    expect(err.code).toBe('conflict');
    expect(err.message).toContain(second.artifactId);
    const { rows } = await t.srv.db.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM approval_requests WHERE workspace_id = $1 AND artifact_id = ANY($2::text[])',
      [ws, [first.artifactId, second.artifactId]],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('approving a request for an archived artifact closes it as rejected with the reason', async () => {
    const ws = await t.workspaceWith(
      [
        [owner, 'owner'],
        [approver, 'approver'],
      ],
      'all_publishes',
    );
    const api = t.api(owner, ws);
    const approverApi = t.api(approver, ws);
    const created = await api.call('artifacts.create', { type: 'note', name: 'Pending note', content: note('Body') });
    const request = await api.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'Review me' });
    expect(request.status).toBe('in_review');

    // The artifact is archived after the request was made (a duplicate import, or a restore).
    await archive(ws, created.artifactId);

    const out = await approverApi.call('approvals.approve', { approvalId: request.approvalId as string });
    expect(out.status).toBe('rejected');
    expect(out.published).toEqual([]);
    expect(out.reason).toContain(created.artifactId);
    expect(await artifactRow(ws, created.artifactId)).toMatchObject({ archived: true, published_version: null });

    const { rows } = await t.srv.db.admin.query<{ status: string; decision_note: string | null }>(
      'SELECT status, decision_note FROM approval_requests WHERE workspace_id = $1 AND id = $2',
      [ws, request.approvalId],
    );
    expect(rows[0]?.status).toBe('rejected');
    expect(rows[0]?.decision_note).toMatch(/archived/);
    const { rows: versions } = await t.srv.db.admin.query<{ state: string }>(
      'SELECT state FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2 AND number = $3',
      [ws, created.artifactId, request.version],
    );
    expect(versions[0]?.state).toBe('rejected');
  });

  it('lists archived rows only on request and marks them', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const active = await api.call('artifacts.create', { type: 'note', name: 'Active note', content: note('Active') });
    const archived = await api.call('artifacts.create', { type: 'note', name: 'Archived note', content: note('Archived') });
    await archive(ws, archived.artifactId);

    const byDefault = await api.call('artifacts.list', { type: 'note' });
    expect(byDefault.artifacts.map((a) => a.id)).toEqual([active.artifactId]);
    expect(byDefault.total).toBe(1);
    expect(byDefault.artifacts[0]?.archived).toBe(false);

    const all = await api.call('artifacts.list', { type: 'note', includeArchived: true });
    expect(all.artifacts.map((a) => a.id).sort()).toEqual([active.artifactId, archived.artifactId].sort());
    expect(all.total).toBe(2);
    expect(all.artifacts.find((a) => a.id === archived.artifactId)?.archived).toBe(true);
  });
});

describe('archived singletons (#899)', () => {
  const siteId = '33333333-3333-4333-8333-333333333333';
  const context = { businessOverview: 'A SaaS for SEO teams.' };

  it('lets a site create a new singleton after archiving the live one', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const first = await api.call('artifacts.create', {
      type: 'site_context',
      name: 'Old context',
      siteId,
      content: context,
    });
    expect((await api.call('artifacts.requestPublish', { artifactId: first.artifactId, note: 'v1' })).status).toBe('published');
    await archive(ws, first.artifactId);

    const second = await api.call('artifacts.create', {
      type: 'site_context',
      name: 'New context',
      siteId,
      content: { businessOverview: 'The replacement.' },
    });
    expect(second.artifactId).not.toBe(first.artifactId);
    const list = await api.call('artifacts.list', { type: 'site_context', siteId });
    expect(list.artifacts.map((a) => a.id)).toEqual([second.artifactId]);
  });

  it('refuses restoring an archived singleton while an active one exists, naming both', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const retained = await api.call('artifacts.create', { type: 'site_context', name: 'Retained', siteId, content: context });
    await archive(ws, retained.artifactId);
    const active = await api.call('artifacts.create', {
      type: 'site_context',
      name: 'Active',
      siteId,
      content: { businessOverview: 'The active one.' },
    });

    const bundle = {
      format: 'agentic-seo/artifacts@1' as const,
      artifacts: [{ id: retained.artifactId, type: 'site_context' as const, name: 'Retained', siteId, content: context }],
    };
    const err = await rejects(api.call('config.import', { bundle, dryRun: false }));
    expect(err.code).toBe('conflict');
    expect(err.message).toContain(retained.artifactId);
    expect(err.message).toContain(active.artifactId);
    expect(await artifactRow(ws, retained.artifactId)).toMatchObject({ archived: true, published_version: null });
  });

  it('restores an archived singleton unpublished, so its old version does not go live again', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const created = await api.call('artifacts.create', { type: 'site_context', name: 'Context', siteId, content: context });
    const published = await api.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'v1' });
    expect(published.status).toBe('published');
    await archive(ws, created.artifactId);

    const bundle = {
      format: 'agentic-seo/artifacts@1' as const,
      artifacts: [{ id: created.artifactId, type: 'site_context' as const, name: 'Context', siteId, content: context }],
    };
    const out = await api.call('config.import', { bundle, dryRun: false });
    // Restoring is a write even though the content is unchanged.
    expect(out.changes).toEqual([{ id: created.artifactId, type: 'site_context', name: 'Context', action: 'update' }]);
    expect(await artifactRow(ws, created.artifactId)).toMatchObject({ archived: false, published_version: null });
    const { rows } = await t.srv.db.admin.query<{ number: number; state: string }>(
      'SELECT number, state FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2 ORDER BY number',
      [ws, created.artifactId],
    );
    expect(rows).toEqual([{ number: 1, state: 'superseded' }]);
  });
});
