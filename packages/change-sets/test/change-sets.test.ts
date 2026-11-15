import { randomUUID } from 'node:crypto';
import { approve as approvalsApprove, requestPublish } from '@agentic-seo/artifacts';
import {
  type AgentActionEntry,
  type AnyCommand,
  agentPrincipal,
  createExecutor,
  type Principal,
  userPrincipal,
} from '@agentic-seo/commands';
import { setCrawlFetchSeams } from '@agentic-seo/crawl';
import { createDb, type Db, schema, type Tx } from '@agentic-seo/db';
import { localKeyProvider } from '@agentic-seo/secrets';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_ROLE, createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import {
  CHANGES_APPLY_TASK,
  CHANGES_VERIFY_TASK,
  changesCreate,
  changesGet,
  changesList,
  changesRequestApply,
  changesRollback,
  changesStatus,
  changesUpdateDraft,
  githubConnect,
  githubDisconnect,
  githubStatus,
  runChangesApplyTask,
  runChangesPollTask,
  runChangesVerifyTask,
} from '../src';
import { type FakeGitHub, pageHtml, type SiteFixture, startFakeGitHub, startSiteFixture, uniqueDomain } from './support';

// Change sets end to end against the shared Postgres: a real executor, the real commands, a real
// connection row with a sealed token, a local fake GitHub through the client's request seam, and a
// local site for deploy detection and verification. No test reaches the internet.

const TOKEN = 'github_pat_11AAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKKLLLMMMNNN';
const DEFAULT_BRANCH = 'main';

const appUrl = (url: URL) => {
  const u = new URL(url.toString());
  u.username = APP_ROLE.appRole;
  u.password = APP_ROLE.appRolePassword;
  return u.toString();
};

/** The repository the fake GitHub starts with: two pages and a redirects file. */
function baseFiles(): Record<string, string> {
  return {
    'about/index.html': pageHtml('Old about', 'Old description'),
    'contact/index.html': pageHtml('Contact'),
    _redirects: '# redirects\n/legacy /about/ 301\n',
  };
}

const mapping = {
  rules: [
    { routes: '/about/', source: 'about/index.html', editor: 'html' },
    // A second route served from the same file: the conflict hold is about the source, not the URL.
    { routes: '/legacy/', source: 'about/index.html', editor: 'html' },
    { routes: '/contact/', source: 'contact/index.html', editor: 'html' },
  ],
  redirects: { file: '_redirects' },
};

const settings = (overrides: Record<string, unknown> = {}) => ({
  owner: 'acme',
  repo: 'site',
  baseBranch: DEFAULT_BRANCH,
  mapping,
  deploy: { detector: 'version_file', path: '/version.txt' },
  deployTimeoutHours: 48,
  ...overrides,
});

