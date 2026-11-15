import { randomUUID } from 'node:crypto';
import { fakeLlm } from '@agentic-seo/ai/testing';
import { type AnyCommand, agentPrincipal, createExecutor, type Services, userPrincipal } from '@agentic-seo/commands';
import { schema } from '@agentic-seo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { hasTestDatabase } from '../../db/test/disposable';
import {
  createRecommendation,
  generateRecommendations,
  getRecommendation,
  getRecommendationRun,
  listRecommendationRuns,
  listRecommendations,
} from '../src/commands';
import { gatherFacts, MAX_FACTS_CHARS } from '../src/facts';
import { runRecommendationGeneration } from '../src/runner';
import {
  addSite,
  createRecommendationTestContext,
  keyProvider,
  loopbackFetch,
  newKeyProvider,
  type RecommendationTestContext,
  seedAudit,
  seedIssue,
  seedProvider,
  services,
} from './support';

// A generation run end to end, against the scripted LLM: the technical specialist proposes, the
// strategist writes, every item is validated and retried once with its errors, and the run records
// what it created, what it dropped and why. Nothing here reaches the internet.

const candidate = (issueIds: string[]) => ({
  title: 'Add the missing titles',
  issueIds,
  changeTypes: ['meta.title'],
  rationale: 'The 12 pages this issue affects have no title, out of the 40 the audit evaluated.',
  effort: 'small',
  affectedUrls: ['https://example.com/pricing/'],
});

