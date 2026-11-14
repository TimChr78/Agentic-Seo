import { dropRunDatabases, prepareTemplateDatabase, TEMPLATE_DB } from './harness';

// Vitest global setup for the server project: migrate one template database, then every test
// file's database is a copy of it (startTestServer). Workers start after this and inherit the env.
// Teardown drops this run's own databases by prefix; ASEO_TEST_KEEP_DB=1 keeps them for inspection.

export async function setup() {
  await prepareTemplateDatabase();
  process.env.ASEO_TEST_TEMPLATE = TEMPLATE_DB;
}

export async function teardown() {
  await dropRunDatabases();
}
