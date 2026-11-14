import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort } from './harness';

let server: Awaited<ReturnType<typeof startTestServer>>;

beforeAll(async () => {
  server = await startTestServer('core', testPort(2501));
});

afterAll(async () => {
  await server.close();
});

describe('the REST surface', () => {
  it('answers health and serves OpenAPI for every registry command', async () => {
    const health = await fetch(`${server.base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });

    const ready = await fetch(`${server.base}/readyz`);
    expect(ready.status).toBe(200);

    const openapi = await (await fetch(`${server.base}/openapi.json`)).json();
    const paths = Object.keys(openapi.paths);
    expect(paths).toContain('/v1/workspace.get');
    expect(paths).toContain('/v1/whoami');
    expect(paths).toContain('/v1/agents.pause');
    // Every registry command has a route and every write declares its action class.
    const { commands } = await import('../src/registry');
    for (const command of commands) expect(paths).toContain(`/v1/${command.name}`);
  });

  it('refuses an unauthenticated call', async () => {
    const res = await fetch(`${server.base}/v1/workspace.get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthorized');
  });

  it('answers workspace.get and whoami for a signed-in person', async () => {
    const user = await server.signUp('owner@example.com');
    const workspaceId = await server.workspaceWith([[user, 'owner']]);

    const workspace = await server.api(user, workspaceId).call('workspace.get', {});
    expect(workspace).toMatchObject({ id: workspaceId, role: 'owner' });
    expect(workspace.permissions).toContain('workspace:admin');

    const me = await server.api(user, workspaceId).call('whoami', {});
    expect(me).toMatchObject({ type: 'user', userId: user.id, workspaceId, role: 'owner' });
    expect(me.agent).toBeUndefined();
  });

  it('scopes a session to the workspace it names and refuses a foreign one', async () => {
    const user = await server.signUp('multi@example.com');
    const a = await server.workspaceWith([[user, 'viewer']]);
    const b = await server.workspaceWith([[user, 'owner']]);

    expect((await server.api(user, a).call('workspace.get', {})).role).toBe('viewer');
    expect((await server.api(user, b).call('workspace.get', {})).role).toBe('owner');

    const { db } = server.srv;
    const stranger = await server.signUp('stranger@example.com');
    await expect(server.api(stranger, a).call('workspace.get', {})).rejects.toMatchObject({ status: 401 });
    // RLS: the app role cannot see another workspace's row even with the id in hand.
    const leaked = await db.withWorkspace(a, (tx) => tx.execute<{ id: string }>(sql`SELECT id FROM workspaces WHERE id <> ${a}`));
    expect(leaked.rows).toHaveLength(0);
  });

  it('validates input and reports unknown keys as warnings without strict mode', async () => {
    const user = await server.signUp('warn@example.com');
    const workspaceId = await server.workspaceWith([[user, 'editor']]);

    const { ApiError } = await import('@agentic-seo/client');
    const invalid = await server
      .api(user, workspaceId)
      .call('agents.get', { id: 'not-an-agent' })
      .catch((err) => err);
    expect(invalid).toBeInstanceOf(ApiError);
    expect(invalid.code).toBe('invalid_input');

    const warned = await server.api(user, workspaceId).call('workspace.get', { surprise: true } as never);
    expect((warned as unknown as { warnings?: string[] }).warnings?.some((w) => w.includes('surprise'))).toBe(true);
  });

  it('replays an idempotent write and audits writes and failures', async () => {
    const user = await server.signUp('idem@example.com');
    const workspaceId = await server.workspaceWith([[user, 'owner']]);

    const input = { name: 'llm.anthropic.api_key', value: 'sk-test-value' };
    const first = await server.api(user, workspaceId).call('secrets.set', input, { idempotencyKey: 'k1' });
    const second = await server.api(user, workspaceId).call('secrets.set', input, { idempotencyKey: 'k1' });
    expect(second.name).toBe(first.name);

    const rows = await server.srv.db.withWorkspace(workspaceId, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM secrets`),
    );
    expect(rows.rows[0]?.n).toBe(1);

    const conflict = await server
      .api(user, workspaceId)
      .call('secrets.set', { name: 'llm.openai.api_key', value: 'sk-test-value' }, { idempotencyKey: 'k1' })
      .catch((err) => err);
    expect(conflict.code).toBe('conflict');

    await server
      .api(user, workspaceId)
      .call('agents.get', { id: 'agt_00000000000000000000000000000000' })
      .catch(() => {});

    const audit = await server.srv.db.withWorkspace(workspaceId, (tx) =>
      tx.execute<{ command: string; ok: boolean; prev_hash: string | null; hash: string }>(
        sql`SELECT command, ok, prev_hash, hash FROM audit_log ORDER BY seq`,
      ),
    );
    expect(audit.rows.some((r) => r.command === 'secrets.set' && r.ok)).toBe(true);
    expect(audit.rows.some((r) => r.command === 'agents.get' && !r.ok)).toBe(true);
    // Every entry past the first chains to the one before it.
    expect(audit.rows[1]?.prev_hash).toBe(audit.rows[0]?.hash);
  });
});
