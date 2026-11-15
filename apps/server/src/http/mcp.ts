import { type Auth, principalFromAccessToken, principalFromApiToken, TOKEN_PREFIX, workspaceHeaderConflict } from '@agentic-seo/auth';
import { type AnyCommand, type Executor, type Principal, ROLE_PERMISSIONS } from '@agentic-seo/commands';
import { AppError } from '@agentic-seo/core';
import type { Db } from '@agentic-seo/db';
import { requireMcpAuth } from '@better-auth/mcp';
import { type AuthInfo, createMcpHandler, McpServer, ResourceTemplate, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { commands } from '../registry';
import { VERSION } from '../version';
import { auditAndProposePrompt, MCP_GUIDE_URI, MCP_INSTRUCTIONS } from './mcpInstructions';

// MCP surface (spec 2026-07-28, SDK v2): a stateless server per request for the authenticated
// principal. Each command the principal may run becomes a tool; humans-only commands are not
// listed. With `stepUp` (OAuth clients), tools the person's role allows but the client was not
// granted are listed too: calling one answers 403 insufficient_scope, so the client can ask the
// person for that scope and retry.

export type McpTextContent = 'json' | 'summary';
export type McpToolNameStyle = 'dotted' | 'underscore';

// JSON-RPC calls carry tool arguments and a short prompt; 1 MB is far above any real call and
// bounds the endpoint before the OAuth/API-token handling reads the request.
export const MCP_MAX_BODY = 1024 * 1024;

/** Tool names are command names by default; some clients only accept letters, digits and underscores. */
export function mcpToolName(commandName: string, style: McpToolNameStyle): string {
  return style === 'underscore' ? commandName.replaceAll('.', '_') : commandName;
}

/** The command behind a tool name, for calls and scope challenges. */
export function commandForMcpTool(toolName: string, style: McpToolNameStyle): AnyCommand | undefined {
  return commands.find((c) => (style === 'underscore' ? mcpToolName(c.name, style) : c.name) === toolName);
}

/**
 * The SDK validates arguments with the input schema and passes only the parsed value on, which
 * would strip unknown keys before the executor can reject or report them. Keep the JSON Schema
 * (so tools/list still advertises the command input) but hand the raw arguments to the executor,
 * which is the single place that parses and reports unknown input keys.
 */
export function mcpInputSchema(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  const standard = schema['~standard'];
  return {
    '~standard': {
      version: standard.version,
      vendor: standard.vendor,
      jsonSchema: standard.jsonSchema,
      validate: (value: unknown) => ({ value }),
    },
  };
}

/**
 * Commands validate their own output, but the executor may add top-level `warnings` for unknown
 * input keys. The SDK validates structuredContent against the advertised output schema, so allow
 * that optional field.
 */
export function mcpOutputSchema(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  if (schema instanceof z.ZodObject && !('warnings' in schema.shape)) {
    return schema.extend({ warnings: z.array(z.string()).optional() }) as unknown as StandardSchemaWithJSON;
  }
  return schema;
}

/** One-line text for `MCP_TEXT_CONTENT=summary`; structuredContent still carries the full result. */
export function summarizeOutput(commandName: string, output: unknown): string {
  const parts: string[] = [];
  if (Array.isArray(output)) {
    parts.push(`${output.length} items`);
  } else if (output && typeof output === 'object') {
    for (const [key, value] of Object.entries(output)) {
      if (Array.isArray(value)) parts.push(`${value.length} ${key}`);
      else if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) parts.push(`${key}=${String(value)}`);
    }
  }
  const summary = `${commandName}: ${parts.length ? parts.join(', ') : 'ok'}`;
  return summary.length > 300 ? `${summary.slice(0, 297)}...` : summary;
}

/** The permission a tool call needs that the principal's role has but the client was not granted. */
export function missingScope(principal: Principal, toolName: string, style: McpToolNameStyle = 'dotted') {
  const cmd = commandForMcpTool(toolName, style);
  if (!cmd?.permission || cmd.humansOnly || principal.permissions.has(cmd.permission)) return null;
  return ROLE_PERMISSIONS[principal.role].includes(cmd.permission) ? cmd.permission : null;
}

/**
 * The command a resource or prompt runs. A resource never reads SQL itself: it goes through the
 * command layer for the same validation, permission check and tenancy every tool call gets.
 */
function commandNamed(name: string): AnyCommand {
  const cmd = commands.find((c) => c.name === name);
  if (!cmd) throw new Error(`the MCP surface needs the ${name} command`);
  return cmd;
}

