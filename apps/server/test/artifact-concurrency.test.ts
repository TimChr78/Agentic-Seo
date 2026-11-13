import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejects, startTestServer, testPort, type User } from './harness';

// What must hold when two requests touch one artifact at the same moment: a publish decides on the
// content that goes live, an artifact has one published version, and a site has one site context.
// A second connection holds the artifact's row lock to place the other request exactly where the
// race would be.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let editor: User;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  t = await startTestServer('test_artifact_concurrency', testPort(3404));
  owner = await t.signUp(`conc-owner-${Date.now()}@example.com`);
  editor = await t.signUp(`conc-editor-${Date.now()}@example.com`);
}, 120_000);
afterAll(() => t?.close());

describe('artifact concurrency', () => {
  it('a publish by a person waits for a concurrent edit and reviews what the agent wrote', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'agent_changes');
    const api = t.api(owner, ws);
    const note = await api.call('artifacts.create', { type: 'note', name: 'Raced note', content: { title: 'Mine', body: 'By a person' } });

    // An agent's edit that is still committing: it holds the artifact and has rewritten the draft.
    const edit = await t.srv.db.admin.connect();
    let publishing: Promise<{ status: string }>;
    try {
      await edit.query('BEGIN');
      await edit.query('SELECT 1 FROM artifacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [ws, note.artifactId]);
      await edit.query(
        `UPDATE artifact_versions SET content = $3::jsonb, content_hash = 'agent-edit', author_type = 'agent', author_client = 'token:x'
          WHERE workspace_id = $1 AND artifact_id = $2 AND number = 1`,
        [ws, note.artifactId, JSON.stringify({ title: 'Agent', body: 'By an agent' })],
      );
      publishing = api.call('artifacts.requestPublish', { artifactId: note.artifactId, note: 'publish my own edit' });
      await pause(400);
      await edit.query('COMMIT');
    } finally {
      edit.release();
    }
    const result = await publishing;
    // Under `agent_changes` an agent's content needs a person's review; it must not go live on the
    // strength of the person's earlier draft.
    expect(result.status).toBe('in_review');
    const after = await api.call('artifacts.get', { artifactId: note.artifactId });
    expect(after.publishedVersion).toBeNull();
    expect(after.version.content).toMatchObject({ title: 'Agent' });
  });

  it('two approvals of one artifact leave exactly one published version', async () => {
    const ws = await t.workspaceWith(
      [
        [owner, 'owner'],
        [editor, 'editor'],
      ],
      'all_publishes',
    );
    const asEditor = t.api(editor, ws);
    const asOwner = t.api(owner, ws);
    const note = await asEditor.call('artifacts.create', { type: 'note', name: 'Twice', content: { title: 'v1', body: 'one' } });
    const first = await asEditor.call('artifacts.requestPublish', { artifactId: note.artifactId, note: 'first' });
    await asEditor.call('artifacts.updateDraft', { artifactId: note.artifactId, content: { title: 'v2', body: 'two' } });
    const second = await asEditor.call('artifacts.requestPublish', { artifactId: note.artifactId, note: 'second' });
    expect([first.version, second.version]).toEqual([1, 2]);

    const hold = await t.srv.db.admin.connect();
    let approvals: Promise<unknown[]>;
    try {
      await hold.query('BEGIN');
      await hold.query('SELECT 1 FROM artifacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [ws, note.artifactId]);
      approvals = Promise.all([
        asOwner.call('approvals.approve', { approvalId: first.approvalId! }),
        asOwner.call('approvals.approve', { approvalId: second.approvalId! }),
      ]);
      await pause(400);
      await hold.query('COMMIT');
    } finally {
      hold.release();
    }
    await approvals;
    const { rows: published } = await t.srv.db.admin.query<{ number: number }>(
      `SELECT number FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2 AND state = 'published'`,
      [ws, note.artifactId],
    );
    const { rows: pointer } = await t.srv.db.admin.query<{ published_version: number }>(
      'SELECT published_version FROM artifacts WHERE workspace_id = $1 AND id = $2',
      [ws, note.artifactId],
    );
    expect(published).toHaveLength(1);
    expect(published[0]?.number).toBe(pointer[0]?.published_version);
  });

  it('a site has one site context when two are created at once', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const create = () =>
      api.call('artifacts.create', { type: 'site_context', name: 'Site context', content: { businessOverview: 'A news site.' } });
    const results = await Promise.allSettled([create(), create(), create()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'conflict' });
    const { rows } = await t.srv.db.admin.query(`SELECT id FROM artifacts WHERE workspace_id = $1 AND type = 'site_context'`, [ws]);
    expect(rows).toHaveLength(1);
  });

  it('the database refuses a second site context whatever the application checked', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const insert = (id: string) =>
      t.srv.db.admin.query(`INSERT INTO artifacts (workspace_id, id, type, name, latest_version) VALUES ($1, $2, 'site_context', 'x', 1)`, [
        ws,
        id,
      ]);
    await insert(`sct_${'1'.repeat(32)}`);
    await expect(insert(`sct_${'2'.repeat(32)}`)).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses a bundle with two site contexts for one site', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const entry = (c: string) => ({
      id: `sct_${c.repeat(32)}`,
      type: 'site_context' as const,
      name: `Context ${c}`,
      content: { businessOverview: 'A news site.' },
    });
    const bundle = { format: 'agentic-seo/artifacts@1' as const, artifacts: [entry('a'), entry('b')] };
    const e = await rejects(api.call('config.import', { bundle: bundle as never, dryRun: false }));
    expect(e.code).toBe('invalid_input');
    expect(e.message).toContain('A site has one');
    const { rows } = await t.srv.db.admin.query(`SELECT id FROM artifacts WHERE workspace_id = $1 AND type = 'site_context'`, [ws]);
    expect(rows).toHaveLength(0);
  });
});
