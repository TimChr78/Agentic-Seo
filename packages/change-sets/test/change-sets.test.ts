import { randomUUID } from 'node:crypto';
import {
  approve as approvalsApprove,
  reject as approvalsReject,
  updateDraft as artifactsUpdateDraft,
  createArtifact,
  importConfig,
  requestPublish,
} from '@agentic-seo/artifacts';
import { sourceHashOf } from '@agentic-seo/changes';
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
import { normalizePageUrl } from '@agentic-seo/search-data';
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
  runChangesPoll,
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
    // Production checks a change URL against https on the site's domain; the fixture has a port, so
    // the seam answers with its origin. What the invariant allows is otherwise unchanged.
    siteUrlFor: () => site.origin,
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

  it('redrafts from the stored wrappers when no changes are supplied', async () => {
    const created = await call(changesCreate, createBody([titleChange('/about/', 'Old about', 'New about')]));

    // A summary-only update must read each stored wrapper's `.change`, not hand `{ change, … }` to
    // the editors.
    const summaryOnly = await call(changesUpdateDraft, {
      changeSetId: created.changeSetId,
      summary: 'A clearer summary of the same edit.',
    });
    expect(summaryOnly.created).toBe(true);
    expect(summaryOnly.changes.map((change: { type: string }) => change.type)).toEqual(['meta.title']);

    // The default redraft (no fields at all) uses the latest draft's changes.
    const defaultRedraft = await call(changesUpdateDraft, { changeSetId: created.changeSetId });
    expect(defaultRedraft).toMatchObject({ created: true, version: 1 });
    expect(defaultRedraft.changes).toHaveLength(1);
    const stored = await call(changesGet, { changeSetId: created.changeSetId });
    expect((stored.content as { summary: string }).summary).toBe('A clearer summary of the same edit.');
  });

  it('refuses change-set content through the generic artifact commands and re-derives it at approval', async () => {
    const forged = {
      connector: 'github',
      title: 'Forged',
      summary: 'Written around the drafting commands.',
      changes: [
        {
          change: { type: 'meta.title', url: 'https://example.com/about/', before: 'Old about', after: 'Forged about' },
          source: { path: 'contact/index.html', editor: 'html', confidence: 'exact', affectedRoutes: ['/about/'] },
          baseSha: 'a'.repeat(40),
          sourceHash: 'b'.repeat(64),
          diff: { path: 'contact/index.html', status: 'modified', unified: '--- a\n+++ b\n', additions: 1, deletions: 1 },
        },
      ],
      verificationPlan: 'None.',
      rollbackPlan: 'None.',
    };
    await expect(call(createArtifact, { type: 'change_set', name: 'Forged', siteId, content: forged })).rejects.toThrow(/changes\.create/);

    const created = await call(changesCreate, createBody([titleChange('/about/', 'Old about', 'New about')]));
    await expect(call(artifactsUpdateDraft, { artifactId: created.changeSetId, content: forged })).rejects.toThrow(/changes\.updateDraft/);

    // Even a direct database write is caught: approval re-derives the path from the mapping.
    const stored = (await call(changesGet, { changeSetId: created.changeSetId })).content;
    const tampered = JSON.parse(JSON.stringify(stored)) as { changes: { source: { path: string } }[] };
    tampered.changes[0]!.source.path = 'contact/index.html';
    await db.admin.query('UPDATE artifact_versions SET content = $3::jsonb WHERE workspace_id = $1 AND artifact_id = $2 AND number = 1', [
      workspace,
      created.changeSetId,
      JSON.stringify(tampered),
    ]);
    await expect(call(changesRequestApply, { changeSetId: created.changeSetId, note: 'Forged.' })).rejects.toThrow(
      /do not match the repository/,
    );
    expect(github.pullRequests).toHaveLength(0);
  });

  it('re-derives the stored diff again in the apply worker', async () => {
    const created = await call(changesCreate, createBody([titleChange('/about/', 'Old about', 'New about')]));
    const submitted = await call(changesRequestApply, { changeSetId: created.changeSetId, note: 'Apply.' });
    await call(approvalsApprove, { approvalId: submitted.approvalId }, personB);

    const stored = (await call(changesGet, { changeSetId: created.changeSetId })).content;
    const tampered = JSON.parse(JSON.stringify(stored)) as { changes: { diff: { unified: string } }[] };
    tampered.changes[0]!.diff.unified = '--- a/about/index.html\n+++ b/about/index.html\n@@ forged @@\n';
    await db.admin.query('UPDATE artifact_versions SET content = $3::jsonb WHERE workspace_id = $1 AND artifact_id = $2 AND number = 1', [
      workspace,
      created.changeSetId,
      JSON.stringify(tampered),
    ]);

    await drain();
    const status = await call(changesStatus, { changeSetId: created.changeSetId });
    expect(status.run.state).toBe('in_review');
    expect(status.run.approvedVersion).toBeNull();
    expect(status.run.lastError).toMatch(/do not match the repository/);
    expect(github.pullRequests).toHaveLength(0);
  });

  it('adopts a pull request only when its commit is exactly the reviewed change', async () => {
    const created = await call(changesCreate, createBody([titleChange('/about/', 'Old about', 'New about')]));
    const submitted = await call(changesRequestApply, { changeSetId: created.changeSetId, note: 'Apply.' });
    await call(approvalsApprove, { approvalId: submitted.approvalId }, personB);

    github.timeoutNextPullRequest = true;
    const pending = jobs.splice(0);
    expect(pending.map((job) => job.identifier)).toEqual([CHANGES_APPLY_TASK]);
    await expect(runChangesApplyTask(db, pending[0]!.payload, deps())).rejects.toThrow(/did not answer|could not be reached|GitHub/i);
    expect(github.pullRequests).toHaveLength(1);

    // A push before the retry: different parent, a different edit and an extra file. The retry must
    // not adopt this as the reviewed change.
    const branch = `aseo/${created.changeSetId}-v1`;
    github.pushToBranch(branch, { 'about/index.html': pageHtml('Sneaky about'), 'sneaky.txt': 'not reviewed' });
    await runChangesApplyTask(db, pending[0]!.payload, deps());

    const status = await call(changesStatus, { changeSetId: created.changeSetId });
    expect(status.run.state).toBe('in_review');
    expect(status.run.approvedVersion).toBeNull();
    expect(status.run.approvedHeadSha).toBeNull();
    expect(status.run.lastError).toMatch(/not the reviewed change/);
    expect(status.events.at(-1)?.reason).toMatch(/not the reviewed change/);
    expect(status.events.at(-1)?.evidence).toMatchObject({ branch, baseSha: github.headOf(DEFAULT_BRANCH) ?? expect.any(String) });
    // The pull request Agentic SEO opened on its own branch is closed; no second one exists.
    expect(github.pullRequests).toHaveLength(1);
    expect(github.pullRequests[0]!.state).toBe('closed');
  });

  /** The change an earlier attempt carried into a pull request, whose response was then lost. */
  async function interruptedApply() {
    const created = await call(changesCreate, createBody([titleChange('/about/', 'Old about', 'New about')]));
    const submitted = await call(changesRequestApply, { changeSetId: created.changeSetId, note: 'Apply.' });
    await call(approvalsApprove, { approvalId: submitted.approvalId }, personB);
    github.timeoutNextPullRequest = true;
    const pending = jobs.splice(0);
    expect(pending.map((job) => job.identifier)).toEqual([CHANGES_APPLY_TASK]);
    await expect(runChangesApplyTask(db, pending[0]!.payload, deps())).rejects.toThrow(/did not answer|could not be reached|GitHub/i);
    expect(github.pullRequests).toHaveLength(1);
    return { changeSetId: created.changeSetId as string, payload: pending[0]!.payload, branch: `aseo/${created.changeSetId}-v1` };
  }

  // Everything a pushed commit can change about a tree entry that a blob-SHA comparison cannot see:
  // the mode (executable bit, symlink), a submodule added, moved or removed, and a file added or
  // deleted. Each must refuse adoption, because none of it is what the person approved.
  const tampering: {
    what: string;
    reason: RegExp;
    /** The base repository already holds a submodule at vendor/lib. */
    submodule?: boolean;
    /** Rewrites the pull request's commit on the base so its tree holds something else. */
    tamper: (fake: FakeGitHub, branch: string) => unknown;
  }[] = [
    {
      what: 'an executable bit on the edited page',
      reason: /changes the mode of about\/index\.html to 100755/,
      tamper: (fake, branch) =>
        fake.rewriteHead(branch, (entries) => {
          const entry = entries.get('about/index.html')!;
          entries.set('about/index.html', { ...entry, mode: '100755' });
        }),
    },
    {
      what: 'a symlink where the edited page was',
      reason: /changes the mode of about\/index\.html to 120000/,
      tamper: (fake, branch) =>
        fake.rewriteHead(branch, (entries) => {
          const entry = entries.get('about/index.html')!;
          entries.set('about/index.html', { ...entry, mode: '120000' });
        }),
    },
    {
      what: 'an added submodule',
      reason: /it adds vendor\/lib/,
      tamper: (fake, branch) =>
        fake.rewriteHead(branch, (entries) => entries.set('vendor/lib', { type: 'commit', mode: '160000', sha: 'a'.repeat(40) })),
    },
    {
      what: 'a changed submodule',
      reason: /it changes vendor\/lib/,
      submodule: true,
      tamper: (fake, branch) =>
        fake.rewriteHead(branch, (entries) => entries.set('vendor/lib', { type: 'commit', mode: '160000', sha: 'b'.repeat(40) })),
    },
    {
      what: 'a deleted submodule',
      reason: /it deletes vendor\/lib/,
      submodule: true,
      tamper: (fake, branch) => fake.rewriteHead(branch, (entries) => entries.delete('vendor/lib')),
    },
    {
      what: 'an extra file',
      reason: /it adds sneaky\.txt/,
      tamper: (fake, branch) => fake.rewriteHead(branch, (entries, blob) => entries.set('sneaky.txt', blob('not reviewed'))),
    },
    {
      what: 'a deleted file',
      reason: /it deletes contact\/index\.html/,
      tamper: (fake, branch) => fake.rewriteHead(branch, (entries) => entries.delete('contact/index.html')),
    },
  ];

  it.each(tampering)('refuses to adopt a pull request that carries $what', async ({ tamper, reason, submodule }) => {
    if (submodule) github.pushEntry(DEFAULT_BRANCH, 'vendor/lib', { type: 'commit', mode: '160000', sha: 'a'.repeat(40) });
    const { changeSetId, payload, branch } = await interruptedApply();
    tamper(github, branch);

    await runChangesApplyTask(db, payload, deps());

    const status = await call(changesStatus, { changeSetId });
    expect(status.run.state).toBe('in_review');
    expect(status.run.approvedVersion).toBeNull();
    expect(status.run.approvedHeadSha).toBeNull();
    expect(status.run.lastError).toMatch(/not the reviewed change/);
    expect(status.run.lastError).toMatch(reason);
    // The pull request Agentic SEO opened on its own branch is closed; no second one exists.
    expect(github.pullRequests).toHaveLength(1);
    expect(github.pullRequests[0]!.state).toBe('closed');
  });

  it('resumes an interrupted commit sequence after the branch and a blob were created', async () => {
    const created = await call(changesCreate, createBody([titleChange('/about/', 'Old about', 'New about')]));
    const submitted = await call(changesRequestApply, { changeSetId: created.changeSetId, note: 'Apply.' });
    await call(approvalsApprove, { approvalId: submitted.approvalId }, personB);
    const pending = jobs.splice(0);
    expect(pending.map((job) => job.identifier)).toEqual([CHANGES_APPLY_TASK]);

    const branch = `aseo/${created.changeSetId}-v1`;
    const baseSha = github.headOf(DEFAULT_BRANCH)!;
    // The first attempt created the branch, then died before its commit.
    github.branches.set(branch, baseSha);
    // A blob for the new file exists from an interrupted blob upload; the retry recreates or reuses it.
    github.putBlob(pageHtml('New about', 'Old description'));

    await runChangesApplyTask(db, pending[0]!.payload, deps());
    const status = await call(changesStatus, { changeSetId: created.changeSetId });
    expect(status.run.state).toBe('pr_open');
    expect(github.pullRequests).toHaveLength(1);
    expect(github.pullRequests[0]!.head).toBe(branch);
    expect(github.filesAt(branch)?.get('about/index.html')).toContain('<title>New about</title>');
  });

  it('fails a pull request merged with commits that were not approved, before any deploy', async () => {
    const { changeSetId, prNumber, branch } = await openPullRequest();
    github.pushToBranch(branch, { 'about/index.html': pageHtml('Pushed then merged') });
    const mergeSha = github.merge(prNumber);
    site.setPage('/about/', pageHtml('Pushed then merged', 'Old description'));
    site.setVersion(mergeSha);

    await poll();
    const status = await call(changesStatus, { changeSetId });
    expect(status.run.state).toBe('failed');
    expect(status.run.deployedSha).toBeNull();
    expect(status.run.lastError).toMatch(/merged with commits that were not approved/);
    expect(status.events.at(-1)).toMatchObject({ fromState: 'pr_open', toState: 'failed' });
    expect(status.events.at(-1)?.evidence).toMatchObject({ approvedHeadSha: expect.any(String), mergedHeadSha: github.headOf(branch) });
    // A merged change nobody approved is not verified.
    expect(jobs.filter((job) => job.identifier === CHANGES_VERIFY_TASK)).toHaveLength(0);
  });

  it('counts an unknown deploy detector result toward the deploy timeout', async () => {
    const { changeSetId, prNumber } = await openPullRequest();
    github.merge(prNumber);
    // No version file: the detector cannot tell, which must not extend the window forever.
    site.setVersion(null);

    await poll();
    expect((await call(changesStatus, { changeSetId })).run.state).toBe('deploying');

    await poll({ now: () => new Date(Date.now() + 49 * 3_600_000) });
    const failed = await call(changesStatus, { changeSetId });
    expect(failed.run.state).toBe('deploy_not_detected');
    expect(failed.run.lastError).toMatch(/still does not show it after 48 hours/);
    expect(failed.run.lastError).toMatch(/answered 404/);
    expect(failed.events.at(-1)?.evidence).toMatchObject({ detectorState: 'unknown', deployTimeoutHours: 48 });
  });

  it('judges the redrafted version, not the previously published one, when the policy runs', async () => {
    const agentId = 'agt_redraft_policy';
    await db.admin.query(`INSERT INTO agents (workspace_id, id, name, sponsor_user_id) VALUES ($1, $2, 'Redrafter', 'sponsor')`, [
      workspace,
      agentId,
    ]);
    const agent = agentPrincipal(
      { id: agentId, name: 'Redrafter', status: 'active', statusReason: null },
      personA.userId,
      'client_redraft',
      workspace,
      'editor',
      ['artifacts:write', 'sites:read', 'changes:apply'],
    );

    // Version 1 was a content change, published, and then went stale.
    const created = await call(changesCreate, createBody([titleChange('/about/', 'Old about', 'New about')]));
    const submitted = await call(changesRequestApply, { changeSetId: created.changeSetId, note: 'First version.' });
    await call(approvalsApprove, { approvalId: submitted.approvalId }, personB);
    github.pushToBranch(DEFAULT_BRANCH, { 'about/index.html': pageHtml('Moved on') });
    await drain();
    expect((await call(changesStatus, { changeSetId: created.changeSetId })).run.state).toBe('stale');

    // Level 3 for content, nothing for structural: the redrafted redirect must be judged structural.
    mandate = { levels: { draft: 3, 'site.content': 3 } };
    executor = createExecutor(db, services());
    const redrafted = await call(
      changesUpdateDraft,
      {
        changeSetId: created.changeSetId,
        changes: [{ type: 'redirect', from: '/retired/', to: '/about/', status: 301, operation: 'add' }],
      },
      agent,
    );
    expect(redrafted).toMatchObject({ created: true, version: 2 });

    const resubmitted = await call(changesRequestApply, { changeSetId: created.changeSetId, note: 'Structural now.' }, agent);
    expect(resubmitted.actionClass).toBe('site.structural');
    expect(resubmitted.status).toBe('in_review');
    expect(ledger.at(-1)).toMatchObject({ command: 'changes.requestApply', actionClass: 'site.structural' });
  });

  it('verifies a redirect by fetching its path on the site origin and checking the Location', async () => {
    const created = await call(
      changesCreate,
      createBody([{ type: 'redirect', from: '/retired/', to: '/about/', status: 301, operation: 'add' }], {
        title: 'Retire a page',
      }),
    );
    expect(created.created).toBe(true);
    const submitted = await call(changesRequestApply, { changeSetId: created.changeSetId, note: 'Retire it.' });
    await call(approvalsApprove, { approvalId: submitted.approvalId }, personB);
    await drain();
    const open = await call(changesStatus, { changeSetId: created.changeSetId });
    expect(open.run.state).toBe('pr_open');

    const pr = github.pullRequests[0]!;
    expect(github.filesAt(pr.head)?.get('_redirects')).toContain('/retired/');
    const mergeSha = github.merge(pr.number);
    site.setRedirect('/retired/', '/about/', 301);
    site.setVersion(mergeSha);

    await poll();
    await drain();
    const verified = await call(changesStatus, { changeSetId: created.changeSetId });
    expect(verified.run.state).toBe('verified');
    expect(verified.verification.results[0]).toMatchObject({ url: `${site.origin}/retired/`, result: 'pass' });
    expect(verified.verification.results[0]?.detail).toContain('301');
  });

  it('queues the apply and verification jobs inside the transaction that makes them due', async () => {
    await installGraphileStub();
    try {
      const created = await call(changesCreate, createBody([titleChange('/about/', 'Old about', 'New about')]));
      const submitted = await call(changesRequestApply, { changeSetId: created.changeSetId, note: 'Apply.' });
      await call(approvalsApprove, { approvalId: submitted.approvalId }, personB);

      // The publish hook queued durably: no helper job was used.
      expect(jobs).toHaveLength(0);
      const { rows: applyRows } = await db.admin.query<{ payload: { artifactId: string } }>(
        'SELECT payload FROM graphile_worker.jobs WHERE identifier = $1',
        [CHANGES_APPLY_TASK],
      );
      expect(applyRows).toHaveLength(1);
      expect(applyRows[0]!.payload.artifactId).toBe(created.changeSetId);

      await runChangesApplyTask(db, applyRows[0]!.payload, deps());
      const pr = github.pullRequests[0]!;
      const mergeSha = github.merge(pr.number);
      site.setPage('/about/', pageHtml('New about', 'Old description'));
      site.setVersion(mergeSha);

      await poll();
      const { rows: verifyRows } = await db.admin.query<{ payload: { artifactId: string } }>(
        'SELECT payload FROM graphile_worker.jobs WHERE identifier = $1',
        [CHANGES_VERIFY_TASK],
      );
      expect(verifyRows).toHaveLength(1);
      expect(verifyRows[0]!.payload.artifactId).toBe(created.changeSetId);

      await runChangesVerifyTask(db, verifyRows[0]!.payload, deps());
      expect((await call(changesStatus, { changeSetId: created.changeSetId })).run.state).toBe('verified');
    } finally {
      await dropGraphileStub();
    }
  });

  it('queues a deployed change set’s verification again when it was lost', async () => {
    const { changeSetId, prNumber } = await openPullRequest();
    const mergeSha = github.merge(prNumber);
    site.setPage('/about/', pageHtml('New about', 'Old description'));
    site.setVersion(mergeSha);

    // The deploy is detected, but there is no queue: the verification job is lost.
    await runChangesPollTask(db, { kp, github: github.seam, siteUrlFor: () => site.origin });
    expect((await call(changesStatus, { changeSetId })).run.state).toBe('deployed');
    expect(jobs).toHaveLength(0);

    await db.admin.query(
      `UPDATE change_set_runs SET deployed_at = now() - interval '20 minutes' WHERE workspace_id = $1 AND artifact_id = $2`,
      [workspace, changeSetId],
    );
    const summary = await runChangesPoll(db, deps());
    expect(summary.requeued).toBe(1);
    expect(jobs.map((job) => job.identifier)).toContain(CHANGES_VERIFY_TASK);

    await drain();
    expect((await call(changesStatus, { changeSetId })).run.state).toBe('verified');
  });

  it('rolls back by proposing a draft change set only, and completes the original when it is verified', async () => {
    const { changeSetId, prNumber } = await openPullRequest();
    const mergeSha = github.merge(prNumber);
    site.setPage('/about/', pageHtml('New about', 'Old description'));
    site.setVersion(mergeSha);
    await poll();
    await drain();
    expect((await call(changesStatus, { changeSetId })).run.state).toBe('verified');

    const pullRequestsBefore = github.pullRequests.length;
    const rollback = await call(changesRollback, { changeSetId, note: 'The title tested badly.' });
    expect(rollback).toMatchObject({ mode: 'exact', filesUnchanged: true, actionClass: 'site.content' });
    // The command itself makes no GitHub write: only the approved apply worker opens the PR.
    expect(github.pullRequests).toHaveLength(pullRequestsBefore);
    const originalAfterProposal = await call(changesStatus, { changeSetId });
    expect(originalAfterProposal.run.state).toBe('verified');
    expect(originalAfterProposal.run.rollbackChangeSetId).toBe(rollback.changeSetId);
    const proposal = await call(changesStatus, { changeSetId: rollback.changeSetId });
    expect(proposal.run).toMatchObject({ state: 'draft', rollbackOf: changeSetId });

    // A second proposal while one is open is refused; abandoning the first allows another.
    await expect(call(changesRollback, { changeSetId, note: 'Again.' })).rejects.toThrow(/already a rollback/);
    await db.admin.query(`UPDATE change_set_runs SET state = 'closed' WHERE workspace_id = $1 AND artifact_id = $2`, [
      workspace,
      rollback.changeSetId,
    ]);
    const second = await call(changesRollback, { changeSetId, note: 'Second proposal.' });
    expect(second.changeSetId).not.toBe(rollback.changeSetId);
    expect((await call(changesStatus, { changeSetId })).run.state).toBe('verified');

    // Completing the rollback through approval, merge, deploy and verification rolls the original back.
    const submitted = await call(changesRequestApply, { changeSetId: second.changeSetId, note: 'Roll it back.' });
    expect(submitted.status).toBe('in_review');
    await call(approvalsApprove, { approvalId: submitted.approvalId }, personB);
    await drain();
    const opened = await call(changesStatus, { changeSetId: second.changeSetId });
    expect(opened.run.state).toBe('pr_open');
    const rollbackPr = github.pullRequests.find((candidate) => candidate.head === opened.run.branch)!;
    expect(github.filesAt(rollbackPr.head)?.get('about/index.html')).toContain('<title>Old about</title>');
    const rollbackMerge = github.merge(rollbackPr.number);
    site.setPage('/about/', pageHtml('Old about', 'Old description'));
    site.setVersion(rollbackMerge);
    await poll();
    await drain();

    expect((await call(changesStatus, { changeSetId: second.changeSetId })).run.state).toBe('verified');
    expect((await call(changesStatus, { changeSetId })).run.state).toBe('rolled_back');
  });

  it('proposes a draft rollback when a file changed after the merge', async () => {
    const { changeSetId, prNumber } = await openPullRequest();
    const mergeSha = github.merge(prNumber);
    site.setPage('/about/', pageHtml('New about', 'Old description'));
    site.setVersion(mergeSha);
    await poll();
    await drain();

    // Someone keeps editing the page after the merge: a revert would overwrite that work.
    github.pushToBranch(DEFAULT_BRANCH, { 'about/index.html': pageHtml('Even newer about') });

    const rollback = await call(changesRollback, { changeSetId, note: 'Roll it back.' });
    expect(rollback).toMatchObject({ mode: 'proposed', filesUnchanged: false });
    expect(rollback.reason).toContain('about/index.html');
    expect(github.pullRequests).toHaveLength(1);
    expect((await call(changesStatus, { changeSetId })).run.state).toBe('verified');

    const proposed = await call(changesStatus, { changeSetId: rollback.changeSetId });
    expect(proposed.run).toMatchObject({ state: 'draft', rollbackOf: changeSetId });
    const content = await call(changesGet, { changeSetId: rollback.changeSetId });
    expect(JSON.stringify(content.content)).toContain('Even newer about');
  });

  /** A live Search Console connection and fresh page rows, so a reach estimate is known. */
  async function seedSearchConsole(rows: { url: string; clicks: number }[] = [{ url: `${site.origin}/about/`, clicks: 12 }]) {
    const property = `sc-domain:${domain}`;
    await db.admin.query(
      `INSERT INTO connections (workspace_id, id, site_id, connector, label, settings, state)
       VALUES ($1, $2, $3, 'google-search-console', 'Google Search Console', $4::jsonb, 'active')`,
      [workspace, `con_${randomUUID().replace(/-/g, '')}`, siteId, JSON.stringify({ property })],
    );
    for (const row of rows) {
      await db.admin.query(
        `INSERT INTO gsc_page_aggregates
           (workspace_id, site_id, property, date, page, page_key, country, device, clicks, impressions, ctr, position, is_final)
         VALUES ($1, $2, $3, current_date, $4, $5, '', '', $6, $7, 0.03, 4, true)`,
        [workspace, siteId, property, row.url, normalizePageUrl(row.url), row.clicks, row.clicks * 10],
      );
    }
  }

  it('proposes one rollback when two requests arrive at the same moment', async () => {
    const { changeSetId, prNumber } = await openPullRequest();
    const mergeSha = github.merge(prNumber);
    site.setPage('/about/', pageHtml('New about', 'Old description'));
    site.setVersion(mergeSha);
    await poll();
    await drain();

    const outcomes = await Promise.allSettled([
      call(changesRollback, { changeSetId, note: 'First request.' }),
      call(changesRollback, { changeSetId, note: 'Second request.' }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    expect(String(refused?.reason)).toMatch(/already a rollback|same moment/);

    // Exactly one proposal exists for the original, and it is linked to it.
    const { rows } = await db.admin.query<{ artifact_id: string }>(
      'SELECT artifact_id FROM change_set_runs WHERE workspace_id = $1 AND rollback_of = $2',
      [workspace, changeSetId],
    );
    expect(rows).toHaveLength(1);
    const original = await call(changesStatus, { changeSetId });
    expect(original.run.rollbackChangeSetId).toBe(rows[0]!.artifact_id);
    expect(original.run.state).toBe('verified');
  });

  it('allows another rollback after a person rejects the proposal', async () => {
    const { changeSetId, prNumber } = await openPullRequest();
    const mergeSha = github.merge(prNumber);
    site.setPage('/about/', pageHtml('New about', 'Old description'));
    site.setVersion(mergeSha);
    await poll();
    await drain();

    const rollback = await call(changesRollback, { changeSetId, note: 'The title tested badly.' });
    const submitted = await call(changesRequestApply, { changeSetId: rollback.changeSetId, note: 'Roll it back.' });
    expect(submitted.status).toBe('in_review');
    await call(approvalsReject, { approvalId: submitted.approvalId, note: 'Not this week.' }, personB);

    // The rejected version is closed for good, so the run no longer looks open.
    const rejected = await call(changesStatus, { changeSetId: rollback.changeSetId });
    expect(rejected.run.state).toBe('closed');
    expect(rejected.events.at(-1)?.reason).toMatch(/rejected/);

    const second = await call(changesRollback, { changeSetId, note: 'Second attempt.' });
    expect(second.changeSetId).not.toBe(rollback.changeSetId);
    expect((await call(changesStatus, { changeSetId })).run.state).toBe('verified');
  });

  it('records an inverse the drafter refuses as uncovered, so the rollback is never exact (review round 3)', async () => {
    const created = await call(
      changesCreate,
      createBody([titleChange('/about/', 'Old about', 'New about'), titleChange('/contact/', 'Contact', 'New contact')], {
        title: 'Rewrite two titles',
      }),
    );
    const submitted = await call(changesRequestApply, { changeSetId: created.changeSetId, note: 'Apply.' });
    await call(approvalsApprove, { approvalId: submitted.approvalId }, personB);
    await drain();
    const open = await call(changesStatus, { changeSetId: created.changeSetId });
    const mergeSha = github.merge(open.run.prNumber as number);
    site.setPage('/about/', pageHtml('New about', 'Old description'));
    site.setPage('/contact/', pageHtml('New contact', 'Old description'));
    site.setVersion(mergeSha);
    await poll();
    await drain();
    expect((await call(changesStatus, { changeSetId: created.changeSetId })).run.state).toBe('verified');

    // The contact page's source is deleted after the merge: its inverse cannot be drafted.
    github.pushEntry(DEFAULT_BRANCH, 'contact/index.html', null);
    const rollback = await call(changesRollback, { changeSetId: created.changeSetId, note: 'Both titles were wrong.' });
    expect(rollback.mode).toBe('proposed');
    expect(rollback.uncoveredChanges.map((entry: { index: number }) => entry.index)).toEqual([1]);
    expect((await call(changesStatus, { changeSetId: rollback.changeSetId })).run.uncoveredChanges).toHaveLength(1);
  });

  it('refuses to reopen a rejected rollback proposal while another is open, with a clear message (review round 3)', async () => {
    const { changeSetId, prNumber } = await openPullRequest();
    const mergeSha = github.merge(prNumber);
    site.setPage('/about/', pageHtml('New about', 'Old description'));
    site.setVersion(mergeSha);
    await poll();
    await drain();

    const first = await call(changesRollback, { changeSetId, note: 'The title tested badly.' });
    const submitted = await call(changesRequestApply, { changeSetId: first.changeSetId, note: 'Roll it back.' });
    await call(approvalsReject, { approvalId: submitted.approvalId, note: 'Not this week.' }, personB);
    const second = await call(changesRollback, { changeSetId, note: 'Second attempt.' });
    expect(second.changeSetId).not.toBe(first.changeSetId);

    await expect(call(changesUpdateDraft, { changeSetId: first.changeSetId, summary: 'Try the first one again.' })).rejects.toThrow(
      new RegExp(`Rollback ${second.changeSetId} of ${changeSetId} is already open`),
    );
    // Its changes are the original's inverses: a hand edit is refused too.
    await expect(
      call(changesUpdateDraft, { changeSetId: second.changeSetId, changes: [titleChange('/about/', 'New about', 'Other')] }),
    ).rejects.toThrow(/Call changes\.rollback again/);
  });

  it('refuses change-set content through config.import, for a new artifact and an existing one', async () => {
    const created = await call(changesCreate, createBody([titleChange('/about/', 'Old about', 'New about')]));
    const stored = (await call(changesGet, { changeSetId: created.changeSetId })).content as Record<string, unknown>;

    // A fresh id: the import would insert the draft itself instead of going through changes.create.
    const fresh = {
      format: 'agentic-seo/artifacts@1',
      artifacts: [{ id: `chg_${'a'.repeat(32)}`, type: 'change_set', name: 'Imported change set', siteId, content: stored }],
    };
    await expect(call(importConfig, { bundle: fresh, dryRun: false })).rejects.toThrow(
      /changes\.create to draft one or changes\.updateDraft/,
    );

    // An existing one: a bundle whose title differs must not edit the draft either.
    const existing = {
      format: 'agentic-seo/artifacts@1',
      artifacts: [
        {
          id: created.changeSetId,
          type: 'change_set',
          name: 'Imported change set',
          siteId,
          content: { ...stored, title: 'Changed by the import' },
        },
      ],
    };
    await expect(call(importConfig, { bundle: existing, dryRun: false })).rejects.toThrow(/changes\.updateDraft/);
    expect(((await call(changesGet, { changeSetId: created.changeSetId })).content as { title: string }).title).toBe(
      'Rewrite a page title',
    );
  });

  it('proposes a partial rollback that is not exact and never marks the original rolled back', async () => {
    await seedSearchConsole();
    // A title change (invertible) plus an inserted meta description (a change cannot remove one).
    const created = await call(
      changesCreate,
      createBody(
        [
          titleChange('/about/', 'Old about', 'New about'),
          { type: 'meta.description', url: pageUrl('/contact/'), before: null, after: 'A fresh description' },
        ],
        { title: 'Rewrite a title and add a description' },
      ),
    );
    expect(created.changes).toHaveLength(2);
    const submitted = await call(changesRequestApply, { changeSetId: created.changeSetId, note: 'Apply.' });
    await call(approvalsApprove, { approvalId: submitted.approvalId }, personB);
    await drain();
    const open = await call(changesStatus, { changeSetId: created.changeSetId });
    const mergeSha = github.merge(open.run.prNumber as number);
    site.setPage('/about/', pageHtml('New about', 'Old description'));
    site.setPage('/contact/', pageHtml('Contact', 'A fresh description'));
    site.setVersion(mergeSha);
    await poll();
    await drain();
    expect((await call(changesStatus, { changeSetId: created.changeSetId })).run.state).toBe('verified');

    const rollback = await call(changesRollback, { changeSetId: created.changeSetId, note: 'Both changes were wrong.' });
    // One change cannot be inverted, so this is a proposal, never exact.
    expect(rollback).toMatchObject({ mode: 'proposed', filesUnchanged: true, actionClass: 'site.content' });
    expect(rollback.uncoveredChanges).toHaveLength(1);
    expect(rollback.uncoveredChanges[0]!.index).toBe(1);
    expect(rollback.uncoveredChanges[0]!.reason).toMatch(/cannot remove one/);
    // The reach is the original change set's (two changes, every route their sources render), not
    // the one URL the covered inverse touches: it equals what changes.requestApply estimated then.
    expect(rollback.reach).toEqual(submitted.reach);
    expect(rollback.reach.kind === 'known' && rollback.reach.affectedUrls).toBeGreaterThan(1);

    const proposal = await call(changesStatus, { changeSetId: rollback.changeSetId });
    expect(proposal.run.state).toBe('draft');
    expect(proposal.run.uncoveredChanges).toHaveLength(1);

    // Completing it reverses the title and still must not claim the whole change set is rolled back.
    const second = await call(changesRequestApply, { changeSetId: rollback.changeSetId, note: 'Roll the title back.' });
    await call(approvalsApprove, { approvalId: second.approvalId }, personB);
    await drain();
    const rollbackRun = await call(changesStatus, { changeSetId: rollback.changeSetId });
    const rollbackPr = github.pullRequests.find((candidate) => candidate.head === rollbackRun.run.branch)!;
    expect(github.filesAt(rollbackPr.head)?.get('about/index.html')).toContain('<title>Old about</title>');
    const rollbackMerge = github.merge(rollbackPr.number);
    site.setPage('/about/', pageHtml('Old about', 'Old description'));
    site.setVersion(rollbackMerge);
    await poll();
    await drain();

    expect((await call(changesStatus, { changeSetId: rollback.changeSetId })).run.state).toBe('verified');
    const original = await call(changesStatus, { changeSetId: created.changeSetId });
    expect(original.run.state).toBe('verified');
    expect(original.events.at(-1)?.reason).toMatch(/does not cover every change/);
  });

  /** A throwaway Graphile schema, so a test can see a transactionally queued job without the worker. */
  async function installGraphileStub(): Promise<void> {
    await db.admin.query('CREATE SCHEMA IF NOT EXISTS graphile_worker');
    await db.admin.query(
      `CREATE TABLE IF NOT EXISTS graphile_worker.jobs (
         id bigserial PRIMARY KEY,
         identifier text NOT NULL,
         payload jsonb NOT NULL,
         run_at timestamptz NOT NULL DEFAULT now(),
         job_key text,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await db.admin.query(
      `CREATE OR REPLACE FUNCTION graphile_worker.add_job(
         identifier text,
         payload jsonb,
         run_at timestamptz DEFAULT now(),
         job_key text DEFAULT NULL,
         job_key_mode text DEFAULT 'replace'
       ) RETURNS void LANGUAGE sql AS $$
         INSERT INTO graphile_worker.jobs (identifier, payload, run_at, job_key)
         VALUES (identifier, payload, run_at, job_key)
       $$`,
    );
  }

  async function dropGraphileStub(): Promise<void> {
    await db.admin.query('DROP SCHEMA IF EXISTS graphile_worker CASCADE');
  }

  /**
   * A change set stored straight in the database, as a write that bypassed the commands leaves it:
   * within the content schema and re-derivable from the repository, with only the URL wrong.
   */
  async function seedStoredChangeSet(url: string, before = 'Old about', after = 'New about'): Promise<string> {
    const id = `chg_${randomUUID().replace(/-/g, '')}`;
    const baseSha = github.headOf(DEFAULT_BRANCH)!;
    const content = {
      connector: 'github',
      title: 'Rewrite a page title',
      summary: 'The title is generic and does not match the search intent.',
      changes: [
        {
          change: { type: 'meta.title', url, before, after },
          source: {
            path: 'about/index.html',
            editor: 'html',
            confidence: 'exact',
            affectedRoutes: [new URL(url).pathname],
          },
          baseSha,
          sourceHash: sourceHashOf(pageHtml(before, 'Old description')),
          diff: { path: 'about/index.html', status: 'modified', unified: '', additions: 1, deletions: 1 },
        },
      ],
      verificationPlan: 'Re-fetch the page and check its title.',
      rollbackPlan: 'Revert the merge commit.',
    };
    await db.admin.query(
      `INSERT INTO artifacts (workspace_id, id, type, name, site_id, latest_version)
       VALUES ($1, $2, 'change_set', 'Rewrite a page title', $3, 1)`,
      [workspace, id, siteId],
    );
    await db.admin.query(
      `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
       VALUES ($1, $2, 1, 'draft', $3::jsonb, 'seed-hash', 'user', $4)`,
      [workspace, id, JSON.stringify(content), personA.userId],
    );
    await db.admin.query(
      `INSERT INTO change_set_runs (workspace_id, artifact_id, site_id, state, drafted_at)
       VALUES ($1, $2, $3, 'draft', now())`,
      [workspace, id, siteId],
    );
    return id;
  }

  it('refuses a change URL that is not on the site, naming the hosts it answers on', async () => {
    const created = await call(
      changesCreate,
      createBody([{ type: 'meta.title', url: 'https://unrelated.example/about/', before: 'Old about', after: 'New about' }]),
    );

    expect(created.created).toBe(false);
    expect(created.refusals).toHaveLength(1);
    expect(created.refusals[0]).toMatchObject({ code: 'invalid', url: 'https://unrelated.example/about/' });
    expect(created.refusals[0]?.reason).toContain('not on site');
    expect(created.refusals[0]?.reason).toContain(domain);
    // Nothing was drafted: no change set row exists for the write to be approved from.
    const { rows } = await db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM change_set_runs WHERE workspace_id = $1', [
      workspace,
    ]);
    expect(rows[0]?.n).toBe(0);
  });

  it('refuses a stored change set for another site at requestApply, before any approval', async () => {
    const changeSetId = await seedStoredChangeSet('https://unrelated.example/about/');

    const refused = await call(changesRequestApply, { changeSetId, note: 'Apply it.' }).then(
      () => null,
      (error: Error) => error,
    );

    expect(refused?.message).toContain('not on site');
    expect(refused?.message).toContain(domain);
    const status = await call(changesStatus, { changeSetId });
    expect(status.run.state).toBe('draft');
    expect(github.paths.filter((path) => path.includes('/pulls'))).toHaveLength(0);
  });

  it('refuses a stored change set for another site in the apply worker, so nothing is written', async () => {
    const changeSetId = await seedStoredChangeSet('https://unrelated.example/about/');
    // The state an approval leaves: published, approved, and queued for the worker.
    await db.admin.query(`UPDATE artifacts SET published_version = 1 WHERE workspace_id = $1 AND id = $2`, [workspace, changeSetId]);
    await db.admin.query(`UPDATE artifact_versions SET state = 'published' WHERE workspace_id = $1 AND artifact_id = $2`, [
      workspace,
      changeSetId,
    ]);
    await db.admin.query(
      `UPDATE change_set_runs SET state = 'approved', approved_version = 1, approved_head_sha = $3
        WHERE workspace_id = $1 AND artifact_id = $2`,
      [workspace, changeSetId, github.headOf(DEFAULT_BRANCH)!],
    );

    await runChangesApplyTask(db, { workspaceId: workspace, siteId, artifactId: changeSetId }, deps());

    expect(github.pullRequests).toHaveLength(0);
    const status = await call(changesStatus, { changeSetId });
    expect(status.run.state).toBe('in_review');
    expect(status.run.lastError).toContain('not on site');
    expect(status.run.lastError).toContain(domain);
  });

  /** The command on the site's own https domain (no fixture-origin seam); nothing is fetched. */
  function callOnDomain<C extends AnyCommand>(command: C, input: unknown) {
    const hostedServices = { ...services(), siteUrlFor: undefined };
    return createExecutor(db, hostedServices).execute(command, input, personA, { surface: 'internal' });
  }

  it('counts a redirect’s stored clicks by resolving its source on the site’s own origin', async () => {
    await seedSearchConsole([{ url: `https://${domain}/old/`, clicks: 100 }]);
    const created = await callOnDomain(
      changesCreate,
      createBody([{ type: 'redirect', from: '/old/', to: '/about/', status: 301, operation: 'add' }], { title: 'Retire a page' }),
    );
    expect(created.created).toBe(true);
    const submitted = await callOnDomain(changesRequestApply, { changeSetId: created.changeSetId, note: 'Retire it.' });
    expect(submitted.reach).toMatchObject({ kind: 'known', affectedUrls: 1, clicksAtRisk: 100 });
  });

  it('counts one page once when a change names it absolutely and its mapping route does too', async () => {
    await seedSearchConsole([{ url: `https://${domain}/about/`, clicks: 100 }]);
    const created = await callOnDomain(
      changesCreate,
      createBody([{ type: 'meta.title', url: `https://${domain}/about/`, before: 'Old about', after: 'New about' }]),
    );
    expect(created.created).toBe(true);
    const submitted = await callOnDomain(changesRequestApply, { changeSetId: created.changeSetId, note: 'Apply it.' });
    expect(submitted.reach).toMatchObject({ kind: 'known', affectedUrls: 1, clicksAtRisk: 100 });
  });
});