describe.skipIf(!hasTestDatabase())('change sets and the GitHub connector', () => {
  let disposable: Awaited<ReturnType<typeof createDisposableDb>>;
  let db: Db;
  let kp: ReturnType<typeof localKeyProvider>;
  let github: FakeGitHub;
  let site: SiteFixture;
  let workspace: string;
  let siteId: string;
  let domain: string;
  let personA: ReturnType<typeof userPrincipal>;
  let personB: ReturnType<typeof userPrincipal>;
  let executor: ReturnType<typeof createExecutor>;
  let jobs: { identifier: string; payload: Record<string, unknown> }[];
  let ledger: { command: string; decision: string; ok: boolean; actionClass: string }[];
  let mandate: { levels: Record<string, number> } | null;

  const deps = () => ({
    kp,
    github: github.seam,
    siteUrlFor: () => site.origin,
    enqueue: async (identifier: string, payload: Record<string, unknown>) => {
      jobs.push({ identifier, payload });
    },
  });

  const services = () => ({
    serverVersion: 'test',
    strictInputs: false,
    keyProvider: kp,
    publicUrl: 'https://seo.example.test',
    github: github.seam,
    enqueueTask: async (identifier: string, payload: Record<string, unknown>) => {
      jobs.push({ identifier, payload });
    },
    agentCounters: async () => ({ changes: 0 }),
    ...(mandate
      ? {
          activeMandate: async () => ({
            view: { id: 'mnd_test', version: 1, holdWindow: 'PT2H', purpose: 'test', levels: mandate!.levels },
            outsideHours: null,
          }),
        }
      : {}),
    onAgentAction: async (tx: Tx, entry: AgentActionEntry) => {
      ledger.push({ command: entry.command, decision: entry.decision, ok: entry.ok, actionClass: entry.actionClass });
      // The ledger the policy reads back, exactly as the server writes it.
      await tx.insert(schema.agentActions).values({
        workspaceId: entry.agentId ? workspace : workspace,
        agentId: entry.agentId,
        command: entry.command,
        actionClass: entry.actionClass,
        decision: entry.decision,
        ok: entry.ok,
        surface: entry.surface,
        target: entry.target,
      });
    },
  });

  const call = (command: AnyCommand, input: unknown, principal: Principal = personA) =>
    executor.execute(command, input, principal, { surface: 'internal' });

  const pageUrl = (path: string) => `${site.origin}${path}`;

  const titleChange = (path: string, before: string, after: string) => ({
    type: 'meta.title' as const,
    url: pageUrl(path),
    before,
    after,
  });

  const createBody = (changes: unknown[], overrides: Record<string, unknown> = {}) => ({
    siteId,
    title: 'Rewrite a page title',
    summary: 'The title is generic and does not match the search intent.',
    changes,
    verificationPlan: 'Re-fetch the page and check its title.',
    rollbackPlan: 'Revert the merge commit.',
    ...overrides,
  });

  /** Connects the site to the fake repository, through the real command. */
  async function connect(overrides: Record<string, unknown> = {}) {
    return call(githubConnect, { siteId, token: TOKEN, ...settings(overrides) });
  }

  /** Runs everything a job would have run, including the verification a deploy queues. */
  async function drain(options: { now?: () => Date } = {}) {
    const pending = jobs.splice(0);
    for (const job of pending) {
      if (job.identifier === CHANGES_APPLY_TASK) await runChangesApplyTask(db, job.payload, { ...deps(), ...options });
      else if (job.identifier === CHANGES_VERIFY_TASK)
        await runChangesVerifyTask(db, job.payload, { ...deps(), userAgent: 'AgenticSEO/test', ...options });
    }
  }

  async function poll(options: { now?: () => Date } = {}) {
    await runChangesPollTask(db, { ...deps(), ...options });
  }

  /** A change set drafted, submitted and approved, with its pull request open. */
  async function openPullRequest(path = '/about/', before = 'Old about', after = 'New about') {
    const created = await call(changesCreate, createBody([titleChange(path, before, after)]));
    expect(created.created).toBe(true);
    const applied = await call(changesRequestApply, { changeSetId: created.changeSetId, note: 'Please apply.' });
    expect(applied.status).toBe('in_review');
    // Under `all_publishes` a person cannot approve their own request: a second person does.
    await call(approvalsApprove, { approvalId: applied.approvalId }, personB);
    await drain();
    const status = await call(changesStatus, { changeSetId: created.changeSetId });
    expect(status.run.state).toBe('pr_open');
    return { changeSetId: created.changeSetId as string, prNumber: status.run.prNumber as number, branch: status.run.branch as string };
  }

  beforeAll(async () => {
    disposable = await createDisposableDb('changesets');
    db = createDb({ adminUrl: disposable.url.toString(), appUrl: appUrl(disposable.url), poolSize: 6 });
    kp = localKeyProvider(Buffer.alloc(32, 5).toString('base64'));
  });

  afterAll(async () => {
    await db?.close();
    await disposable?.close();
  });

  beforeEach(async () => {
    // The poller is cross-tenant by design, so a change set an earlier test left open would be
    // polled against this test's fake GitHub. Close them: each test owns exactly its own rows.
    await db.admin.query(
      `UPDATE change_set_runs SET state = 'closed'
        WHERE state IN ('draft', 'in_review', 'approved', 'applying', 'pr_open', 'merged', 'deploying', 'deployed')`,
    );
    workspace = randomUUID();
    await db.admin.query('INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, $2, $3)', [workspace, 'Changes', 'all_publishes']);
    siteId = randomUUID();
    domain = uniqueDomain();
    await db.admin.query(
      `INSERT INTO sites (workspace_id, id, name, primary_domain, verification_token, verified_at)
       VALUES ($1, $2, 'Example', $3, 'verify-token', now())`,
      [workspace, siteId, domain],
    );
    github = await startFakeGitHub(DEFAULT_BRANCH, baseFiles());
    site = await startSiteFixture();
    site.setPage('/about/', pageHtml('Old about', 'Old description'));
    site.setPage('/contact/', pageHtml('Contact'));
    setCrawlFetchSeams({ allow: site.allow, resolver: site.resolver });

    jobs = [];
    ledger = [];
    mandate = null;
    personA = userPrincipal(randomUUID(), workspace, 'owner');
    personB = userPrincipal(randomUUID(), workspace, 'owner');
    executor = createExecutor(db, services());
    // Every test starts from a connected site; the connector's own tests reconnect on purpose.
    await call(githubConnect, { siteId, token: TOKEN, ...settings() });
  });

  afterEach(async () => {
    setCrawlFetchSeams(null);
    await github?.close();
    await site?.close();
  });

  it('connects a repository, drafts, approves, opens one pull request, detects the deploy and verifies the page', async () => {
    const connected = await connect();
    expect(connected.repository).toBe('acme/site');
    expect(JSON.stringify(connected)).not.toContain(TOKEN);

    const created = await call(changesCreate, createBody([titleChange('/about/', 'Old about', 'New about')]));
    expect(created.created).toBe(true);
    expect(created.changes[0]).toMatchObject({
      type: 'meta.title',
      url: pageUrl('/about/'),
      source: { path: 'about/index.html', editor: 'html' },
    });

    // Submitting records the impact: a content change, reach unknown without Search Console data,
    // and it waits for a person.
    const submitted = await call(changesRequestApply, { changeSetId: created.changeSetId, note: 'Apply it.' });
    expect(submitted).toMatchObject({ status: 'in_review', actionClass: 'site.content' });
    expect(submitted.reach.kind).toBe('unknown');

    const approved = await call(approvalsApprove, { approvalId: submitted.approvalId }, personB);
    expect(approved.published).toEqual([{ artifactId: created.changeSetId, version: 1 }]);

    // The publish hook queued the apply job; running it opens the pull request.
    await drain();
    const open = await call(changesStatus, { changeSetId: created.changeSetId });
    expect(open.run.state).toBe('pr_open');
    expect(github.pullRequests).toHaveLength(1);
    const pr = github.pullRequests[0]!;
    expect(pr.title).toBe('Rewrite a page title');
    expect(pr.body).toContain('Opened by Agentic SEO');
    expect(pr.body).toContain('New about');
    expect(github.filesAt(pr.head)?.get('about/index.html')).toContain('<title>New about</title>');
    // Exactly the one file the change names, and no other.
    expect(github.filesAt(pr.head)?.get('contact/index.html')).toContain('<title>Contact</title>');

    // The build publishes the merge commit, then the site serves the new page.
    const mergeSha = github.merge(pr.number);
    site.setPage('/about/', pageHtml('New about', 'Old description'));
    site.setVersion(mergeSha);

    await poll();
    const deployed = await call(changesStatus, { changeSetId: created.changeSetId });
    expect(deployed.run.state).toBe('deployed');
    expect(deployed.run.deployedSha).toBe(mergeSha);
    expect(deployed.run.mergeCommitSha).toBe(mergeSha);

    await drain();
    const verified = await call(changesStatus, { changeSetId: created.changeSetId });
    expect(verified.run.state).toBe('verified');
    expect(verified.verification.attempt).toBe(1);
    expect(verified.verification.results).toEqual([
      expect.objectContaining({ url: pageUrl('/about/'), result: 'pass', deployedSha: mergeSha }),
    ]);
    // Every transition is in the event log, with the state it moved from.
    expect(verified.events.map((event: { toState: string }) => event.toState)).toEqual([
      'draft',
      'in_review',
      'approved',
      'applying',
      'pr_open',
      'merged',
      'deploying',
      'deployed',
      'verified',
    ]);
  });

  it('reports a merge whose deploy is never detected as deploy_not_detected after the window', async () => {
    const { changeSetId, prNumber } = await openPullRequest();
    const mergeSha = github.merge(prNumber);
    // The site still publishes the commit before the merge: the deployment does not contain it.
    site.setVersion('a'.repeat(40));
    void mergeSha;

    await poll();
    const waiting = await call(changesStatus, { changeSetId });
    expect(waiting.run.state).toBe('deploying');

    const later = new Date(Date.now() + 49 * 3_600_000);
    await poll({ now: () => later });
    const failed = await call(changesStatus, { changeSetId });
    expect(failed.run.state).toBe('deploy_not_detected');
    expect(failed.run.lastError).toMatch(/still does not show it after 48 hours/);
    expect(failed.events.at(-1)).toMatchObject({ fromState: 'deploying', toState: 'deploy_not_detected' });
  });

  it('detects the deploy but records verification_failed when the page does not show the change', async () => {
    const { changeSetId, prNumber } = await openPullRequest();
    const mergeSha = github.merge(prNumber);
    site.setVersion(mergeSha);
    // The build shipped, but the page still carries the old title.
    await poll();
    const deployed = await call(changesStatus, { changeSetId });
    expect(deployed.run.state).toBe('deployed');

    await drain();
    const failed = await call(changesStatus, { changeSetId });
    expect(failed.run.state).toBe('verification_failed');
    expect(failed.verification.results[0]).toMatchObject({ result: 'fail' });
    expect(failed.verification.results[0]?.detail).toContain('not "New about"');
  });

  it('sends a change set back to review when a commit is pushed to the pull request after approval', async () => {
    const { changeSetId, prNumber, branch } = await openPullRequest();
    const approvedHead = github.headOf(branch);

    github.pushToBranch(branch, { 'about/index.html': pageHtml('Pushed after approval') });

    await poll();
    const back = await call(changesStatus, { changeSetId });
    expect(back.run.state).toBe('in_review');
    expect(back.run.approvedVersion).toBeNull();
    expect(back.run.approvedHeadSha).toBeNull();
    expect(back.events.at(-1)?.reason).toMatch(/pushed to pull request #1 after approval/);
    expect(back.events.at(-1)?.evidence).toMatchObject({ approvedHeadSha: approvedHead, headSha: github.headOf(branch) });
    // The pull request Agentic SEO opened is closed, so it cannot be merged by mistake.
    expect(github.pullRequests.find((pr) => pr.number === prNumber)?.state).toBe('closed');

    // With no approval, the apply job has nothing to do: no second pull request, no merge.
    await drain();
    expect(github.pullRequests).toHaveLength(1);
    const unchanged = await call(changesStatus, { changeSetId });
    expect(unchanged.run.state).toBe('in_review');
  });

  it('refuses to publish a change set for a site whose ownership is not verified', async () => {
    const created = await call(changesCreate, createBody([titleChange('/about/', 'Old about', 'New about')]));
    await db.admin.query('UPDATE sites SET verified_at = NULL WHERE workspace_id = $1 AND id = $2', [workspace, siteId]);

    // The fixed rule: nothing is applied to a site nobody has proved they own.
    const refused = await call(changesRequestApply, { changeSetId: created.changeSetId, note: 'Apply.' }).then(
      () => null,
      (error: Error) => error,
    );
    expect(refused?.message ?? '').toMatch(/is not verified/);
    expect(github.pullRequests).toHaveLength(0);
  });

  it('treats more than 20 redirects in one change set as a person’s decision', async () => {
    await db.admin.query('UPDATE workspaces SET approval_policy = $2 WHERE id = $1', [workspace, 'none']);
    const redirects = Array.from({ length: 21 }, (_, index) => ({
      type: 'redirect' as const,
      from: `/old-${index}/`,
      to: '/about/',
      status: 301 as const,
      operation: 'add' as const,
    }));
    const created = await call(changesCreate, createBody(redirects, { title: 'Retire the old section' }));
    expect(created).toMatchObject({ created: true, refusals: [] });
    expect(created.changes).toHaveLength(21);

    const submitted = await call(changesRequestApply, { changeSetId: created.changeSetId, note: 'Twenty-one redirects.' });
    // A person's request would otherwise publish straight through under policy `none`.
    expect(submitted.status).toBe('in_review');
    expect(submitted.heldBecause.join(' ')).toMatch(/redirects 21 URLs; more than 20/);
    expect(submitted.actionClass).toBe('site.structural');
  });

  it('holds a second change set that touches the same source file, and not one that touches another', async () => {
    const first = await call(changesCreate, createBody([titleChange('/about/', 'Old about', 'New about')]));
    const firstApply = await call(changesRequestApply, { changeSetId: first.changeSetId, note: 'First.' });
    expect(firstApply.status).toBe('in_review');

    const sameFile = await call(
      changesCreate,
      createBody([{ type: 'meta.title', url: pageUrl('/legacy/'), before: 'Old about', after: 'Legacy about' }]),
    );
    const held = await call(changesRequestApply, { changeSetId: sameFile.changeSetId, note: 'Second on the same file.' });
    expect(held.status).toBe('in_review');
    expect(held.heldBecause.join(' ')).toContain(first.changeSetId as string);
    expect(held.heldBecause.join(' ')).toContain('about/index.html');

    // A different file is not a conflict: with the policy at none, it publishes straight away.
    await db.admin.query('UPDATE workspaces SET approval_policy = $2 WHERE id = $1', [workspace, 'none']);
    const otherFile = await call(
      changesCreate,
      createBody([{ type: 'meta.title', url: pageUrl('/contact/'), before: 'Contact', after: 'Contact us' }]),
    );
    const published = await call(changesRequestApply, { changeSetId: otherFile.changeSetId, note: 'Different file.' });
    expect(published.status).toBe('published');
    expect(published.heldBecause).toEqual([]);
  });

  it('adopts the pull request an earlier attempt created when the response timed out, so there is exactly one', async () => {
    const created = await call(changesCreate, createBody([titleChange('/about/', 'Old about', 'New about')]));
    const applied = await call(changesRequestApply, { changeSetId: created.changeSetId, note: 'Apply.' });
    await call(approvalsApprove, { approvalId: applied.approvalId }, personB);

    github.timeoutNextPullRequest = true;
    const pending = jobs.splice(0);
    expect(pending.map((job) => job.identifier)).toEqual([CHANGES_APPLY_TASK]);
    // The first attempt opens the pull request and loses the answer.
    await expect(runChangesApplyTask(db, pending[0]!.payload, deps())).rejects.toThrow(/did not answer|could not be reached|GitHub/i);
    expect(github.pullRequests).toHaveLength(1);
    const stillApplying = await call(changesStatus, { changeSetId: created.changeSetId });
    expect(stillApplying.run.state).toBe('applying');

    // The retry finds the branch and the pull request and adopts them.
    await runChangesApplyTask(db, pending[0]!.payload, deps());
    expect(github.pullRequests).toHaveLength(1);
    const adopted = await call(changesStatus, { changeSetId: created.changeSetId });
    expect(adopted.run.state).toBe('pr_open');
    expect(adopted.run.prNumber).toBe(1);
    expect(adopted.events.at(-1)?.reason).toMatch(/Adopted the pull request/);
  });

  it('marks the change set stale when a source changed since it was drafted', async () => {
    const created = await call(changesCreate, createBody([titleChange('/about/', 'Old about', 'New about')]));
    const applied = await call(changesRequestApply, { changeSetId: created.changeSetId, note: 'Apply.' });
    await call(approvalsApprove, { approvalId: applied.approvalId }, personB);

    // Someone edits the same file on the base branch after the draft.
    github.pushToBranch(DEFAULT_BRANCH, { 'about/index.html': pageHtml('Wrong about') });

    await drain();
    const stale = await call(changesStatus, { changeSetId: created.changeSetId });
    expect(stale.run.state).toBe('stale');
    expect(stale.run.lastError).toContain('about/index.html');
    expect(stale.run.lastError).toMatch(/Redraft it/);
    expect(github.pullRequests).toHaveLength(0);

    // Redrafting picks up the new file and returns to a draft that can be submitted again.
    const redrafted = await call(changesUpdateDraft, {
      changeSetId: created.changeSetId,
      changes: [{ type: 'meta.title', url: pageUrl('/about/'), before: 'Wrong about', after: 'New about' }],
    });
    expect(redrafted).toMatchObject({ created: true, version: 2 });
    const back = await call(changesStatus, { changeSetId: created.changeSetId });
    expect(back.run.state).toBe('draft');
  });

  it('requires a person for a change set with unknown reach even when the agent’s mandate allows the class', async () => {
    const agentId = 'agt_changes_l3';
    await db.admin.query(`INSERT INTO agents (workspace_id, id, name, sponsor_user_id) VALUES ($1, $2, 'Fixer', 'sponsor')`, [
      workspace,
      agentId,
    ]);
    const agent = agentPrincipal(
      { id: agentId, name: 'Fixer', status: 'active', statusReason: null },
      personA.userId,
      'client_changes',
      workspace,
      'editor',
      ['artifacts:write', 'sites:read', 'changes:apply'],
    );
    mandate = { levels: { 'site.content': 3 } };
    executor = createExecutor(db, services());
    await connect();

    const created = await call(changesCreate, createBody([titleChange('/about/', 'Old about', 'New about')]), agent);
    expect(created.created).toBe(true);
    const submitted = await call(changesRequestApply, { changeSetId: created.changeSetId, note: 'Agent wants this.' }, agent);
    // Level 3 would publish; unknown reach caps it at a person's decision.
    expect(submitted.status).toBe('in_review');
    expect(submitted.heldBecause.join(' ')).toMatch(/traffic at risk is unknown/i);
    expect(ledger.map((entry) => [entry.command, entry.decision])).toEqual([
      ['changes.create', 'allow'],
      ['changes.requestApply', 'ask'],
    ]);
  });

  it('records agent change sets in the policy ledger', async () => {
    const agentId = 'agt_ledger';
    await db.admin.query(`INSERT INTO agents (workspace_id, id, name, sponsor_user_id) VALUES ($1, $2, 'Drafter', 'sponsor')`, [
      workspace,
      agentId,
    ]);
    const agent = agentPrincipal(
      { id: agentId, name: 'Drafter', status: 'active', statusReason: null },
      personA.userId,
      'client_ledger',
      workspace,
      'editor',
      ['artifacts:write'],
    );
    executor = createExecutor(db, services());
    await connect();

    const created = await call(changesCreate, createBody([titleChange('/about/', 'Old about', 'New about')]), agent);
    expect(created.created).toBe(true);
    const { rows } = await db.admin.query<{ command: string; action_class: string; decision: string; ok: boolean }>(
      'SELECT command, action_class, decision, ok FROM agent_actions WHERE workspace_id = $1 AND agent_id = $2 ORDER BY command',
      [workspace, agentId],
    );
    expect(rows).toEqual([{ command: 'changes.create', action_class: 'draft', decision: 'allow', ok: true }]);
  });

  it('lets only people connect, change and disconnect the connector', async () => {
    const agentId = 'agt_connector';
    await db.admin.query(`INSERT INTO agents (workspace_id, id, name, sponsor_user_id) VALUES ($1, $2, 'Connector', 'sponsor')`, [
      workspace,
      agentId,
    ]);
    const agent = agentPrincipal(
      { id: agentId, name: 'Connector', status: 'active', statusReason: null },
      personA.userId,
      'client_connector',
      workspace,
      'owner',
      ['sites:write', 'sites:read'],
    );
    executor = createExecutor(db, services());

    await expect(call(githubConnect, { siteId, token: TOKEN, ...settings() }, agent)).rejects.toThrow(/can only be run by a person/);
    // Reading the status is not a settings change: an agent may look, and still sees no token.
    const asAgent = await call(githubStatus, { siteId }, agent);
    expect(asAgent.hasToken).toBe(true);
    expect(JSON.stringify(asAgent)).not.toContain(TOKEN);

    await connect();
    await expect(call(githubConnect, { siteId, token: TOKEN, ...settings({ baseBranch: 'other' }) }, agent)).rejects.toThrow(
      /can only be run by a person/,
    );
    await expect(call(githubDisconnect, { siteId }, agent)).rejects.toThrow(/can only be run by a person/);

    // The checklist's site connector fact follows the connection.
    const before = await call(githubStatus, { siteId }, personA);
    expect(before).toMatchObject({ hasToken: true, repository: 'acme/site', deploy: { detector: 'version_file', detail: '/version.txt' } });
    await call(githubDisconnect, { siteId });
    const after = await call(githubStatus, { siteId });
    expect(after.connection).toBeNull();
  });

  it('never puts the token in an output, an event, an error or the stored rows', async () => {
    const connected = await connect();
    expect(JSON.stringify(connected)).not.toContain(TOKEN);
    const status = await call(githubStatus, { siteId });
    expect(JSON.stringify(status)).not.toContain(TOKEN);

    // A failure while reading the repository must not carry the token either: the client redacts
    // GitHub's own text, and this command never echoes what it was given.
    const broken = await call(githubConnect, { siteId, token: TOKEN, ...settings({ repo: 'gone' }) }).then(
      () => null,
      (error: Error) => error,
    );
    expect(broken).toBeInstanceOf(Error);
    expect(broken?.message ?? '').not.toContain(TOKEN);
    expect(broken?.message ?? '').toContain('gone');

    const created = await call(changesCreate, createBody([titleChange('/about/', 'Old about', 'New about')]));
    const events = await call(changesStatus, { changeSetId: created.changeSetId });
    expect(JSON.stringify(events)).not.toContain(TOKEN);

    // The connection row keeps the token sealed, not as plaintext bytes.
    const { rows } = await db.admin.query<{ settings: unknown; secrets: Buffer | null }>(
      'SELECT settings, secrets FROM connections WHERE workspace_id = $1 AND site_id = $2',
      [workspace, siteId],
    );
    expect(JSON.stringify(rows[0]?.settings)).not.toContain(TOKEN);
    expect(rows[0]?.secrets?.includes(Buffer.from(TOKEN, 'utf8'))).toBe(false);
    expect(github.paths.length).toBeGreaterThan(0);
  });

  it('judges a change set published through the artifact commands as a site change, not a draft', async () => {
    const agentId = 'agt_publisher';
    await db.admin.query(`INSERT INTO agents (workspace_id, id, name, sponsor_user_id) VALUES ($1, $2, 'Publisher', 'sponsor')`, [
      workspace,
      agentId,
    ]);
    const agent = agentPrincipal(
      { id: agentId, name: 'Publisher', status: 'active', statusReason: null },
      personA.userId,
      'client_publisher',
      workspace,
      'editor',
      ['artifacts:write', 'artifacts:publish'],
    );
    executor = createExecutor(db, services());
    const created = await call(changesCreate, createBody([titleChange('/about/', 'Old about', 'New about')]), agent);
    expect(created.created).toBe(true);

    // Going through artifacts.requestPublish must judge the change set by what its changes do: the
    // old class table called every change-set publish a draft.
    const submitted = await call(requestPublish, { artifactId: created.changeSetId, note: 'Ship it.' }, agent);
    expect(submitted.status).toBe('in_review');
    expect(ledger.at(-1)).toEqual({
      command: 'artifacts.requestPublish',
      decision: 'ask',
      ok: true,
      actionClass: 'site.content',
    });
    // The run row stays a draft until the approval publishes the version: the artifact carries the
    // pending review, and the publish hook moves the run to `approved` when the person decides.
    const pending = await call(changesStatus, { changeSetId: created.changeSetId });
    expect(pending.run.state).toBe('draft');
    expect(github.pullRequests).toHaveLength(0);
  });

  it('keeps one workspace’s change sets out of another’s reads', async () => {
    await connect();
    const created = await call(changesCreate, createBody([titleChange('/about/', 'Old about', 'New about')]));

    const intruder = userPrincipal(randomUUID(), workspace, 'owner');
    const otherWorkspace = randomUUID();
    await db.admin.query('INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, $2, $3)', [otherWorkspace, 'Other', 'none']);
    const outsider = userPrincipal(randomUUID(), otherWorkspace, 'owner');
    expect(intruder.workspaceId).toBe(workspace);

    await expect(call(changesStatus, { changeSetId: created.changeSetId }, outsider)).rejects.toThrow(/not a change set/);
    await expect(call(changesList, { siteId }, outsider)).rejects.toThrow(/does not exist/);
    const rows = await db.withWorkspace(otherWorkspace, (tx) =>
      tx.execute<{ artifact_id: string }>(sql`SELECT artifact_id FROM change_set_runs`),
    );
    expect(rows.rows).toEqual([]);
    const own = await call(changesList, { siteId }, personA);
    expect(own.changes.map((run: { artifactId: string }) => run.artifactId)).toEqual([created.changeSetId]);
  });

  it('rolls back with an exact revert pull request while the files still match the merge', async () => {
    const { changeSetId, prNumber } = await openPullRequest();
    const mergeSha = github.merge(prNumber);
    site.setPage('/about/', pageHtml('New about', 'Old description'));
    site.setVersion(mergeSha);
    await poll();
    await drain();
    expect((await call(changesStatus, { changeSetId })).run.state).toBe('verified');

    const rollback = await call(changesRollback, { changeSetId, note: 'The title tested badly.' });
    expect(rollback.mode).toBe('revert_pr');
    expect(rollback.prNumber).not.toBeNull();
    expect(github.pullRequests).toHaveLength(2);
    const revert = github.pullRequests[1]!;
    expect(revert.title).toMatch(/^Revert: /);
    // The revert restores the file exactly as it was before the merge.
    expect(github.filesAt(revert.head)?.get('about/index.html')).toContain('<title>Old about</title>');
    expect((await call(changesStatus, { changeSetId })).run.state).toBe('rolled_back');

    // Approving the rollback adopts the revert pull request rather than opening a second one.
    const rollbackStatus = await call(changesStatus, { changeSetId: rollback.changeSetId });
    expect(rollbackStatus.run.state).toBe('in_review');
    await call(approvalsApprove, { approvalId: rollback.approvalId }, personB);
    await drain();
    expect(github.pullRequests).toHaveLength(2);
    const adopted = await call(changesStatus, { changeSetId: rollback.changeSetId });
    expect(adopted.run).toMatchObject({ state: 'pr_open', prNumber: revert.number, rollbackOf: changeSetId });
  });

  it('proposes a draft rollback instead of a revert when a file changed after the merge', async () => {
    const { changeSetId, prNumber } = await openPullRequest();
    const mergeSha = github.merge(prNumber);
    site.setPage('/about/', pageHtml('New about', 'Old description'));
    site.setVersion(mergeSha);
    await poll();
    await drain();

    // Someone keeps editing the page after the merge: a revert would overwrite that work.
    github.pushToBranch(DEFAULT_BRANCH, { 'about/index.html': pageHtml('Even newer about') });

    const rollback = await call(changesRollback, { changeSetId, note: 'Roll it back.' });
    expect(rollback.mode).toBe('proposed');
    expect(rollback.prNumber).toBeNull();
    expect(rollback.reason).toContain('about/index.html');
    expect(github.pullRequests).toHaveLength(1);

    const proposed = await call(changesStatus, { changeSetId: rollback.changeSetId });
    expect(proposed.run).toMatchObject({ state: 'draft', rollbackOf: changeSetId });
    const content = await call(changesGet, { changeSetId: rollback.changeSetId });
    expect(JSON.stringify(content.changes)).toContain('Even newer about');
  });
});
