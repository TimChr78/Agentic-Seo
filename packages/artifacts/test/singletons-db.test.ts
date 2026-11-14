import { afterAll, describe, expect, it } from 'vitest';
import { createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { publishedSingleton } from '../src/commands';
import { activeMandates } from '../src/mandates';

// #899 and #911: singleton readers skip archived rows, and the mandate the runtime picks is
// deterministic when two published mandates of one agent carry the same timestamp.

const open: DisposableDb[] = [];
afterAll(async () => {
  for (const db of open) await db.close().catch(() => {});
});

const seedArtifact = async (d: DisposableDb, artifactId: string, type: string, content: unknown, opts: { archived?: boolean } = {}) => {
  await d.db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version, archived)
     VALUES ($1, $2, $3, 'Seeded', 1, 1, $4)`,
    [d.workspace, artifactId, type, opts.archived ?? false],
  );
  await d.db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1, $2, 1, 'published', $3::jsonb, $4, 'user', 'user_seed')`,
    [d.workspace, artifactId, JSON.stringify(content), `hash-${artifactId}`],
  );
};

describe.skipIf(!hasTestDatabase())('singleton readers and archived rows', () => {
  it('does not return an archived site context as the workspace’s published one (#899)', async () => {
    const d = await createDisposableDb('singleton_readers');
    open.push(d);
    const archivedId = `sct_${'1'.repeat(32)}`;
    await seedArtifact(d, archivedId, 'site_context', { businessOverview: 'The archived one.' }, { archived: true });

    const read = () => d.db.withWorkspace(d.workspace, (tx) => publishedSingleton(tx, 'site_context'));
    // The dead row is history: nothing is live for the workspace, even though its version is published.
    expect(await read()).toBeNull();

    // With a live successor, the reader names the successor.
    const activeId = `sct_${'2'.repeat(32)}`;
    await seedArtifact(d, activeId, 'site_context', { businessOverview: 'The active one.' });
    expect(await read()).toMatchObject({ businessOverview: 'The active one.' });
  });

  it('picks the same mandate for equal timestamps, by artifact id (#911)', async () => {
    const d = await createDisposableDb('mandate_order');
    open.push(d);
    const agent = `agt_${'a'.repeat(32)}`;
    const expires = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const low = `mnd_${'0'.repeat(32)}`;
    const high = `mnd_${'9'.repeat(32)}`;
    await seedArtifact(d, low, 'agent_mandate', { agent, purpose: 'Lower id', expires });
    await seedArtifact(d, high, 'agent_mandate', { agent, purpose: 'Higher id', expires });
    await d.db.admin.query('UPDATE artifacts SET updated_at = $1 WHERE workspace_id = $2', [new Date('2026-01-01T00:00:00Z'), d.workspace]);

    const picked = await d.db.withWorkspace(d.workspace, (tx) => activeMandates(tx, [agent]));
    expect(picked.get(agent)?.view.id).toBe(high);
  });
});
