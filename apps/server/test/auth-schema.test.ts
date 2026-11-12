import { authOptions } from '@agentic-seo/auth';
import { createDb } from '@agentic-seo/db';
import { getMigrations } from 'better-auth/db/migration';
import { afterAll, describe, expect, it } from 'vitest';
import { freshDatabase } from './harness';

// The SQL migration must match Better Auth's own expectation exactly: the server still calls
// migrateAuth at start-up, and a mismatch would ALTER tables on every boot (or fail on a fresh
// install). This test compares the two once, on a copy of the migrated template.

const opened: { close(): Promise<void> }[] = [];
afterAll(async () => {
  for (const db of opened) await db.close();
});

describe('the auth schema', () => {
  it('needs no change from Better Auth after the SQL migration', async () => {
    const { url } = await freshDatabase('aseo_authschema');
    const db = createDb({ adminUrl: url.toString(), appUrl: url.toString() });
    opened.push(db);

    const { toBeCreated, toBeAdded, toBeAddedIndexes } = await getMigrations(
      authOptions({ baseUrl: 'http://localhost:3000', secret: 'test-secret-test-secret-test-secret-123', db }),
    );
    expect(toBeCreated.map((table) => table.table)).toEqual([]);
    expect(toBeAdded.map((table) => table.table)).toEqual([]);
    expect(toBeAddedIndexes).toEqual([]);
  });
});
