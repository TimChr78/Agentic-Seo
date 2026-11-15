import { type APIRequestContext, expect, request, test } from '@playwright/test';
import { checkById } from '../packages/checks/src/catalogue';
import { BASE, call, PASSWORD, PEOPLE, settle, signIn } from './helpers';
import { e2eDb, seedThinLoop } from './seed';

// The thin loop, in a browser: an issue an audit found, a recommendation written from it, a change
// set drafted with the GitHub connector, a second person's approval in the Inbox, and the apply job
// that opens the pull request.
//
// The audit and the issue are seeded (e2e/seed.ts): the crawler needs a fixture host. Everything
// after that is the real command layer and the real screens: the recommendation is written in the
// form, the change set is drafted through the site's source mapping, a different person approves it
// in the Inbox, and the change-set screen reads the state the apply job wrote. The e2e server
// replaces GitHub with the change-sets package's own fake and runs the approved apply job once
// through a test-only route (it has no worker); production keeps both paths, and nothing in this
// spec reaches api.github.com.

type SiteOut = { id: string; name: string; domain: string };

/** The catalogue's own title: the screen shows what `checks.explain` shows, not a copy. */
const ISSUE_TITLE = checkById('title.too_long')?.title ?? 'title.too_long';

let db: Awaited<ReturnType<typeof e2eDb>>;
let workspaceId: string;
let siteId: string;
let domain: string;
let recommendationId: string;
let changeSetId: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  db = await e2eDb();
  // The owner's own workspace and site, as the server seeded them.
  const context = await request_(PEOPLE.owner);
  try {
    const membership = await call<{ workspaces: { id: string }[] }>(context, 'workspace.memberships', {});
    workspaceId = membership.workspaces[0]!.id;
    const sites = await call<{ sites: SiteOut[] }>(context, 'sites.list', {});
    const site = sites.sites[0]!;
    siteId = site.id;
    domain = site.domain;
    const ownerId = (await me(context))!;
    // A publish is a person's decision, so the change set is held for the approver instead of
    // publishing itself; without this every publish needs no approval and the Inbox has nothing.
    await db.admin.query('UPDATE workspaces SET approval_policy = $2 WHERE id = $1', [workspaceId, 'all_publishes']);
    // The server's DNS seam answers the token for a `verify-` domain, so ownership is proved the
    // same way a person's site would be; requestApply refuses a change set on an unverified site.
    const verified = await call<{ verified: boolean }>(context, 'sites.verify', { siteId });
    expect(verified.verified, 'the seeded site is verified through the e2e DNS seam').toBe(true);
    await seedThinLoop(db, { workspaceId, siteId, userId: ownerId, domain });
    // A second person, an approver, so the decision is not the requester's own.
    await addApprover(db, workspaceId, 'approver@example.com');
  } finally {
    await context.dispose();
  }
});

test.afterAll(async () => {
  await db.close();
});

