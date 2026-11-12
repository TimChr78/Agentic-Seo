import { agentForCredential, chooseOAuthWorkspace, cleanupExpiredOAuthWorkspaceSelections } from '@agentic-seo/auth';
import { newUuid } from '@agentic-seo/core';
import type { Db } from '@agentic-seo/db';
import { sql } from 'drizzle-orm';
import { parseCrontab } from 'graphile-worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consentWorkspaceId, withConsentRequest } from '../../../packages/auth/src/oauthWorkspace';
import { CLEANUP_OAUTH_SELECTIONS_TASK, CRONTAB, taskListFor } from '../src/workers';
import { startTestServer, testPort, type User } from './harness';

// Tenant writes on the credential path must run as `aseo_app` with RLS. The owner pool is for the
// installation-level lookups that happen before a workspace is known (the token hash, the session
// membership) and never for rows that carry a workspace. The expired-choice cleanup is the one
// deliberate cross-tenant operation, and it runs from the scheduler, not a request.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';

beforeAll(async () => {
  t = await startTestServer('tenant_writes', testPort(2507));
  owner = await t.signUp(`tenant-owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
});

afterAll(async () => {
  await t?.close();
});

/**
 * A Db whose owner pool refuses tenant writes. Anything that inserts, updates or deletes through
 * `admin`, or opens an owner connection to do so, is recorded and thrown; the app pool and
 * `withWorkspace` stay real.
 */
function refusingOwnerWrites(db: Db): { db: Db; attempted: string[] } {
  const attempted: string[] = [];
  const refuse = (what: string): never => {
    attempted.push(what);
    throw new Error(`owner pool used for ${what}`);
  };
  const admin = new Proxy(db.admin, {
    get(target, prop, receiver) {
      if (prop === 'connect') return () => refuse('a connection');
      if (prop === 'query') {
        return (text: string, values?: unknown[]) => {
          if (/\b(insert|update|delete)\b/i.test(String(text))) return refuse('a tenant write');
          return target.query(text as never, values as never);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { db: { ...db, admin }, attempted };
}

describe('tenant writes on the auth path', () => {
  it('creates an agent for a first-used credential as the app role', async () => {
    const { db, attempted } = refusingOwnerWrites(t.srv.db);
    const agent = await agentForCredential(db, ws, 'api_token', 'tok_tenant_probe', owner.id, async () => 'Probe agent');
    expect(agent).toMatchObject({ name: 'Probe agent', status: 'active' });
    expect(attempted).toEqual([]);

    const { rows } = await t.srv.db.withWorkspace(ws, (tx) =>
      tx.execute<{ id: string }>(sql`SELECT id FROM agents WHERE id = ${agent.id}`),
    );
    expect(rows).toEqual([{ id: agent.id }]);
  });

  it('records a consent workspace choice as the app role', async () => {
    const { db, attempted } = refusingOwnerWrites(t.srv.db);
    const chosen = await chooseOAuthWorkspace(db, {
      sessionId: 'session-tenant-probe',
      userId: owner.id,
      workspaceId: ws,
      scope: 'sites:read',
      oauthQuery: 'client_id=probe-client&state=probe-state&response_type=code',
    });
    expect(chosen).toMatchObject({ id: ws });
    expect(attempted).toEqual([]);

    const { rows } = await t.srv.db.withWorkspace(ws, (tx) =>
      tx.execute<{ workspace_id: string }>(sql`SELECT workspace_id::text FROM oauth_workspace_selections WHERE workspace_id = ${ws}`),
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('cleans up only expired pending selections, for every workspace', async () => {
    const otherWorkspace = newUuid();
    await t.srv.db.admin.query('INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, $2, $3)', [otherWorkspace, 'Other', 'none']);
    await t.srv.db.admin.query(
      `INSERT INTO oauth_workspace_selections (session_id, workspace_id, created_at, updated_at) VALUES
         ('expired-a', $1, now() - interval '2 days', now() - interval '2 days'),
         ('expired-b', $2, now() - interval '2 days', now() - interval '2 days'),
         ('fresh-c', $1, now(), now())`,
      [ws, otherWorkspace],
    );

    expect(await cleanupExpiredOAuthWorkspaceSelections(t.srv.db)).toBe(2);
    const { rows } = await t.srv.db.admin.query<{ session_id: string }>(
      'SELECT session_id FROM oauth_workspace_selections ORDER BY session_id',
    );
    const remaining = rows.map((row) => row.session_id);
    expect(remaining).not.toContain('expired-a');
    expect(remaining).not.toContain('expired-b');
    expect(remaining).toContain('fresh-c');
  });

  it('consumes a consent choice as the app role, and hands it to exactly one of two concurrent consumers', async () => {
    const both = await t.signUp(`tenant-two-${Date.now()}@example.com`);
    await t.workspaceWith([[both, 'owner']]);
    const second = await t.workspaceWith([[both, 'owner']]);
    const oauthQuery = 'client_id=race-client&state=race-state&response_type=code';
    await chooseOAuthWorkspace(t.srv.db, {
      sessionId: 'session-race',
      userId: both.id,
      workspaceId: second,
      scope: 'sites:read',
      oauthQuery,
    });

    const { db, attempted } = refusingOwnerWrites(t.srv.db);
    const consume = () => withConsentRequest({ query: oauthQuery, mode: 'consent' }, () => consentWorkspaceId(db, both.id, 'session-race'));
    const results = await Promise.all([consume(), consume()]);

    // The choice is consumed once: one consumer gets it, the other finds nothing (two memberships,
    // so there is no single-membership fallback).
    expect(results.filter((r) => r === second)).toHaveLength(1);
    expect(results.filter((r) => r === undefined)).toHaveLength(1);
    expect(attempted).toEqual([]);
  });

  it('registers the cleanup as an hourly scheduler task, not in the request path', () => {
    // Graphile Worker must accept the crontab: an invalid task identifier stops the scheduler from starting.
    expect(() => parseCrontab(CRONTAB)).not.toThrow();
    expect(CRONTAB).toBe(`0 * * * * ${CLEANUP_OAUTH_SELECTIONS_TASK}`);
    expect(Object.keys(taskListFor(t.srv.db))).toContain(CLEANUP_OAUTH_SELECTIONS_TASK);
  });
});
