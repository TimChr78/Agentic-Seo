import { dependencyOrder } from '@agentic-seo/artifacts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejects, startTestServer, testPort, type User } from './harness';

// The generic artifact system: drafts with optimistic concurrency, history, structural diffs,
// the approval policy (including four-eyes), bundles and site-scoped singletons. Ported from
// Agentic Marketing 311460e apps/server tests and adapted to the SEO artifact types.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let approver: User;

const note = (title: string, body = 'Body') => ({ title, body });

beforeAll(async () => {
  t = await startTestServer('test_artifacts', testPort(3401));
  owner = await t.signUp(`artifacts-owner-${Date.now()}@example.com`);
  approver = await t.signUp(`artifacts-approver-${Date.now()}@example.com`);
}, 120_000);
afterAll(() => t?.close());

const api = (workspace: string, user: User = owner) => t.api(user, workspace);

describe('artifacts: drafts, history and diffs', () => {
  let ws = '';
  let apiOwner: ReturnType<typeof t.api>;
  let noteId = '';

  beforeAll(async () => {
    ws = await t.workspaceWith(
      [
        [owner, 'owner'],
        [approver, 'approver'],
      ],
      'none',
    );
    apiOwner = api(ws);
  });

  it('creates a draft, reads it and reports warnings only where the schema would fail', async () => {
    const created = await apiOwner.call('artifacts.create', { type: 'note', name: 'First note', content: note('Hello') });
    noteId = created.artifactId;
    expect(created).toMatchObject({ version: 1, state: 'draft', warnings: [] });
    const got = await apiOwner.call('artifacts.get', { artifactId: noteId });
    expect(got).toMatchObject({
      id: noteId,
      type: 'note',
      name: 'First note',
      latestVersion: 1,
      publishedVersion: null,
      version: { number: 1, state: 'draft', content: note('Hello') },
    });
    expect(got.version.by).toMatchObject({ kind: 'person', personName: owner.email.split('@')[0] });
  });

  it('refuses a draft write whose expected content hash is stale', async () => {
    const first = await apiOwner.call('artifacts.get', { artifactId: noteId });
    await apiOwner.call('artifacts.updateDraft', {
      artifactId: noteId,
      content: note('Changed once'),
      expectedContentHash: first.version.contentHash,
    });
    const stale = await rejects(
      apiOwner.call('artifacts.updateDraft', {
        artifactId: noteId,
        content: note('Changed twice'),
        expectedContentHash: first.version.contentHash,
      }),
    );
    expect(stale.code).toBe('precondition_failed');
    expect((await apiOwner.call('artifacts.get', { artifactId: noteId })).version.content).toEqual(note('Changed once'));
  });

  it('publishes a note directly under the none policy and starts a new draft after it', async () => {
    const published = await apiOwner.call('artifacts.requestPublish', { artifactId: noteId, note: 'First publish' });
    expect(published).toMatchObject({ status: 'published', version: 1, approvalId: null });
    const next = await apiOwner.call('artifacts.updateDraft', { artifactId: noteId, content: note('Second draft') });
    expect(next).toMatchObject({ version: 2, state: 'draft' });
    const a = await apiOwner.call('artifacts.get', { artifactId: noteId });
    expect(a).toMatchObject({ latestVersion: 2, publishedVersion: 1 });
    const history = await apiOwner.call('artifacts.history', { artifactId: noteId });
    expect(history.versions.map((v) => v.number)).toEqual([2, 1]);
    expect(history.versions[1]?.by?.kind).toBe('person');
  });

  it('shows a structural diff from the published version to the latest draft', async () => {
    const out = await apiOwner.call('artifacts.diff', { artifactId: noteId });
    expect(out.from).toBe(1);
    expect(out.to).toBe(2);
    expect(out.changes).toContainEqual({ path: 'title', kind: 'changed', before: 'Changed once', after: 'Second draft' });
  });

  it('discards the unpublished versions and returns to the live one', async () => {
    const created = await apiOwner.call('artifacts.create', { type: 'note', name: 'Discard note', content: note('live') });
    await apiOwner.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'v1' });
    await apiOwner.call('artifacts.updateDraft', { artifactId: created.artifactId, content: note('draft') });
    const discarded = await apiOwner.call('artifacts.discardDraft', { artifactId: created.artifactId });
    expect(discarded).toMatchObject({ version: 1, state: 'published', discardedVersions: [2] });
    const got = await apiOwner.call('artifacts.get', { artifactId: created.artifactId });
    expect(got).toMatchObject({ latestVersion: 1, publishedVersion: 1 });
  });

  it('refuses content for a placeholder type with the phase it arrives in', async () => {
    const e = await rejects(
      apiOwner.call('artifacts.create', {
        type: 'recommendation',
        name: 'Too early',
        content: { title: 'Not yet' },
      }),
    );
    expect(e.code).toBe('invalid_input');
    expect(e.message).toContain('This artifact type arrives in Phase 1.');
  });

  it('makes site_context a singleton per site, not per workspace', async () => {
    const siteA = '11111111-1111-4111-8111-111111111111';
    const siteB = '22222222-2222-4222-8222-222222222222';
    const context = { businessOverview: 'A SaaS for SEO teams.' };
    const first = await apiOwner.call('artifacts.create', {
      type: 'site_context',
      name: 'Site A context',
      siteId: siteA,
      content: context,
    });
    const duplicate = await rejects(
      apiOwner.call('artifacts.create', { type: 'site_context', name: 'Another A', siteId: siteA, content: context }),
    );
    expect(duplicate.code).toBe('conflict');
    const second = await apiOwner.call('artifacts.create', {
      type: 'site_context',
      name: 'Site B context',
      siteId: siteB,
      content: context,
    });
    expect(second.artifactId).not.toBe(first.artifactId);
    expect((await apiOwner.call('artifacts.get', { artifactId: first.artifactId })).siteId).toBe(siteA);
    expect((await apiOwner.call('artifacts.list', { type: 'site_context', siteId: siteB })).total).toBe(1);
  });
});

