import { createDb, type Tx } from '@agentic-seo/db';
import { afterAll, describe, expect, it } from 'vitest';
import { APP_ROLE, createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { localKeyProvider } from '../src/keys';
import { activeDataKey } from '../src/secrets';

// The data key is per workspace and purpose. The partial unique index must not treat a workspace's
// secrets key and identity key as the same row, and a losing concurrent first use must resolve to
// the winner instead of retrying forever.

const kp = localKeyProvider(Buffer.alloc(32, 9).toString('base64'));

const appUrl = (url: URL) => {
  const u = new URL(url.toString());
  u.username = APP_ROLE.appRole;
  u.password = APP_ROLE.appRolePassword;
  return u.toString();
};

describe.skipIf(!hasTestDatabase())('the active data key', () => {
  let disposable: Awaited<ReturnType<typeof createDisposableDb>> | undefined;

  afterAll(async () => {
    await disposable?.close();
  });

  it('keeps one active key per purpose, and returns the same key on every use', async () => {
    const current = await createDisposableDb('datakeys');
    disposable = current;
    const db = createDb({ adminUrl: current.url.toString(), appUrl: appUrl(current.url), poolSize: 4 });
    try {
      const secrets = await db.withWorkspace(current.workspace, (tx) => activeDataKey(tx, current.workspace, kp, 'secrets'));
      const identity = await db.withWorkspace(current.workspace, (tx) => activeDataKey(tx, current.workspace, kp, 'identity'));
      expect(identity.id).not.toBe(secrets.id);

      const again = await db.withWorkspace(current.workspace, (tx) => activeDataKey(tx, current.workspace, kp, 'identity'));
      expect(again.id).toBe(identity.id);
      expect(again.key).toEqual(identity.key);
    } finally {
      await db.close();
    }
  });

  it('resolves two concurrent first uses to one key', async () => {
    const current = await createDisposableDb('datakeys_race');
    disposable = current;
    const db = createDb({ adminUrl: current.url.toString(), appUrl: appUrl(current.url), poolSize: 4 });
    try {
      const [a, b] = await Promise.all([
        db.withWorkspace(current.workspace, (tx) => activeDataKey(tx, current.workspace, kp, 'matching')),
        db.withWorkspace(current.workspace, (tx) => activeDataKey(tx, current.workspace, kp, 'matching')),
      ]);
      expect(b.id).toBe(a.id);
      expect(b.key).toEqual(a.key);
    } finally {
      await db.close();
    }
  });

  it('gives up with an error instead of recursing when the conflicting key is not visible', async () => {
    // A conflicting insert whose winner this transaction cannot see (a repeatable-read snapshot)
    // must fail clearly rather than retry forever.
    const invisibleTx = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
      insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }) }),
    } as unknown as Tx;
    await expect(activeDataKey(invisibleTx, 'ws-1', kp, 'secrets')).rejects.toThrow(/Could not create a "secrets" data key/);
  });
});
