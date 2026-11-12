import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejects, startTestServer, testPort, type User } from './harness';

// Mandates feed the policy engine from the published agent_mandate artifact (agents-and-autonomy
// §4). Phase 0 enforces levels 0 and 1; an L2 decision keeps its level and reasons but is degraded
// to an ordinary approval request until holds arrive in Phase 7. Only people may create, change or
// publish a mandate.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let api: ReturnType<typeof t.api>;
let token = '';
let agentId = '';

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

beforeAll(async () => {
  t = await startTestServer('test_artifact_mandates', testPort(3402));
  owner = await t.signUp(`mandates-owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  api = t.api(owner, ws);
  // Give the workspace room to grant levels 2 and 3; the mandate is still capped by each ceiling.
  await t.srv.db.admin.query(`UPDATE workspaces SET settings = $2::jsonb WHERE id = $1`, [
    ws,
    JSON.stringify({ maxLevel: { draft: 3, 'report.share': 2, 'site.content': 3, settings: 3 }, allowLoops: false }),
  ]);
  token = (
    await api.call('apiTokens.create', {
      name: 'Mandate test agent',
      scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'],
    })
  ).token;
  const me = await agentCall('whoami');
  expect(me.status).toBe(200);
  agentId = me.body.agent.id;
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

const mandateContent = (over: Record<string, unknown> = {}) => ({
  agent: agentId,
  purpose: 'Keep the technical audit clean.',
  expires: inDays(30),
  ...over,
});

describe('agent mandates', () => {
  let mandateId = '';

  it('only people can create a mandate', async () => {
    const refused = await agentCall('artifacts.create', { type: 'agent_mandate', name: 'My own borders', content: mandateContent() });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toContain('Only people can create, change or publish agent mandates');
  });

  it('a draft mandate does not apply, and level 0 stops the agent drafting', async () => {
    const created = await api.call('artifacts.create', {
      type: 'agent_mandate',
      name: 'Technical mandate',
      content: mandateContent({ levels: { draft: 0 } }),
    });
    mandateId = created.artifactId;

    // Not published: the agent has no mandate, so a draft is allowed.
    expect(
      (await agentCall('artifacts.create', { type: 'note', name: 'Before the mandate', content: { title: 'x', body: 'y' } })).status,
    ).toBe(200);

    const published = await api.call('artifacts.requestPublish', { artifactId: mandateId, note: 'grant' });
    expect(published.status).toBe('published');

    const refused = await agentCall('artifacts.create', { type: 'note', name: 'Blocked', content: { title: 'x', body: 'y' } });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toContain('observe-only');
  });

  it('an active agent mandate cannot be changed by an agent', async () => {
    const refused = await agentCall('artifacts.updateDraft', { artifactId: mandateId, content: mandateContent({ levels: { draft: 1 } }) });
    // The observe-only mandate already refuses the draft write; either way the agent cannot raise
    // its own level.
    expect(refused.status).toBe(403);
    expect(refused.body.message).toMatch(/observe-only|Only people can create, change or publish agent mandates/);
  });

  it('level 1 lets the agent draft and propose, and a person still publishes', async () => {
    await api.call('artifacts.updateDraft', {
      artifactId: mandateId,
      content: mandateContent({ levels: { draft: 1 } }),
    });
    const granted = await api.call('artifacts.requestPublish', { artifactId: mandateId, note: 'raise to level 1' });
    expect(granted.status).toBe('published');

    // With draft at level 1 the policy lets a draft through, so the people-only gate is what stops it.
    const ownBorders = await agentCall('artifacts.updateDraft', {
      artifactId: mandateId,
      content: mandateContent({ levels: { draft: 3 } }),
    });
    expect(ownBorders.status).toBe(403);
    expect(ownBorders.body.message).toContain('Only people can create, change or publish agent mandates');

    const created = await agentCall('artifacts.create', { type: 'note', name: 'Agent note', content: { title: 'Agent', body: 'draft' } });
    expect(created.status).toBe(200);
    const published = await agentCall('artifacts.requestPublish', { artifactId: created.body.artifactId, note: 'Agent publishes a note' });
    expect(published.status).toBe(200);
    expect(published.body.status).toBe('published');
  });

  it('an L2 decision degrades to ask with “Holds arrive in Phase 7” and never holds silently', async () => {
    // A report is a placeholder content type in Phase 0, so it cannot be created through the
    // command; seed the draft directly and let the agent try to publish it. The policy decision is
    // made before the content check, and the ledger keeps it.
    const reportId = `rpt_${'b'.repeat(32)}`;
    await t.srv.db.admin.query(
      `INSERT INTO artifacts (workspace_id, id, type, name, latest_version) VALUES ($1, $2, 'report', 'Quarterly report', 1)`,
      [ws, reportId],
    );
    await t.srv.db.admin.query(
      `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
       VALUES ($1, $2, 1, 'draft', '{}'::jsonb, 'seed', 'user', $3)`,
      [ws, reportId, owner.id],
    );
    await api.call('artifacts.updateDraft', {
      artifactId: mandateId,
      content: mandateContent({ levels: { draft: 1, 'report.share': 2 } }),
    });
    expect((await api.call('artifacts.requestPublish', { artifactId: mandateId, note: 'report at level 2' })).status).toBe('published');

    const attempt = await agentCall('artifacts.requestPublish', { artifactId: reportId, note: 'Publish the report' });
    expect(attempt.status).toBe(400);
    const { rows } = await t.srv.db.admin.query<{ decision: string; reasons: string[]; level: number }>(
      `SELECT decision, reasons, level FROM agent_actions
        WHERE workspace_id = $1 AND agent_id = $2 AND target = $3
        ORDER BY id DESC LIMIT 1`,
      [ws, agentId, reportId],
    );
    expect(rows[0]?.decision).toBe('ask');
    expect(rows[0]?.level).toBe(2);
    expect(rows[0]?.reasons.join(' ')).toContain('Holds arrive in Phase 7');
    // Nothing was published and no approval request was created by the refused call.
    expect(
      (await t.srv.db.admin.query('SELECT published_version FROM artifacts WHERE workspace_id = $1 AND id = $2', [ws, reportId])).rows[0],
    ).toMatchObject({ published_version: null });
  });

  it('refuses a mandate above the workspace ceiling', async () => {
    const created = await api.call('artifacts.create', {
      type: 'agent_mandate',
      name: 'Over the ceiling',
      content: mandateContent({ levels: { 'site.content': 4 } }),
    });
    // The active mandate is the same agent's, so publishing this one fails for two reasons; the
    // ceiling is the one this test is about.
    const e = await rejects(api.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'too much' }));
    expect(e.code).toBe('invalid_input');
    expect(e.message).toContain('above the workspace ceiling');
  });
});