test('a person turns an audit issue into a recommendation', async ({ page }) => {
  await signIn(page, PEOPLE.owner);
  await page.goto('/issues');

  // The issue the seed wrote, with the pages it covers and its severity.
  await expect(page.getByRole('heading', { level: 1, name: 'Issues' })).toBeVisible();
  await page.getByRole('link', { name: ISSUE_TITLE }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: ISSUE_TITLE })).toBeVisible();
  await expect(page.getByText(/on 1 of 3 pages/)).toBeVisible();
  await expect(page.getByText(/traffic unknown: Search Console is not connected/)).toBeVisible();

  // The evidence is on the Pages tab: what was found, what was expected.
  await expect(page.getByText(/far too long to be shown in full/).first()).toBeVisible();
  await expect(page.getByText('Within 580 px')).toBeVisible();

  // Create recommendation: the issue is the evidence the form carries, and no page is proposed
  // yet — the change-set form will ask for each edit.
  await page.getByRole('button', { name: 'Create recommendation' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create recommendation' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(/^What to do/)).toHaveValue(ISSUE_TITLE);
  await dialog.getByLabel(/^Rationale/).fill('The pricing page title is cut off in the result.');
  await dialog.getByLabel(/^Hypothesis/).fill('If the title fits, the whole message is read.');
  await dialog.getByLabel(/^Expected impact/).fill('Expected: CTR +5–10% on the pricing page');
  await dialog.getByLabel(/^What a re-fetch must show/).fill('The pricing page title is short.');
  await dialog.getByLabel(/^Falsification check/).fill('We will know this failed if CTR is unchanged after 28 days.');
  await dialog.getByLabel(/^Leading indicator/).fill('impressions-weighted CTR, daily');
  await dialog.getByRole('button', { name: 'Create recommendation' }).click();

  // The recommendation's own screen: consequence first, then the tabs. An issue-created
  // recommendation names no page, and drafting starts from an empty change list.
  await expect(page.getByRole('heading', { level: 1, name: ISSUE_TITLE })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Expected: CTR \+5–10%/)).toBeVisible();
  await expect(page.getByText(/draft a change set and name each edit/)).toBeVisible();
  recommendationId = page.url().split('/recommendations/')[1]!;
  expect(recommendationId).toMatch(/^rcm_[0-9a-f]{32}$/);
  const draft = page.getByRole('button', { name: 'Draft change set' });
  await expect(draft).toBeEnabled();
});

