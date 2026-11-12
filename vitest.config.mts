import { defineConfig } from 'vitest/config';

// Pin the time zone before anything creates a Date, as in Agentic Marketing.
process.env.TZ = 'UTC';

// Projects:
//   packages  package unit and integration tests. Integration tests reach the shared test Postgres
//             through TEST_DATABASE_URL (scripts/test-services.sh) and create their own databases.
//   server    full-stack tests of apps/server (added in Phase 0 task C).
//   web       the admin UI's unit and component tests (added in Phase 0 task F).
const workers = Number(process.env.TEST_WORKERS ?? 4);

export default defineConfig({
  test: {
    env: { TZ: 'UTC' },
    projects: [
      {
        extends: true,
        test: {
          name: 'packages',
          include: ['packages/*/test/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
          maxWorkers: workers,
        },
      },
      {
        extends: true,
        test: {
          name: 'web',
          include: ['apps/web/test/**/*.test.{ts,tsx}', 'apps/web/src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['apps/web/test/setup.ts'],
          // Its own group: a different worker count from the packages project needs a distinct order.
          sequence: { groupOrder: 1 },
        },
      },
    ],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
