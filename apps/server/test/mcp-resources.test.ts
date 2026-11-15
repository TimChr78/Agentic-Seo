import { randomUUID } from 'node:crypto';
import { normalizePageUrl } from '@agentic-seo/search-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAgent, startTestServer, testPort, type User } from './harness';

// The Phase 1 MCP surface beyond tools: the catalogues and site resources an agent reads for
// context, the one prompt for the thin loop, and the refusal a people-only command deserves when an
// agent names it. The resources are backed by commands, so this also proves the command layer's
// tenancy: another workspace's site answers as if it does not exist.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let wsA = '';
let wsB = '';
let siteA = '';
let siteB = '';
let domain = '';
const aboutUrl = () => `https://${domain}/about/`;

const jsonOf = async (client: Awaited<ReturnType<typeof connectAgent>>['client'], uri: string) => {
  const result = await client.readResource({ uri });
  const first = result.contents[0] as { text?: string };
  return JSON.parse(first.text ?? '') as Record<string, unknown>;
};

const toolErrorOf = (out: { content?: unknown; isError?: boolean }) => {
  expect(out.isError).toBe(true);
  const content = out.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text) as { code: string; message: string };
};

beforeAll(async () => {
  t = await startTestServer('mcp_resources', testPort(2512));
  owner = await t.signUp(`owner-resources-${Date.now()}@example.com`);
  wsA = await t.workspaceWith([[owner, 'owner']]);
  wsB = await t.workspaceWith([[owner, 'owner']]);
  domain = `resources-${Date.now()}.example`;

  const api = t.api(owner, wsA);
  siteA = (await api.call('sites.create', { name: 'Context site', domain })).site.id;
  siteB = (await t.api(owner, wsB).call('sites.create', { name: 'Other site', domain: `other-${Date.now()}.example` })).site.id;
  await t.srv.db.admin.query(`UPDATE sites SET verified_at = now(), verification_method = 'dns' WHERE workspace_id = $1 AND id = $2`, [
    wsA,
    siteA,
  ]);

  // A published site context: the resource shows the published version, not a draft.
  const contextId = `sct_${'a'.repeat(32)}`;
  const content = {
    businessOverview: 'We sell widgets to small workshops.',
    currentGoal: 'Grow organic signups',
    positioning: '',
    writingPreferences: { voice: 'plain English', style: '', avoid: [] },
    keyPages: [{ url: `https://${domain}/`, role: 'home', why: 'The main entry point' }],
    competitors: [],
    researchLog: [],
  };
  await t.srv.db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version, site_id)
     VALUES ($1, $2, 'site_context', 'Site context', 2, 1, $3)`,
    [wsA, contextId, siteA],
  );
  await t.srv.db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1, $2, 1, 'published', $3::jsonb, 'context-hash', 'user', $4)`,
    [wsA, contextId, JSON.stringify(content), owner.id],
  );
  // A newer draft (review of #24): the resource must keep showing the published version.
  await t.srv.db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1, $2, 2, 'draft', $3::jsonb, 'context-draft-hash', 'user', $4)`,
    [wsA, contextId, JSON.stringify({ ...content, businessOverview: 'DRAFT ONLY, not published.' }), owner.id],
  );

  // A finished crawl and two open issues, seeded as a crawl would leave them: the resources only
  // read what the crawl wrote, and running a crawl is not what this file tests.
  const auditId = `adt_${'b'.repeat(32)}`;
  await t.srv.db.admin.query(
    `INSERT INTO audits (workspace_id, id, site_id, scope, state, requested_by_type, requested_by_id, finished_at, pages_crawled, pages_discovered)
     VALUES ($1, $2, $3, 'site', 'completed', 'user', $4, now(), 2, 2)`,
    [wsA, auditId, siteA, owner.id],
  );
  const origin = `https://${domain}`;
  const issues = [
    {
      id: `iss_${'1'.repeat(32)}`,
      checkId: 'robots_txt.blocks_all',
      subjectKey: origin,
      subject: origin,
      severity: 'critical',
      category: 'crawlability',
      affectedUrls: [origin],
      affectedPages: 2,
      evaluatedPages: 2,
      evidence: { items: [{ subject: origin, value: 'Disallow: /' }], total: 1, truncated: false },
    },
    {
      id: `iss_${'2'.repeat(32)}`,
      checkId: 'title.missing',
      subjectKey: aboutUrl(),
      subject: aboutUrl(),
      severity: 'high',
      category: 'on_page',
      affectedUrls: [aboutUrl()],
      affectedPages: 1,
      evaluatedPages: 2,
      evidence: { items: [{ subject: aboutUrl(), expected: 'A title' }], total: 1, truncated: false },
    },
    {
      // Medium severity but on the page with the traffic: ranks above the high issue on a page
      // with none (review of #24: rank by severity × traffic before limiting).
      id: `iss_${'3'.repeat(32)}`,
      checkId: 'description.missing',
      subjectKey: `${origin}/pricing/`,
      subject: `${origin}/pricing/`,
      severity: 'medium',
      category: 'on_page',
      affectedUrls: [`${origin}/pricing/`],
      affectedPages: 1,
      evaluatedPages: 2,
      evidence: { items: [{ subject: `${origin}/pricing/`, expected: 'A description' }], total: 1, truncated: false },
    },
  ];
  await t.srv.db.admin.query(
    `INSERT INTO connections (workspace_id, id, site_id, connector, label, settings, state)
     VALUES ($1, $2, $3, 'google-search-console', 'Search Console', $4::jsonb, 'active')`,
    [wsA, `con_${randomUUID().replaceAll('-', '')}`, siteA, JSON.stringify({ property: `sc-domain:${domain}` })],
  );
  await t.srv.db.admin.query(
    `INSERT INTO gsc_page_aggregates (workspace_id, site_id, property, date, page, page_key, clicks, impressions, ctr, position)
     VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, 50, 500, 0.1, 3)`,
    [wsA, siteA, `sc-domain:${domain}`, `${origin}/pricing/`, normalizePageUrl(`${origin}/pricing/`)],
  );
  for (const issue of issues)
    await t.srv.db.admin.query(
      `INSERT INTO issues (workspace_id, id, site_id, check_id, subject_key, subject, state, severity, category,
         first_seen_audit_id, last_seen_audit_id, last_checked_audit_id, evidence, affected_urls, affected_pages, evaluated_pages)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9, $9, $9, $10::jsonb, $11, $12, $13)`,
      [
        wsA,
        issue.id,
        siteA,
        issue.checkId,
        issue.subjectKey,
        issue.subject,
        issue.severity,
        issue.category,
        auditId,
        JSON.stringify(issue.evidence),
        issue.affectedUrls,
        issue.affectedPages,
        issue.evaluatedPages,
      ],
    );
});