describe.skipIf(!hasTestDatabase())('recommendations.generate', () => {
  let ctx: RecommendationTestContext;
  let ws = '';
  let siteId = '';
  let auditId = '';
  let issueId = '';

  const recommendation = (overrides: Record<string, unknown> = {}) => ({
    title: 'Add titles to the 12 pages that have none',
    rationale: 'The 12 pages this issue affects have no title, out of the 40 the audit evaluated.',
    evidence: [{ kind: 'issue', id: issueId, note: 'Titles are missing on 12 pages' }],
    hypothesis: 'A specific title wins more clicks at the same position.',
    expectedImpact: { summary: 'Expected: more clicks on the 12 pages', confidence: 'medium' },
    effort: 'small',
    verificationPlan: { recheck: 'Re-fetch the 12 pages: each has a non-empty title', when: '7 days after the deploy' },
    falsificationCheck: 'We will know this failed if clicks do not move within 28 days.',
    leadingIndicator: 'Clicks on the 12 pages, daily',
    proposedChanges: [{ type: 'meta.title', url: 'https://example.com/pricing/', summary: 'Write a title' }],
    ...overrides,
  });
  const kp = keyProvider;

  const owner = () => userPrincipal('user_owner', ws, 'owner');
  const call = <C extends AnyCommand>(command: C, input: unknown, principal = owner()): Promise<z.output<C['output']>> =>
    ctx.executor.execute(command, input, principal, { surface: 'rest' });

  const run = async (llmBaseUrl: string, settings: { budget?: number | null } = {}) => {
    // One provider per run, so a later run never calls the previous test's closed server.
    await ctx.db.admin.query('DELETE FROM ai_providers WHERE workspace_id = $1', [ws]);
    await seedProvider(ctx.db, ws, kp, {
      baseUrl: llmBaseUrl,
      ...(settings.budget === undefined ? {} : { monthlyTokenBudget: settings.budget }),
    });
    const queued = await call(generateRecommendations, { siteId });
    const outcome = await runRecommendationGeneration(
      ctx.db,
      { workspaceId: ws, runId: queued.runId, siteId },
      { kp, fetch: loopbackFetch },
    );
    const detail = await call(getRecommendationRun, { runId: queued.runId });
    return { queued, outcome, detail };
  };

  beforeAll(async () => {
    ctx = await createRecommendationTestContext('recommendation_generate');
    ws = ctx.disposable.workspace;
    siteId = await addSite(ctx.db, ws, 'example.com');
    auditId = await seedAudit(ctx.db, ws, siteId, { score: 74, pagesCrawled: 40 });
    issueId = await seedIssue(ctx.db, ws, siteId, auditId, { urls: ['https://example.com/pricing/'] });
  }, 120_000);

  afterAll(async () => {
    await ctx?.db.close();
    await ctx?.disposable.close();
  });

  it('creates draft recommendations authored by the strategist, with ledger entries and logged calls', async () => {
    const llm = await fakeLlm((request) => {
      if (request.user.includes('Propose at most'))
        return { text: JSON.stringify({ candidates: [candidate([issueId])] }), inputTokens: 300, outputTokens: 40 };
      return {
        text: JSON.stringify({
          recommendations: [
            recommendation(),
            recommendation({ title: 'Second recommendation', rationale: 'The 12 pages this issue affects have no title.' }),
          ],
        }),
        inputTokens: 700,
        outputTokens: 120,
      };
    });
    try {
      const { queued, detail } = await run(llm.baseUrl);
      expect(queued.state).toBe('queued');
      expect(detail).toMatchObject({ state: 'completed', created: 2, dropped: 0, candidates: 1, derived: 2 });
      expect(detail.inputTokens).toBe(1_000);
      expect(detail.outputTokens).toBe(160);

      // Two published specialist skills were seeded, one per workspace.
      const skills = await ctx.db.admin.query<{ name: string; published_version: number }>(
        `SELECT name, published_version FROM artifacts WHERE workspace_id = $1 AND type = 'skill' ORDER BY name`,
        [ws],
      );
      expect(skills.rows).toHaveLength(2);
      expect(skills.rows.every((row) => row.published_version === 1)).toBe(true);

      const one = await call(getRecommendation, { recommendationId: detail.createdIds[0] as string });
      expect((one.content as { author: unknown }).author).toEqual({ kind: 'specialist', specialist: 'strategist' });
      expect(one.status).toBe('proposed');
      expect(one.ownerAgentId).toMatch(/^agt_/);

      // The specialists are real agents: their drafts are in the action ledger, class draft.
      const ledger = await ctx.db.admin.query<{ agent_id: string; action_class: string; decision: string; target: string }>(
        `SELECT agent_id, action_class, decision, target FROM agent_actions WHERE workspace_id = $1 AND command = 'recommendations.generate' ORDER BY id`,
        [ws],
      );
      expect(ledger.rows).toHaveLength(2);
      expect(ledger.rows.every((row) => row.action_class === 'draft' && row.decision === 'allow')).toBe(true);
      expect(ledger.rows[0]?.agent_id).toBe(one.ownerAgentId);

      // Every model call is in the AI decision log, naming the playbook version it used.
      const calls = await ctx.db.admin.query<{ kind: string; status: string; model: string; prompt_id: string; input_tokens: number }>(
        `SELECT kind, status, model, prompt_id, input_tokens FROM ai_calls WHERE workspace_id = $1 ORDER BY created_at`,
        [ws],
      );
      expect(calls.rows.map((row) => row.kind)).toEqual(['generate', 'generate']);
      expect(calls.rows.map((row) => row.model)).toEqual(['fast-model', 'deep-model']);
      expect(calls.rows.every((row) => row.status === 'done')).toBe(true);
      expect(calls.rows[1]?.prompt_id).toMatch(/^skl_/);

      const listed = await call(listRecommendations, { siteId, author: 'strategist' });
      expect(listed.recommendations.length).toBeGreaterThanOrEqual(2);
    } finally {
      await llm.close();
    }
  }, 60_000);

  it('retries an invalid item once with its errors, then keeps it when the retry fixes it', async () => {
    let strategistCalls = 0;
    const llm = await fakeLlm((request) => {
      if (request.user.includes('Propose at most')) return { text: JSON.stringify({ candidates: [candidate([issueId])] }) };
      if (request.user.includes('<validation_errors>')) {
        // The retry sees the errors and answers with the corrected item.
        expect(request.user).toContain('not in the facts');
        return { text: JSON.stringify({ recommendations: [recommendation({ title: 'Retried item' })] }) };
      }
      strategistCalls += 1;
      return {
        text: JSON.stringify({
          recommendations: [recommendation({ title: 'Retried item', rationale: 'The 12 pages earn 9,999 clicks a month.' })],
        }),
      };
    });
    try {
      const { detail } = await run(llm.baseUrl);
      expect(strategistCalls).toBe(1);
      expect(detail).toMatchObject({ state: 'completed', created: 1, dropped: 0 });
      expect(detail.createdIds).toHaveLength(1);
    } finally {
      await llm.close();
    }
  }, 60_000);

  it('drops an item the retry leaves broken, with the reason on the run', async () => {
    const llm = await fakeLlm((request) => {
      if (request.user.includes('Propose at most')) return { text: JSON.stringify({ candidates: [candidate([issueId])] }) };
      return {
        text: JSON.stringify({ recommendations: [recommendation({ rationale: 'This will boost the 12 pages to guaranteed rank one.' })] }),
      };
    });
    try {
      const { detail } = await run(llm.baseUrl);
      expect(detail).toMatchObject({ state: 'completed', created: 0, dropped: 1 });
      const droppped = detail.droppedItems[0];
      expect(droppped?.reason).toContain('boost');
      expect(droppped?.reason).toContain('guaranteed');
    } finally {
      await llm.close();
    }
  }, 60_000);

  it('drops an item whose evidence id the facts do not carry', async () => {
    const llm = await fakeLlm((request) => {
      if (request.user.includes('Propose at most')) return { text: JSON.stringify({ candidates: [candidate([issueId])] }) };
      return {
        text: JSON.stringify({
          recommendations: [recommendation({ evidence: [{ kind: 'issue', id: `iss_${'e'.repeat(32)}`, note: 'Made up' }] })],
        }),
      };
    });
    try {
      const { detail } = await run(llm.baseUrl);
      expect(detail).toMatchObject({ state: 'completed', created: 0, dropped: 1 });
      expect(detail.droppedItems[0]?.reason).toContain('does not exist for this site');
    } finally {
      await llm.close();
    }
  }, 60_000);

  it('drops an item with an empty falsification check', async () => {
    const llm = await fakeLlm((request) => {
      if (request.user.includes('Propose at most')) return { text: JSON.stringify({ candidates: [candidate([issueId])] }) };
      return { text: JSON.stringify({ recommendations: [recommendation({ falsificationCheck: '   ' })] }) };
    });
    try {
      const { detail } = await run(llm.baseUrl);
      expect(detail).toMatchObject({ state: 'completed', created: 0, dropped: 1 });
      expect(detail.droppedItems[0]?.reason).toContain('falsificationCheck is empty');
    } finally {
      await llm.close();
    }
  }, 60_000);

  it('fails the run with the budget message when the provider’s month is used up, and creates nothing', async () => {
    const before = await ctx.db.admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM artifacts WHERE workspace_id = $1 AND type = 'recommendation'`,
      [ws],
    );
    const llm = await fakeLlm(() => ({ text: JSON.stringify({ candidates: [] }) }));
    try {
      const { queued, detail } = await run(llm.baseUrl, { budget: 10 });
      expect(detail).toMatchObject({ state: 'failed', created: 0, dropped: 0 });
      expect(detail.error).toContain('budget');
      const runs = await call(listRecommendationRuns, { siteId, state: 'failed' });
      expect(runs.runs.map((item) => item.id)).toContain(queued.runId);
      const after = await ctx.db.admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM artifacts WHERE workspace_id = $1 AND type = 'recommendation'`,
        [ws],
      );
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    } finally {
      await llm.close();
    }
  }, 60_000);

  it('refuses generate with the setup step when no provider is configured', async () => {
    const empty = await addSite(ctx.db, ws, 'no-provider.example');
    const audit = await seedAudit(ctx.db, ws, empty);
    await seedIssue(ctx.db, ws, empty, audit, { urls: ['https://no-provider.example/a/'] });
    // A workspace with no agents provider: the command refuses before it creates a run.
    await ctx.db.admin.query('DELETE FROM ai_providers WHERE workspace_id = $1', [ws]);
    const error = await call(generateRecommendations, { siteId: empty }).then(
      () => null,
      (err: Error) => err,
    );
    expect(error?.message).toContain('aiProviders.create');
    const runs = await ctx.db.admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM recommendation_runs WHERE workspace_id = $1 AND site_id = $2`,
      [ws, empty],
    );
    expect(runs.rows[0]?.n).toBe('0');
  });

  it('keeps the facts payload under its cap on a site with 2,000 issues', async () => {
    const big = await addSite(ctx.db, ws, 'big.example');
    const audit = await seedAudit(ctx.db, ws, big, { pagesCrawled: 2_000 });
    await ctx.db.admin.query(
      `INSERT INTO issues (workspace_id, id, site_id, check_id, subject_key, subject, state, severity, category,
                           first_seen_audit_id, last_seen_audit_id, last_checked_audit_id, affected_urls, affected_pages, evaluated_pages, evidence)
       SELECT $1, 'iss_' || md5('big-' || g), $2, 'title.missing', 'https://big.example/p/' || g,
              'https://big.example/p/' || g, 'open', 'high', 'on_page', $3, $3, $3,
              ARRAY['https://big.example/p/' || g], 1, 2000,
              '{"items":[],"total":1,"truncated":false}'::jsonb
         FROM generate_series(1, 2000) AS g`,
      [ws, big, audit],
    );
    const facts = await ctx.db.withWorkspace(ws, (tx) => gatherFacts(tx, { workspaceId: ws, siteId: big, maxRecommendations: 10 }));
    expect(facts.counts.openIssues).toBe(2_000);
    expect(facts.issues.length).toBeLessThanOrEqual(40);
    expect(JSON.stringify(facts).length).toBeLessThanOrEqual(MAX_FACTS_CHARS);
    expect(facts.truncated || facts.issues.length <= 40).toBe(true);
  }, 120_000);

  it('shows a run to this workspace only', async () => {
    const runs = await ctx.db.admin.query<{ id: string }>('SELECT id FROM recommendation_runs WHERE workspace_id = $1 LIMIT 1', [ws]);
    const runId = runs.rows[0]?.id as string;
    const elsewhere = randomUUID();
    await ctx.db.admin.query('INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, $2, $3)', [elsewhere, 'Elsewhere', 'none']);
    const error = await ctx.db
      .withWorkspace(elsewhere, (tx) =>
        getRecommendationRun.handler(
          { runId },
          {
            principal: userPrincipal('user_other', elsewhere, 'owner'),
            tx,
            services: { ...services, keyProvider: kp },
            surface: 'rest',
          },
        ),
      )
      .then(
        () => null,
        (err: Error) => err,
      );
    expect(error?.message).toContain('does not exist in this workspace');
  });
});

describe.skipIf(!hasTestDatabase())('recommendations.create from an agent', () => {
  let ctx: RecommendationTestContext;
  let ws = '';
  let siteId = '';
  let issueId = '';

  beforeAll(async () => {
    ctx = await createRecommendationTestContext('recommendation_agent');
    ws = ctx.disposable.workspace;
    siteId = await addSite(ctx.db, ws, 'agent.example');
    const audit = await seedAudit(ctx.db, ws, siteId);
    issueId = await seedIssue(ctx.db, ws, siteId, audit, { urls: ['https://agent.example/a/'] });
  }, 120_000);

  afterAll(async () => {
    await ctx?.db.close();
    await ctx?.disposable.close();
  });

  it('judges the call as a draft and records it in the action ledger', async () => {
    const ledger: Parameters<NonNullable<Services['onAgentAction']>>[1][] = [];
    const executor = createExecutor(ctx.db, {
      ...services,
      keyProvider: newKeyProvider(),
      agentCounters: async () => ({ changes: 0 }),
      onAgentAction: async (tx, entry) => {
        ledger.push(entry);
        // The server's wiring writes the same row; this is the ledger the agent screen reads.
        await tx.insert(schema.agentActions).values({
          workspaceId: ws,
          agentId: entry.agentId,
          command: entry.command,
          actionClass: entry.actionClass,
          decision: entry.decision,
          reasons: entry.reasons,
          impact: entry.impact as Record<string, unknown>,
          ok: entry.ok,
          error: entry.error,
          target: entry.target,
          surface: entry.surface,
          level: entry.level,
          intent: entry.intent,
          undo: entry.undo,
        });
      },
    });
    const agent = agentPrincipal(
      { id: `agt_${'b'.repeat(32)}`, name: 'MCP client', status: 'active', statusReason: null },
      'user_owner',
      'client_mcp',
      ws,
      'owner',
      ['artifacts:read', 'artifacts:write'],
    );
    const created = await executor.execute(
      createRecommendation,
      {
        siteId,
        title: 'Agent recommendation',
        rationale: 'The 12 pages this issue affects have no title.',
        evidence: [{ kind: 'issue', id: issueId, note: 'Titles are missing' }],
        hypothesis: 'A title wins clicks.',
        expectedImpact: { summary: 'Expected: more clicks', confidence: 'low' },
        effort: 'small',
        verificationPlan: { recheck: 'Re-fetch the pages', when: '28 days after the deploy' },
        falsificationCheck: 'We will know this failed if nothing changes.',
        leadingIndicator: 'Clicks, daily',
      },
      agent,
      { surface: 'mcp' },
    );
    expect(created.recommendationId).toMatch(/^rcm_/);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      command: 'recommendations.create',
      actionClass: 'draft',
      decision: 'allow',
      ok: true,
      surface: 'mcp',
    });
    expect(ledger[0]?.target).toBe(siteId);

    const row = await ctx.db.admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2`,
      [ws, created.recommendationId],
    );
    expect(row.rows[0]?.n).toBe('1');
    // The author is the agent principal, never a claim.
    const content = await ctx.db.admin.query<{ content: { author: { kind: string } } }>(
      `SELECT content FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2`,
      [ws, created.recommendationId],
    );
    expect(content.rows[0]?.content.author.kind).toBe('agent');

    const rows = await ctx.db.admin.query<{ command: string; action_class: string; decision: string; surface: string }>(
      `SELECT command, action_class, decision, surface FROM agent_actions WHERE workspace_id = $1 AND command = 'recommendations.create'`,
      [ws],
    );
    expect(rows.rows).toMatchObject([{ action_class: 'draft', decision: 'allow', surface: 'mcp' }]);
  }, 60_000);
});
