import { randomBytes } from 'node:crypto';
import type { CommandContext } from '@agentic-seo/commands';
import { userPrincipal } from '@agentic-seo/commands';
import { type KeyProvider, localKeyProvider, sealJson } from '@agentic-seo/secrets';
import { afterAll, describe, expect, it } from 'vitest';
import { createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { listAiCalls } from '../src/commands';
import { testPrompt, testRunResults } from '../src/prompts';
import { createAiProvider, listAiProviders } from '../src/providers';
import { fakeLlm } from '../src/testing';
import { runQueuedPromptTests } from '../src/worker';

// The call path at its entry points (the command, the service): a queued prompt test reserves
// tokens against the provider's budget, calls the model outside any transaction, logs the call and
// settles the reservation. Marketing's equivalent is packages/ai/test/steps.test.ts and the budget
// half of prompts.test.ts; here the invariants are checked through prompts.test and the worker.

const open: DisposableDb[] = [];
afterAll(async () => {
  for (const db of open) await db.close().catch(() => {});
});

const newKeyProvider = (): KeyProvider => localKeyProvider(randomBytes(32).toString('base64'));

/** A plain fetch for the scripted server: the production guard refuses loopback on purpose. */
const loopbackFetch: typeof fetch = (input, init) => fetch(input, init);

const promptContent = {
  title: 'Write a title',
  instructions: 'Write a title for the topic.',
  output: {
    kind: 'text',
    slots: [{ name: 'title', description: 'A page title', maxLength: 40, fallback: 'Fallback title' }],
    forbidden: [],
  },
  tests: [{ name: 'pricing', input: { topic: 'pricing' }, expect: { contains: ['pricing'] } }],
};

async function seedPrompt(d: DisposableDb, artifactId: string) {
  await d.db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version)
     VALUES ($1, $2, 'prompt', 'Title prompt', 1, 1)`,
    [d.workspace, artifactId],
  );
  await d.db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1, $2, 1, 'published', $3::jsonb, $4, 'user', 'user_seed')`,
    [d.workspace, artifactId, JSON.stringify(promptContent), `hash-${artifactId}`],
  );
}

async function seedProvider(
  d: DisposableDb,
  kp: KeyProvider,
  opts: { baseUrl: string; monthlyTokenBudget: number | null },
): Promise<string> {
  const id = `aip_${randomBytes(16).toString('hex')}`;
  const sealed = await d.db.withWorkspace(d.workspace, (tx) => sealJson(tx, d.workspace, kp, { apiKey: 'test-key' }));
  await d.db.admin.query(
    `INSERT INTO ai_providers (workspace_id, id, name, kind, base_url, models, use_for, monthly_token_budget, secrets, secrets_key_id)
     VALUES ($1, $2, 'Scripted', 'openai-compatible', $3, $4::jsonb, ARRAY['agents'], $5, $6, $7)`,
    [d.workspace, id, opts.baseUrl, JSON.stringify({ default: 'm' }), opts.monthlyTokenBudget, sealed.blob, sealed.keyId],
  );
  return id;
}

function context(d: DisposableDb, keyProvider: KeyProvider, tx: CommandContext['tx']): CommandContext {
  return {
    principal: userPrincipal('user_test', d.workspace, 'owner'),
    tx,
    services: { serverVersion: 'test', strictInputs: true, keyProvider },
    surface: 'internal',
  };
}

const holdCount = async (d: DisposableDb) =>
  Number((await d.db.admin.query<{ n: string }>('SELECT count(*) AS n FROM ai_token_reservations')).rows[0]?.n ?? 0);