/** Whether the principal may run every command a template needs; otherwise the template is hidden. */
function mayRunAll(principal: Principal, names: readonly string[]): boolean {
  return names.every((name) => {
    const cmd = commandNamed(name);
    return cmd.permission !== null && principal.permissions.has(cmd.permission);
  });
}

/**
 * One template's read: a site id from the URI, resolved through commands only. `site-context` shows
 * the *published* site context, because that is the version every other read and the copilot see;
 * a draft is not yet the site's context.
 */
async function readSiteContext(principal: Principal, executor: Executor, siteId: string) {
  if (!siteId) throw new AppError('invalid_input', 'The URI needs a site id, e.g. site-context://<siteId>.');
  const site = await executor.execute(commandNamed('sites.get'), { siteId }, principal, { surface: 'mcp' });
  const artifactId = site.site.contextArtifactId as string | null;
  if (!artifactId)
    throw new AppError(
      'not_found',
      `Site ${siteId} has no site context artifact yet. A person drafts one with artifacts.create (type site_context) and publishes it.`,
    );
  const latest = await executor.execute(commandNamed('artifacts.get'), { artifactId }, principal, { surface: 'mcp' });
  if (latest.publishedVersion === null)
    throw new AppError('not_found', `The site context for site ${siteId} is not published yet, so there is nothing to read.`);
  const published = await executor.execute(commandNamed('artifacts.get'), { artifactId, version: latest.publishedVersion }, principal, {
    surface: 'mcp',
  });
  return { siteId, artifactId, version: latest.publishedVersion, content: published.version.content };
}

