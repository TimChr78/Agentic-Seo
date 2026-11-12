import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { migrateAuth } from '@agentic-seo/auth';
import { newUuid } from '@agentic-seo/core';
import { createDb, migrate } from '@agentic-seo/db';
import { rewrapDataKeys } from '@agentic-seo/secrets';
import { createServer } from './app';
import { resolvePassword } from './cli-password';
import { ConfigError, loadConfig } from './config';
import { keyProviderFor } from './keys';
import { COMMIT, VERSION } from './version';

// Admin CLI.
//   pnpm cli migrate
//   pnpm cli bootstrap --email you@example.com --workspace 'My site'
//   pnpm cli reset-password --email you@example.com
//   pnpm cli rotate-keys    (after setting a new MASTER_KEY and the old one in MASTER_KEY_PREVIOUS, or a new KEY_PROVIDER)
//   pnpm cli init | doctor
// Passwords come from ASEO_BOOTSTRAP_PASSWORD / ASEO_RESET_PASSWORD, a hidden terminal prompt, or
// stdin (bootstrap also still accepts --password, with a deprecation warning).

const GENERAL_USAGE = `usage: aseo <command> [options]

Commands:
  init            write a .env with fresh secrets and your public URL
  doctor          check the configuration, Postgres and migrations without changing anything
  migrate         apply database migrations
  bootstrap       create the first user and workspace
  reset-password  set a new password for a user
  rotate-keys     re-wrap stored secrets after changing the key provider
  version         print the version and commit

Run \`aseo <command> --help\` for a command's options.`;

const ADMIN_USAGE: Record<string, string> = {
  migrate: `usage: aseo migrate

Applies database migrations and exits. The app does this at start-up unless SKIP_MIGRATIONS=true.`,
  bootstrap: `usage: aseo bootstrap --email EMAIL --workspace NAME [--name NAME] [--password PASSWORD]

Creates the first user and a workspace, with the user as its owner.
The password comes from ASEO_BOOTSTRAP_PASSWORD, a hidden terminal prompt, or stdin.`,
  'reset-password': `usage: aseo reset-password --email EMAIL [--password PASSWORD]

Sets a new password for an existing user.
The password comes from ASEO_RESET_PASSWORD, a hidden terminal prompt, or stdin.`,
  'rotate-keys': `usage: aseo rotate-keys

Re-wraps every stored data key with the current key provider or MASTER_KEY.
Set the new key first and keep the old one in MASTER_KEY_PREVIOUS.`,
};

// Operations run before (or without) migrating: `init` before there is a .env, `doctor` to check
// an install. Each module loads only what it needs.
const operations: Record<string, () => Promise<{ run: (args: string[]) => Promise<number> }>> = {
  init: () => import('./ops/init'),
  doctor: () => import('./ops/doctor'),
};

const wantsHelp = (args: string[]) => args.includes('--help') || args.includes('-h');

async function operationHelp(command: string): Promise<boolean> {
  if (!Object.hasOwn(operations, command)) return false;
  const operation = await operations[command]();
  return (await operation.run(['--help'])) === 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  // `pnpm cli -- doctor` passes the separator through; Node's own `--` puts it there too.
  if (argv[0] === '--') argv.shift();
  const [command, ...rest] = argv;

  // Help and version need no configuration and no .env: they are what a broken install has left.
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    const target = command === 'help' ? rest[0] : undefined;
    if (!target) {
      console.log(GENERAL_USAGE);
      return 0;
    }
    if (target in ADMIN_USAGE) {
      console.log(ADMIN_USAGE[target]);
      return 0;
    }
    if (await operationHelp(target)) return 0;
    console.error(`aseo: unknown command "${target}"`);
    console.log(GENERAL_USAGE);
    return 1;
  }
  if (command === 'version' || command === '--version' || command === '-V') {
    console.log(`aseo ${VERSION}${COMMIT ? ` (${COMMIT})` : ''}`);
    return 0;
  }
  if (!Object.hasOwn(operations, command) && !Object.hasOwn(ADMIN_USAGE, command)) {
    console.error(`aseo: unknown command "${command}"`);
    console.log(GENERAL_USAGE);
    return 1;
  }

  // An operation's own --help: skip loading .env so a broken environment cannot get in the way.
  if (Object.hasOwn(operations, command) && wantsHelp(rest)) {
    const operation = await operations[command]();
    return operation.run(rest);
  }
  if (Object.hasOwn(ADMIN_USAGE, command) && wantsHelp(rest)) {
    console.log(ADMIN_USAGE[command]);
    return 0;
  }

  try {
    return await dispatch(command, rest);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
}

