import { createClient } from '@agentic-seo/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Commands } from '../src/registry';
import { PASSWORD, startTestServer, testPort, type User } from './harness';

// Members, invitations and API tokens: the rules that decide who may do what, and that a token
// narrows at once, widens only with a password, and stays in its one workspace.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let editor: User;
let ws = '';

const tokenApi = (token: string) => createClient<Commands>({ baseUrl: t.base, headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  t = await startTestServer('auth', testPort(2502));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  editor = await t.signUp(`editor-${Date.now()}@example.com`);
  ws = await t.workspaceWith([
    [owner, 'owner'],
    [editor, 'editor'],
  ]);
});

afterAll(async () => {
  await t?.close();
});

describe('members and invitations', () => {
  it('lets an owner invite a person who then joins with the link', async () => {
    const invitee = await t.signUp(`invitee-${Date.now()}@example.com`);
    const invite = await t.api(owner, ws).call('members.invite', { email: invitee.email, role: 'viewer' });
    expect(invite.status).toBe('pending');
    expect(invite.acceptPath).toContain('#');

    const pending = await t.api(owner, ws).call('invitations.list', { status: 'pending' });
    expect(pending.invitations.map((i) => i.id)).toContain(invite.id);

    const accepted = await fetch(`${t.base}/api/invitations/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: invitee.cookie, origin: t.base },
      body: JSON.stringify({ token: invite.token }),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ workspaceId: ws, role: 'viewer' });

    const me = await t.api(invitee, ws).call('whoami', {});
    expect(me.role).toBe('viewer');
  });

  it('refuses an invitation for a different address', async () => {
    const intended = await t.signUp(`intended-${Date.now()}@example.com`);
    const wrong = await t.signUp(`wrong-${Date.now()}@example.com`);
    const invite = await t.api(owner, ws).call('members.invite', { email: intended.email, role: 'viewer' });
    const res = await fetch(`${t.base}/api/invitations/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: wrong.cookie, origin: t.base },
      body: JSON.stringify({ token: invite.token }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).message).toContain(intended.email);
  });

  it('keeps at least one owner and lets only owners change owners', async () => {
    const sole = await t.signUp(`sole-${Date.now()}@example.com`);
    const other = await t.workspaceWith([[sole, 'owner']]);

    await expect(t.api(sole, other).call('members.setRole', { userId: sole.id, role: 'viewer' })).rejects.toMatchObject({
      message: expect.stringContaining('at least one owner'),
    });

    // An editor cannot invite at all (no workspace:admin), let alone make an owner.
    await expect(t.api(editor, ws).call('members.invite', { email: `x-${Date.now()}@example.com`, role: 'editor' })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('lists members with their names and roles', async () => {
    const list = await t.api(owner, ws).call('members.list', {});
    expect(list.members.find((m) => m.userId === editor.id)?.role).toBe('editor');
    expect(list.members.find((m) => m.userId === editor.id)?.email).toBe(editor.email);
  });
});

describe('API tokens', () => {
  let token = '';

  it('creates a token that acts as an agent, with the scopes chosen', async () => {
    const created = await t.api(owner, ws).call('apiTokens.create', { name: 'n8n', scopes: ['sites:read', 'artifacts:read'] });
    token = created.token;
    expect(token.startsWith('aseo_')).toBe(true);
    expect(created.workspaceId).toBe(ws);

    const me = await tokenApi(token).call('whoami', {});
    expect(me.type).toBe('agent');
    expect(me.clientId).toBe(`token:${created.id}`);
    expect(me.agent?.name).toBe('n8n');
    expect(me.permissions).toEqual(expect.arrayContaining(['sites:read', 'artifacts:read']));
    expect(me.permissions).not.toContain('workspace:admin');
  });

  it('cannot exceed the owner’s role and refuses another workspace through the header', async () => {
    await expect(t.api(owner, ws).call('apiTokens.create', { name: 'bad', scopes: ['messages:send' as never] })).rejects.toMatchObject({
      status: 400,
    });
    const other = await t.workspaceWith([[owner, 'owner']]);
    await expect(
      createClient<Commands>({
        baseUrl: t.base,
        headers: { authorization: `Bearer ${token}`, 'x-workspace-id': other },
      }).call('workspace.get', {}),
    ).rejects.toMatchObject({ status: 403, message: expect.stringContaining('bound to one workspace') });
  });

  it('narrows at once: a removed scope is refused on the next call', async () => {
    const tokenId = (await tokenApi(token).call('whoami', {})).clientId?.replace('token:', '');
    const narrowed = await t.api(owner, ws).call('apiTokens.update', { id: tokenId!, scopes: ['artifacts:read'] });
    expect(narrowed.removed).toEqual(['sites:read']);
    expect(narrowed.steppedUp).toBe(false);

    await expect(tokenApi(token).call('workspace.memberships', {})).rejects.toMatchObject({ status: 403 });
  });

  it('widens only with the owner’s password, and records the step-up', async () => {
    const tokenId = (await tokenApi(token).call('whoami', {})).clientId?.replace('token:', '') as string;

    await expect(
      t.api(owner, ws).call('apiTokens.update', { id: tokenId, scopes: ['sites:read', 'artifacts:read'] }),
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('Confirm with your password'),
    });
    await expect(
      t.api(owner, ws).call('apiTokens.update', { id: tokenId, password: 'wrong-password', scopes: ['sites:read', 'artifacts:read'] }),
    ).rejects.toMatchObject({ status: 403, message: 'The password is not correct.' });

    const widened = await t.api(owner, ws).call('apiTokens.update', {
      id: tokenId,
      password: PASSWORD,
      scopes: ['sites:read', 'artifacts:read'],
    });
    expect(widened.steppedUp).toBe(true);
    expect((await tokenApi(token).call('workspace.memberships', {})).workspaces.map((w) => w.id)).toEqual([ws]);
  });

  it('revokes at once and never shows the value again', async () => {
    const list = await t.api(owner, ws).call('apiTokens.list', {});
    const row = list.tokens.find((x) => x.name === 'n8n');
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain(token);

    await t.api(owner, ws).call('apiTokens.revoke', { id: row!.id });
    await expect(tokenApi(token).call('workspace.get', {})).rejects.toMatchObject({ status: 401 });
  });

  it('is never created by an agent, whatever its scopes', async () => {
    const created = await t.api(owner, ws).call('apiTokens.create', { name: 'agent', scopes: ['sites:read', 'workspace:admin'] });
    await expect(tokenApi(created.token).call('apiTokens.create', { name: 'nested', scopes: ['sites:read'] })).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('only be run by a person'),
    });
  });
});
