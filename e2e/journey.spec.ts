import { expect, test } from '@playwright/test';
import { BASE, call, PASSWORD, PEOPLE, settle, signIn, signUp } from './helpers';

// The Phase 0 done criterion, in a browser: a person signs in, creates a site, and sees the setup
// checklist; the checklist opens the verification screen with the record and the tag the server
// published. The ownership check runs for real — the e2e server resolves the TXT record only for the
// seeded `verify-…` site, so the other site exercises the server's own failure message.

const NEW_SITE = { name: 'New site', domain: 'new-site.example.com' };

type SiteOut = { id: string; name: string; domain: string; verified: boolean };
type VerificationOut = {
  token: string;
  dns: { name: string; value: string };
  meta: { name: string; content: string };
};

test.describe('signing in and setting up a site', () => {
  test('signs up and is told they are not in a workspace yet', async ({ page }) => {
    const email = `signup-${Date.now()}@example.com`;
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();

    // Accounts are created by the server's own auth surface; an account without a workspace is a
    // real state, and the app says so instead of showing an empty shell.
    await signUp(page.request, email);
    await page.goto('/');

    await expect(page.getByText("You're not in a workspace yet")).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('creates the first site and opens its verification screen from the checklist', async ({ page }) => {
    await page.goto('/');

    // The SPA's sign-in screen: the server serves it on the same origin and answers /api/auth.
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await page.getByLabel('E-mail').fill(PEOPLE.newcomer);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // The first run: no site yet, so the switcher cannot help and Home cannot answer.
    await expect(page.getByText('No sites yet')).toBeVisible();
    await page.getByRole('button', { name: 'Add your first site' }).click();
    await page.getByLabel('Site name').fill(NEW_SITE.name);
    await page.getByLabel('Primary domain').fill(NEW_SITE.domain);
    await page.getByRole('button', { name: 'Add site' }).click();

    // Home reads the real facts: the site exists, the checklist is open and no tile invents a number.
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    await expect(page.getByText(`Set up ${NEW_SITE.name}`)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Key metrics' }).getByText('Clicks', { exact: true })).toBeVisible();
    await expect(page.getByText('Connect Search Console to collect clicks.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Verify site', exact: true })).toBeVisible();

    // The checklist's verify step opens Settings → Site for this site.
    await page.getByRole('link', { name: 'Verify site', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Site' })).toBeVisible();
    await expect(page.getByText('Not verified', { exact: true }).first()).toBeVisible();

    // Compare the screen with what the server actually published for this site.
    const sites = await call<{ sites: SiteOut[] }>(page.request, 'sites.list', {});
    const site = sites.sites.find((candidate) => candidate.domain === NEW_SITE.domain);
    expect(site, `${NEW_SITE.domain} was not listed by sites.list`).toBeTruthy();
    const verification = await call<VerificationOut>(page.request, 'sites.verification', { siteId: site!.id });

    const dnsCard = page.locator('section').filter({ has: page.getByRole('heading', { name: 'DNS TXT record' }) });
    const metaCard = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Meta tag' }) });
    await expect(dnsCard.getByText('TXT', { exact: true })).toBeVisible();
    await expect(dnsCard.getByText(verification.dns.name, { exact: true })).toBeVisible();
    await expect(dnsCard.getByText(verification.dns.value, { exact: true })).toBeVisible();
    await expect(
      metaCard.getByText(`<meta name="${verification.meta.name}" content="${verification.meta.content}">`, { exact: true }),
    ).toBeVisible();

    // Check now asks the server. This domain has no record and no reachable home page, so the
    // screen shows the server's specific reason rather than a generic failure.
    await page.getByRole('button', { name: 'Check now' }).click();
    await expect(page.getByText('Not verified yet', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(new RegExp(`Ownership of ${NEW_SITE.domain.replaceAll('.', '\\.')} is not verified yet\\.`))).toBeVisible();
    await expect(page.getByText('Verified', { exact: true })).toHaveCount(0);

    // A refused write keeps the server's own sentence, not a generic message.
    await page.getByRole('button', { name: /Switch site/ }).click();
    await page.getByRole('menuitem', { name: 'New site…' }).click();
    await page.getByLabel('Site name').fill('Duplicate');
    await page.getByLabel('Primary domain').fill(NEW_SITE.domain);
    await page.getByRole('button', { name: 'Add site' }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText(`This workspace already tracks ${NEW_SITE.domain}`);
  });

  test('verifies a site over its DNS record and confirms it on Home', async ({ page }) => {
    await signIn(page, PEOPLE.owner);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    await expect(page.getByText('Set up MartechSignal')).toBeVisible();
    await expect(page.getByText('0 of 5 required steps confirmed')).toBeVisible();

    await page.getByRole('link', { name: 'Verify site', exact: true }).click();
    await page.getByRole('button', { name: 'Check now' }).click();

    await expect(page.getByText('Ownership verified with the DNS TXT record')).toBeVisible({ timeout: 20_000 });

    // The checklist reads the same fact from `sites.checklist`: the step is confirmed.
    await page.goto('/');
    await expect(page.getByText('1 of 5 required steps confirmed')).toBeVisible();
    await expect(page.getByText('Confirmed', { exact: true })).toBeVisible();
  });
});

/**
 * A small guard against a suite that silently scans nothing: the server has to answer the health
 * endpoint the UI's own probe uses, and the built UI has to be the one it serves.
 */
test('the e2e server serves the built UI and the API on one origin', async ({ page }) => {
  await page.goto('/');
  await settle(page);
  expect(await page.title()).toContain('Agentic SEO');
  const health = await page.request.get(`${BASE}/healthz`);
  expect(health.ok()).toBeTruthy();
});
