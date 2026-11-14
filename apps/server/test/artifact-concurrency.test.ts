import { singletonLockKey } from '@agentic-seo/artifacts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// What must hold when two requests touch one artifact at the same moment: a publish decides on the
// content that goes live, an artifact has one published version, and a site has one site context.
// A second connection holds a lock to place the other requests exactly where the race would be, and
// releases it only once the database reports them waiting, so no test depends on timing.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let editor: User;

/** The backend holding the lock in `holding`, so `blocked` counts only sessions waiting for it. */
let holderPid = 0;

/**
 * Resolves once `n` sessions are waiting for a lock the holding connection has, directly or queued
 * behind another session that is (a second request for one row waits in line behind the first).
 */
const blocked = (n: number) =>
  eventually(
    async () =>
      Number(
        (
          await t.srv.db.admin.query<{ n: string }>(
            `WITH waiting AS (
               SELECT pid, pg_blocking_pids(pid) AS behind FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'
             ), direct AS (SELECT pid FROM waiting WHERE $1::int = ANY (behind))
             SELECT count(*) AS n FROM waiting
              WHERE $1::int = ANY (behind) OR behind && ARRAY(SELECT pid FROM direct)`,
            [holderPid],
          )
        ).rows[0]?.n,
      ),
    (waiting) => waiting >= n,
  ).then((waiting) => expect(waiting).toBeGreaterThanOrEqual(n));

/** Whether a third session could take this lock right now (it is rolled back at once). */
async function free(sql: string, params: unknown[]): Promise<boolean> {
  const client = await t.srv.db.admin.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ free?: boolean }>(sql, params);
    return rows[0]?.free ?? true;
  } catch (err) {
    if ((err as { code?: string }).code === '55P03') return false;
    throw err;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}
const rowFree = (ws: string, id: string) => free('SELECT 1 FROM artifacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE NOWAIT', [ws, id]);
const advisoryFree = (key: string) => free('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS free', [key]);

/**
 * Runs `during` while a second connection holds whatever `take` locked, commits, and only then
 * waits for the requests `during` started (they are blocked until the commit).
 */
