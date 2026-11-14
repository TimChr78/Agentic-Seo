import { setTxtResolver } from '@agentic-seo/sites';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { connectAgent, startTestServer, testPort, type User } from './harness';

// The site surface end to end: a person creates and verifies a site over REST, an MCP client reads
// it, and an agent's attempt to create one goes through the policy engine and lands in the action
// ledger. Artifacts may only name a real, active site of the same workspace.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';

const textOf = (out: { content: unknown }) => {
  const content = out.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
};

beforeAll(async () => {
  t = await startTestServer('sites', testPort(2514));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
});

afterAll(async () => {
  await t?.close();
});

afterEach(() => {
  setTxtResolver(null);
});

describe('sites over the command surfaces', () => {
  it('lets a person create a site, read the instructions and verify it through the DNS record', async () => {
    const api = t.api(owner, ws);
    const { site } = await api.call('sites.create', { name: 'Acme store', domain: 'Example.COM.' });
    expect(site).toMatchObject({ name: 'Acme store', domain: 'example.com', verified: false, archived: false });
    expect((await api.call('sites.list', {})).sites.map((s) => s.domain)).toContain('example.com');

    const instructions = await api.call('sites.verification', { siteId: site.id });
    expect(instructions.dns.value).toBe(`aseo-site-verification=${instructions.token}`);
    expect(instructions.meta.instructions).toContain(`<meta name="aseo-site-verification" content="${instructions.token}">`);
    expect(instructions.verified).toBe(false);

    // Publish the record the instructions name, then verify through the command the UI calls.
    setTxtResolver(async () => [[instructions.dns.value]]);
    const verified = await api.call('sites.verify', { siteId: site.id });
    expect(verified).toMatchObject({ siteId: site.id, verified: true, method: 'dns', error: null });
    expect((await api.call('sites.get', { siteId: site.id })).site).toMatchObject({ verified: true, verificationMethod: 'dns' });
  });

  it('returns the active site context artifact with the site', async () => {
    const api = t.api(owner, ws);
    const { site } = await api.call('sites.create', { name: 'Context site', domain: 'context.example' });
    expect((await api.call('sites.get', { siteId: site.id })).site.contextArtifactId).toBeNull();

    const artifact = await api.call('artifacts.create', {
      type: 'site_context',
      name: 'Context site memory',
      siteId: site.id,
      content: { businessOverview: 'A store for context.' },
    });
    expect((await api.call('sites.get', { siteId: site.id })).site.contextArtifactId).toBe(artifact.artifactId);
  });

  it('refuses an artifact for a site the workspace does not have, or for an archived one', async () => {
    const api = t.api(owner, ws);
    await expect(
      api.call('artifacts.create', {
        type: 'site_context',
        name: 'Nobody’s memory',
        siteId: '00000000-0000-4000-8000-000000000000',
        content: { businessOverview: 'Not a site.' },
      }),
    ).rejects.toMatchObject({ status: 404, message: expect.stringContaining('does not exist in this workspace') });

    const { site } = await api.call('sites.create', { name: 'Old site', domain: 'old.example' });
    await api.call('sites.archive', { siteId: site.id });
    await expect(
      api.call('artifacts.create', {
        type: 'site_context',
        name: 'Old memory',
        siteId: site.id,
        content: { businessOverview: 'Archived site.' },
      }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('archived') });
  });

  it('serves sites.list to an MCP client that was granted sites:read', async () => {
    const agent = await connectAgent(t.base, owner, ['sites:read'], undefined, ws);
    const listed = textOf(await agent.client.callTool({ name: 'sites.list', arguments: {} }));
    expect((listed.sites as { domain: string }[]).map((s) => s.domain)).toContain('example.com');
    await agent.client.close();
  });

  it('sends an agent’s sites.create through the policy engine and records the refusal in the ledger', async () => {
    const agent = await connectAgent(t.base, owner, ['sites:read', 'sites:write'], undefined, ws);
    const me = textOf(await agent.client.callTool({ name: 'agents.get', arguments: {} }));
    const refused = await agent.client.callTool({ name: 'sites.create', arguments: { name: 'Agent site', domain: 'agent.example' } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain('settings change always needs a person');

    const activity = await t.api(owner, ws).call('agents.activity', { agentId: me.id as string });
    expect(activity.actions).toContainEqual(
      expect.objectContaining({ command: 'sites.create', actionClass: 'settings', decision: 'deny', ok: false }),
    );
    // The refusal rolled back the whole transaction: no site was created.
    expect((await t.api(owner, ws).call('sites.list', {})).sites.map((s) => s.domain)).not.toContain('agent.example');
    await agent.client.close();
  });

  it('reports a stored DataForSEO key in the setup checklist', async () => {
    const api = t.api(owner, ws);
    const { site } = await api.call('sites.create', { name: 'Checklist site', domain: 'checklist.example' });
    expect((await api.call('sites.checklist', { siteId: site.id })).dataForSeoKey).toBe(false);

    await api.call('secrets.set', { name: 'dataforseo.login', value: 'login:password' });
    const facts = await api.call('sites.checklist', { siteId: site.id });
    expect(facts).toMatchObject({
      dataForSeoKey: true,
      siteVerified: false,
      competitors: 0,
      audits: 0,
      searchConsole: false,
      siteConnector: false,
    });
  });
});
