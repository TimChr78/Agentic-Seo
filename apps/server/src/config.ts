import { fileURLToPath } from 'node:url';
import { isIpOrCidr } from '@agentic-seo/core';
import { z } from 'zod';

// The runtime roles a process can take. `ROLE` is a comma-separated list of these; any other value
// is a start-up error, because a process that matches no role branch would start and then serve
// nothing.
const Role = z.enum(['api', 'worker', 'scheduler']);
const ROLES_HELP = `Comma-separated roles: ${Role.options.join(', ')}, or all`;

// All configuration comes from the environment and is validated at start-up, so a missing or
// malformed setting fails fast with a clear message instead of at the first request.
const Env = z.object({
  SKIP_MIGRATIONS: z
    .enum(['true', 'false'])
    .default('false')
    .describe('Start without migrating (Kubernetes: a migration job runs before each upgrade)'),
  STRICT_INPUTS: z
    .enum(['true', 'false'])
    .default('false')
    .describe('Reject unknown command input keys instead of accepting them with a warning (roll it out before flipping this)'),
  MCP_TEXT_CONTENT: z
    .enum(['json', 'summary'])
    .default('json')
    .describe('Text block of an MCP tool result: the full result as JSON, or a one-line summary (structuredContent is always complete)'),
  MCP_TOOL_NAME_STYLE: z
    .enum(['dotted', 'underscore'])
    .default('dotted')
    .describe('MCP tool names: command names such as sites.list, or underscore names such as sites_list'),
  ROLE: z
    .string()
    .default('all')
    .describe(ROLES_HELP)
    .superRefine((value, ctx) => {
      if (value.trim() === 'all') return;
      for (const entry of value.split(',').map((part) => part.trim())) {
        if (!Role.safeParse(entry).success) {
          ctx.addIssue({
            code: 'custom',
            message: `ROLE has unknown role "${entry}"; use ${Role.options.join(', ')}, or all`,
          });
        }
      }
    }),
  PORT: z.coerce.number().int().default(3000),
  WEB_DIST: z
    .string()
    .optional()
    .describe('Directory with the built admin UI; default: apps/web/dist in the repo, which is also where the image puts it'),
  PUBLIC_URL: z.url().optional(),
  CLIENT_IP_HEADER: z
    .string()
    .default('x-forwarded-for')
    .describe(
      'Headers carrying the client IP, in trust order and comma-separated, e.g. cf-connecting-ip,x-forwarded-for for public traffic through a Cloudflare Tunnel plus LAN/VPN sign-ins; the first header present is used, and a multi-value header is read right to left past trusted proxies',
    ),
  TRUSTED_PROXY_CIDRS: z
    .string()
    .default('')
    .refine(
      (value) =>
        value
          .split(',')
          .map((entry) => entry.trim())
          .every((entry) => !entry || isIpOrCidr(entry)),
      'TRUSTED_PROXY_CIDRS must be a comma-separated list of IP addresses or CIDR ranges',
    )
    .describe(
      'Comma-separated proxy/loopback ranges whose forwarding headers are trusted, e.g. 127.0.0.1/32,::1/128,10.0.0.0/8; empty ignores forwarding headers and uses the socket address',
    ),
  DATABASE_URL: z.string().describe('Owner/admin connection, used for migrations and auth tables'),
  APP_DB_ROLE: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/)
    .default('aseo_app')
    .describe('Name of the row-level-security role; separate installs on one Postgres server need different names'),
  APP_DB_PASSWORD: z.string().min(8).describe('Password for the aseo_app role the command layer uses (row-level security applies)'),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters (e.g. `openssl rand -base64 32`)'),
  KEY_PROVIDER: z
    .enum(['local', 'openbao', 'aws-kms'])
    .default('local')
    .describe('Where the key-encryption key lives: MASTER_KEY (local), OpenBao/Vault Transit, or AWS KMS'),
  MASTER_KEY: z
    .string()
    .optional()
    .describe(
      'Base64 32-byte key-encryption key for secrets (`openssl rand -base64 32`); with another KEY_PROVIDER, the key to migrate from',
    ),
  MASTER_KEY_PREVIOUS: z
    .string()
    .optional()
    .describe('Comma-separated previous master keys, kept only while `aseo rotate-keys` re-wraps data keys'),
  OPENBAO_ADDR: z.url().optional().describe('OpenBao or Vault address, e.g. https://bao.internal:8200'),
  OPENBAO_TOKEN: z.string().optional(),
  OPENBAO_TOKEN_FILE: z.string().optional().describe('File with the token (agent sidecar, Kubernetes secret); re-read when rejected'),
  OPENBAO_TRANSIT_MOUNT: z.string().default('transit'),
  OPENBAO_TRANSIT_KEY: z.string().default('agentic-seo'),
  OPENBAO_NAMESPACE: z.string().optional(),
  AWS_KMS_KEY_ID: z.string().optional().describe('Key id, ARN or alias of a symmetric KMS key'),
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_SESSION_TOKEN: z.string().optional(),
  AWS_KMS_ENDPOINT: z.url().optional().describe('A VPC endpoint or a test server instead of kms.<region>.amazonaws.com'),
  TRUSTED_ORIGINS: z.string().optional().describe('Comma-separated extra origins allowed to call auth endpoints'),
  METRICS_TOKEN: z
    .string()
    .min(16, 'METRICS_TOKEN must be at least 16 characters (e.g. `openssl rand -hex 24`)')
    .optional()
    .describe('Bearer token for GET /metrics on the main listener; unset disables the endpoint, which then answers 404'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(5).describe('Graphile Worker jobs a worker process runs at once'),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(2000).describe('How often a worker checks for due jobs'),
  JOB_TICK_MS: z.coerce.number().int().min(250).default(60_000).describe('How often the scheduler enqueues recurring jobs'),
});

