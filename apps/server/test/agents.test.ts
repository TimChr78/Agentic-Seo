import { createClient } from '@agentic-seo/client';
import { agentPrincipal, defineCommand } from '@agentic-seo/commands';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Commands } from '../src/registry';
import { APP_ROLE, connectAgent, startTestServer, testPort, type User } from './harness';

// Agents as first-class principals: an API token or MCP client becomes one on first use, pausing
// stops every credential at once, and every write lands in the action ledger with its decision.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let token = '';
let agentId = '';

const tokenApi = (value = token) => createClient<Commands>({ baseUrl: t.base, headers: { authorization: `Bearer ${value}` } });

// A stand-in for a real agent write: Phase 0 ships no SEO write command an agent may run yet
// (everything that changes a site lands with its phase), so the ledger is exercised through the
// executor's public path with a command of its own.
const testDraft = defineCommand({
  name: 'test.draft',
  title: 'Test draft',
  description: 'A draft used by the server tests to exercise the agent policy engine and the action ledger.',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  permission: 'sites:write',
  effect: 'write',
  actionClass: 'draft',
  handler: async () => ({ ok: true }),
});

const testSubmit = defineCommand({
  name: 'test.submit',
  title: 'Test submit',
  description: 'A non-draft write used by the server tests to exercise the agent policy engine.',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  permission: 'sites:write',
  effect: 'write',
  actionClass: 'index.submit',
  handler: async () => ({ ok: true }),
});

beforeAll(async () => {
  t = await startTestServer('agents', testPort(2503));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
  token = (
    await t
      .api(owner, ws)
      .call('apiTokens.create', { name: 'Hermes', scopes: ['sites:read', 'artifacts:read', 'audit:read', 'sites:write'] })
  ).token;
});

afterAll(async () => {
  await t?.close();
});

describe('agents as principals', () => {
  it('becomes an agent on first use, with its creator as sponsor', async () => {
    const me = await tokenApi().call('agents.get', {});
    agentId = me.id;
    expect(me).toMatchObject({ name: 'Hermes', status: 'active', sponsor: { id: owner.id } });
    expect(me.credentials).toMatchObject([{ kind: 'api_token' }]);

    const list = await t.api(owner, ws).call('agents.list', {});
    expect(list.agents.map((a) => a.name)).toContain('Hermes');
  });

  it('records an allowed write and a refused write in the action ledger', async () => {
    const me = await tokenApi().call('agents.get', {});
    const principal = agentPrincipal(
      { id: me.id, name: me.name, status: me.status, statusReason: me.statusReason },
      owner.id,
      `token:${token.slice(0, 4)}`,
      ws,
      'owner',
      ['sites:write'],
    );
    await t.srv.executor.execute(testDraft, {}, principal, { surface: 'internal' });

    await t.srv.db.admin.query(`UPDATE workspaces SET settings = '{"switch":"propose_only"}' WHERE id = $1`, [ws]);
    await expect(t.srv.executor.execute(testSubmit, {}, principal, { surface: 'internal' })).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('propose-only'),
    });
    await t.srv.db.admin.query(`UPDATE workspaces SET settings = '{}' WHERE id = $1`, [ws]);

    const activity = await t.api(owner, ws).call('agents.activity', { agentId });
    expect(activity.actions).toHaveLength(2);
    const [denied, allowed] = activity.actions;
    expect(allowed).toMatchObject({ command: 'test.draft', decision: 'allow', ok: true, actionClass: 'draft' });
    expect(denied).toMatchObject({ command: 'test.submit', decision: 'deny', ok: false });
    expect(denied?.reasons.join(' ')).toContain('propose-only');
    expect(denied?.intent).toBeNull();
  });

  it('pauses every credential at once and resumes it', async () => {
    await t.api(owner, ws).call('agents.pause', { id: agentId, reason: 'Checking last week’s run' });
    await expect(tokenApi().call('workspace.get', {})).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('Checking last week’s run'),
    });

    await t.api(owner, ws).call('agents.resume', { id: agentId });
    expect((await tokenApi().call('workspace.get', {})).id).toBe(ws);
  });

  it('revokes for good: no resume, and the credential is refused', async () => {
    await t.api(owner, ws).call('agents.revoke', { id: agentId, reason: 'retired' });
    await expect(tokenApi().call('workspace.get', {})).rejects.toMatchObject({ status: 403 });
    await expect(t.api(owner, ws).call('agents.resume', { id: agentId })).rejects.toMatchObject({ status: 409 });
  });

  it('makes a connected MCP client an agent too, and lets a person rename it', async () => {
    const agent = await connectAgent(t.base, owner, ['sites:read'], undefined, ws);
    const out = await agent.client.callTool({ name: 'agents.get', arguments: {} });
    const content = out.content as { type: string; text: string }[];
    const self = JSON.parse(content[0]!.text) as { id: string; name: string; credentials: { kind: string }[] };
    expect(self.credentials.some((c) => c.kind === 'oauth_client')).toBe(true);

    const renamed = await t
      .api(owner, ws)
      .call('agents.update', { id: self.id, name: 'Claude Code', description: 'Weekly technical audit' });
    expect(renamed.name).toBe('Claude Code');

    const list = await t.api(owner, ws).call('agents.list', {});
    expect(list.agents.find((a) => a.id === self.id)?.credentials.some((c) => c.kind === 'oauth_client')).toBe(true);
    await agent.client.close();
  });

  it('refuses a sponsor who is not a member', async () => {
    const stranger = await t.signUp(`stranger-${Date.now()}@example.com`);
    const list = await t.api(owner, ws).call('agents.list', {});
    const active = list.agents.find((a) => a.status === 'active')!;
    await expect(t.api(owner, ws).call('agents.update', { id: active.id, sponsorUserId: stranger.id })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('counts what an agent did in the last 24 hours', async () => {
    const list = await t.api(owner, ws).call('agents.list', {});
    const hermes = list.agents.find((a) => a.id === agentId)!;
    // Drafts are not changes, and a refused submission is not one either; the refusal is counted.
    expect(hermes.last24h.changes).toBe(0);
    expect(hermes.last24h.denied).toBe(1);
    // The ledger is append-only for the app role: no update or delete grant beyond undoing.
    const grants = await t.srv.db.admin.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'agent_actions' AND grantee = '${APP_ROLE.appRole}'`,
    );
    expect(grants.rows.map((r) => r.privilege_type).sort()).toEqual(['INSERT', 'SELECT']);
    // Updating an action is column-level: only the three columns that mark it undone.
    const columns = await t.srv.db.admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE table_name = 'agent_actions' AND grantee = '${APP_ROLE.appRole}' AND privilege_type = 'UPDATE' ORDER BY column_name`,
    );
    expect(columns.rows.map((r) => r.column_name)).toEqual(['undo_result', 'undone_at', 'undone_by']);
  });
});
