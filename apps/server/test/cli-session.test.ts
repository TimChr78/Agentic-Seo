import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256 } from '@agentic-seo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetPasswordForEmail } from '../src/passwordReset';
import { APP_ROLE, cookieOf, startTestServer, testDatabaseUrl, testPort, type User } from './harness';

// `aseo reset-password` is the break-glass path when a password may be compromised. It must end the
// person's sessions in the same operation: a stolen cookie must stop working, while nobody else's
// session is touched.

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

function cli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, ['--import', 'tsx', CLI, ...args], {
      cwd: SERVER_DIR,
      env: { ...process.env, ...env },
      maxBuffer: 4 * 1024 * 1024,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin?.end();
  });
}

const whoami = (base: string, cookie: string, workspaceId: string) =>
  fetch(`${base}/v1/whoami`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie, 'x-workspace-id': workspaceId },
    body: '{}',
  });

let t: Awaited<ReturnType<typeof startTestServer>>;
let user: User;
let other: User;
let ws = '';

beforeAll(async () => {
  t = await startTestServer('cli_session', testPort(2506));
  user = await t.signUp(`cli-reset-${Date.now()}@example.com`);
  other = await t.signUp(`cli-other-${Date.now()}@example.com`);
  ws = await t.workspaceWith([
    [user, 'owner'],
    [other, 'viewer'],
  ]);
});

afterAll(async () => {
  await t?.close();
});

describe('aseo reset-password', { timeout: 180_000 }, () => {
  it('ends the person’s existing sessions and leaves everyone else signed in', async () => {
    expect((await whoami(t.base, user.cookie, ws)).status).toBe(200);

    const reset = await cli(['reset-password', '--email', user.email], {
      DATABASE_URL: testDatabaseUrl(t.dbName).toString(),
      APP_DB_ROLE: APP_ROLE.appRole,
      APP_DB_PASSWORD: APP_ROLE.appRolePassword,
      AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
      MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      PUBLIC_URL: t.base,
      ASEO_RESET_PASSWORD: 'a-brand-new-password',
    });
    expect(reset.code).toBe(0);
    expect(reset.stdout).toContain(`password updated for ${user.email}`);

    // The cookie issued before the reset is no longer a session.
    expect((await whoami(t.base, user.cookie, ws)).status).toBe(401);
    // Only that person's sessions were revoked.
    expect((await whoami(t.base, other.cookie, ws)).status).toBe(200);
  });
});

