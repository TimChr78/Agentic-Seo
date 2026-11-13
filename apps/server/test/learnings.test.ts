import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// Learnings: a small store of conclusions with the experiments behind them. People and agents add
// them, only people retract them, and agents read the active ones through learnings://current.
// Ported from Agentic Marketing 311460e apps/server/test/learnings.test.ts.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let token = '';
let evidenceId = '';
let personLearningId = '';
let agentLearningId = '';
let client: Client;

const evidence = (id: string) => [
  {
    kind: 'recommendation' as const,
    id,
    summary: 'The rewrite raised clicks on the tested pages',
    numbers: { clicks: 240, control: 180 },
  },
];

const siteId = '44444444-4444-4444-8444-444444444444';

beforeAll(async () => {
  t = await startTestServer('test_learnings', testPort(3322));
  owner = await t.signUp(`owner-learnings-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner, ws);
  // A real recommendation artifact to cite as the source of the result. Recommendation content
  // arrives in Phase 1, so the row is seeded directly; the foreign key shape is what matters.
  evidenceId = `rcm_${'a'.repeat(32)}`;
  await t.srv.db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, latest_version) VALUES ($1, $2, 'recommendation', 'Seeded recommendation', 1)`,
    [ws, evidenceId],
  );
  await t.srv.db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1, $2, 1, 'published', '{}'::jsonb, 'seed', 'user', $3)`,
    [ws, evidenceId, owner.id],
  );
  token = (await api.call('apiTokens.create', { name: 'Learning writer', scopes: ['artifacts:read', 'artifacts:write'] })).token;
  client = new Client({ name: 'learning test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${t.base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
}, 120_000);
afterAll(async () => {
  await client?.close();
  await t?.close();
});

const apiCall = async (name: string, body: unknown = {}) => {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

describe('learnings', () => {
  it('a person adds a learning and finds it by status and scope', async () => {
    const learning = await t.api(owner, ws).call('learnings.add', {
      statement: 'Rewriting titles of striking-distance pages raises CTR',
      scope: { siteId, markets: ['DK:da'], changeTypes: ['meta.title'] },
      evidence: evidence(evidenceId),
    });
    personLearningId = learning.id;
    expect(learning).toMatchObject({
      id: expect.stringMatching(/^lrn_[0-9a-f]{32}$/),
      siteId,
      status: 'active',
      author: { type: 'user', id: owner.id },
      agentId: null,
      scope: { siteId, markets: ['DK:da'], changeTypes: ['meta.title'] },
    });
    expect(learning.evidence).toEqual(evidence(evidenceId));

    const current = await t.api(owner, ws).call('learnings.list', {});
    expect(current.learnings.map((l) => l.id)).toContain(personLearningId);
    expect((await t.api(owner, ws).call('learnings.list', { siteId })).learnings.map((l) => l.id)).toEqual([personLearningId]);
    expect((await t.api(owner, ws).call('learnings.list', { changeType: 'meta.title' })).learnings.map((l) => l.id)).toEqual([
      personLearningId,
    ]);
    expect((await t.api(owner, ws).call('learnings.list', { market: 'US:en' })).learnings).toEqual([]);
    expect((await t.api(owner, ws).call('learnings.list', { siteId: '55555555-5555-4555-8555-555555555555' })).learnings).toEqual([]);
  });

  it('a person retracts it with a reason; a retracted learning is no longer current', async () => {
    const retracted = await t.api(owner, ws).call('learnings.retract', {
      id: personLearningId,
      reason: 'The effect did not repeat in the next four tests',
    });
    expect(retracted).toMatchObject({
      id: personLearningId,
      status: 'retracted',
      retractedBy: owner.id,
      retractReason: 'The effect did not repeat in the next four tests',
    });
    expect(retracted.retractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await t.api(owner, ws).call('learnings.list', {})).learnings.map((l) => l.id)).not.toContain(personLearningId);
    expect((await t.api(owner, ws).call('learnings.list', { status: 'retracted' })).learnings.map((l) => l.id)).toEqual([personLearningId]);
  });

  it('an agent adds one with evidence that references a real recommendation', async () => {
    const out = await apiCall('learnings.add', {
      statement: 'Numbers in the title win on informational pages',
      scope: { changeTypes: ['meta.title'] },
      evidence: evidence(evidenceId),
    });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ status: 'active', author: { type: 'agent' }, scope: { changeTypes: ['meta.title'] } });
    expect(out.body.author.id).toBe(owner.id);
    expect(out.body.agentId).toMatch(/^agt_[0-9a-f]{32}$/);
    agentLearningId = out.body.id;
  });

  it('an agent without evidence or with an unknown id is refused', async () => {
    const noEvidence = await apiCall('learnings.add', { statement: 'Something I remember', evidence: [] });
    expect(noEvidence.status).toBe(400);

    const unknown = await apiCall('learnings.add', {
      statement: 'Something a result said',
      evidence: evidence(`rcm_${'f'.repeat(32)}`),
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toContain('is not an artifact in this workspace');
  });

  it('an agent cannot retract a learning', async () => {
    const out = await apiCall('learnings.retract', { id: agentLearningId, reason: 'An agent tries' });
    expect(out.status).toBe(403);
    expect(out.body.error).toBe('forbidden');
    expect(out.body.message).toContain('can only be run by a person');
  });

  it('learnings://current serves only the active learnings', async () => {
    const { resources } = await client.listResources();
    expect(resources.find((r) => r.uri === 'learnings://current')).toMatchObject({ mimeType: 'application/json' });
    const read = await client.readResource({ uri: 'learnings://current' });
    const body = JSON.parse((read.contents[0] as { text: string }).text) as {
      learnings: { id: string; status: string }[];
      count: number;
    };
    expect(body.learnings.map((l) => l.id)).toEqual([agentLearningId]);
    expect(body.learnings.every((l) => l.status === 'active')).toBe(true);
    expect(body.count).toBe(1);
  });

  it('artifact-types://catalogue serves the JSON Schema for every type', async () => {
    const { resources } = await client.listResources();
    expect(resources.find((r) => r.uri === 'artifact-types://catalogue')).toMatchObject({ mimeType: 'application/json' });
    const read = await client.readResource({ uri: 'artifact-types://catalogue' });
    const body = JSON.parse((read.contents[0] as { text: string }).text) as { types: { type: string }[] };
    expect(body.types.map((x) => x.type)).toEqual(expect.arrayContaining(['note', 'site_context', 'agent_mandate']));
  });
});
