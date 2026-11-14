import { defineConfig, devices } from '@playwright/test';
import { e2eBase, e2eReadinessBase } from './e2e/ports';

// End-to-end tests of the admin UI against a seeded server (apps/server/test/e2e/server.ts).
//   corepack pnpm e2e                                   builds the UI, starts the seeded server on :3100, runs both projects
//   corepack pnpm e2e --project axe                     only the accessibility scan
//   E2E_BASE=http://localhost:5173 corepack pnpm e2e    against a running Vite dev server instead
//   E2E_PORT=3120 E2E_DB=e2e_mine corepack pnpm e2e     another port and database, so two checkouts can run at once
// TEST_PORT_OFFSET moves the default port and the readiness port together (e2e/ports.ts).
// Uses the system Chromium when CHROMIUM is set, else Playwright's own.
const executablePath = process.env.CHROMIUM || undefined;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  // The functional suite is the default; the axe checks are their own project so they can run alone.
  projects: [
    { name: 'functional', testIgnore: /axe\.spec\.ts/ },
    { name: 'axe', testMatch: '**/axe.spec.ts' },
  ],
  use: {
    baseURL: e2eBase,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    // Chromium needs this where /dev/shm is the container default of 64 MB (axe opens a second tab).
    launchOptions: { executablePath, args: ['--disable-dev-shm-usage'] },
  },
  webServer: process.env.E2E_BASE
    ? undefined
    : {
        command: 'corepack pnpm --filter @agentic-seo/web build && corepack pnpm exec tsx apps/server/test/e2e/server.ts',
        // The readiness port answers only after the seed finishes; /healthz is up too early.
        url: `${e2eReadinessBase}/ready`,
        timeout: 240_000,
        reuseExistingServer: !process.env.CI,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