export function mcpServerFor(
  principal: Principal,
  executor: Executor,
  opts: { stepUp?: boolean; textContent?: McpTextContent; toolNameStyle?: McpToolNameStyle } = {},
) {
  const style = opts.toolNameStyle ?? 'dotted';
  const server = new McpServer({ name: 'agentic-seo', version: VERSION }, { instructions: MCP_INSTRUCTIONS });
  server.registerResource(
    'guide',
    MCP_GUIDE_URI,
    {
      title: 'Agent guide',
      description: 'How to read the workspace, what an agent may do, and how to ask a person for more.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({ contents: [{ uri: uri.href, text: MCP_INSTRUCTIONS, mimeType: 'text/markdown' }] }),
  );
  // Resources are context a client reads before it acts, so they are not tools. Each is backed by
  // one command (or, for a site, a short chain of them), and a principal without the command's
  // permission does not see it at all. The catalogue resources are static; the two site resources
  // are templates so one registration serves every site the connection can reach.
  const resources: { name: string; uri: string; title: string; description: string; command: string; input: unknown }[] = [
    {
      name: 'artifact-types',
      uri: 'artifact-types://catalogue',
      title: 'Artifact type catalogue',
      description: 'Every artifact type with the JSON Schema its content must match.',
      command: 'artifacts.types',
      input: {},
    },
    {
      name: 'learnings',
      uri: 'learnings://current',
      title: 'Active learnings',
      description: 'The active conclusions with their evidence, newest first.',
      command: 'learnings.list',
      input: { status: 'active' },
    },
    {
      name: 'check-catalogue',
      uri: 'checks://catalogue',
      title: 'Audit check catalogue',
      description: 'Every audit check with its category, severity, scope, explanation, fix type and official references.',
      command: 'checks.catalogue',
      input: {},
    },
    {
      name: 'change-types',
      uri: 'change-types://catalogue',
      title: 'Change type catalogue',
      description: 'Every change a change set can carry, with its action class, what verifies it and the JSON Schema it accepts.',
      command: 'changes.types',
      input: {},
    },
  ];
  for (const resource of resources) {
    const cmd = commandNamed(resource.command);
    if (!cmd.permission || !principal.permissions.has(cmd.permission)) continue;
    server.registerResource(
      resource.name,
      resource.uri,
      { title: resource.title, description: resource.description, mimeType: 'application/json' },
      async (uri) => {
        const out = await executor.execute(cmd, resource.input, principal, { surface: 'mcp' });
        return { contents: [{ uri: uri.href, text: JSON.stringify(out), mimeType: 'application/json' }] };
      },
    );
  }
  const templates: {
    name: string;
    uriTemplate: string;
    title: string;
    description: string;
    /** Every command the read runs; the template is hidden unless the principal may run all of them. */
    commands: readonly string[];
    read: (siteId: string) => Promise<unknown>;
  }[] = [
    {
      name: 'site-context',
      uriTemplate: 'site-context://{siteId}',
      title: 'Site context',
      description:
        'The site’s published site context: business overview, current goal, positioning, writing preferences, key pages and competitors.',
      commands: ['sites.get', 'artifacts.get'],
      read: (siteId) => readSiteContext(principal, executor, siteId),
    },
    {
      name: 'issues',
      uriTemplate: 'issues://{siteId}',
      title: 'Open issues',
      description: 'The site’s open issues, worst first by severity and affected pages, with the clicks over 28 days they put at risk.',
      commands: ['audits.issues'],
      read: (siteId) =>
        executor.execute(commandNamed('audits.issues'), { siteId, state: 'open', limit: 10 }, principal, { surface: 'mcp' }),
    },
  ];
  for (const template of templates) {
    if (!mayRunAll(principal, template.commands)) continue;
    server.registerResource(
      template.name,
      new ResourceTemplate(template.uriTemplate, { list: undefined }),
      { title: template.title, description: template.description, mimeType: 'application/json' },
      async (uri, variables) => {
        const siteId = String(variables.siteId ?? '');
        const out = await template.read(siteId);
        return { contents: [{ uri: uri.href, text: JSON.stringify(out), mimeType: 'application/json' }] };
      },
    );
  }
  // One Phase 1 prompt: the thin loop, written so the client reads the same order and the same
  // evidence rule the hosted specialists follow. It is text only; no command runs when it is read.
  if (principal.permissions.has('sites:read'))
    server.registerPrompt(
      'audit-and-propose',
      {
        title: 'Audit this site and propose the top fixes',
        description:
          'The Phase 1 loop for one site: read the issues, propose evidence-backed recommendations and draft a change set. Never invents a metric.',
        argsSchema: z.object({ siteId: z.string().describe('The site id to audit, e.g. from sites.list') }),
      },
      ({ siteId }) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: auditAndProposePrompt(siteId) } }] }),
    );
  for (const cmd of commands) {
    if (cmd.humansOnly || !cmd.permission) continue;
    const toolName = mcpToolName(cmd.name, style);
    const granted = principal.permissions.has(cmd.permission);
    if (!granted && !(opts.stepUp && missingScope(principal, toolName, style))) continue;
    server.registerTool(
      toolName,
      {
        title: cmd.title,
        description: granted
          ? cmd.description
          : `${cmd.description}\n\nNeeds the "${cmd.permission}" permission, which this connection was not granted: calling it asks the person to grant it.`,
        inputSchema: mcpInputSchema(cmd.input),
        outputSchema: mcpOutputSchema(cmd.output),
        annotations: {
          readOnlyHint: cmd.effect === 'read',
          destructiveHint: cmd.effect === 'destructive',
          idempotentHint: cmd.effect === 'read',
          openWorldHint: false,
        },
      },
      async (input: unknown) => {
        try {
          const out = await executor.execute(cmd, input, principal, { surface: 'mcp' });
          return {
            content: [
              { type: 'text' as const, text: opts.textContent === 'summary' ? summarizeOutput(cmd.name, out) : JSON.stringify(out) },
            ],
            structuredContent: out as Record<string, unknown>,
          };
        } catch (err) {
          if (err instanceof AppError) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(err.toJSON()) }] };
          throw err;
        }
      },
    );
  }
  return server;
}

