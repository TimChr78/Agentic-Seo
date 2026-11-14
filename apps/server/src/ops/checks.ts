import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMcpResourceUrlAllowed } from '@agentic-seo/auth';
import { createDb } from '@agentic-seo/db';
import { type Config, ConfigError, loadConfig } from '../config';

// Checks for `aseo doctor`. Offline checks need only the environment; live checks run only when
// the configuration parses, and every network operation has a short timeout so a broken service
// cannot make the command hang.

export interface Check {
  id: string;
  status: 'ok' | 'warn' | 'info' | 'fail';
  message: string;
  hint?: string;
}

/** Every key a new `.env` should carry; `doctor --env-file` compares a file with the template. */
export const ENV_TEMPLATE = fileURLToPath(new URL('../../../../.env.example', import.meta.url));

/** Read KEY=VALUE pairs from an env file, ignoring comments and blank lines. */
export function envFileValues(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) values[match[1] as string] = (match[2] as string).replace(/^['"]|['"]$/g, '');
  }
  return values;
}

/** Base64 for exactly 32 bytes: the shape MASTER_KEY and AUTH_SECRET are generated in. */
function masterKeyBytes(value: string): number | null {
  try {
    const decoded = Buffer.from(value, 'base64');
    // Buffer.from is lenient; re-encoding catches a non-canonical string.
    return decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '') ? 32 : null;
  } catch {
    return null;
  }
}

const isPlaceholder = (value: string) => /^(change-me|changeme|secret|password|test)+$/i.test(value);

/** The checks that need only the environment. They always run. */
export function offlineChecks(env: NodeJS.ProcessEnv): Check[] {
  const checks: Check[] = [];
  const authSecret = env.AUTH_SECRET?.trim() ?? '';
  checks.push(
    !authSecret || authSecret.length < 32 || isPlaceholder(authSecret)
      ? {
          id: 'secrets.auth-secret',
          status: 'fail',
          message: !authSecret ? 'AUTH_SECRET is not set' : 'AUTH_SECRET is shorter than 32 characters or a placeholder',
          hint: 'Generate one with `openssl rand -base64 32`. Changing it signs everyone out.',
        }
      : { id: 'secrets.auth-secret', status: 'ok', message: 'AUTH_SECRET is set and long enough' },
  );

  const provider = env.KEY_PROVIDER?.trim() || 'local';
  if (provider === 'local') {
    const masterKey = env.MASTER_KEY?.trim() ?? '';
    checks.push(
      masterKeyBytes(masterKey) === 32
        ? { id: 'secrets.master-key', status: 'ok', message: 'MASTER_KEY is base64 for 32 bytes' }
        : {
            id: 'secrets.master-key',
            status: 'fail',
            message: !masterKey ? 'MASTER_KEY is not set' : 'MASTER_KEY is not base64 for exactly 32 bytes',
            hint: 'Generate one with `openssl rand -base64 32`, or use KEY_PROVIDER=openbao or aws-kms.',
          },
    );
  } else {
    checks.push({ id: 'secrets.master-key', status: 'ok', message: `MASTER_KEY is not required with KEY_PROVIDER=${provider}` });
  }

  const appPassword = env.APP_DB_PASSWORD?.trim() ?? '';
  checks.push(
    appPassword.length >= 8 && !isPlaceholder(appPassword)
      ? { id: 'secrets.app-db-password', status: 'ok', message: 'APP_DB_PASSWORD is set' }
      : {
          id: 'secrets.app-db-password',
          status: 'fail',
          message: !appPassword ? 'APP_DB_PASSWORD is not set' : 'APP_DB_PASSWORD is shorter than 8 characters or a placeholder',
          hint: 'Generate one with `openssl rand -hex 24`.',
        },
  );

  const publicUrl = env.PUBLIC_URL?.trim() ?? '';
  let url: URL | undefined;
  try {
    url = publicUrl ? new URL(publicUrl) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    checks.push({
      id: 'public-url',
      status: publicUrl ? 'fail' : 'warn',
      message: publicUrl ? 'PUBLIC_URL is not a valid http(s) URL' : 'PUBLIC_URL is not set; localhost is assumed',
      hint: 'Set PUBLIC_URL to the address people and AI agents use, e.g. https://seo.example.com.',
    });
  } else if (isMcpResourceUrlAllowed(publicUrl)) {
    checks.push({ id: 'public-url', status: 'ok', message: 'PUBLIC_URL is usable for MCP and sign-in' });
  } else {
    checks.push({
      id: 'public-url',
      status: 'warn',
      message: 'PUBLIC_URL is plain HTTP on a non-loopback host, so MCP/OAuth is disabled',
      hint: 'Use HTTPS (a Cloudflare Tunnel, Tailscale or a reverse proxy) to enable MCP.',
    });
  }

  checks.push(
    env.TRUSTED_PROXY_CIDRS?.trim()
      ? { id: 'trusted-proxy-cidrs', status: 'ok', message: 'TRUSTED_PROXY_CIDRS is set' }
      : {
          id: 'trusted-proxy-cidrs',
          status: 'warn',
          message: 'TRUSTED_PROXY_CIDRS is empty, so forwarding headers are ignored',
          hint: 'List the proxy and loopback ranges, e.g. 127.0.0.1/32,::1/128,10.0.0.0/8.',
        },
  );
  return checks;
}

