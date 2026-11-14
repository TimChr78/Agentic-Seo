import { afterAll, describe, expect, it } from 'vitest';
import { createDisposableDb, type DisposableDb, hasTestDatabase } from './disposable';

// #912 and #899: two artifact invariants the application also keeps are held by the database, so a
// writer that skips the publish or singleton lock cannot quietly break them. There is no legacy
// repair because Phase 0 has not shipped; the indexes are part of the first migration.

const open: DisposableDb[] = [];
afterAll(async () => {
  for (const db of open) await db.close().catch(() => {});
});

let nextId = 1;
const id = (prefix: string) => `${prefix}_${(nextId++).toString(16).padStart(32, '0')}`;

describe.skipIf(!hasTestDatabase())('artifact integrity indexes', () => {
  const setup = async () => {
    const d = await createDisposableDb('artifact_integrity');
    open.push(d);
    return d;
  };

  const insertArtifact = (d: DisposableDb, artifactId: string, type = 'note', archived = false) =>
    d.db.admin.query(
      `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, archived) VALUES ($1, $2, $3, 'Seeded', 1, $4)`,
      [d.workspace, artifactId, type, archived],
    );

  const insertVersion = (d: DisposableDb, artifactId: string, number: number, state: string) =>
    d.db.admin.query(
      `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, 'user', 'user_seed')`,
      [d.workspace, artifactId, number, state, `hash-${artifactId}-${number}`],
    );

  it('refuses a second published version and frees the slot only after superseding the live one', async () => {
    const d = await setup();
    const artifactId = id('not');
    await insertArtifact(d, artifactId);
    await insertVersion(d, artifactId, 1, 'published');
    await insertVersion(d, artifactId, 2, 'draft');

    await expect(insertVersion(d, artifactId, 3, 'published')).rejects.toMatchObject({
      code: '23505',
      constraint: 'artifact_versions_one_published',
    });
    await expect(
      d.db.admin.query("UPDATE artifact_versions SET state = 'published' WHERE workspace_id = $1 AND artifact_id = $2 AND number = 2", [
        d.workspace,
        artifactId,
      ]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'artifact_versions_one_published' });

    // The publish path supersedes the live version first, which frees the one slot.
    await d.db.admin.query(
      "UPDATE artifact_versions SET state = 'superseded' WHERE workspace_id = $1 AND artifact_id = $2 AND number = 1",
      [d.workspace, artifactId],
    );
    await insertVersion(d, artifactId, 3, 'published');
    const { rows } = await d.db.admin.query<{ number: number; state: string }>(
      'SELECT number, state FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2 ORDER BY number',
      [d.workspace, artifactId],
    );
    expect(rows).toEqual([
      { number: 1, state: 'superseded' },
      { number: 2, state: 'draft' },
      { number: 3, state: 'published' },
    ]);
  });

  it('refuses a second active singleton but allows one once the live row is archived', async () => {
    const d = await setup();
    const first = id('sct');
    await insertArtifact(d, first, 'site_context');
    await expect(insertArtifact(d, id('sct'), 'site_context')).rejects.toMatchObject({
      code: '23505',
      constraint: 'artifacts_singleton_type',
    });
    // A different singleton type, a different site and an archived row do not collide.
    await insertArtifact(d, id('sct'), 'site_context', true);
    await d.db.admin.query('UPDATE artifacts SET archived = true WHERE workspace_id = $1 AND id = $2', [d.workspace, first]);
    await insertArtifact(d, id('sct'), 'site_context');
  });

  it('declares both indexes as partial and valid', async () => {
    const d = await setup();
    const { rows } = await d.db.admin.query<{ name: string; indexdef: string; valid: boolean }>(
      `SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS indexdef, i.indisvalid AS valid
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname IN ('artifact_versions_one_published', 'artifacts_singleton_type')
        ORDER BY c.relname`,
    );
    expect(rows.map((row) => row.name)).toEqual(['artifact_versions_one_published', 'artifacts_singleton_type']);
    expect(rows.every((row) => row.valid)).toBe(true);
    expect(rows[0]?.indexdef).toMatch(/state = 'published'/);
    expect(rows[1]?.indexdef).toMatch(/archived = false/);
    expect(rows[1]?.indexdef).toMatch(/site_id/);
  });
});
