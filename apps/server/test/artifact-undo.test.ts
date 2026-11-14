import { undoBlocker } from '@agentic-seo/commands';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejects, startTestServer, testPort, type User } from './harness';

// The ledger keeps how to reverse an agent's publish, and agents.undo republishes the version it
// replaced (or unpublishes what it first published). Only people may undo. Ported from Agentic
// Marketing 311460e apps/server/test/agent-undo.test.ts, restricted to artifact reversals.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let token = '';

beforeAll(async () => {
  t = await startTestServer('test_artifact_undo', testPort(3499));
  owner = await t.signUp(`undo-owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  token = (
    await t.api(owner, ws).call('apiTokens.create', {
      name: 'Undo writer',
      scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'],
    })
  ).token;
}, 120_000);
afterAll(() => t?.close());

async function agentCall(name: string, body: unknown = {}) {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function actionFor(artifactId: string) {
  const { rows } = await t.srv.db.admin.query<{
    id: string;
    undo: { kind: string; artifactId: string; previousVersion: number | null };
    undone_at: Date | null;
  }>(
    `SELECT id, undo, undone_at FROM agent_actions
      WHERE workspace_id = $1 AND command = 'artifacts.requestPublish' AND target = $2
      ORDER BY id DESC LIMIT 1`,
    [ws, artifactId],
  );
  expect(rows[0], `no ledger entry for ${artifactId}`).toBeTruthy();
  // The raw pg driver returns bigint as text; the command expects a number.
  return { ...rows[0]!, id: Number(rows[0]!.id) };
}

let undoneActionId = 0;

describe('undoing an agent publish', () => {
  it('republishes the previous version and records who undid it', async () => {
    const api = t.api(owner, ws);
    const note = await api.call('artifacts.create', { type: 'note', name: 'Undo note', content: { title: 'v1', body: 'original' } });
    await api.call('artifacts.requestPublish', { artifactId: note.artifactId, note: 'v1 by a person' });
    await agentCall('artifacts.updateDraft', { artifactId: note.artifactId, content: { title: 'v2', body: 'agent edit' } });
    const published = await agentCall('artifacts.requestPublish', { artifactId: note.artifactId, note: 'v2 from the agent' });
    expect(published.body).toMatchObject({ status: 'published', version: 2 });

    const action = await actionFor(note.artifactId);
    expect(action.undo).toMatchObject({ kind: 'republish', artifactId: note.artifactId, previousVersion: 1 });
    undoneActionId = action.id;

    const undone = await api.call('agents.undo', { actionId: action.id, note: 'The title tested worse' });
    expect(undone.result).toContain('Republished');
    expect(undone.steps.join(' ')).toContain(`Republished ${note.artifactId} v1`);
    expect((await api.call('artifacts.get', { artifactId: note.artifactId })).publishedVersion).toBe(1);

    const { rows } = await t.srv.db.admin.query('SELECT undone_at, undone_by, undo_result FROM agent_actions WHERE id = $1', [action.id]);
    expect(rows[0]).toMatchObject({ undone_by: owner.id });
    expect(rows[0].undone_at).not.toBeNull();
    expect(rows[0].undo_result).toContain('Republished');
    expect(rows[0].undo_result).toContain('The title tested worse');
  });

  it('undoing a first publish takes it out of service again', async () => {
    const created = await agentCall('artifacts.create', { type: 'note', name: 'First note', content: { title: 'Fresh', body: 'x' } });
    const published = await agentCall('artifacts.requestPublish', { artifactId: created.body.artifactId, note: 'First publish' });
    expect(published.body).toMatchObject({ status: 'published', version: 1 });
    const action = await actionFor(created.body.artifactId);
    expect(action.undo).toMatchObject({ kind: 'republish', previousVersion: null });

    const undone = await t.api(owner, ws).call('agents.undo', { actionId: action.id });
    expect(undone.result).toContain('Unpublished');
    expect((await t.api(owner, ws).call('artifacts.get', { artifactId: created.body.artifactId })).publishedVersion).toBeNull();
    const { rows } = await t.srv.db.admin.query(
      'SELECT state FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2 AND number = 1',
      [ws, created.body.artifactId],
    );
    expect(rows[0]).toMatchObject({ state: 'draft' });
  });

  it('undoing twice is refused, and an agent can never undo', async () => {
    await expect(t.api(owner, ws).call('agents.undo', { actionId: undoneActionId })).rejects.toMatchObject({
      message: expect.stringContaining('already undone'),
    });
    const out = await agentCall('agents.undo', { actionId: undoneActionId });
    expect(out.status).toBe(403);
    expect(out.body.message).toContain('can only be run by a person');
  });

  it('refuses when newer work went live since, instead of discarding it', async () => {
    const api = t.api(owner, ws);
    const note = await api.call('artifacts.create', { type: 'note', name: 'Newer work', content: { title: 'v1', body: 'a' } });
    await api.call('artifacts.requestPublish', { artifactId: note.artifactId, note: 'v1' });
    await agentCall('artifacts.updateDraft', { artifactId: note.artifactId, content: { title: 'v2', body: 'b' } });
    await agentCall('artifacts.requestPublish', { artifactId: note.artifactId, note: 'v2' });
    const action = await actionFor(note.artifactId);

    // A person publishes v3 after the agent's v2.
    await api.call('artifacts.updateDraft', { artifactId: note.artifactId, content: { title: 'v3', body: 'c' } });
    await api.call('artifacts.requestPublish', { artifactId: note.artifactId, note: 'v3 by a person' });

    const refused = await rejects(api.call('agents.undo', { actionId: action.id }));
    expect(refused.code).toBe('conflict');
    expect(refused.message).toContain('published after this action');
    expect((await api.call('artifacts.get', { artifactId: note.artifactId })).publishedVersion).toBe(3);

    // The read-only blocker reports the same refusal without changing anything (task B deferred it).
    const blocker = await t.srv.db.withWorkspace(ws, (tx) => undoBlocker(tx, action.undo as never));
    expect(blocker).toContain('published since');
  });
});
