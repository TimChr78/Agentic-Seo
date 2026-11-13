import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejects, startTestServer, testPort, type User } from './harness';

// Config as code: export artifacts as one JSON bundle, compare it with the workspace, and import it
// through the same drafts and approval policy as any edit. Ported from Agentic Marketing 311460e
// packages/artifacts/src/bundle.ts (the marketing settings are gone).

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let api: ReturnType<typeof t.api>;

beforeAll(async () => {
  t = await startTestServer('test_config_bundle', testPort(3403));
  owner = await t.signUp(`bundle-owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  api = t.api(owner, ws);
}, 120_000);
afterAll(() => t?.close());

describe('config bundles', () => {
  it('exports published artifacts and settings, and drift reports them unchanged', async () => {
    const note = await api.call('artifacts.create', { type: 'note', name: 'Bundled note', content: { title: 'Bundled', body: 'Body' } });
    await api.call('artifacts.requestPublish', { artifactId: note.artifactId, note: 'publish' });
    const skill = await api.call('artifacts.create', {
      type: 'skill',
      name: 'Bundled skill',
      content: { title: 'Title rewrites', instructions: 'Keep intent.' },
    });

    const bundle = await api.call('config.export', { includeSettings: true });
    expect(bundle.format).toBe('agentic-seo/artifacts@1');
    expect(bundle.artifacts.map((a) => a.id)).toEqual(expect.arrayContaining([note.artifactId]));
    // The unpublished skill is not live, so a plain export leaves it out.
    expect(bundle.artifacts.some((a) => a.id === skill.artifactId)).toBe(false);
    expect(bundle.settings).toMatchObject({ approvalPolicy: 'none' });
    expect(JSON.stringify(bundle)).not.toContain('password');

    const drift = await api.call('config.drift', { bundle });
    expect(drift.summary).toMatchObject({ create: 0, update: 0, conflict: 0 });
    expect(drift.drift.find((d) => d.key === note.artifactId)?.status).toBe('unchanged');
  });

  it('imports a new artifact and a changed draft, starting as a dry run', async () => {
    const bundle = await api.call('config.export', { includeDrafts: true });
    const note = bundle.artifacts.find((a) => a.type === 'note')!;
    const newId = `skl_${'c'.repeat(32)}`;
    const next = {
      ...bundle,
      artifacts: [
        { ...note, content: { title: 'Changed title', body: 'Changed body' } },
        { id: newId, type: 'skill' as const, name: 'Imported skill', content: { title: 'Imported', instructions: 'Do the thing.' } },
      ],
    };

    const drift = await api.call('config.drift', { bundle: next });
    expect(drift.summary.create).toBe(1);
    expect(drift.summary.update).toBe(1);

    const dry = await api.call('config.import', { bundle: next });
    expect(dry.dryRun).toBe(true);
    expect(dry.changes.map((c) => c.action).sort()).toEqual(['create', 'update']);
    // Nothing was written.
    await expect(api.call('artifacts.get', { artifactId: newId })).rejects.toMatchObject({ code: 'not_found' });

    const applied = await api.call('config.import', { bundle: next, dryRun: false });
    expect(applied.dryRun).toBe(false);
    expect((await api.call('artifacts.get', { artifactId: newId })).name).toBe('Imported skill');
    const changed = await api.call('artifacts.get', { artifactId: note.id });
    expect(changed.version.content).toMatchObject({ title: 'Changed title' });
    expect(changed.version.state).toBe('draft');
  });

  it('applies non-secret settings only for a person with workspace:admin', async () => {
    const exported = await api.call('config.export', { includeSettings: true });
    const bundle = { ...exported, settings: { ...exported.settings!, name: 'Renamed workspace' } };
    const imported = await api.call('config.import', { bundle, dryRun: false });
    expect(imported.settings.find((s) => s.key === 'name')?.action).toBe('update');
    expect((await api.call('workspace.get', {})).name).toBe('Renamed workspace');

    const token = (await api.call('apiTokens.create', { name: 'Bundle agent', scopes: ['artifacts:read', 'artifacts:write'] })).token;
    const res = await fetch(`${t.base}/v1/config.import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ bundle, dryRun: false }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).message).toContain('workspace:admin');
  });

  it('records each publish of an agent’s import in the ledger, held and refused alike', async () => {
    const token = (
      await api.call('apiTokens.create', { name: 'Importing agent', scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'] })
    ).token;
    const agentCall = async (name: string, body: unknown = {}) => {
      const res = await fetch(`${t.base}/v1/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    const agentId = (await agentCall('whoami')).body.agent.id as string;
    const exported = await api.call('config.export', {});
    const ledger = async (target: string) =>
      (
        await t.srv.db.admin.query<{ decision: string; ok: boolean; impact: { approvalId?: string }; command: string }>(
          `SELECT command, decision, ok, impact FROM agent_actions
            WHERE workspace_id = $1 AND agent_id = $2 AND target = $3 AND command = 'artifacts.requestPublish'
            ORDER BY id`,
          [ws, agentId, target],
        )
      ).rows;

    // Held: site memory is a settings change, so a person must approve it.
    const contextId = `sct_${'e'.repeat(32)}`;
    const held = await agentCall('config.import', {
      bundle: {
        ...exported,
        artifacts: [{ id: contextId, type: 'site_context', name: 'Site context', content: { businessOverview: 'A news site.' } }],
      },
      dryRun: false,
      publish: true,
    });
    expect(held.status).toBe(200);
    expect(held.body.changes[0].publish).toBe('in_review');
    const [pending] = (
      await t.srv.db.admin.query<{ id: string }>(
        `SELECT id FROM approval_requests WHERE workspace_id = $1 AND artifact_id = $2 AND status = 'pending'`,
        [ws, contextId],
      )
    ).rows;
    const heldRows = await ledger(contextId);
    expect(heldRows).toHaveLength(1);
    expect(heldRows[0]).toMatchObject({ decision: 'ask', ok: true });
    expect(heldRows[0]?.impact.approvalId).toBe(pending?.id);

    // Refused: a mandate at level 0 for settings forbids this agent to publish site memory.
    const mandate = await api.call('artifacts.create', {
      type: 'agent_mandate',
      name: 'No settings',
      content: {
        agent: agentId,
        purpose: 'Draft only.',
        expires: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        levels: { draft: 1, settings: 0 },
      },
    });
    expect((await api.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'grant' })).status).toBe('published');
    await api.call('approvals.reject', { approvalId: pending!.id, note: 'Not yet' });
    const refused = await agentCall('config.import', {
      bundle: {
        ...exported,
        artifacts: [{ id: contextId, type: 'site_context', name: 'Site context', content: { businessOverview: 'A sports site.' } }],
      },
      dryRun: false,
      publish: true,
    });
    expect(refused.status).toBe(200);
    expect(refused.body.changes[0].publish).toBe('failed');
    const rows = await ledger(contextId);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ decision: 'deny', ok: false });
  });

  it('refuses an unknown artifact type in a bundle', async () => {
    const exported = await api.call('config.export', { includeDrafts: true });
    const bundle = {
      ...exported,
      artifacts: [{ id: `not_${'d'.repeat(32)}`, type: 'journey' as never, name: 'Old type', content: {} }],
    };
    const e = await rejects(api.call('config.drift', { bundle }));
    expect(e.code).toBe('invalid_input');
  });
});