afterAll(() => t?.close());

describe('MCP resources', () => {
  it('serves the catalogues and the site resources from commands', async () => {
    const agent = await connectAgent(t.base, owner, ['sites:read', 'artifacts:read'], undefined, wsA);
    try {
      const resources = (await agent.client.listResources()).resources.map((resource) => resource.uri);
      expect(resources).toEqual(
        expect.arrayContaining(['artifact-types://catalogue', 'learnings://current', 'checks://catalogue', 'change-types://catalogue']),
      );

      const templates = (await agent.client.listResourceTemplates()).resourceTemplates.map((template) => template.uriTemplate);
      expect(templates).toEqual(expect.arrayContaining(['site-context://{siteId}', 'issues://{siteId}']));

      const checks = await jsonOf(agent.client, 'checks://catalogue');
      const catalogue = checks.checks as { id: string; explain: string }[];
      expect(catalogue.length).toBeGreaterThanOrEqual(40);
      expect(catalogue.find((check) => check.id === 'title.missing')?.explain.length).toBeGreaterThan(40);

      const changeTypes = await jsonOf(agent.client, 'change-types://catalogue');
      const types = changeTypes.types as { type: string; actionClass: string; jsonSchema: unknown }[];
      expect(types.map((type) => type.type)).toEqual(['meta.title', 'meta.description', 'schema.jsonld', 'image.alt', 'redirect']);
      expect(types[0]).toMatchObject({ actionClass: 'site.content' });
      expect(types[0]?.jsonSchema).toEqual(expect.objectContaining({ type: 'object' }));

      const context = await jsonOf(agent.client, `site-context://${siteA}`);
      expect(context).toMatchObject({ siteId: siteA, version: 1, content: { businessOverview: 'We sell widgets to small workshops.' } });
      expect(JSON.stringify(context)).not.toContain('DRAFT ONLY');

      const issues = await jsonOf(agent.client, `issues://${siteA}`);
      const list = issues.issues as { checkId: string; severity: string; state: string }[];
      // Severity × traffic: the medium issue on the page with 50 clicks outranks the high one on a
      // page with none; the critical site-wide one stays first.
      expect(list.map((issue) => issue.checkId)).toEqual(['robots_txt.blocks_all', 'description.missing', 'title.missing']);
      expect(list.every((issue) => issue.state === 'open')).toBe(true);
      expect(issues.hasGsc).toBe(true);
    } finally {
      await agent.client.close();
    }
  });

  it('answers another workspace’s site as if it does not exist', async () => {
    const agent = await connectAgent(t.base, owner, ['sites:read', 'artifacts:read'], undefined, wsA);
    try {
      await expect(agent.client.readResource({ uri: `site-context://${siteB}` })).rejects.toThrow(/does not exist in this workspace/);
      // The issues resource is a command read: another workspace's site has no issues this principal
      // can see, so the answer is an empty list rather than a leak.
      const issues = await jsonOf(agent.client, `issues://${siteB}`);
      expect(issues.issues).toEqual([]);
    } finally {
      await agent.client.close();
    }
  });

  it('offers the thin loop as one prompt, without running anything', async () => {
    const agent = await connectAgent(t.base, owner, ['sites:read'], undefined, wsA);
    try {
      const prompts = (await agent.client.listPrompts()).prompts;
      expect(prompts.map((prompt) => prompt.name)).toContain('audit-and-propose');
      const prompt = await agent.client.getPrompt({ name: 'audit-and-propose', arguments: { siteId: siteA } });
      const text = prompt.messages.map((message) => (message.content.type === 'text' ? message.content.text : '')).join('\n');
      expect(text).toContain('audits.issues');
      expect(text).toContain('recommendations.create');
      expect(text).toContain('Never invent traffic');
      expect(text).toContain(siteA);
    } finally {
      await agent.client.close();
    }
  });
});

describe('people-only commands over MCP', () => {
  it('is not listed to an agent and is refused with a clear message when it is named', async () => {
    const agent = await connectAgent(t.base, owner, ['sites:read', 'artifacts:read', 'sites:write', 'artifacts:approve'], undefined, wsA);
    try {
      const tools = (await agent.client.listTools()).tools.map((tool) => tool.name);
      expect(tools).not.toContain('approvals.approve');
      expect(tools).not.toContain('connectors.github.connect');
      expect(tools).not.toContain('search.gsc.connect');

      for (const name of ['approvals.approve', 'connectors.github.connect', 'search.gsc.connect']) {
        const refusal = toolErrorOf(await agent.client.callTool({ name, arguments: { siteId: siteA, approvalId: 'apr_x' } }));
        expect(refusal.code).toBe('forbidden');
        expect(refusal.message).toContain('can only be run by a person');
      }
    } finally {
      await agent.client.close();
    }
  });
});
