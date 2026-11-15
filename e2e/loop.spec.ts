import { type APIRequestContext, expect, request, test } from '@playwright/test';
import { BASE, call, PASSWORD, PEOPLE, settle, signIn } from './helpers';
import { e2eDb, seedThinLoop, type ThinLoopIds } from './seed';

// The thin loop, in a browser: an issue an audit found, a recommendation with that issue as its
// evidence, a second person's approval in the Inbox, and the change set that carries it.
//
// The audit and the artifacts are seeded (e2e/seed.ts): the crawler needs a fixture host and the
// connector needs a GitHub fake, and the e2e server exposes neither. Everything the journey does
// afterwards is the real command layer: the recommendation is written in the form, the approval is
// decided by a second person, and every screen reads the rows it produced.

type SiteOut = { id: string; name: string; domain: string };

let ids: ThinLoopIds;
let db: Awaited<ReturnType<typeof e2eDb>>;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  db = await e2eDb();
  // The owner's own workspace and site, as the server seeded them.
  const context = await request_(PEOPLE.owner);
  const membership = await call<{ workspaces: { id: string }[] }>(context, 'workspace.memberships', {});
  const workspaceId = membership.workspaces[0]!.id;
  const sites = await call<{ sites: SiteOut[] }>(context, 'sites.list', {});
  const site = sites.sites[0]!;
  const ownerId = (await me(context))!;
  ids = await seedThinLoop(db, { workspaceId, siteId: site.id, userId: ownerId, domain: site.domain });
  // A second person, an approver, so the decision is not the requester's own.
  await addApprover(db, workspaceId, 'approver@example.com');
  await context.dispose();
});

test.afterAll(async () => {
  await db.close();
});

test('a person turns an audit issue into a recommendation', async ({ page }) => {
  await signIn(page, PEOPLE.owner);
  await page.goto('/issues');

  // The issue the seed wrote, with the pages it covers and its severity.
  await expect(page.getByRole('heading', { level: 1, name: 'Issues' })).toBeVisible();
  await page.getByRole('link', { name: 'Page title is too long' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Page title is too long' })).toBeVisible();
  await expect(page.getByText(/on 1 of 3 pages/)).toBeVisible();
  await expect(page.getByText(/traffic unknown: Search Console is not connected/)).toBeVisible();

  // The evidence is on the Pages tab: what was found, what was expected.
  await expect(page.getByText(/far too long to be shown in full/).first()).toBeVisible();
  await expect(page.getByText('Within 580 px')).toBeVisible();

  // Create recommendation: the issue is the evidence the form carries.
  await page.getByRole('button', { name: 'Create recommendation' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create recommendation' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(/^What to do/)).toHaveValue('Page title is too long');
  await dialog.getByLabel(/^Rationale/).fill('The pricing page title is cut off in the result.');
  await dialog.getByLabel(/^Hypothesis/).fill('If the title fits, the whole message is read.');
  await dialog.getByLabel(/^Expected impact/).fill('Expected: CTR +5–10% on the pricing page');
  await dialog.getByLabel(/^What a re-fetch must show/).fill('The pricing page title is short.');
  await dialog.getByLabel(/^Falsification check/).fill('We will know this failed if CTR is unchanged after 28 days.');
  await dialog.getByLabel(/^Leading indicator/).fill('impressions-weighted CTR, daily');
  await dialog.getByRole('button', { name: 'Create recommendation' }).click();

  // The recommendation's own screen: consequence first, then the tabs.
  await expect(page.getByRole('heading', { level: 1, name: 'Page title is too long' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Expected: CTR \+5–10%/)).toBeVisible();
  await expect(page.getByText(/draft a change set from the proposed changes/)).toBeVisible();
  await expect(page.getByRole('tab', { name: /Evidence/ })).toBeVisible();
});

test('a second person approves in the Inbox and the change set shows its pull request', async ({ browser }) => {
  // The approver is a different person: their own context, the same workspace.
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  await signIn(context, 'approver@example.com');
  const page = await context.newPage();
  await page.goto('/inbox');
  await settle(page);

  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  await expect(page.getByText('Shorten the pricing page title').first()).toBeVisible();
  await page.getByRole('button', { name: 'Review' }).first().click();
  const drawer = page.getByRole('dialog', { name: 'Shorten the pricing page title' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('What changes')).toBeVisible();
  await drawer.getByRole('button', { name: 'Approve and publish' }).click();

  // The request leaves the Inbox once decided.
  await expect(page.getByText('Nothing is waiting for you')).toBeVisible({ timeout: 20_000 });
  await context.close();

  // The change set the loop produced: at its pull request, with the connector named.
  await signIn(page, PEOPLE.owner);
  await page.goto(`/changes/${ids.changeSetId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Shorten the pricing page title' })).toBeVisible();
  await expect(page.getByText('PR open').first()).toBeVisible();
  await expect(page.getByRole('list', { name: 'Change set pipeline' })).toBeVisible();
  await expect(page.getByRole('link', { name: '#42' })).toBeVisible();

  // And the recommendation is accepted, because a published version is what acceptance means.
  await page.goto(`/recommendations/${ids.recommendationId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Shorten the pricing page title' })).toBeVisible();
});

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
