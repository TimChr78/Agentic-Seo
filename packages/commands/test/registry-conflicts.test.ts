import type { AppError } from '@agentic-seo/core';
import { createDb, schema } from '@agentic-seo/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { APP_ROLE, createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { userPrincipal } from '../src';
import { createExecutor, defineCommand } from '../src/registry';

// #867 and #912: a writer that races another past the advisory locks still reaches a partial unique
// index. That must read as a conflict a person can act on — once in the ledger, once in the audit
// log — never as an internal failure.

const appUrl = (url: URL) => {
  const u = new URL(url.toString());
  u.username = APP_ROLE.appRole;
  u.password = APP_ROLE.appRolePassword;
  return u.toString();
};

const services = { serverVersion: 'test', strictInputs: false };

/** A writer that skips `lockSingleton`: it inserts a second site context straight into the table. */
const duplicateSingleton = defineCommand({
  name: 'test.duplicateSingleton',
  title: 'Duplicate singleton',
  description: 'Test-only write: inserts a second site context without the singleton lock.',
  input: z.object({}),
  output: z.object({}),
  permission: null,
  effect: 'write',
  actionClass: 'draft',
  handler: async (_input, ctx) => {
    await ctx.tx.insert(schema.artifacts).values({
      workspaceId: ctx.principal.workspaceId,
      id: `sct_${'d'.repeat(32)}`,
      type: 'site_context',
      name: 'A second context',
      latestVersion: 1,
    });
    return {};
  },
});

/** A writer that publishes a second version without superseding the first (#912). */
const secondPublished = defineCommand({
  name: 'test.secondPublished',
  title: 'Second published version',
  description: 'Test-only write: marks another version published without superseding the live one.',
  input: z.object({ artifactId: z.string(), number: z.number().int() }),
  output: z.object({}),
  permission: null,
  effect: 'write',
  actionClass: 'draft',
  handler: async (input, ctx) => {
    await ctx.tx
      .update(schema.artifactVersions)
      .set({ state: 'published' })
      .where(
        and(
          eq(schema.artifactVersions.workspaceId, ctx.principal.workspaceId),
          eq(schema.artifactVersions.artifactId, input.artifactId),
          eq(schema.artifactVersions.number, input.number),
        ),
      );
    return {};
  },
});

describe.skipIf(!hasTestDatabase())('unique-index races answer as conflicts', () => {
  let disposable: Awaited<ReturnType<typeof createDisposableDb>> | undefined;
  afterAll(async () => {
    await disposable?.close();
  });

  const seed = async () => {
    disposable = await createDisposableDb('conflicts');
    const current = disposable;
    const db = createDb({ adminUrl: current.url.toString(), appUrl: appUrl(current.url), poolSize: 2 });
    const executor = createExecutor(db, services);
    const principal = userPrincipal('user_1', current.workspace, 'owner');
    return { current, db, executor, principal };
  };

  it('maps a second active singleton to a readable conflict with one audit row', async () => {
    const { current, db, executor, principal } = await seed();
    try {
      await current.db.admin.query(
        `INSERT INTO artifacts (workspace_id, id, type, name, latest_version) VALUES ($1, $2, 'site_context', 'Context', 1)`,
        [current.workspace, `sct_${'e'.repeat(32)}`],
      );
      const err = await executor.execute(duplicateSingleton, {}, principal, { surface: 'rest' }).then(
        () => null,
        (e) => e as AppError,
      );
      expect(err?.code).toBe('conflict');
      expect(err?.message).toMatch(/already has an artifact of that type/);
      const { rows } = await current.db.admin.query<{ ok: boolean; error: string }>(
        "SELECT ok, error FROM audit_log WHERE workspace_id = $1 AND command = 'test.duplicateSingleton'",
        [current.workspace],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.error).toMatch(/^conflict: This workspace already has an artifact of that type/);
    } finally {
      await db.close();
    }
  });

  it('maps a second published version to a readable conflict with one audit row', async () => {
    const { current, db, executor, principal } = await seed();
    try {
      const artifactId = `not_${'f'.repeat(32)}`;
      await current.db.admin.query(
        `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version)
         VALUES ($1, $2, 'note', 'Note', 2, 1)`,
        [current.workspace, artifactId],
      );
      for (const [number, state] of [
        [1, 'published'],
        [2, 'draft'],
      ] as const)
        await current.db.admin.query(
          `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
           VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, 'user', 'user_1')`,
          [current.workspace, artifactId, number, state, `hash-${number}`],
        );

      const err = await executor.execute(secondPublished, { artifactId, number: 2 }, principal, { surface: 'rest' }).then(
        () => null,
        (e) => e as AppError,
      );
      expect(err?.code).toBe('conflict');
      expect(err?.message).toMatch(/already has a published version/);
      const { rows } = await current.db.admin.query<{ ok: boolean; error: string }>(
        "SELECT ok, error FROM audit_log WHERE workspace_id = $1 AND command = 'test.secondPublished'",
        [current.workspace],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.error).toMatch(/^conflict: This artifact already has a published version/);
      // Nothing changed: the transaction rolled back whole.
      const { rows: versions } = await current.db.admin.query<{ number: number; state: string }>(
        'SELECT number, state FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2 ORDER BY number',
        [current.workspace, artifactId],
      );
      expect(versions).toEqual([
        { number: 1, state: 'published' },
        { number: 2, state: 'draft' },
      ]);
    } finally {
      await db.close();
    }
  });
});
