import { createClient } from '@agentic-seo/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Commands } from '../src/registry';
import { rejects, startTestServer, testPort, type User } from './harness';

// A prompt's test cases call the paid LLM provider, so `prompts.test` is a research spend: it needs
// the spending permission and the policy engine judges it as `research.spend`. An agent with only
// artifacts:write is refused at the permission gate; an agent that may spend but has no mandate is
// refused by the policy engine, and the action ledger records that refusal. A person can queue it.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let promptId = '';

const agentApi = (token: string) => createClient<Commands>({ baseUrl: t.base, headers: { authorization: `Bearer ${token}` } });

const promptContent = {
  title: 'Write a page title',
  instructions: 'Write a short title for the page in the input.',
  output: {
    kind: 'text',
    slots: [{ name: 'title', description: 'A concise page title', maxLength: 60, fallback: 'Untitled page' }],
    forbidden: [],
  },
  tests: [
    {
      name: 'pricing page',
      input: { page_url: 'https://example.com/pricing' },
      expect: { contains: ['pricing'], notContains: [] },
    },
  ],
};

beforeAll(async () => {
  t = await startTestServer('test_ai_prompt_spend', testPort(3516));
  owner = await t.signUp(`prompt-spend-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
  const api = t.api(owner, ws);
  // No call is made: prompts.test only resolves the model before it queues the cases.
  await api.call('aiProviders.create', {
    name: 'Agents provider',
    kind: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    models: { default: 'a-model' },
    useFor: ['agents'],
    apiKey: 'test-key',
  });
  promptId = (await api.call('artifacts.create', { type: 'prompt', name: 'Page title prompt', content: promptContent })).artifactId;
}, 120_000);

afterAll(() => t?.close());

describe('prompts.test as a research spend', () => {
  it('lets a person with research:spend queue the cases', async () => {
    const run = await t.api(owner, ws).call('prompts.test', { artifactId: promptId });
    expect(run).toMatchObject({ version: 1, queued: 1 });
    expect(run.runId).toMatch(/^run_[0-9a-f]{32}$/);
  });

  it('refuses an agent that may only draft, before it reaches the provider', async () => {
    const token = (
      await t.api(owner, ws).call('apiTokens.create', {
        name: 'Drafting agent',
        scopes: ['artifacts:read', 'artifacts:write'],
      })
    ).token;
    await expect(agentApi(token).call('prompts.test', { artifactId: promptId })).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('"research:spend" permission'),
    });
  });

  it('refuses an agent that may spend but has no mandate, and records the refusal', async () => {
    const token = (
      await t.api(owner, ws).call('apiTokens.create', {
        name: 'Spending agent',
        scopes: ['artifacts:read', 'research:spend'],
      })
    ).token;
    const api = agentApi(token);
    const me = await api.call('whoami', {});
    const agentId = me.agent!.id;

    const err = await rejects(api.call('prompts.test', { artifactId: promptId }));
    expect(err).toMatchObject({ status: 403, message: expect.stringContaining('no mandate') });

    const { rows } = await t.srv.db.admin.query<{ command: string; action_class: string; decision: string; ok: boolean }>(
      'SELECT command, action_class, decision, ok FROM agent_actions WHERE workspace_id = $1 AND agent_id = $2 ORDER BY id DESC LIMIT 1',
      [ws, agentId],
    );
    expect(rows[0]).toEqual({ command: 'prompts.test', action_class: 'research.spend', decision: 'deny', ok: false });
  });
});
