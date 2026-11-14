import { type APIRequestContext, type BrowserContext, expect, type Page } from '@playwright/test';
import { e2eBase } from './ports';

/** Where the e2e server runs (see e2e/ports.ts). */
export const BASE = e2eBase;

/**
 * The password every seeded person has. The server test harness owns the same value; it is repeated
 * here so the Playwright suite does not load the server's own test code.
 */
export const PASSWORD = 'correct-horse-battery-staple';

/** The seeded people, one per situation the suite needs. */
export const PEOPLE = {
  /** Owns a workspace with one site, whose DNS record the e2e server can resolve. */
  owner: 'owner@example.com',
  /** Owns a workspace with no sites; the journey creates its first one. */
  newcomer: 'newcomer@example.com',
  /** Owns a workspace with no sites and is never changed: the no-site screen stays empty. */
  noSites: 'no-sites@example.com',
  /** Has an account but no workspace at all: the invitation has not been accepted yet. */
  noWorkspace: 'no-workspace@example.com',
};

/** Signs in over the API, which sets the session cookie on the page's own context. */
export async function signIn(target: Page | BrowserContext, email: string) {
  const response = await target.request.post('/api/auth/sign-in/email', {
    data: { email, password: PASSWORD },
    headers: { origin: BASE },
  });
  expect(response.ok(), `sign-in for ${email}: ${await response.text()}`).toBeTruthy();
}

/** Creates an account over the API (the person has no workspace yet unless an admin invites them). */
export async function signUp(request: APIRequestContext, email: string, name = email.split('@')[0]) {
  const response = await request.post('/api/auth/sign-up/email', {
    data: { email, password: PASSWORD, name },
    headers: { origin: BASE },
  });
  expect(response.ok(), `sign-up for ${email}: ${await response.text()}`).toBeTruthy();
}

/** Calls one command as the signed-in person, the same API the UI uses. */
export async function call<T>(request: APIRequestContext, name: string, input: unknown): Promise<T> {
  const response = await request.post(`/v1/${name}`, {
    data: input,
    headers: { 'content-type': 'application/json', origin: BASE },
  });
  const body = await response.json().catch(() => ({}));
  expect(response.ok(), `${name}: ${response.status()} ${JSON.stringify(body)}`).toBeTruthy();
  return body as T;
}

/**
 * Waits until the page has painted its data: the session resolved, no skeleton region is still
 * waiting on a read, and fonts are loaded. Every route ends in one of these states, signed in or
 * signed out, so a shot or an axe scan never measures a placeholder.
 */
export async function settle(page: Page) {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('[role="main"], main, form').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.as-skeleton')).toHaveCount(0, { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
}
