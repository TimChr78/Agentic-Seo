import type { Role } from '@agentic-seo/db';

/** Permission strings double as OAuth scopes for agents. */
export const PERMISSIONS = [
  'artifacts:read',
  'artifacts:write',
  'artifacts:publish',
  'artifacts:approve',
  'sites:read',
  'sites:write',
  'audits:run',
  'research:spend',
  'changes:apply',
  'audit:read',
  'secrets:read',
  'secrets:write',
  'workspace:admin',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Who may do what. Agentic Marketing had five roles; "marketer" is renamed "editor" for SEO.
 *
 * | Permission        | owner | admin | editor | approver | viewer |
 * |-------------------|:-----:|:-----:|:------:|:--------:|:------:|
 * | artifacts:read    |   ✓   |   ✓   |   ✓    |    ✓     |   ✓    |
 * | artifacts:write   |   ✓   |   ✓   |   ✓    |          |        |
 * | artifacts:publish |   ✓   |   ✓   |   ✓    |          |        |
 * | artifacts:approve |   ✓   |   ✓   |        |    ✓     |        |
 * | sites:read        |   ✓   |   ✓   |   ✓    |    ✓     |   ✓    |
 * | sites:write       |   ✓   |   ✓   |   ✓    |          |        |
 * | audits:run        |   ✓   |   ✓   |   ✓    |          |        |
 * | research:spend    |   ✓   |   ✓   |   ✓    |          |        |
 * | changes:apply     |   ✓   |   ✓   |   ✓    |          |        |
 * | audit:read        |   ✓   |   ✓   |   ✓    |    ✓     |        |
 * | secrets:read      |   ✓   |   ✓   |        |          |        |
 * | secrets:write     |   ✓   |   ✓   |        |          |        |
 * | workspace:admin   |   ✓   |   ✓   |        |          |        |
 *
 * Editors do the daily work (sites, audits, research, change sets); approvers review change sets;
 * viewers read. Secret values stay write-only and are never readable through the command layer;
 * `secrets:read` only lists names and who changed them.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  editor: [
    'artifacts:read',
    'artifacts:write',
    'artifacts:publish',
    'sites:read',
    'sites:write',
    'audits:run',
    'research:spend',
    'changes:apply',
    'audit:read',
  ],
  approver: ['artifacts:read', 'artifacts:approve', 'sites:read', 'audit:read'],
  viewer: ['artifacts:read', 'sites:read'],
};

/** The agent behind an agent principal: the row the action ledger and policy refer to. */
export interface AgentIdentity {
  id: string;
  name: string;
  status: 'active' | 'paused' | 'revoked';
  statusReason: string | null;
}

interface BasePrincipal {
  /** The person; for agents, the person the agent acts for. */
  userId: string;
  /** OAuth client id when the principal is an agent. */
  clientId?: string;
  workspaceId: string;
  role: Role;
  /** Effective permissions: the role's permissions, intersected with granted scopes for agents. */
  permissions: ReadonlySet<Permission>;
}

/** A person. `agent` is present-but-undefined so code can read it without narrowing first. */
export interface UserPrincipal extends BasePrincipal {
  type: 'user';
  agent?: undefined;
}

/**
 * An agent. The identity is required, not optional: without it the policy engine cannot run, so
 * `agentPrincipal` always supplies it and the compiler refuses a principal that leaves it out.
 * The executor still guards at runtime, because a token or OAuth client is built from stored data.
 */
export interface AgentPrincipal extends BasePrincipal {
  type: 'agent';
  clientId: string;
  agent: AgentIdentity;
}

export type Principal = UserPrincipal | AgentPrincipal;

export function userPrincipal(userId: string, workspaceId: string, role: Role): UserPrincipal {
  return { type: 'user', userId, workspaceId, role, permissions: new Set(ROLE_PERMISSIONS[role]) };
}

export function agentPrincipal(
  agent: AgentIdentity,
  userId: string,
  clientId: string,
  workspaceId: string,
  role: Role,
  grantedScopes: Iterable<string>,
): AgentPrincipal {
  const granted = new Set(grantedScopes);
  return {
    type: 'agent',
    userId,
    clientId,
    workspaceId,
    role,
    permissions: new Set(ROLE_PERMISSIONS[role].filter((p) => granted.has(p))),
    agent,
  };
}
