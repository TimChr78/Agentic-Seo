import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, startTestServer, testDatabaseUrl, testPort, type User } from './harness';

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