// #913: the credential write and the session deletion are one transaction, and the CLI writes the
// same audit entry the web reset writes. A crash between the two used to leave every session stolen
// before the reset valid, with no audit row recording that it happened.
describe('the reset itself (#913)', { timeout: 90_000 }, () => {
  let txn: User;
  let other: User;
  let txnWs = '';
  let txnOtherWs = '';

  const hashOf = async (userId: string) => {
    const { rows } = await t.srv.db.admin.query<{ password: string | null }>(
      `SELECT password FROM "account" WHERE "userId" = $1 AND "providerId" = 'credential'`,
      [userId],
    );
    return rows[0]?.password ?? null;
  };
  const whoamiIn = (cookie: string) =>
    fetch(`${t.base}/v1/whoami`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: t.base, cookie, 'x-workspace-id': txnWs },
      body: '{}',
    });
  const signIn = (email: string, password: string) =>
    fetch(`${t.base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: t.base },
      body: JSON.stringify({ email, password }),
    });

  type AuditRow = {
    seq: string;
    workspace_id: string;
    principal_type: string;
    client_id: string | null;
    principal_id: string;
    surface: string;
    command: string;
    effect: string;
    target: string | null;
    input_hash: string;
    ok: boolean;
    error: string | null;
    prev_hash: string | null;
    hash: string;
    ip: string | null;
  };
  // The entry lands in the person's oldest workspace, which is not necessarily the one the test
  // made first, so both are read and the chain is checked per workspace.
  const audits = async () => {
    const { rows } = await t.srv.db.admin.query<AuditRow>(
      `SELECT * FROM audit_log WHERE workspace_id = ANY($1) AND command = 'auth.passwordReset' ORDER BY seq`,
      [[txnWs, txnOtherWs]],
    );
    return rows;
  };
  /** The hash chain as `audit.verify` reads it: an absent IP is omitted, never hashed as null. */
  const chainOk = async (workspaceId: string) => {
    const { rows } = await t.srv.db.admin.query<AuditRow>('SELECT * FROM audit_log WHERE workspace_id = $1 ORDER BY seq', [workspaceId]);
    return rows.map((row, i) => {
      const entry = {
        workspaceId: row.workspace_id,
        principalType: row.principal_type,
        principalId: row.principal_id,
        clientId: row.client_id,
        surface: row.surface,
        command: row.command,
        effect: row.effect,
        target: row.target,
        inputHash: row.input_hash,
        ok: row.ok,
        error: row.error,
        prevHash: row.prev_hash,
        ...(row.ip ? { ip: row.ip } : {}),
      };
      return {
        seq: row.seq,
        linkOk: row.prev_hash === (i === 0 ? null : rows[i - 1]?.hash),
        hashOk: sha256(canonicalJson(entry)) === row.hash,
      };
    });
  };

  beforeAll(async () => {
    txn = await t.signUp(`cli-txn-${Date.now()}@example.com`);
    other = await t.signUp(`cli-txn-other-${Date.now()}@example.com`);
    txnWs = await t.workspaceWith([
      [txn, 'owner'],
      [other, 'viewer'],
    ]);
    // A second membership: the audit entry lands in one of them, and both chains must still verify.
    txnOtherWs = await t.workspaceWith([
      [txn, 'admin'],
      [other, 'admin'],
    ]);
  });

  it('leaves the password and the sessions alone when the session deletion fails', async () => {
    const before = await hashOf(txn.id);
    expect(before).not.toBeNull();
    await expect(
      resetPasswordForEmail(
        {
          db: t.srv.db,
          auth: t.srv.auth,
          revokeSessions: async () => {
            throw new Error('session store unavailable');
          },
        },
        txn.email,
        'a-rolled-back-password',
      ),
    ).rejects.toThrow('session store unavailable');
    expect(await hashOf(txn.id)).toBe(before);
    expect((await whoamiIn(txn.cookie)).status).toBe(200);
    expect((await signIn(txn.email, 'a-rolled-back-password')).status).toBe(401);
    expect(await audits()).toEqual([]);
  });

  // A failure injected *before* either write would pass without a transaction. This one fails
  // inside the credential write, after the session deletion has already run, so only a transaction
  // can put the sessions back.
  it('restores the sessions when the password write fails after they were deleted', async () => {
    const before = await hashOf(txn.id);
    await expect(
      resetPasswordForEmail(
        {
          db: t.srv.db,
          auth: t.srv.auth,
          writeCredential: async () => {
            throw new Error('credential store unavailable');
          },
        },
        txn.email,
        'a-rolled-back-password',
      ),
    ).rejects.toThrow('credential store unavailable');
    expect(await hashOf(txn.id)).toBe(before);
    // The default revocation really ran first; the rollback is what makes the old cookie work again.
    expect((await whoamiIn(txn.cookie)).status).toBe(200);
    expect((await signIn(txn.email, 'a-rolled-back-password')).status).toBe(401);
    expect(await audits()).toEqual([]);
  });

  it('covers the link-account branch, and a person who has no password account', async () => {
    const noCred = await t.signUp(`cli-nocred-${Date.now()}@example.com`);
    const ws = await t.workspaceWith([[noCred, 'owner']]);
    // A person with no credential account: an account provisioned through another provider.
    await t.srv.db.admin.query(`DELETE FROM "account" WHERE "userId" = $1 AND "providerId" = 'credential'`, [noCred.id]);
    const credentialRows = async () => {
      const { rows } = await t.srv.db.admin.query(`SELECT id FROM "account" WHERE "userId" = $1 AND "providerId" = 'credential'`, [
        noCred.id,
      ]);
      return rows.length;
    };
    expect(await credentialRows()).toBe(0);

    await expect(
      resetPasswordForEmail(
        {
          db: t.srv.db,
          auth: t.srv.auth,
          writeCredential: async () => {
            throw new Error('link failed');
          },
        },
        noCred.email,
        'a-linked-password',
      ),
    ).rejects.toThrow('link failed');
    expect(await credentialRows()).toBe(0);
    expect(
      (
        await fetch(`${t.base}/v1/whoami`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: t.base, cookie: noCred.cookie, 'x-workspace-id': ws },
          body: '{}',
        })
      ).status,
    ).toBe(200);

    // Without a failure the same person gets a credential account and can sign in with it.
    await resetPasswordForEmail({ db: t.srv.db, auth: t.srv.auth }, noCred.email, 'a-linked-password');
    expect(await credentialRows()).toBe(1);
    expect((await signIn(noCred.email, 'a-linked-password')).status).toBe(200);
  });

  it('commits the password, ends the old sessions and records the CLI audit entry', async () => {
    await resetPasswordForEmail({ db: t.srv.db, auth: t.srv.auth }, txn.email, 'a-committed-password');

    expect(await hashOf(txn.id)).not.toBeNull();
    expect((await whoamiIn(txn.cookie)).status).toBe(401);
    const signedIn = await signIn(txn.email, 'a-committed-password');
    expect(signedIn.status).toBe(200);
    txn = { ...txn, cookie: cookieOf(signedIn) };
    expect((await whoamiIn(txn.cookie)).status).toBe(200);

    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ surface: 'cli', principal_type: 'user', principal_id: txn.id, ok: true, ip: null });

    // The CLI reset writes no IP. The chain has to verify anyway: a hand-built entry that hashed
    // `ip: null` while verification omits it broke the chain after a reset (#913).
    for (const workspaceId of [txnWs, txnOtherWs]) {
      for (const row of await chainOk(workspaceId)) expect(row, workspaceId).toMatchObject({ linkOk: true, hashOk: true });
    }
  });
});
