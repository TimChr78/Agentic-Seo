import { runChangesApplyTask } from '@agentic-seo/change-sets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeGitHub, pageHtml, startFakeGitHub } from '../../../packages/change-sets/test/support';
import { connectAgent, startTestServer, testPort, type User } from './harness';

// The Phase 1 promise, over MCP: an agent reads a site's issues, drafts a recommendation that cites
// them, turns it into a change set, and submits it. The change waits for a person; the person
// approves; the apply job opens exactly one pull request; the agent reads the result with
// changes.status. Every agent write lands in the action ledger.
//
// The crawl and the GitHub repository are fixtures: the audit's issues are seeded as the crawl
// leaves them, and the repository is the change-set package's in-memory fake through its documented
// request seam. Nothing here reaches the internet.

const TOKEN = 'github_pat_11AAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKKLLLMMMNNN';

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let approver: User;
let ws = '';
let siteId = '';
let domain = '';
let github: FakeGitHub;
let issueId = '';
const aboutUrl = () => `https://${domain}/about/`;

const textOf = (out: { content: unknown }) => {
  const content = out.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
};

beforeAll(async () => {
  t = await startTestServer('mcp_thin_loop', testPort(2513));
  owner = await t.signUp(`owner-loop-${Date.now()}@example.com`);
  approver = await t.signUp(`approver-loop-${Date.now()}@example.com`);
  // `agent_changes`: an agent's publish goes to review, and only a person can approve it.
  ws = await t.workspaceWith(
    [
      [owner, 'owner'],
      [approver, 'owner'],
    ],
    'agent_changes',
  );
  domain = `loop-${Date.now()}.example`;

  const api = t.api(owner, ws);
  siteId = (await api.call('sites.create', { name: 'Pilot site', domain })).site.id;
  // Verification itself is a DNS/meta fetch; the invariant here is the crawl that produced the
  // issues, so the site starts verified.
  await t.srv.db.admin.query(`UPDATE sites SET verified_at = now(), verification_method = 'dns' WHERE workspace_id = $1 AND id = $2`, [
    ws,
    siteId,
  ]);

  github = await startFakeGitHub('main', { 'about/index.html': pageHtml('Old about', 'Old description') });
  // The app's documented test seam: commands and the change-set worker read GitHub through it.
  t.srv.services.github = github.seam;
  await api.call('connectors.github.connect', {
    siteId,
    token: TOKEN,
    owner: 'acme',
    repo: 'site',
    baseBranch: 'main',
    mapping: { rules: [{ routes: '/about/', source: 'about/index.html', editor: 'html' }] },
    deploy: { detector: 'version_file', path: '/version.txt' },
    deployTimeoutHours: 48,
  });

  // A finished crawl and one open issue, as the crawl and the finalize step leave them.
  const auditId = `adt_${'c'.repeat(32)}`;
  await t.srv.db.admin.query(
    `INSERT INTO audits (workspace_id, id, site_id, scope, state, requested_by_type, requested_by_id, finished_at, pages_crawled, pages_discovered)
     VALUES ($1, $2, $3, 'site', 'completed', 'user', $4, now(), 1, 1)`,
    [ws, auditId, siteId, owner.id],
  );
  issueId = `iss_${'3'.repeat(32)}`;
  await t.srv.db.admin.query(
    `INSERT INTO issues (workspace_id, id, site_id, check_id, subject_key, subject, state, severity, category,
       first_seen_audit_id, last_seen_audit_id, last_checked_audit_id, evidence, affected_urls, affected_pages, evaluated_pages)
     VALUES ($1, $2, $3, 'title.too_long', $4, $4, 'open', 'high', 'on_page', $5, $5, $5, $6::jsonb, $7, 1, 1)`,
    [
      ws,
      issueId,
      siteId,
      aboutUrl(),
      auditId,
      JSON.stringify({ items: [{ subject: aboutUrl(), value: 'Old about', expected: 'A shorter title' }], total: 1, truncated: false }),
      [aboutUrl()],
    ],
  );
});

afterAll(async () => {
  await github?.close();
  await t?.close();
});

