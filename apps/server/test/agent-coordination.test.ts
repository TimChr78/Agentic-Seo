import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// Several agents in one workspace: artifact ownership and conflict holds. An active owner's
// artifact cannot be published by another agent without a person; a pending change from another
// agent on the same artifact also sends the change to a person. Ported from Agentic Marketing
// 311460e apps/server/test/agent-coordination.test.ts, using site context (a settings-class
// artifact) because Phase 0's other artifact types publish as draft-level work.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let a = '';
let b = '';
let aToken = '';
let bToken = '';

const siteA = '66666666-6666-4666-8666-666666666666';
const siteB = '77777777-7777-4777-8777-777777777777';

beforeAll(async () => {
  t = await startTestServer('test_agent_coordination', testPort(4260));
  owner = await t.signUp(`coordination-owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner, ws);
  const tokenA = (
    await api.call('apiTokens.create', {
      name: 'First agent',
      scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'],
    })
  ).token;
  const tokenB = (
    await api.call('apiTokens.create', {
      name: 'Second agent',
      scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'],
    })
  ).token;
  aToken = tokenA;
  bToken = tokenB;
  a = (await agentCall(aToken, 'whoami')).body.agent.id;
  b = (await agentCall(bToken, 'whoami')).body.agent.id;
}, 120_000);
afterAll(() => t?.close());

async function agentCall(token: string, name: string, body: unknown = {}) {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const context = (overview: string) => ({ businessOverview: overview });

describe('artifact ownership', () => {
  let owned = '';

  it('an agent owns what it creates, and people may transfer or clear ownership', async () => {
    const created = await agentCall(aToken, 'artifacts.create', {
      type: 'site_context',
      name: 'Owned context',
      siteId: siteA,
      content: context('First agent’s site.'),
    });
    expect(created.status).toBe(200);
    owned = created.body.artifactId;
    expect((await t.api(owner, ws).call('artifacts.get', { artifactId: owned })).ownerAgentId).toBe(a);
    expect((await t.api(owner, ws).call('artifacts.list', { type: 'site_context', siteId: siteA })).artifacts[0]?.ownerAgentId).toBe(a);

    const refused = await agentCall(aToken, 'artifacts.setOwner', { artifactId: owned, ownerAgentId: b });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toContain('can only be run by a person');

    const assigned = await t.api(owner, ws).call('artifacts.setOwner', { artifactId: owned, ownerAgentId: b });
    expect(assigned).toEqual({ artifactId: owned, ownerAgentId: b });
    expect((await t.api(owner, ws).call('artifacts.setOwner', { artifactId: owned, ownerAgentId: null })).ownerAgentId).toBeNull();
  });

  it('another agent’s publish of an owned artifact waits for a person, with the reason', async () => {
    await t.api(owner, ws).call('artifacts.setOwner', { artifactId: owned, ownerAgentId: a });
    const edited = await agentCall(bToken, 'artifacts.updateDraft', {
      artifactId: owned,
      content: context('Edited by the second agent.'),
    });
    expect(edited.status).toBe(200);
    const out = await agentCall(bToken, 'artifacts.requestPublish', { artifactId: owned, note: 'Let me change this' });
    expect(out.status).toBe(200);
    expect(out.body.status).toBe('in_review');
    expect(out.body.heldBecause).toEqual(expect.arrayContaining([expect.stringContaining('is owned by agent First agent')]));
  });

  it('the owner publishing its own artifact is not blocked by ownership', async () => {
    const edited = await agentCall(aToken, 'artifacts.updateDraft', {
      artifactId: owned,
      content: context('The owner edits its own context.'),
    });
    expect(edited.status).toBe(200);
    const out = await agentCall(aToken, 'artifacts.requestPublish', { artifactId: owned, note: 'Our own change' });
    expect(out.body.status).toBe('in_review');
    expect(out.body.heldBecause?.join(' ') ?? '').not.toContain('is owned by agent');
  });

  it('a paused owner does not block, and the reason says so', async () => {
    // Clear the pending requests so only ownership is at issue.
    const pending = await t.api(owner, ws).call('approvals.list', { artifactId: owned, status: 'pending' });
    for (const request of pending.approvals) await t.api(owner, ws).call('approvals.reject', { approvalId: request.id, note: 'reset' });

    await t.api(owner, ws).call('agents.pause', { id: a, reason: 'On holiday' });
    await agentCall(bToken, 'artifacts.updateDraft', { artifactId: owned, content: context('Edited while the owner is away.') });
    const out = await agentCall(bToken, 'artifacts.requestPublish', { artifactId: owned, note: 'While the owner is away' });
    expect(out.body.status).toBe('in_review');
    expect(out.body.heldBecause?.join(' ')).toContain('which is not active; ownership does not block this change');
    await t.api(owner, ws).call('agents.resume', { id: a });
  });
});

describe('conflict holds', () => {
  it('the second agent’s change waits while the first has one pending', async () => {
    const api = t.api(owner, ws);
    const created = await api.call('artifacts.create', {
      type: 'site_context',
      name: 'Shared context',
      siteId: siteB,
      content: context('A person made this.'),
    });
    expect(
      (await agentCall(aToken, 'artifacts.updateDraft', { artifactId: created.artifactId, content: context('First edit.') })).status,
    ).toBe(200);
    const first = await agentCall(aToken, 'artifacts.requestPublish', { artifactId: created.artifactId, note: 'First change' });
    expect(first.body.status).toBe('in_review');

    await agentCall(bToken, 'artifacts.updateDraft', { artifactId: created.artifactId, content: context('Second edit.') });
    const second = await agentCall(bToken, 'artifacts.requestPublish', { artifactId: created.artifactId, note: 'Second change' });
    expect(second.body.status).toBe('in_review');
    expect(second.body.heldBecause).toEqual(
      expect.arrayContaining([expect.stringMatching(/already has an open approval request from agent First agent/)]),
    );
  });
});
