import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isMcpResourceUrlAllowed } from '@agentic-seo/auth';

// `aseo init`: write a .env from the template, with fresh secrets and the address of this install.
// It runs before the stack exists, so it reads and writes files only; never print a secret.

const TEMPLATE = new URL('../../../../.env.example', import.meta.url);
const GENERATED = ['POSTGRES_PASSWORD', 'APP_DB_PASSWORD', 'AUTH_SECRET', 'MASTER_KEY'] as const;

const USAGE = `usage: aseo init [--out PATH] [--force] [--public-url URL]

Writes .env from .env.example with fresh secrets. It never prints a secret.

  --out PATH          Where to write, relative to where you ran the command (default: .env).
  --force             Overwrite an existing file.
  --public-url URL    Address people and AI agents use (admin UI, REST and MCP).`;

function templateValue(template: string, key: string): string {
  for (const line of template.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match?.[1] === key) return match[2] as string;
  }
  throw new Error(`the .env.example template has no ${key}`);
}

function invalidUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'must start with http:// or https://';
    return null;
  } catch {
    return 'is not a valid URL';
  }
}

function render(template: string, values: Record<string, string>): string {
  const found = new Set<string>();
  const lines = template.split(/\r?\n/).map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (!match || !(match[1] in values)) return line;
    found.add(match[1] as string);
    return `${match[1]}=${values[match[1] as string]}`;
  });
  for (const key of Object.keys(values)) if (!found.has(key)) throw new Error(`the .env.example template has no ${key}`);
  return lines.join('\n');
}

function generatedValues(): Record<(typeof GENERATED)[number], string> {
  return {
    POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
    APP_DB_PASSWORD: randomBytes(24).toString('hex'),
    AUTH_SECRET: randomBytes(32).toString('base64'),
    MASTER_KEY: randomBytes(32).toString('base64'),
  };
}

async function askForUrl(label: string, fallback: string, required: boolean, question: (prompt: string) => Promise<string>) {
  for (;;) {
    const answer = (await question(`${label} [${fallback || 'empty'}]: `)).trim();
    const value = answer || fallback;
    if (!required && !value) return '';
    if (!value) {
      console.error(`${label} is required`);
      continue;
    }
    const problem = invalidUrl(value);
    if (problem) {
      console.error(`${label} ${problem}`);
      continue;
    }
    return value;
  }
}

export async function run(args: string[]): Promise<number> {
  let values: { out?: string; force?: boolean; help?: boolean; 'public-url'?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        out: { type: 'string' },
        force: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        'public-url': { type: 'string' },
      },
    }));
  } catch (err) {
    console.error(`aseo init: ${err instanceof Error ? err.message : String(err)}`);
    console.error(USAGE);
    return 1;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const cwd = process.env.INIT_CWD ?? process.cwd();
  const out = resolve(cwd, values.out ?? '.env');
  if (existsSync(out) && !values.force) {
    console.error(`${out} already exists; pass --force to overwrite it`);
    return 1;
  }

  try {
    const template = await readFile(fileURLToPath(TEMPLATE), 'utf8');
    const examplePublicUrl = templateValue(template, 'PUBLIC_URL');

    let publicUrl = values['public-url'];
    if (publicUrl === undefined) {
      if (process.stdin.isTTY === true) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          publicUrl = await askForUrl('PUBLIC_URL', examplePublicUrl, true, (prompt) => rl.question(prompt));
        } finally {
          rl.close();
        }
      } else {
        publicUrl = examplePublicUrl;
        console.warn(`PUBLIC_URL was not provided; keeping the example value ${examplePublicUrl}`);
      }
    }

    const publicProblem = invalidUrl(publicUrl);
    if (publicProblem) {
      console.error(`PUBLIC_URL ${publicProblem}`);
      return 1;
    }
    if (!isMcpResourceUrlAllowed(publicUrl))
      console.warn('warning: PUBLIC_URL is not HTTPS and not loopback; MCP will be off. Use HTTPS to enable it.');

    const secrets = generatedValues();
    const rendered = render(template, { ...secrets, PUBLIC_URL: publicUrl });
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, rendered, { mode: 0o600 });
    await chmod(out, 0o600);

    console.log(`wrote ${out}`);
    console.log(`generated: ${GENERATED.join(', ')}`);
    console.log('next:');
    console.log('  docker compose up -d');
    console.log("  docker compose exec app aseo bootstrap --email you@example.com --workspace 'My workspace'");
    console.log('  docker compose exec app aseo doctor');
    return 0;
  } catch (err) {
    console.error(`aseo init: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
