import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAgent, startTestServer, testPort, type User } from './harness';

// The MCP surface: OAuth 2.1 with a consent screen, one workspace per connection, scope step-up
// for a tool the person's role allows but the connection was not granted, and API tokens for
// scripts.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let wsA = '';
let wsB = '';

const textOf = (out: { content: unknown }) => {
  const content = out.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
};

beforeAll(async () => {
  t = await startTestServer('mcp', testPort(2504));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  wsA = await t.workspaceWith([[owner, 'owner']]);
  wsB = await t.workspaceWith([[owner, 'owner']]);
});

afterAll(async () => {
  await t?.close();
});

describe('MCP over OAuth', () => {
  it('binds a connection to the workspace chosen on the consent screen', async () => {
    const agent = await connectAgent(t.base, owner, ['sites:read', 'artifacts:read'], undefined, wsB);
    const workspace = textOf(await agent.client.callTool({ name: 'workspace.get', arguments: {} }));
    expect(workspace.id).toBe(wsB);
    expect(workspace.role).toBe('owner');
    await agent.client.close();
  });

  it('lists tools the role allows but the connection lacks, and answers 403 insufficient_scope', async () => {
    const agent = await connectAgent(t.base, owner, ['sites:read'], undefined, wsA);
    const tools = await agent.client.listTools();
    const members = tools.tools.find((tool) => tool.name === 'members.list');
    expect(members).toBeDefined();
    expect(members?.description).toContain('Needs the "workspace:admin" permission');

    // The SDK answers a challenge by trying to re-authorize; a raw call shows the challenge itself.
    const access = agent.provider.tokenSet?.access_token as string;
    const denied = await fetch(`${t.base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'members.list', arguments: {} } }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain('insufficient_scope');
    expect(denied.headers.get('www-authenticate')).toContain('workspace:admin');
    await agent.client.close();
  });

  it('refuses a connection that chose no workspace when the person has several', async () => {
    // No choice for this request: the grant carries no workspace claim, so the connection cannot act.
    const failed = await connectAgent(t.base, owner, []).catch((err: Error) => err);
    expect(String(failed)).toMatch(/no_workspace/);
  });

  it('accepts an API token without OAuth, with only the tools its scopes allow', async () => {
    const token = (await t.api(owner, wsA).call('apiTokens.create', { name: 'script', scopes: ['sites:read', 'artifacts:read'] })).token;
    const client = new Client({ name: 'script', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${t.base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('workspace.get');
    // People-only commands are never listed to an agent.
    expect(tools.tools.map((tool) => tool.name)).not.toContain('members.invite');
    expect(textOf(await client.callTool({ name: 'workspace.get', arguments: {} })).id).toBe(wsA);
    await client.close();
  });
});