async function dispatch(command: string, rest: string[]): Promise<number> {
  // Local runs load the checkout's .env; pnpm leaves INIT_CWD at the directory the user ran from,
  // so `pnpm cli` and `aseo` inside the image both work. `init` writes that file and must not fail
  // on a broken one that it is about to replace.
  if (command !== 'init') {
    const envFile = resolve(process.env.INIT_CWD ?? process.cwd(), '.env');
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  }

  if (Object.hasOwn(operations, command)) {
    const operation = await operations[command]();
    return operation.run(rest);
  }

  await admin(command, rest);
  return 0;
}

async function admin(command: string, rest: string[]) {
  const config = loadConfig();

  if (command === 'migrate') {
    await migrateOnly(config);
    console.log('database is up to date');
    return;
  }
  if (command === 'rotate-keys') {
    await migrateOnly(config);
    const db = createDb({ adminUrl: config.adminDatabaseUrl, appUrl: config.appDatabaseUrl });
    try {
      const { rewrapped } = await rewrapDataKeys(db.admin, keyProviderFor(config));
      console.log(`re-wrapped ${rewrapped} data key(s) with ${keyProviderFor(config).id}`);
      if (config.keys.provider !== 'local' && config.masterKey)
        console.log(`every data key now uses ${config.keys.provider}; you can remove MASTER_KEY and MASTER_KEY_PREVIOUS`);
      else if (config.previousMasterKeys.length)
        console.log('every data key now uses the current master key; you can remove MASTER_KEY_PREVIOUS');
    } finally {
      await db.close();
    }
    return;
  }

  await migrateOnly(config);
  const { db, auth, ready } = createServer(config);
  try {
    await ready;
    if (command === 'bootstrap') {
      const { values } = parseArgs({
        args: rest,
        options: { email: { type: 'string' }, password: { type: 'string' }, name: { type: 'string' }, workspace: { type: 'string' } },
      });
      if (!values.email || !values.workspace) throw new Error('bootstrap needs --email and --workspace');
      const password = await resolvePassword({
        command: 'bootstrap',
        envVar: 'ASEO_BOOTSTRAP_PASSWORD',
        passwordFlag: values.password,
      });
      const { user } = await auth.api.signUpEmail({
        body: { email: values.email, password, name: values.name ?? values.email },
      });
      const workspaceId = newUuid();
      await db.admin.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [workspaceId, values.workspace]);
      await db.admin.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [workspaceId, user.id]);
      console.log(`created workspace "${values.workspace}" (${workspaceId}) with owner ${values.email}`);
    } else if (command === 'reset-password') {
      const { values } = parseArgs({ args: rest, options: { email: { type: 'string' }, password: { type: 'string' } } });
      if (!values.email) throw new Error('reset-password needs --email');
      const password = await resolvePassword({
        command: 'reset-password',
        envVar: 'ASEO_RESET_PASSWORD',
        passwordFlag: values.password,
      });
      const context = await auth.$context;
      const found = await context.internalAdapter.findUserByEmail(values.email, { includeAccounts: true });
      if (!found) throw new Error(`reset-password: no user with email ${values.email}`);
      const hashed = await context.password.hash(password);
      const credential = found.accounts.find((account) => account.providerId === 'credential');
      if (credential) await context.internalAdapter.updateAccount(credential.id, { password: hashed });
      else
        await context.internalAdapter.linkAccount({
          userId: found.user.id,
          providerId: 'credential',
          accountId: found.user.id,
          password: hashed,
        });
      console.log(`password updated for ${values.email}`);
    }
  } finally {
    await db.close();
  }
}

/**
 * Migrate before the auth instance exists: Better Auth validates its schema when it is created
 * and caches a mismatch, so a fresh database would fail every auth request.
 */
async function migrateOnly(config: ReturnType<typeof loadConfig>) {
  const boot = createDb({ adminUrl: config.adminDatabaseUrl, appUrl: config.appDatabaseUrl });
  try {
    await migrate(boot.admin, { appRolePassword: config.appDbPassword, appRole: config.appDbRole, log: console.log });
    await migrateAuth({ baseUrl: config.publicUrl, secret: config.authSecret, db: boot });
  } finally {
    await boot.close();
  }
}

process.exitCode = await main();
