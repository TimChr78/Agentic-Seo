import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/pool';
import { APP_ROLE, createDisposableDb, hasTestDatabase } from './disposable';

// Tenancy is enforced by Postgres, not by hope: the app role only sees the workspace named in
// `app.workspace_id`, cannot write another workspace's rows, and the audit log is append-only.

const workspace = randomUUID();
const other = randomUUID();

const appUrl = (url: URL) => {
  const u = new URL(url.toString());
  u.username = APP_ROLE.appRole;
  u.password = APP_ROLE.appRolePassword;
  return u.toString();
};

/** Drizzle wraps a Postgres error, so the policy message is in its cause chain. */
const messagesOf = (err: unknown) => {
  const parts: string[] = [];
  for (let e = err as { message?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) parts.push(e.message ?? '');
  return parts.join(' | ');
};

describe.skipIf(!hasTestDatabase())('foundation tables', () => {
  let disposable: Awaited<ReturnType<typeof createDisposableDb>> | undefined;

  afterAll(async () => {
    await disposable?.close();
  });

  it('scopes every tenant table to app.workspace_id and keeps the audit log append-only', async () => {
    const current = await createDisposableDb('foundations');
    disposable = current;
    await current.db.admin.query('INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, $2, $3)', [other, 'Other', 'none']);
    const db = createDb({
      adminUrl: current.url.toString(),
      appUrl: appUrl(current.url),
      poolSize: 2,
    });
    try {
      const seen = await db.withWorkspace(current.workspace, (tx) => tx.execute<{ id: string }>('SELECT id::text AS id FROM workspaces'));
      expect(seen.rows.map((row) => row.id)).toEqual([current.workspace]);

      const visibleSecrets = await db.withWorkspace(current.workspace, (tx) => tx.execute<{ name: string }>('SELECT name FROM secrets'));
      expect(visibleSecrets.rows).toEqual([]);

      // A row for another workspace breaks the policy's WITH CHECK.
      const rls = await db
        .withWorkspace(current.workspace, (tx) =>
          tx.execute(
            sql`INSERT INTO idempotency_keys (workspace_id, key, command, input_hash, response)
                VALUES (${other}, 'k', 'c', 'h', '{}'::jsonb)`,
          ),
        )
        .then(
          () => null,
          (err) => err,
        );
      expect(messagesOf(rls)).toMatch(/row-level security/);

      // The app role can append audit entries but never rewrite them.
      await db.withWorkspace(current.workspace, (tx) =>
        tx.execute(
          sql`INSERT INTO audit_log (workspace_id, principal_type, principal_id, surface, command, effect, input_hash, ok, hash)
              VALUES (${current.workspace}, 'user', 'u', 'rest', 'test.run', 'write', 'h', true, 'h')`,
        ),
      );
      const updated = await db
        .withWorkspace(current.workspace, (tx) => tx.execute('UPDATE audit_log SET ok = false'))
        .then(
          () => null,
          (err) => err,
        );
      expect(messagesOf(updated)).toMatch(/permission denied/);
      const deleted = await db
        .withWorkspace(current.workspace, (tx) => tx.execute('DELETE FROM audit_log'))
        .then(
          () => null,
          (err) => err,
        );
      expect(messagesOf(deleted)).toMatch(/permission denied/);
    } finally {
      await db.close();
    }
  });

  it('lets the app role insert a workspace for workspace.create (RLS still scopes it)', async () => {
    const current = disposable!;
    const db = createDb({ adminUrl: current.url.toString(), appUrl: appUrl(current.url), poolSize: 2 });
    try {
      await db.withWorkspace(workspace, (tx) =>
        tx.execute(
          sql`INSERT INTO workspaces (id, name, approval_policy, settings) VALUES (${workspace}, 'New', 'agent_changes', '{"switch":"off"}')`,
        ),
      );
      const [row] = (
        await db.admin.query<{ settings: Record<string, unknown> }>('SELECT settings FROM workspaces WHERE id = $1', [workspace])
      ).rows;
      expect(row?.settings).toEqual({ switch: 'off' });
    } finally {
      await db.close();
    }
  });
});
