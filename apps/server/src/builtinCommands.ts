import { defineCommand } from '@agentic-seo/commands';
import { schema } from '@agentic-seo/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

// The two commands every principal needs before it can do anything: what workspace am I acting in,
// and who am I (person or agent, role, effective permissions). Both are reads and both are visible
// to every role, so an agent can discover its own limits without a person explaining them.

const RoleSchema = z.enum(['owner', 'admin', 'editor', 'approver', 'viewer']);

export const getWorkspace = defineCommand({
  name: 'workspace.get',
  title: 'Get this workspace',
  description:
    'The workspace this request acts in: its name, approval policy and time zone, your role and the permissions you have. A credential (API token or MCP connection) always sees the one workspace it was created for; a person’s session may switch with the X-Workspace-Id header.',
  input: z.object({}),
  output: z.object({
    id: z.string(),
    name: z.string(),
    approvalPolicy: z.enum(['none', 'agent_changes', 'all_publishes']),
    timeZone: z.string(),
    role: RoleSchema,
    permissions: z.array(z.string()),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (_input, ctx) => {
    const [workspace] = await ctx.tx
      .select({
        id: schema.workspaces.id,
        name: schema.workspaces.name,
        approvalPolicy: schema.workspaces.approvalPolicy,
        timeZone: schema.workspaces.timeZone,
      })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, ctx.principal.workspaceId));
    if (!workspace) throw new Error(`workspace ${ctx.principal.workspaceId} not found`);
    return {
      ...workspace,
      role: ctx.principal.role,
      permissions: [...ctx.principal.permissions],
    };
  },
});

export const whoami = defineCommand({
  name: 'whoami',
  title: 'Who am I',
  description:
    'The principal behind this request: a person (user) or an agent, the workspace it acts in, its role, the effective permissions, and — for an agent — its id and status. Use it to check what a token or connection may do.',
  input: z.object({}),
  output: z.object({
    type: z.enum(['user', 'agent']),
    userId: z.string(),
    clientId: z.string().optional(),
    workspaceId: z.string(),
    role: RoleSchema,
    permissions: z.array(z.string()),
    agent: z
      .object({ id: z.string(), name: z.string(), status: z.enum(['active', 'paused', 'revoked']), statusReason: z.string().nullable() })
      .optional(),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (_input, ctx) => ({
    type: ctx.principal.type,
    userId: ctx.principal.userId,
    ...(ctx.principal.clientId ? { clientId: ctx.principal.clientId } : {}),
    workspaceId: ctx.principal.workspaceId,
    role: ctx.principal.role,
    permissions: [...ctx.principal.permissions],
    ...(ctx.principal.agent ? { agent: ctx.principal.agent } : {}),
  }),
});
