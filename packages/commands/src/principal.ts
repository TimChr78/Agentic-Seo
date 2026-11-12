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

export interface Principal {
  type: 'user' | 'agent';
  /** The person; for agents, the person the agent acts for. */
  userId: string;
  /** OAuth client id when the principal is an agent. */
  clientId?: string;
  workspaceId: string;
  role: Role;
  /** Effective permissions: the role's permissions, intersected with granted scopes for agents. */
  permissions: ReadonlySet<Permission>;
  /** The agent this principal acts as (ADR-0006); set for API tokens and OAuth clients. */
  agent?: { id: string; name: string; status: 'active' | 'paused' | 'revoked'; statusReason: string | null };
}

export function userPrincipal(userId: string, workspaceId: string, role: Role): Principal {
  return { type: 'user', userId, workspaceId, role, permissions: new Set(ROLE_PERMISSIONS[role]) };
}

export function agentPrincipal(
  userId: string,
  clientId: string,
  workspaceId: string,
  role: Role,
  grantedScopes: Iterable<string>,
): Principal {
  const granted = new Set(grantedScopes);
  return {
    type: 'agent',
    userId,
    clientId,
    workspaceId,
    role,
    permissions: new Set(ROLE_PERMISSIONS[role].filter((p) => granted.has(p))),
  };
}