export function mcpEndpoint(deps: {
  auth: Auth;
  db: Db;
  executor: Executor;
  resource: string;
  textContent?: McpTextContent;
  toolNameStyle?: McpToolNameStyle;
}) {
  const style = deps.toolNameStyle ?? 'dotted';
  const handler = createMcpHandler(({ authInfo }) =>
    mcpServerFor(authInfo!.extra!.principal as Principal, deps.executor, {
      stepUp: authInfo!.extra!.stepUp === true,
      textContent: deps.textContent,
      toolNameStyle: style,
    }),
  );
  const resourceMetadata = `${new URL(deps.resource).origin}/.well-known/oauth-protected-resource${new URL(deps.resource).pathname}`;

  /** A tools/call the client lacks a scope for gets the standard challenge instead of a tool error. */
  async function stepUpChallenge(request: Request, principal: Principal) {
    if (request.method !== 'POST') return null;
    const body = await request
      .clone()
      .json()
      .catch(() => null);
    const calls = (Array.isArray(body) ? body : [body]).filter((m) => m?.method === 'tools/call');
    const needed = [...new Set(calls.map((m) => missingScope(principal, String(m.params?.name ?? ''), style)).filter((p) => p !== null))];
    if (!needed.length) return null;
    const scope = [...new Set([...principal.permissions, ...needed])].join(' ');
    return new Response(
      JSON.stringify({
        error: 'insufficient_scope',
        message: `This connection needs the ${needed.join(', ')} permission. Ask the person to grant it.`,
      }),
      {
        status: 403,
        headers: {
          'content-type': 'application/json',
          'www-authenticate': `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${resourceMetadata}", error_description="The ${needed.join(', ')} permission was not granted to this client"`,
        },
      },
    );
  }

  /** The parsed body of a single JSON-RPC call, or null when this is not one. */
  async function singleCall(request: Request) {
    if (request.method !== 'POST') return null;
    const body = await request
      .clone()
      .json()
      .catch(() => null);
    if (!body || Array.isArray(body) || body.method !== 'tools/call') return null;
    return body as { id?: unknown; params?: { name?: unknown } };
  }

  /** A JSON-RPC tool error: clients keep their session and read the sentence. */
  const toolError = (id: unknown, error: { code: string; message: string }) =>
    Response.json({
      jsonrpc: '2.0',
      id: id ?? null,
      result: { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] },
    });

  /**
   * A people-only command is never listed to an agent, so a client that names one is answered with
   * a clear refusal instead of a bare "tool not found": the person can run it in the app, and the
   * agent should ask rather than retry. A scope challenge is wrong here, because no grant would
   * ever let an agent run it.
   */
  async function peopleOnlyDenial(request: Request) {
    const body = await singleCall(request);
    if (!body) return null;
    const cmd = commandForMcpTool(String(body.params?.name ?? ''), style);
    if (!cmd?.humansOnly) return null;
    return toolError(body.id, {
      code: 'forbidden',
      message: `${cmd.name} can only be run by a person, not by a connected agent. Ask the person who owns this workspace to do it in the app.`,
    });
  }

  /**
   * API tokens have no scope step-up of their own: their owner edits them. A tool the token no
   * longer has a scope for (after narrowing) fails on the very next call with a tool error that
   * says why. It is a JSON-RPC result, not an HTTP error, so clients keep their session.
   */
  async function apiTokenDenial(request: Request, principal: Principal) {
    const body = await singleCall(request);
    if (!body) return null;
    const cmd = commandForMcpTool(String(body.params?.name ?? ''), style);
    if (!cmd?.permission || principal.permissions.has(cmd.permission)) return null;
    return toolError(body.id, {
      code: 'insufficient_scope',
      message: `This API token does not have the ${cmd.permission} permission. Its owner can add it with apiTokens.update.`,
    });
  }

  const oauth = requireMcpAuth(
    deps.auth,
    async (request, claims) => {
      const principal = await principalFromAccessToken(deps.db, claims);
      if (!principal)
        return Response.json(
          {
            error: 'no_workspace',
            message:
              'This connection is not bound to a workspace. Reconnect and choose the workspace it acts in, or ask for membership of one.',
          },
          { status: 403 },
        );
      const conflict = workspaceHeaderConflict(principal, request.headers);
      if (conflict) return Response.json({ error: 'workspace_mismatch', message: conflict }, { status: 403 });
      const authInfo: AuthInfo = {
        token: '',
        clientId: principal.clientId!,
        scopes: [...principal.permissions],
        expiresAt: claims.exp,
        resource: new URL(deps.resource),
        extra: { principal, stepUp: true },
      };
      return (await peopleOnlyDenial(request)) ?? (await stepUpChallenge(request, principal)) ?? handler.fetch(request, { authInfo });
    },
    { resource: deps.resource },
  );
  // API tokens (scripts, n8n) skip OAuth; everything else goes through it.
  return async (request: Request) => {
    const bearer = request.headers.get('authorization')?.match(new RegExp(`^Bearer (${TOKEN_PREFIX}\\S+)$`))?.[1];
    if (!bearer) return oauth(request);
    const principal = await principalFromApiToken(deps.db, bearer);
    if (!principal)
      return Response.json({ error: 'invalid_token', message: 'This API token is unknown, revoked or expired.' }, { status: 401 });
    const conflict = workspaceHeaderConflict(principal, request.headers);
    if (conflict) return Response.json({ error: 'workspace_mismatch', message: conflict }, { status: 403 });
    // The server (and its tool list) is built per request from this principal, so a narrowed token
    // loses tools at once rather than keeping a cached server from an earlier request.
    const denial = (await peopleOnlyDenial(request)) ?? (await apiTokenDenial(request, principal));
    if (denial) return denial;
    const authInfo: AuthInfo = { token: '', clientId: principal.clientId!, scopes: [...principal.permissions], extra: { principal } };
    return handler.fetch(request, { authInfo });
  };
}
