import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// A session cookie rides on a cross-site request whatever the content type. A write that would be
// allowed for the person must still prove it came from the app: JSON only (an HTML form cannot send
// it), and an Origin that matches the app or a trusted origin. Bearer tokens are not attached by a
// browser and stay usable without an Origin.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let viewer: User;
let ws = '';

const postJson = (path: string, headers: Record<string, string>, body: unknown) =>
  fetch(`${t.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  t = await startTestServer('csrf', testPort(2505));
  owner = await t.signUp(`csrf-owner-${Date.now()}@example.com`);
  viewer = await t.signUp(`csrf-viewer-${Date.now()}@example.com`);
  ws = await t.workspaceWith([
    [owner, 'owner'],
    [viewer, 'viewer'],
  ]);
});

afterAll(async () => {
  await t?.close();
});

describe('CSRF on cookie-authenticated writes', () => {
  it('refuses text/plain, so a form cannot forge a privileged mutation', async () => {
    const res = await fetch(`${t.base}/v1/members.setRole`, {
      method: 'POST',
      headers: {
        // A simple request an HTML form or a cross-site fetch can send without a preflight.
        'content-type': 'text/plain',
        origin: 'https://evil.example',
        cookie: viewer.cookie,
        'x-workspace-id': ws,
      },
      body: JSON.stringify({ userId: viewer.id, role: 'owner' }),
    });
    expect(res.status).toBe(415);

    const members = await t.api(owner, ws).call('members.list', {});
    expect(members.members.find((member) => member.userId === viewer.id)?.role).toBe('viewer');
  });

  it('refuses a JSON write from another origin', async () => {
    // The owner is allowed to change the role, so a 403 can only come from the origin check.
    const res = await postJson(
      '/v1/members.setRole',
      { origin: 'https://evil.example', cookie: owner.cookie, 'x-workspace-id': ws },
      { userId: viewer.id, role: 'owner' },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
    const members = await t.api(owner, ws).call('members.list', {});
    expect(members.members.find((member) => member.userId === viewer.id)?.role).toBe('viewer');
  });

  it('allows a JSON write from the app origin, and falls back to Sec-Fetch-Site when Origin is absent', async () => {
    const allowed = await postJson(
      '/v1/members.setRole',
      { origin: t.base, cookie: owner.cookie, 'x-workspace-id': ws },
      { userId: viewer.id, role: 'approver' },
    );
    expect(allowed.status).toBe(200);

    const fallback = await postJson(
      '/v1/members.setRole',
      { 'sec-fetch-site': 'same-origin', cookie: owner.cookie, 'x-workspace-id': ws },
      { userId: viewer.id, role: 'viewer' },
    );
    expect(fallback.status).toBe(200);
  });

  it('refuses a write with neither Origin nor Sec-Fetch-Site', async () => {
    const res = await postJson(
      '/v1/members.setRole',
      { cookie: viewer.cookie, 'x-workspace-id': ws },
      { userId: viewer.id, role: 'owner' },
    );
    expect(res.status).toBe(403);

    // A read is still refused: the guard covers every non-GET/HEAD method, not only mutations.
    const read = await postJson('/v1/workspace.get', { cookie: viewer.cookie, 'x-workspace-id': ws }, {});
    expect(read.status).toBe(403);
  });

  it('allows a bearer token without an Origin: a page cannot attach it', async () => {
    const created = await t.api(owner, ws).call('apiTokens.create', { name: 'CSRF probe', scopes: ['sites:read', 'artifacts:read'] });
    const res = await fetch(`${t.base}/v1/whoami`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });

  it('refuses a form post to the invitation endpoint from another origin', async () => {
    const res = await fetch(`${t.base}/api/invitations/accept`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example',
        cookie: viewer.cookie,
      },
      body: 'token=whatever',
    });
    expect(res.status).toBe(403);
  });

  it('refuses a form post to the consent workspace endpoint from another origin', async () => {
    const res = await fetch(`${t.base}/api/oauth/workspace`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example',
        cookie: owner.cookie,
      },
      body: `workspaceId=${ws}`,
    });
    expect(res.status).toBe(403);
  });

  it('lets a same-origin form submit an invitation, still checking the origin', async () => {
    const invitee = await t.signUp(`csrf-invitee-${Date.now()}@example.com`);
    const invite = await t.api(owner, ws).call('members.invite', { email: invitee.email, role: 'viewer' });
    const res = await fetch(`${t.base}/api/invitations/accept`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: t.base,
        cookie: invitee.cookie,
      },
      body: new URLSearchParams({ token: invite.token }).toString(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ workspaceId: ws, role: 'viewer' });
  });

  it('trusts an origin from TRUSTED_ORIGINS', async () => {
    const trusted = 'https://ui.example.test';
    const other = await startTestServer('csrf_trusted', testPort(2509), { TRUSTED_ORIGINS: trusted });
    try {
      const user = await other.signUp(`csrf-trusted-${Date.now()}@example.com`);
      const workspaceId = await other.workspaceWith([[user, 'owner']]);

      const allowed = await fetch(`${other.base}/v1/workspace.get`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: trusted, cookie: user.cookie, 'x-workspace-id': workspaceId },
        body: '{}',
      });
      expect(allowed.status).toBe(200);

      const refused = await fetch(`${other.base}/v1/workspace.get`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie: user.cookie, 'x-workspace-id': workspaceId },
        body: '{}',
      });
      expect(refused.status).toBe(403);
    } finally {
      await other.close();
    }
  });
});