async function holding<T>(
  take: (q: (sql: string, params?: unknown[]) => Promise<unknown>) => Promise<void>,
  during: () => Promise<{ pending: Promise<T> }>,
): Promise<T> {
  const client = await t.srv.db.admin.connect();
  let started: { pending: Promise<T> };
  try {
    await client.query('BEGIN');
    holderPid = Number((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid);
    await take((sql, params) => client.query(sql, params));
    started = await during();
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return started.pending;
}

const advisory = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';

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
    const publishing = await holding(
      async (q) => {
        await q('SELECT 1 FROM artifacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [ws, note.artifactId]);
        await q(
          `UPDATE artifact_versions SET content = $3::jsonb, content_hash = 'agent-edit', author_type = 'agent', author_client = 'token:x'
            WHERE workspace_id = $1 AND artifact_id = $2 AND number = 1`,
          [ws, note.artifactId, JSON.stringify({ title: 'Agent', body: 'By an agent' })],
        );
      },
      async () => {
        const call = api.call('artifacts.requestPublish', { artifactId: note.artifactId, note: 'publish my own edit' });
        call.catch(() => {});
        await blocked(1);
        return { pending: call };
      },
    );
    // Under `agent_changes` an agent's content needs a person's review; it must not go live on the
    // strength of the person's earlier draft.
    expect((await publishing).status).toBe('in_review');
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

    const approvals = await holding(
      (q) => q('SELECT 1 FROM artifacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [ws, note.artifactId]).then(() => {}),
      async () => {
        const calls = Promise.allSettled([
          asOwner.call('approvals.approve', { approvalId: first.approvalId! }),
          asOwner.call('approvals.approve', { approvalId: second.approvalId! }),
        ]);
        await blocked(2);
        return { pending: calls };
      },
    );
    expect((await approvals).map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
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
    // Both creations are held at the singleton check, so neither has seen the other's row.
    const results = await holding(
      (q) => q(advisory, [singletonLockKey(ws, 'site_context', null)]).then(() => {}),
      async () => {
        const calls = Promise.allSettled([create(), create()]);
        await blocked(2);
        return { pending: calls };
      },
    );
    const settled = await results;
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of settled) if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'conflict' });
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

  const contextEntry = (c: string, overview = 'A news site.') => ({
    id: `sct_${c.repeat(32)}`,
    type: 'site_context' as const,
    name: `Context ${c}`,
    content: { businessOverview: overview },
  });
  const bundleOf = (artifacts: unknown[]) => ({ format: 'agentic-seo/artifacts@1' as const, artifacts }) as never;

  it('refuses a bundle with two site contexts for one site', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    await expect(
      api.call('config.import', { bundle: bundleOf([contextEntry('a'), contextEntry('b')]), dryRun: false }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('A site has one'),
    });
    const { rows } = await t.srv.db.admin.query(`SELECT id FROM artifacts WHERE workspace_id = $1 AND type = 'site_context'`, [ws]);
    expect(rows).toHaveLength(0);
  });

  it('an import updates a site context that another request created while it waited', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const existingId = `sct_${'c'.repeat(32)}`;
    const imported = await holding(
      async (q) => {
        await q(advisory, [singletonLockKey(ws, 'site_context', null)]);
        await q(`INSERT INTO artifacts (workspace_id, id, type, name, latest_version) VALUES ($1, $2, 'site_context', 'First', 1)`, [
          ws,
          existingId,
        ]);
        await q(
          `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
           VALUES ($1, $2, 1, 'draft', $3::jsonb, 'seed', 'user', $4)`,
          [ws, existingId, JSON.stringify({ businessOverview: 'First.' }), owner.id],
        );
      },
      async () => {
        const call = api.call('config.import', { bundle: bundleOf([contextEntry('d', 'Second.')]), dryRun: false });
        call.catch(() => {});
        await blocked(1);
        return { pending: call };
      },
    );
    expect((await imported).changes).toMatchObject([{ id: existingId, action: 'update' }]);
    const { rows } = await t.srv.db.admin.query(`SELECT id FROM artifacts WHERE workspace_id = $1 AND type = 'site_context'`, [ws]);
    expect(rows).toEqual([{ id: existingId }]);
  });

  it('two imports of the same artifacts in opposite orders both finish', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const make = async (name: string) =>
      (await api.call('artifacts.create', { type: 'note', name, content: { title: name, body: 'before' } })).artifactId;
    const [a, b] = [await make('One'), await make('Two')].sort();
    const entry = (id: string, body: string) => ({ id, type: 'note' as const, name: id.slice(0, 8), content: { title: 'Imported', body } });
    const settled = await holding(
      (q) => q('SELECT 1 FROM artifacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [ws, a]).then(() => {}),
      async () => {
        // The first import waits for `a` holding nothing; the second takes `b` first in bundle order.
        const forward = api.call('config.import', { bundle: bundleOf([entry(a!, 'x'), entry(b!, 'x')]), dryRun: false });
        forward.catch(() => {});
        await blocked(1);
        const backward = api.call('config.import', { bundle: bundleOf([entry(b!, 'y'), entry(a!, 'y')]), dryRun: false });
        backward.catch(() => {});
        await blocked(2);
        return { pending: Promise.allSettled([forward, backward]) };
      },
    );
    expect((await settled).map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
  });

  it('an agent has one active mandate when two are published at once', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const token = (await api.call('apiTokens.create', { name: 'Mandated agent', scopes: ['artifacts:read'] })).token;
    const me = await fetch(`${t.base}/v1/whoami`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{}',
    });
    const agentId = ((await me.json()) as { agent: { id: string } }).agent.id;
    const mandate = async (name: string) =>
      (
        await api.call('artifacts.create', {
          type: 'agent_mandate',
          name,
          content: { agent: agentId, purpose: name, expires: new Date(Date.now() + 30 * 86_400_000).toISOString() },
        })
      ).artifactId;
    const ids = [await mandate('First mandate'), await mandate('Second mandate')];
    const settled = await holding(
      (q) => q(advisory, [`agent-mandate:${ws}:${agentId}`]).then(() => {}),
      async () => {
        const calls = Promise.allSettled(ids.map((artifactId) => api.call('artifacts.requestPublish', { artifactId, note: 'grant' })));
        await blocked(2);
        return { pending: calls };
      },
    );
    const results = await settled;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results)
      if (r.status === 'rejected')
        expect(r.reason).toMatchObject({ code: 'invalid_input', message: expect.stringContaining('already has an active mandate') });
    const { rows } = await t.srv.db.admin.query(
      `SELECT id FROM artifacts WHERE workspace_id = $1 AND type = 'agent_mandate' AND published_version IS NOT NULL`,
      [ws],
    );
    expect(rows).toHaveLength(1);
  });

  it('two imports creating the same new artifacts in opposite orders both finish', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const [a, b] = [`not_${'1'.repeat(32)}`, `not_${'2'.repeat(32)}`];
    const entry = (id: string) => ({ id, type: 'note' as const, name: id.slice(0, 8), content: { title: 'New', body: 'x' } });
    // Neither artifact exists, so there is no row to lock: the imports wait on the ids themselves.
    const settled = await holding(
      (q) => q(advisory, [`artifact-id:${ws}:${a}`]).then(() => {}),
      async () => {
        const calls = Promise.allSettled([
          api.call('config.import', { bundle: bundleOf([entry(a), entry(b)]), dryRun: false }),
          api.call('config.import', { bundle: bundleOf([entry(b), entry(a)]), dryRun: false }),
        ]);
        await blocked(2);
        return { pending: calls };
      },
    );
    expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
  });

  const agentOf = async (api: ReturnType<typeof t.api>, name: string, scopes: string[]) => {
    const token = (await api.call('apiTokens.create', { name, scopes: scopes as never })).token;
    const call = async (command: string, body: unknown = {}) => {
      const res = await fetch(`${t.base}/v1/${command}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    return { call, id: (await call('whoami')).body.agent.id as string };
  };

  it('an agent’s publish waits for its policy lock before it locks the artifact', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const agent = await agentOf(api, 'Ordered agent', ['artifacts:read', 'artifacts:write', 'artifacts:publish']);
    const note = (await agent.call('artifacts.create', { type: 'note', name: 'Mine', content: { title: 'a', body: 'b' } })).body;
    const settled = await holding(
      (q) => q(advisory, [`agent-policy:${ws}:${agent.id}`]).then(() => {}),
      async () => {
        const calls = Promise.all([
          agent.call('artifacts.requestPublish', { artifactId: note.artifactId, note: 'publish' }),
          agent.call('artifacts.updateDraft', { artifactId: note.artifactId, content: { title: 'a', body: 'c' } }),
        ]);
        await blocked(2);
        // Holding the artifact here while the edit holds the policy lock is the deadlock.
        expect(await rowFree(ws, note.artifactId)).toBe(true);
        return { pending: calls };
      },
    );
    for (const r of settled) expect(r.status).toBeLessThan(500);
  });

  it('imports publishing mandates for the same agents take the mandate locks in one order', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const agents = [
      (await agentOf(api, 'Agent one', ['artifacts:read'])).id,
      (await agentOf(api, 'Agent two', ['artifacts:read'])).id,
    ].sort();
    const mandate = (c: string, agent: string) => ({
      id: `mnd_${c.repeat(32)}`,
      type: 'agent_mandate' as const,
      name: `Mandate ${c}`,
      content: { agent, purpose: 'Test.', expires: new Date(Date.now() + 30 * 86_400_000).toISOString() },
    });
    const [first, second] = agents as [string, string];
    const settled = await holding(
      (q) => q(advisory, [`agent-mandate:${ws}:${first}`]).then(() => {}),
      async () => {
        const calls = Promise.allSettled([
          api.call('config.import', { bundle: bundleOf([mandate('1', first), mandate('2', second)]), dryRun: false, publish: true }),
          api.call('config.import', { bundle: bundleOf([mandate('3', second), mandate('4', first)]), dryRun: false, publish: true }),
        ]);
        await blocked(2);
        // Neither import went ahead and took the second agent's lock out of order.
        expect(await advisoryFree(`agent-mandate:${ws}:${second}`)).toBe(true);
        return { pending: calls };
      },
    );
    expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
  });

  it('undoing a group locks its artifacts in id order, whatever order it was recorded in', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const agent = await agentOf(api, 'Undone agent', ['artifacts:read']);
    const twice = async (name: string) => {
      const { artifactId } = await api.call('artifacts.create', { type: 'note', name, content: { title: name, body: 'v1' } });
      await api.call('artifacts.requestPublish', { artifactId, note: 'v1' });
      await api.call('artifacts.updateDraft', { artifactId, content: { title: name, body: 'v2' } });
      await api.call('artifacts.requestPublish', { artifactId, note: 'v2' });
      return artifactId;
    };
    const [a, b] = [await twice('One'), await twice('Two')].sort() as [string, string];
    const step = (artifactId: string) => ({ kind: 'republish', artifactId, previousVersion: 1, publishedVersion: 2 });
    // The ledger entry of a bundle the agent published as [b, a].
    const { rows } = await t.srv.db.admin.query<{ id: string }>(
      `INSERT INTO agent_actions (workspace_id, agent_id, command, action_class, decision, ok, surface, undo)
       VALUES ($1, $2, 'artifacts.requestPublishBundle', 'draft', 'allow', true, 'rest', $3::jsonb) RETURNING id`,
      [ws, agent.id, JSON.stringify({ kind: 'group', items: [step(b), step(a)] })],
    );
    const undone = await holding(
      (q) => q('SELECT 1 FROM artifacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [ws, a]).then(() => {}),
      async () => {
        const call = api.call('agents.undo', { actionId: Number(rows[0]?.id) });
        call.catch(() => {});
        await blocked(1);
        // It waits for `a` without having taken `b` first.
        expect(await rowFree(ws, b)).toBe(true);
        return { pending: call };
      },
    );
    expect(undone.steps).toHaveLength(2);
  });
});