describe('the thin loop over MCP', () => {
  it('goes from an issue to an approved pull request, with a person in the approval', async () => {
    const agent = await connectAgent(t.base, owner, ['sites:read', 'artifacts:read', 'artifacts:write', 'changes:apply'], undefined, ws);
    try {
      // 1. What is wrong, from the crawl.
      const issues = textOf(await agent.client.callTool({ name: 'audits.issues', arguments: { siteId, state: 'open' } }));
      const open = issues.issues as { id: string; checkId: string; clicks28d: number | null }[];
      expect(open.map((issue) => issue.id)).toContain(issueId);
      expect(open[0]?.clicks28d).toBeNull();

      // 2. A recommendation that cites the issue; the traffic at stake is computed, never supplied.
      const recommendation = textOf(
        await agent.client.callTool({
          name: 'recommendations.create',
          arguments: {
            siteId,
            title: 'Shorten the about page title',
            rationale: 'The about page carries a long title that search results cut off, so the snippet loses its meaning.',
            evidence: [{ kind: 'issue', id: issueId, note: 'title.too_long on the about page' }],
            hypothesis:
              'If the title fits the snippet, then the result reads as a complete sentence, because Google truncates long titles.',
            expectedImpact: { summary: 'Expected: a complete snippet on the about page', confidence: 'medium' },
            effort: 'small',
            verificationPlan: { recheck: 'Fetch the about page and read its first title', when: 'After the pull request is deployed' },
            falsificationCheck: 'We will know this failed if the deployed page still shows the old title.',
            leadingIndicator: 'The next crawl reports title.too_long resolved.',
            proposedChanges: [{ type: 'meta.title', url: aboutUrl(), summary: 'Shorten the title' }],
          },
        }),
      );
      const recommendationId = recommendation.recommendationId as string;
      expect(recommendation.status).toBe('proposed');
      expect(recommendationId).toMatch(/^rcm_[0-9a-f]{32}$/);

      // 3. A change set from the recommendation, resolved through the GitHub mapping.
      const created = textOf(
        await agent.client.callTool({
          name: 'changes.create',
          arguments: {
            siteId,
            title: 'Shorten the about page title',
            summary: 'The title is too long; the recommendation and issue are the evidence.',
            changes: [{ type: 'meta.title', url: aboutUrl(), before: 'Old about', after: 'About Acme' }],
            verificationPlan: 'Fetch the about page: its first title must be the new one.',
            rollbackPlan: 'Revert the merge commit.',
            recommendationId,
          },
        }),
      );
      expect(created.created).toBe(true);
      const changeSetId = created.changeSetId as string;

      // 4. Submit it: the agent's request goes to review, never straight to GitHub.
      const submitted = textOf(
        await agent.client.callTool({ name: 'changes.requestApply', arguments: { changeSetId, note: 'Please apply.' } }),
      );
      expect(submitted.status).toBe('in_review');
      expect(submitted.heldBecause).toEqual(expect.arrayContaining([expect.stringContaining('traffic at risk is unknown')]));
      const approvalId = submitted.approvalId as string;

      // 5. An agent cannot approve its own change: the command is people-only over MCP.
      const refusal = await agent.client.callTool({ name: 'approvals.approve', arguments: { approvalId } });
      expect(refusal.isError).toBe(true);
      expect(JSON.stringify(refusal.content)).toContain('can only be run by a person');

      const requested = await t.srv.db.admin.query<{ requested_by_type: string; status: string }>(
        'SELECT requested_by_type, status FROM approval_requests WHERE workspace_id = $1 AND id = $2',
        [ws, approvalId],
      );
      expect(requested.rows[0]).toEqual({ requested_by_type: 'agent', status: 'pending' });

      // 6. A person approves through the executor, as the app does.
      const approved = await t.api(approver, ws).call('approvals.approve', { approvalId });
      expect(approved.status).toBe('approved');

      // 7. The apply job opens exactly one pull request.
      await runChangesApplyTask(
        t.srv.db,
        { workspaceId: ws, siteId, artifactId: changeSetId },
        { kp: t.srv.keyProvider, github: github.seam },
      );
      expect(github.pullRequests).toHaveLength(1);
      const pr = github.pullRequests[0]!;
      expect(pr.base).toBe('main');
      expect(github.filesAt(pr.head)?.get('about/index.html')).toContain('<title>About Acme</title>');

      // 8. The agent sees where it is, over MCP.
      const status = textOf(await agent.client.callTool({ name: 'changes.status', arguments: { changeSetId } }));
      const run = status.run as { state: string; prNumber: number; prUrl: string };
      expect(run.state).toBe('pr_open');
      expect(run.prNumber).toBe(1);
      expect(run.prUrl).toBe(pr.htmlUrl);

      // 9. Every agent write is in the action ledger, with the surface it came in on.
      const ledger = await t.srv.db.admin.query<{ command: string; decision: string; ok: boolean; surface: string; agent_id: string }>(
        'SELECT command, decision, ok, surface, agent_id FROM agent_actions WHERE workspace_id = $1 ORDER BY at',
        [ws],
      );
      const writes = ledger.rows.filter((row) =>
        ['recommendations.create', 'changes.create', 'changes.requestApply'].includes(row.command),
      );
      expect(writes.map((row) => row.command)).toEqual(['recommendations.create', 'changes.create', 'changes.requestApply']);
      for (const row of writes) {
        expect(row).toMatchObject({ surface: 'mcp', ok: true });
        expect(row.agent_id).toEqual(expect.any(String));
      }
      expect(writes.find((row) => row.command === 'changes.requestApply')?.decision).toBe('ask');
    } finally {
      await agent.client.close();
    }
  });
});