test('the GitHub connection carries a drafted change set to an approved pull request', async ({ browser }) => {
  const owner = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  await signIn(owner, PEOPLE.owner);
  const ownerPage = await owner.newPage();

  // Connect GitHub to the fake repository the e2e server stubs at the connector seam.
  await ownerPage.goto('/settings/connections');
  await settle(ownerPage);
  await ownerPage.getByRole('button', { name: 'Connect GitHub' }).click();
  await ownerPage.getByLabel(/^Owner/).fill('acme');
  await ownerPage.getByLabel(/^Repository/).fill('site');
  await ownerPage.getByLabel(/^Base branch/).fill('main');
  await ownerPage.getByLabel(/^Personal access token/).fill('ghp_0123456789012345678901');
  const mapping = ownerPage.getByLabel(/^Source mapping/);
  await mapping.fill(JSON.stringify({ rules: [{ routes: '/pricing', source: 'content/pricing/index.html', editor: 'html' }] }));
  await ownerPage.getByRole('button', { name: 'Connect GitHub' }).click();
  await expect(ownerPage.getByText('acme/site')).toBeVisible({ timeout: 20_000 });

  // Draft from the recommendation: an issue-created one starts with an empty row, so the person
  // names the type, page and values here.
  await ownerPage.goto(`/recommendations/${recommendationId}`);
  await ownerPage.getByRole('button', { name: 'Draft change set' }).click();
  const draft = ownerPage.getByRole('dialog', { name: 'Draft a change set' });
  await expect(draft).toBeVisible();
  await draft.getByLabel('Page URL').fill(`https://${domain}/pricing`);
  await draft.getByLabel('Value now').fill('A pricing page title that is far too long to be shown in full');
  await draft.getByLabel('Value to write').fill('Pricing plans and prices');
  await draft.getByRole('button', { name: 'Draft change set' }).click();

  // The change-set screen the draft produced, at its draft state.
  await expect(ownerPage.getByRole('heading', { level: 1, name: ISSUE_TITLE })).toBeVisible({ timeout: 20_000 });
  changeSetId = ownerPage.url().split('/changes/')[1]!;
  expect(changeSetId).toMatch(/^chg_[0-9a-f]{32}$/);
  expect(await runState(changeSetId)).toBe('draft');

  // Request apply: the policy holds it for a person, and the recommendation is the source recorded.
  await ownerPage.getByRole('button', { name: 'Request apply' }).click();
  const submit = ownerPage.getByRole('dialog', { name: 'Submit this change set' });
  await submit.getByLabel(/^What changed and why/).fill('One title change, backed by the issue.');
  await submit.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(submit.getByText('Waiting for a person')).toBeVisible();
  await submit.getByRole('button', { name: 'Close' }).click();
  expect(await runState(changeSetId)).toBe('in_review');
  const pending = await db.admin.query<{ id: string }>(
    "SELECT id FROM approval_requests WHERE workspace_id = $1 AND artifact_id = $2 AND status = 'pending'",
    [workspaceId, changeSetId],
  );
  expect(pending.rows).toHaveLength(1);

  // A second person approves in the Inbox: the decision is not the requester's own.
  const approver = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  await signIn(approver, 'approver@example.com');
  const approverPage = await approver.newPage();
  await approverPage.goto('/inbox');
  await settle(approverPage);
  await expect(approverPage.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  const row = approverPage.getByRole('listitem').filter({ hasText: ISSUE_TITLE }).first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Review' }).click();
  const drawer = approverPage.getByRole('dialog', { name: ISSUE_TITLE });
  await expect(drawer.getByText('What changes')).toBeVisible();
  await drawer.getByRole('button', { name: 'Approve and publish' }).click();
  // This request leaves the Inbox; the seeded recommendation's own request is still there.
  await expect(row).toHaveCount(0, { timeout: 20_000 });
  await approver.close();
  expect(await runState(changeSetId)).toBe('approved');

  // Applying is the job the queue would run; this server has no worker, so the spec runs that task
  // once through its test-only route, with the same fake GitHub the commands used.
  const applied = await ownerPage.request.post('/test/changes/apply', { data: { workspaceId, siteId, artifactId: changeSetId } });
  expect(applied.ok(), `apply job: ${applied.status()} ${await applied.text()}`).toBeTruthy();
  const run = await db.admin.query<{ state: string; pr_number: number; pr_url: string }>(
    'SELECT state, pr_number, pr_url FROM change_set_runs WHERE workspace_id = $1 AND artifact_id = $2',
    [workspaceId, changeSetId],
  );
  expect(run.rows[0]?.state).toBe('pr_open');
  expect(run.rows[0]?.pr_number).toBe(1);

  // The screen shows what the job wrote: the pull request and the connector that carried it.
  await ownerPage.goto(`/changes/${changeSetId}`);
  await expect(ownerPage.getByRole('heading', { level: 1, name: ISSUE_TITLE })).toBeVisible();
  await expect(ownerPage.getByText('PR open').first()).toBeVisible();
  await expect(ownerPage.getByRole('list', { name: 'Change set pipeline' })).toBeVisible();
  await expect(ownerPage.getByRole('link', { name: '#1' })).toBeVisible();
  await expect(ownerPage.getByText('GitHub · acme/site')).toBeVisible();

  await owner.close();
});

/** The run state one change set is in, read from the database the server uses. */
async function runState(artifactId: string) {
  const { rows } = await db.admin.query<{ state: string }>(
    'SELECT state FROM change_set_runs WHERE workspace_id = $1 AND artifact_id = $2',
    [workspaceId, artifactId],
  );
  return rows[0]?.state ?? null;
}

/** A request context signed in as a seeded person, for the seeding calls. */
async function request_(email: string) {
  const context = await request.newContext({ baseURL: BASE });
  const response = await context.post('/api/auth/sign-in/email', {
    data: { email, password: PASSWORD },
    headers: { origin: BASE },
  });
  expect(response.ok(), `sign-in for ${email}: ${await response.text()}`).toBeTruthy();
  return context;
}

/** The signed-in person's own id. */
async function me(context: APIRequestContext) {
  const response = await context.get('/api/auth/get-session');
  const body = (await response.json()) as { user?: { id: string } };
  return body.user?.id ?? null;
}

/** Signs an approver up and puts them in the workspace with the role the server checks. */
async function addApprover(database: Awaited<ReturnType<typeof e2eDb>>, workspaceId: string, email: string) {
  const context = await request.newContext({ baseURL: BASE });
  const response = await context.post('/api/auth/sign-up/email', {
    data: { email, password: PASSWORD, name: 'Approver' },
    headers: { origin: BASE },
  });
  expect(response.ok(), `sign-up for ${email}: ${await response.text()}`).toBeTruthy();
  const body = (await response.json()) as { user: { id: string } };
  await database.admin.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [
    workspaceId,
    body.user.id,
    'approver',
  ]);
  await context.dispose();
}