/** The configuration check, and the parsed configuration for the live checks. */
export function checkConfig(env: NodeJS.ProcessEnv): { check: Check; config?: Config } {
  try {
    const config = loadConfig(env);
    return { check: { id: 'config', status: 'ok', message: 'the configuration is valid' }, config };
  } catch (err) {
    if (err instanceof ConfigError) return { check: { id: 'config', status: 'fail', message: err.message } };
    return { check: { id: 'config', status: 'fail', message: err instanceof Error ? err.message : String(err) } };
  }
}

const TIMEOUT_MS = 3000;

async function within<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The checks that need a running Postgres, gated behind a valid configuration. */
export async function liveChecks(config: Config): Promise<Check[]> {
  const checks: Check[] = [];
  const db = createDb({ adminUrl: config.adminDatabaseUrl, appUrl: config.appDatabaseUrl, connectionTimeoutMillis: TIMEOUT_MS });
  try {
    try {
      await within(db.admin.query('SELECT 1'), 'Postgres');
      checks.push({ id: 'postgres', status: 'ok', message: 'Postgres answered' });
    } catch (err) {
      checks.push({
        id: 'postgres',
        status: 'fail',
        message: `cannot reach the database: ${err instanceof Error ? err.message : String(err)}`,
        hint: 'Start Postgres and check DATABASE_URL, the user and the password.',
      });
      return checks;
    }

    try {
      const present = await db.admin.query<{ present: boolean }>("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present");
      if (!present.rows[0]?.present) {
        checks.push({
          id: 'migrations',
          status: 'warn',
          message: 'the schema is not migrated yet',
          hint: 'Start the app or run `aseo migrate`.',
        });
      } else {
        const applied = new Set(
          (await db.admin.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((row) => row.version),
        );
        const pending = readdirSync(fileURLToPath(new URL('../../../../packages/db/migrations', import.meta.url)))
          .filter((name) => name.endsWith('.sql'))
          .filter((name) => !applied.has(name));
        checks.push(
          pending.length
            ? {
                id: 'migrations',
                status: 'warn',
                message: `${pending.length} migration(s) pending: ${pending.join(', ')}`,
                hint: 'Start the app or run `aseo migrate`.',
              }
            : { id: 'migrations', status: 'ok', message: 'every migration is applied' },
        );
      }
    } catch (err) {
      checks.push({
        id: 'migrations',
        status: 'warn',
        message: `could not read the migration head: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } finally {
    await db.close();
  }
  return checks;
}