/** Every key the server understands, for tooling such as `aseo doctor --env-file`. */
export const ENV_KEYS = Object.keys(Env.shape);

/** Keys without a default and not optional: the ones a fresh install has to provide. */
export const REQUIRED_ENV_KEYS = Object.entries(Env.shape)
  .filter(([, schema]) => !schema.isOptional())
  .map(([key]) => key);

/**
 * A configuration problem an operator can act on. Callers print the message without a stack
 * trace: the stack points at loadConfig, not at anything they can fix.
 */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Parse DATABASE_URL and turn a malformed one into a ConfigError with the likely cause. Docker
 * Compose interpolates POSTGRES_PASSWORD into DATABASE_URL raw and cannot percent-encode it, so a
 * base64 password containing `/` makes the URL unparseable; a raw TypeError from `new URL()` would
 * escape the ConfigError path in main.ts and print a stack instead of the fix.
 */
function databaseUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new ConfigError(
      'Configuration is incomplete: DATABASE_URL is not a valid URL. A password with a reserved character ' +
        '(`/`, `?` or `#`) must be percent-encoded in the URL (`/` as `%2F`) — Docker Compose cannot encode ' +
        'the POSTGRES_PASSWORD it interpolates — or the password must be hex, which needs no encoding: ' +
        'generate it with `openssl rand -hex 32` instead of `openssl rand -base64 32`.',
    );
  }
}

