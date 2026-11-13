import type { AgentActionEntry, AgentCounters, Services } from '@agentic-seo/commands';
import { schema, type Tx } from '@agentic-seo/db';
import { and, desc, eq, sql } from 'drizzle-orm';

// The action ledger (ADR-0006): every agent write, including refusals and failures, with the policy
// decision that allowed, escalated or refused it. The executor calls these two services; they live
// in the server because only a host knows how tenancy and the ledger table fit together.

/** The workspace the current transaction is scoped to, as RLS sees it. */
async function workspaceOf(tx: Tx): Promise<string> {
  const result = await tx.execute<{ workspace_id: string }>(sql`SELECT current_setting('app.workspace_id')::uuid AS workspace_id`);
  const workspaceId = result.rows[0]?.workspace_id;
  if (!workspaceId) throw new Error('agent ledger used outside a workspace-scoped transaction');
  return workspaceId;
}

/** What an agent did in the last 24 hours: changes that ran, for the per-agent limit. */
export async function agentCounters(tx: Tx, agentId: string): Promise<AgentCounters> {
  const a = schema.agentActions;
  const [row] = await tx
    .select({ changes: sql<number>`count(*) FILTER (WHERE ${a.decision} = 'allow' AND ${a.ok} AND ${a.actionClass} <> 'draft')::int` })
    .from(a)
    .where(and(eq(a.agentId, agentId), sql`${a.at} > now() - interval '24 hours'`));
  return { changes: row?.changes ?? 0 };
}

/** Appends one ledger row. The table is append-only for the app role. */
export async function recordAgentAction(tx: Tx, entry: AgentActionEntry): Promise<void> {
  await tx.insert(schema.agentActions).values({
    workspaceId: await workspaceOf(tx),
    agentId: entry.agentId,
    command: entry.command,
    actionClass: entry.actionClass,
    decision: entry.decision,
    reasons: entry.reasons,
    impact: entry.impact as Record<string, unknown>,
    ok: entry.ok,
    error: entry.error,
    target: entry.target,
    surface: entry.surface,
    level: entry.level,
    intent: entry.intent,
    undo: entry.undo,
    mandateId: entry.mandateId ?? null,
    mandateVersion: entry.mandateVersion ?? null,
  });
}

/** The two hooks the executor needs, ready to spread into `Services`. */
export function agentLedgerServices(): Pick<Services, 'agentCounters' | 'onAgentAction'> {
  return { agentCounters, onAgentAction: recordAgentAction };
}

/** The ledger rows of one agent, newest first; used by tests and operators. */
export async function recentActions(tx: Tx, agentId: string, limit = 20) {
  return tx
    .select()
    .from(schema.agentActions)
    .where(eq(schema.agentActions.agentId, agentId))
    .orderBy(desc(schema.agentActions.id))
    .limit(limit);
}