describe.skipIf(!hasTestDatabase())('queued prompt tests', () => {
  it('runs the case, logs one call with its tokens and releases the reservation', async () => {
    const d = await createDisposableDb('ai_prompt_test');
    open.push(d);
    const kp = newKeyProvider();
    const llm = await fakeLlm(() => ({
      text: JSON.stringify({ slots: { title: 'Pricing that converts' } }),
      inputTokens: 50,
      outputTokens: 7,
    }));
    try {
      const providerId = await seedProvider(d, kp, { baseUrl: llm.baseUrl, monthlyTokenBudget: null });
      const artifactId = `prm_${randomBytes(16).toString('hex')}`;
      await seedPrompt(d, artifactId);

      const queued = await d.db.withWorkspace(d.workspace, (tx) => testPrompt.handler({ artifactId }, context(d, kp, tx)));
      expect(queued).toMatchObject({ version: 1, queued: 1 });

      expect(await runQueuedPromptTests(d.db, { kp, fetch: loopbackFetch })).toBe(1);

      const run = await d.db.withWorkspace(d.workspace, (tx) => testRunResults.handler({ runId: queued.runId }, context(d, kp, tx)));
      expect(run).toMatchObject({ status: 'done', passed: 1, failed: 0, inputTokens: 50, outputTokens: 7 });
      expect(run.cases[0]).toMatchObject({ status: 'done', answer: { slots: { title: 'Pricing that converts' } } });

      const calls = await d.db.withWorkspace(d.workspace, (tx) =>
        listAiCalls.handler({ promptId: artifactId, limit: 50 }, context(d, kp, tx)),
      );
      expect(calls.calls).toHaveLength(1);
      expect(calls.calls[0]).toMatchObject({ kind: 'test', status: 'done', providerId, model: 'm' });
      expect(await holdCount(d)).toBe(0);
    } finally {
      await llm.close();
    }
  });

  it('refuses a case whose estimate would pass the monthly budget, and keeps no hold', async () => {
    const d = await createDisposableDb('ai_budget');
    open.push(d);
    const kp = newKeyProvider();
    const llm = await fakeLlm(() => ({ text: JSON.stringify({ slots: { title: 'Never asked' } }) }));
    try {
      // More than nothing is left, but far less than the call's estimate: the reservation refuses it.
      await seedProvider(d, kp, { baseUrl: llm.baseUrl, monthlyTokenBudget: 100 });
      const artifactId = `prm_${randomBytes(16).toString('hex')}`;
      await seedPrompt(d, artifactId);

      const queued = await d.db.withWorkspace(d.workspace, (tx) => testPrompt.handler({ artifactId }, context(d, kp, tx)));
      expect(await runQueuedPromptTests(d.db, { kp, fetch: loopbackFetch })).toBe(1);

      const run = await d.db.withWorkspace(d.workspace, (tx) => testRunResults.handler({ runId: queued.runId }, context(d, kp, tx)));
      expect(run).toMatchObject({ status: 'done', passed: 0, failed: 1 });
      expect(run.cases[0]?.problems.join(' ')).toContain('budget');
      expect(llm.requests).toHaveLength(0);
      expect(await holdCount(d)).toBe(0);
    } finally {
      await llm.close();
    }
  });
});

describe.skipIf(!hasTestDatabase())('AI provider commands', () => {
  it('refuses a base URL that points inside the network', async () => {
    const d = await createDisposableDb('ai_provider_url');
    open.push(d);
    const kp = newKeyProvider();
    const attempt = async (baseUrl: string) =>
      d.db.withWorkspace(d.workspace, (tx) =>
        createAiProvider.handler(
          {
            name: 'Bad',
            kind: 'openai-compatible',
            baseUrl,
            models: { default: 'm' },
            structuredOutputs: true,
            monthlyTokenBudget: null,
            region: '',
            apiKey: 'k',
            useFor: [],
          },
          context(d, kp, tx),
        ),
      );
    for (const baseUrl of [
      'http://169.254.169.254/v1',
      'https://127.0.0.1/v1',
      'https://localhost/v1',
      'https://cache.internal/v1',
      'https://api.example.com:8443/v1',
    ])
      await expect(attempt(baseUrl)).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('stores the key sealed, never returns it, and gives a use to one provider', async () => {
    const d = await createDisposableDb('ai_provider_seal');
    open.push(d);
    const kp = newKeyProvider();
    const create = (name: string) =>
      d.db.withWorkspace(d.workspace, (tx) =>
        createAiProvider.handler(
          {
            name,
            kind: 'openai-compatible',
            baseUrl: 'https://api.openai.com/v1/',
            models: { default: 'gpt-4o-mini' },
            structuredOutputs: true,
            monthlyTokenBudget: null,
            region: '',
            apiKey: 'sk-test-secret',
            useFor: ['agents'],
          },
          context(d, kp, tx),
        ),
      );
    const first = await create('First');
    expect(first.hasApiKey).toBe(true);
    expect(first.baseUrl).toBe('https://api.openai.com/v1');
    expect(JSON.stringify(first)).not.toContain('sk-test-secret');

    const second = await create('Second');
    const listed = await d.db.withWorkspace(d.workspace, (tx) => listAiProviders.handler({}, context(d, kp, tx)));
    const byId = new Map(listed.providers.map((p) => [p.id, p]));
    expect(byId.get(first.id)?.useFor).toEqual([]);
    expect(byId.get(second.id)?.useFor).toEqual(['agents']);
  });
});