/** Turn a zod issue into one short phrase, using the names the operator sees in .env. */
function issueText(issue: z.core.$ZodIssue): string {
  const key = issue.path.map(String).join('.') || 'configuration';
  // Messages written next to the schema (AUTH_SECRET's, TRUSTED_PROXY_CIDRS') already read well.
  if (issue.message.startsWith(`${key} `)) return issue.message;
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined ? `${key} is missing` : `${key} is invalid`;
    case 'too_small':
      return issue.origin === 'string' ? `${key} must be at least ${issue.minimum} characters` : `${key} must be at least ${issue.minimum}`;
    case 'too_big':
      return issue.origin === 'string' ? `${key} must be at most ${issue.maximum} characters` : `${key} must be at most ${issue.maximum}`;
    case 'invalid_format':
      return issue.format === 'url' ? `${key} must be a valid URL` : `${key} has an invalid format`;
    case 'invalid_value':
      return `${key} must be one of ${issue.values.map(String).join(', ')}`;
    default:
      return `${key}: ${issue.message}`;
  }
}

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  // docker compose passes unset variables as empty strings: treat them as not set.
  const parsed = Env.safeParse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')));
  if (!parsed.success) {
    throw new ConfigError(`Configuration is incomplete: ${parsed.error.issues.map(issueText).join(', ')}`);
  }
  const e = parsed.data;
  const missing = (names: string[]) => names.filter((n) => !e[n as keyof typeof e]);
  const needed =
    e.KEY_PROVIDER === 'local'
      ? missing(['MASTER_KEY'])
      : e.KEY_PROVIDER === 'openbao'
        ? [...missing(['OPENBAO_ADDR']), ...(e.OPENBAO_TOKEN || e.OPENBAO_TOKEN_FILE ? [] : ['OPENBAO_TOKEN or OPENBAO_TOKEN_FILE'])]
        : missing(['AWS_KMS_KEY_ID', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
  if (needed.length) throw new ConfigError(`Configuration is incomplete: KEY_PROVIDER=${e.KEY_PROVIDER} needs ${needed.join(', ')}`);
  const appUrl = databaseUrl(e.DATABASE_URL);
  appUrl.username = e.APP_DB_ROLE;
  appUrl.password = e.APP_DB_PASSWORD;
  const clientIpHeaders = [
    ...new Set(
      e.CLIENT_IP_HEADER.split(',')
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  // The schema above rejects any role outside the enum, so this only turns the string into a set.
  const roles = e.ROLE.trim() === 'all' ? [...Role.options] : e.ROLE.split(',').map((role) => Role.parse(role.trim()));
  return {
    roles: new Set(roles),
    port: e.PORT,
    // Resolved from this file, never from the working directory: `pnpm start` and the image both
    // run from /app, where the built UI sits next to the server.
    webDist: e.WEB_DIST ?? fileURLToPath(new URL('../../../apps/web/dist', import.meta.url)),
    skipMigrations: e.SKIP_MIGRATIONS === 'true',
    strictInputs: e.STRICT_INPUTS === 'true',
    mcpTextContent: e.MCP_TEXT_CONTENT,
    mcpToolNameStyle: e.MCP_TOOL_NAME_STYLE,
    publicUrl: (e.PUBLIC_URL ?? `http://localhost:${e.PORT}`).replace(/\/$/, ''),
    clientIpHeaders: clientIpHeaders.length ? clientIpHeaders : ['x-forwarded-for'],
    clientIpHeader: clientIpHeaders[0] ?? 'x-forwarded-for',
    trustedProxyCidrs: e.TRUSTED_PROXY_CIDRS.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    adminDatabaseUrl: e.DATABASE_URL,
    appDatabaseUrl: appUrl.toString(),
    appDbPassword: e.APP_DB_PASSWORD,
    appDbRole: e.APP_DB_ROLE,
    authSecret: e.AUTH_SECRET,
    masterKey: e.MASTER_KEY,
    keys: {
      provider: e.KEY_PROVIDER,
      openbao: {
        addr: e.OPENBAO_ADDR ?? '',
        token: e.OPENBAO_TOKEN,
        tokenFile: e.OPENBAO_TOKEN_FILE,
        mount: e.OPENBAO_TRANSIT_MOUNT,
        key: e.OPENBAO_TRANSIT_KEY,
        namespace: e.OPENBAO_NAMESPACE,
      },
      awsKms: {
        keyId: e.AWS_KMS_KEY_ID ?? '',
        region: e.AWS_REGION ?? '',
        accessKeyId: e.AWS_ACCESS_KEY_ID ?? '',
        secretAccessKey: e.AWS_SECRET_ACCESS_KEY ?? '',
        sessionToken: e.AWS_SESSION_TOKEN,
        endpoint: e.AWS_KMS_ENDPOINT,
      },
    },
    previousMasterKeys:
      e.MASTER_KEY_PREVIOUS?.split(',')
        .map((k) => k.trim())
        .filter(Boolean) ?? [],
    trustedOrigins: e.TRUSTED_ORIGINS?.split(',').map((o) => o.trim()) ?? [],
    metricsToken: e.METRICS_TOKEN,
    worker: {
      concurrency: e.WORKER_CONCURRENCY,
      pollIntervalMs: e.WORKER_POLL_INTERVAL_MS,
      tickMs: e.JOB_TICK_MS,
    },
  };
}
