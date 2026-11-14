import { createClient } from '@agentic-seo/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Commands } from '../src/registry';
import { rejects, startTestServer, testPort, type User } from './harness';

// The provider usage commands are part of the running server's registry: a person sets a monthly
// budget and reads spend back, and an agent never sets a budget. Phase 0 configures no data
// adapter, so a port without one answers with the key that unlocks it instead of fake data.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';

const agentApi = (token: string) => createClient<Commands>({ baseUrl: t.base, headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  t = await startTestServer('test_provider_usage', testPort(3515));
  owner = await t.signUp(`usage-owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
}, 120_000);

afterAll(() => t?.close());

describe('provider usage through the server', () => {
  it('sets a monthly budget as a person and reads it back', async () => {
    const api = t.api(owner, ws);
    const set = await api.call('usage.setBudget', {
      providerId: 'dataforseo',
      period: '2026-11',
      currency: 'USD',
      budgetMicros: 5_000_000,
    });
    expect(set).toMatchObject({
      providerId: 'dataforseo',
      period: '2026-11',
      currency: 'USD',
      budgetMicros: 5_000_000,
      spentMicros: 0,
      heldMicros: 0,
      remainingMicros: 5_000_000,
    });

    const budgets = await api.call('usage.budgets', { period: '2026-11' });
    expect(budgets.period).toBe('2026-11');
    expect(budgets.budgets).toEqual([
      expect.objectContaining({
        providerId: 'dataforseo',
        period: '2026-11',
        budgetMicros: 5_000_000,
        remainingMicros: 5_000_000,
      }),
    ]);
  });

  it('answers spend and unresolved calls before any adapter is configured', async () => {
    const api = t.api(owner, ws);
    expect(await api.call('usage.spend', { period: '2026-11' })).toEqual({ period: '2026-11', rows: [] });
    expect(await api.call('usage.unresolved', {})).toEqual({ calls: [] });
  });

  it('refuses an estimate for a port with no adapter instead of inventing a price', async () => {
    const err = await rejects(
      t.api(owner, ws).call('usage.estimate', {
        port: 'KeywordData',
        operation: 'metrics',
        request: { keywords: ['technical seo'], market: 'us' },
      }),
    );
    expect(err).toMatchObject({
      status: 412,
      message: expect.stringContaining('no adapter is configured'),
    });
  });

  it('refuses a budget change from an agent, whatever its scopes', async () => {
    const token = (
      await t.api(owner, ws).call('apiTokens.create', {
        name: 'Budget agent',
        scopes: ['artifacts:read', 'research:spend'],
      })
    ).token;
    await expect(
      agentApi(token).call('usage.setBudget', {
        providerId: 'dataforseo',
        period: '2026-11',
        currency: 'USD',
        budgetMicros: 1_000_000,
      }),
    ).rejects.toMatchObject({ status: 403, message: expect.stringContaining('can only be run by a person') });
  });
});
