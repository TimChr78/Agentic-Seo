import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejects, startTestServer, testPort, type User } from './harness';

// artifacts.list must page past its 200-row maximum and report the true total. The UI follows
// nextCursor; this proves the keyset boundary never skips or repeats a row, and that the type and
// site filters apply to the total as well. Ported from Agentic Marketing 311460E (#382).

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
const SITE = '33333333-3333-4333-8333-333333333333';

beforeAll(async () => {
  t = await startTestServer('test_artifact_pages', testPort(3510));
  owner = await t.signUp(`pages-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
  // Seeded directly: the boundary is what is under test, and 201 HTTP round trips would only
  // slow the suite down.
  await t.srv.db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, site_id)
     SELECT $1, 'not_' || lpad(i::text, 32, '0'), 'note', 'Numbered note ' || i, 1,
            CASE WHEN i % 2 = 0 THEN $2::uuid ELSE NULL END
     FROM generate_series(1, 201) AS i`,
    [ws, SITE],
  );
  await t.srv.db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     SELECT $1, 'not_' || lpad(i::text, 32, '0'), 1, 'draft', '{}'::jsonb, 'hash-' || i, 'user', $2
     FROM generate_series(1, 201) AS i`,
    [ws, owner.id],
  );
  // Every row shares a JS millisecond, with microsecond spacing: a cursor rounded through Date
  // would skip the last tied row.
  await t.srv.db.admin.query(
    `WITH ranked AS (
       SELECT id, row_number() OVER (ORDER BY id) AS n FROM artifacts WHERE workspace_id = $1
     ) UPDATE artifacts a
     SET updated_at = '2026-11-04 12:34:56.123000+00'::timestamptz + ranked.n * interval '1 microsecond'
     FROM ranked WHERE a.workspace_id = $1 AND a.id = ranked.id`,
    [ws],
  );
}, 120_000);
afterAll(() => t?.close());

describe('artifacts.list pagination', () => {
  it('reaches every artifact and reports the server total, not the page length', async () => {
    const api = t.api(owner, ws);
    const first = await api.call('artifacts.list', { type: 'note', limit: 200 });
    expect(first.artifacts).toHaveLength(200);
    expect(first.total).toBe(201);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await api.call('artifacts.list', { type: 'note', limit: 200, cursor: first.nextCursor! });
    expect(second.artifacts).toHaveLength(1);
    expect(second.total).toBe(201);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.artifacts, ...second.artifacts].map((a) => a.id)).size).toBe(201);
  });

  it('filters the total by type and site and rejects a malformed cursor', async () => {
    const api = t.api(owner, ws);
    expect((await api.call('artifacts.list', { type: 'note', limit: 1 })).total).toBe(201);
    expect((await api.call('artifacts.list', { type: 'skill', limit: 1 })).total).toBe(0);
    expect((await api.call('artifacts.list', { type: 'note', siteId: SITE, limit: 1 })).total).toBe(100);

    const bad = await rejects(api.call('artifacts.list', { cursor: 'not-a-cursor' }));
    expect(bad.code).toBe('invalid_input');
    const notes = await api.call('artifacts.list', { type: 'note', limit: 1 });
    for (const stamp of ['2026-02-30 12:00:00+00', '0000-01-01 00:00:00+00', '0']) {
      const invalidDate = await rejects(api.call('artifacts.list', { cursor: `${stamp}~${notes.artifacts[0]!.id}` }));
      expect(invalidDate.code).toBe('invalid_input');
      expect(invalidDate.status).toBe(400);
    }
  });
});