describe('artifacts: the approval policy', () => {
  let ws = '';
  let apiOwner: ReturnType<typeof t.api>;
  let apiApprover: ReturnType<typeof t.api>;

  beforeAll(async () => {
    ws = await t.workspaceWith(
      [
        [owner, 'owner'],
        [approver, 'approver'],
      ],
      'agent_changes',
    );
    apiOwner = api(ws);
    apiApprover = api(ws, approver);
  });

  it('sends a person’s own change straight through but reviews an agent’s', async () => {
    const created = await apiOwner.call('artifacts.create', { type: 'note', name: 'Reviewed note', content: note('v1') });
    expect((await apiOwner.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'v1' })).status).toBe('published');
    await apiOwner.call('artifacts.updateDraft', { artifactId: created.artifactId, content: note('v2') });
    expect((await apiOwner.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'v2' })).status).toBe('published');

    const token = (
      await apiOwner.call('apiTokens.create', { name: 'Writer', scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'] })
    ).token;
    const agent = await agentCall(token, 'whoami');
    expect(agent.status).toBe(200);
    const agentApi = (name: string, body: unknown = {}) => agentCall(token, name, body);
    const ok = await agentApi('artifacts.updateDraft', { artifactId: created.artifactId, content: note('v3 by agent') });
    expect(ok.status).toBe(200);
    const pending = await agentApi('artifacts.requestPublish', { artifactId: created.artifactId, note: 'agent v3' });
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({ status: 'in_review', version: 3 });
    const list = await apiOwner.call('approvals.list', { status: 'pending' });
    expect(list.approvals.find((a) => a.id === pending.body.approvalId)).toMatchObject({
      artifactId: created.artifactId,
      artifactType: 'note',
      version: 3,
      status: 'pending',
    });
    const detail = await apiOwner.call('approvals.get', { approvalId: pending.body.approvalId });
    expect(detail.diff.changes).toContainEqual({ path: 'title', kind: 'changed', before: 'v2', after: 'v3 by agent' });

    const approved = await apiApprover.call('approvals.approve', { approvalId: pending.body.approvalId });
    expect(approved.published).toEqual([{ artifactId: created.artifactId, version: 3 }]);
    expect((await apiOwner.call('artifacts.get', { artifactId: created.artifactId })).publishedVersion).toBe(3);
  });

  it('rejects a request and leaves the version in history as rejected', async () => {
    const created = await apiOwner.call('artifacts.create', { type: 'note', name: 'Rejected note', content: note('good') });
    await apiOwner.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'publish' });
    await apiOwner.call('artifacts.updateDraft', { artifactId: created.artifactId, content: note('bad') });
    const token = (
      await apiOwner.call('apiTokens.create', {
        name: 'Rejected writer',
        scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'],
      })
    ).token;
    const pending = await agentCall2(token, 'artifacts.requestPublish', { artifactId: created.artifactId, note: 'bad' });
    expect(pending.status).toBe(200);
    await apiApprover.call('approvals.reject', { approvalId: pending.body.approvalId, note: 'Not this one' });
    const a = await apiOwner.call('artifacts.get', { artifactId: created.artifactId });
    expect(a.publishedVersion).toBe(1);
    expect(a.version).toMatchObject({ number: 2, state: 'rejected' });
  });

  it('four-eyes: under all_publishes the requester cannot approve their own change', async () => {
    const all = await t.workspaceWith(
      [
        [owner, 'owner'],
        [approver, 'approver'],
      ],
      'all_publishes',
    );
    const o = api(all);
    const a = api(all, approver);
    const created = await o.call('artifacts.create', { type: 'note', name: 'Four eyes', content: note('x') });
    const pending = await o.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'please review' });
    expect(pending.status).toBe('in_review');
    const own = await rejects(o.call('approvals.approve', { approvalId: pending.approvalId! }));
    expect(own.code).toBe('forbidden');
    expect(own.message).toContain('someone else must approve');
    expect((await a.call('approvals.approve', { approvalId: pending.approvalId! })).status).toBe('approved');
  });
});

