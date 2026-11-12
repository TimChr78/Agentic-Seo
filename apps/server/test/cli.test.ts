import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDb } from '@agentic-seo/db';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_ROLE, freshDatabase } from './harness';

// The admin CLI: migrate, bootstrap (password on stdin), reset-password, doctor and version. It
// spawns the real CLI, so the same code path an operator runs in the image is exercised here.

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[], env: Record<string, string>, stdin?: string): Promise<CliResult> {
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
    // A non-TTY process reads one line from stdin.
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
  });
}

async function fresh(prefix: string, useTemplate = true) {
  const { url, dbName } = await freshDatabase(`aseo_${prefix}`, useTemplate);
  const env = {
    DATABASE_URL: url.toString(),
    APP_DB_ROLE: APP_ROLE.appRole,
    APP_DB_PASSWORD: APP_ROLE.appRolePassword,
    AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
    MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    PUBLIC_URL: 'http://localhost:3000',
  };
  return { url, dbName, env };
}

describe('aseo CLI', { timeout: 180_000 }, () => {
  it('prints the version without any configuration', async () => {
    const out = await cli(['version'], { DATABASE_URL: '', APP_DB_PASSWORD: '', AUTH_SECRET: '' });
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/^aseo \d+\.\d+\.\d+/);
  });

  it('migrates, bootstraps the first owner, resets a password and passes doctor', async () => {
    const { url, env } = await fresh('cli');
    const db = createDb({ adminUrl: url.toString(), appUrl: url.toString() });
    cleanups.push(() => db.close());

    const migrateRun = await cli(['migrate'], env);
    expect(migrateRun.code).toBe(0);
    expect(migrateRun.stdout).toContain('database is up to date');

    const doctor = await cli(['doctor', '--json'], env);
    expect(doctor.code).toBe(0);
    const checks = JSON.parse(doctor.stdout) as { id: string; status: string }[];
    expect(checks.find((check) => check.id === 'postgres')?.status).toBe('ok');
    expect(checks.find((check) => check.id === 'migrations')?.status).toBe('ok');

    const bootstrap = await cli(['bootstrap', '--email', 'you@example.com', '--workspace', 'CLI site'], env, 'a-long-password\n');
    expect(bootstrap.code).toBe(0);
    expect(bootstrap.stdout).toContain('created workspace "CLI site"');
    expect(bootstrap.stdout).not.toContain('correct-horse');

    const owner = await db.admin.query<{ email: string; role: string }>(
      `SELECT u.email, m.role FROM workspace_members m JOIN "user" u ON u.id = m.user_id WHERE u.email = 'you@example.com'`,
    );
    expect(owner.rows).toEqual([{ email: 'you@example.com', role: 'owner' }]);

    const reset = await cli(['reset-password', '--email', 'you@example.com'], { ...env, ASEO_RESET_PASSWORD: 'another-long-password' });
    expect(reset.code).toBe(0);
    expect(reset.stdout).toContain('password updated for you@example.com');
  });

  it('fails with one actionable line when the configuration is incomplete', async () => {
    const { env } = await fresh('cli_bad');
    const out = await cli(['migrate'], { ...env, AUTH_SECRET: '' });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('Configuration is incomplete: AUTH_SECRET is missing');
    expect(out.stderr).not.toContain('at loadConfig');
  });

  it('refuses to bootstrap without a password on a non-TTY stdin', async () => {
    const { env } = await fresh('cli_nopw');
    const out = await cli(['bootstrap', '--email', 'you@example.com', '--workspace', 'No password'], env);
    expect(out.code).not.toBe(0);
  });

  it('reports pending migrations as a warning before the schema is created', async () => {
    const { url, env } = await fresh('cli_empty', false);
    const db = createDb({ adminUrl: url.toString(), appUrl: url.toString() });
    cleanups.push(() => db.close());
    const doctor = await cli(['doctor', '--json'], env);
    const checks = JSON.parse(doctor.stdout) as { id: string; status: string; message: string }[];
    const migrations = checks.find((check) => check.id === 'migrations');
    expect(migrations?.status).toBe('warn');
    expect(migrations?.message).toContain('not migrated');
  });
});