describe('artifacts: bundles', () => {
  let ws = '';
  let apiOwner: ReturnType<typeof t.api>;
  let apiApprover: ReturnType<typeof t.api>;

  beforeAll(async () => {
    ws = await t.workspaceWith(
      [
        [owner, 'owner'],
        [approver, 'approver'],
      ],
      'all_publishes',
    );
    apiOwner = api(ws);
    apiApprover = api(ws, approver);
  });

  it('orders members so references come first, and refuses a circle', () => {
    const order = dependencyOrder([
      { id: 'not_1', content: { cites: 'rcm_1' } },
      { id: 'rcm_1', content: { title: 'x' } },
    ]);
    expect(order.map((m) => m.id)).toEqual(['rcm_1', 'not_1']);
    expect(() =>
      dependencyOrder([
        { id: 'a_1', content: { ref: 'b_1' } },
        { id: 'b_1', content: { ref: 'a_1' } },
      ]),
    ).toThrow(/circle/);
  });

  it('reviews two drafts once and publishes both in dependency order', async () => {
    const first = await apiOwner.call('artifacts.create', { type: 'note', name: 'Cited note', content: note('Evidence') });
    const second = await apiOwner.call('artifacts.create', { type: 'note', name: 'Citing note', content: note(`See ${first.artifactId}`) });
    const bundle = await apiOwner.call('artifacts.requestPublishBundle', {
      artifactIds: [second.artifactId, first.artifactId],
      note: 'Together',
    });
    expect(bundle.status).toBe('in_review');
    // The citing note names the first, so it is published second.
    expect(bundle.members.map((m) => m.artifactId)).toEqual([first.artifactId, second.artifactId]);
    const pending = (await apiOwner.call('approvals.list', { status: 'pending' })).approvals.filter(
      (a) => a.bundle?.id === bundle.bundleId,
    );
    expect(pending).toHaveLength(2);
    expect(pending[0]?.bundle?.members.map((m) => m.artifactId)).toEqual([first.artifactId, second.artifactId]);

    const approved = await apiApprover.call('approvals.approve', { approvalId: bundle.members[1]!.approvalId! });
    expect(approved.published).toEqual([
      { artifactId: first.artifactId, version: 1 },
      { artifactId: second.artifactId, version: 1 },
    ]);
    for (const id of [first.artifactId, second.artifactId])
      expect((await apiOwner.call('artifacts.get', { artifactId: id })).publishedVersion).toBe(1);
  });

  it('rejects the whole bundle when one member is rejected', async () => {
    const a = await apiOwner.call('artifacts.create', { type: 'note', name: 'Bundle reject A', content: note('a') });
    const b = await apiOwner.call('artifacts.create', { type: 'note', name: 'Bundle reject B', content: note('b') });
    const bundle = await apiOwner.call('artifacts.requestPublishBundle', { artifactIds: [a.artifactId, b.artifactId], note: 'nope' });
    await apiApprover.call('approvals.reject', { approvalId: bundle.members[0]!.approvalId!, note: 'Wrong' });
    for (const id of [a.artifactId, b.artifactId]) {
      const got = await apiOwner.call('artifacts.get', { artifactId: id });
      expect(got.publishedVersion).toBeNull();
      expect(got.version.state).toBe('rejected');
    }
  });

  it('refuses a bundle that would not publish, names the artifact and changes nothing', async () => {
    const a = await apiOwner.call('artifacts.create', { type: 'note', name: 'Bundle check note', content: note('ok') });
    const mandate = await apiOwner.call('artifacts.create', {
      type: 'agent_mandate',
      name: 'Unknown agent mandate',
      content: {
        agent: `agt_${'0'.repeat(32)}`,
        purpose: 'This agent does not exist.',
        expires: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      },
    });
    const e = await rejects(
      apiOwner.call('artifacts.requestPublishBundle', { artifactIds: [a.artifactId, mandate.artifactId], note: 'bad' }),
    );
    expect(e.message).toContain('Unknown agent mandate');
    expect(e.message).toContain('does not exist');
    for (const id of [a.artifactId, mandate.artifactId]) {
      const got = await apiOwner.call('artifacts.get', { artifactId: id });
      expect(got.version.state).toBe('draft');
      expect(got.publishedVersion).toBeNull();
    }
  });
});

async function agentCall(token: string, name: string, body: unknown = {}) {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** The same REST call, for a token created inside a test after the outer helper is bound. */
async function agentCall2(token: string, name: string, body: unknown = {}) {
  return agentCall(token, name, body);
}
