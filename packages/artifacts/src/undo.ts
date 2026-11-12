import { type CommandContext, defineCommand, registerUndoHandler, runUndo } from '@agentic-seo/commands';
import { AppError } from '@agentic-seo/core';
import { type AgentUndo, schema, type Tx } from '@agentic-seo/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { publishArtifactVersion, unpublishArtifactVersion } from './commands';

// Reversing an agent's publish (ADR-0006 §5.4). The previous version goes live through the same
// publish checks and listeners as any publish; a first publish is taken out of service again and
// its version becomes a draft. A person's undo is audited by `agents.undo` itself.

registerUndoHandler(async (ctx, undo) => {
  if (undo.kind !== 'republish') return null;
  // Only the agent's own version is reverted: if a newer one went live since, undoing would discard
  // someone else's work, so a person decides by hand. Locked so a publish cannot slip in.
  const [live] = await ctx.tx
    .select({ publishedVersion: schema.artifacts.publishedVersion })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.workspaceId, ctx.principal.workspaceId), eq(schema.artifacts.id, undo.artifactId)))
    .for('update');
  // Records from before undo knew which version was published cannot be reversed safely.
  if (undo.publishedVersion === undefined)
    throw new AppError(
      'conflict',
      `This action was recorded before undo knew which version the agent published, so it cannot tell whether newer work went live since. Reverse ${undo.artifactId} by hand: republish the version you want from its history.`,
    );
  if (live?.publishedVersion !== undo.publishedVersion)
    throw new AppError(
      'conflict',
      live?.publishedVersion == null
        ? `${undo.artifactId} is no longer live, so there is nothing of this action to undo.`
        : `${undo.artifactId} v${live.publishedVersion} was published after this action (it published v${undo.publishedVersion}); undoing it would discard newer work. Change it by hand instead.`,
    );
  if (undo.previousVersion === null) {
    const version = await unpublishArtifactVersion(ctx, undo.artifactId);
    if (version === null) return `${undo.artifactId} was not live any more.`;
    return `Unpublished ${undo.artifactId}; v${version} is a draft again.`;
  }
  await publishArtifactVersion(ctx, undo.artifactId, undo.previousVersion);
  return `Republished ${undo.artifactId} v${undo.previousVersion}.`;
});

/**
 * Reverses one agent action in the caller's transaction, returns what happened and marks the
 * ledger row undone. `by` names the person who did it. The command lives here because the
 * reversal handlers do; it is still an agent-control command, so only people may run it.
 */
export async function undoAgentAction(tx: Tx, ctx: CommandContext, actionId: number, by: string, note?: string) {
  const [action] = await tx.select().from(schema.agentActions).where(eq(schema.agentActions.id, actionId)).for('update');
  if (!action) throw new AppError('not_found', `Agent action ${actionId} was not found in this workspace.`);
  if (action.undoneAt)
    throw new AppError(
      'conflict',
      `This action was already undone on ${action.undoneAt.toISOString()}${action.undoneBy ? ` by ${action.undoneBy}` : ''}. It cannot be undone twice.`,
    );
  if (!action.ok || action.decision === 'deny')
    throw new AppError('conflict', `${action.command} did not happen, so there is nothing to undo.`);
  if (action.decision === 'ask' || action.decision === 'hold')
    throw new AppError(
      'conflict',
      `${action.command} waited for a person and never ran by itself, so there is nothing to undo. Use approvals.reject to withdraw it.`,
    );
  const undo = action.undo as AgentUndo | null;
  if (!undo) throw new AppError('conflict', `${action.command} changed nothing that can be undone.`);
  if (undo.kind === 'none') throw new AppError('conflict', undo.reason);
  const steps = await runUndo({ ...ctx, tx }, undo);
  const result = [steps.join(' '), note ? `Note: ${note}` : ''].filter(Boolean).join(' ').slice(0, 2000);
  const undoneAt = new Date();
  await tx.update(schema.agentActions).set({ undoneAt, undoneBy: by, undoResult: result }).where(eq(schema.agentActions.id, actionId));
  return { actionId, undoneAt: undoneAt.toISOString(), result, steps };
}

export const undoAgent = defineCommand({
  name: 'agents.undo',
  title: 'Undo an agent action',
  description:
    'Reverse something an agent did: republish the version it replaced, or unpublish what it first published. Only people can undo. An action whose artifact has newer work live cannot be undone automatically; the refusal explains it.',
  input: z.object({
    actionId: z.number().int().describe('The ledger entry, from agents.activity'),
    note: z.string().max(1000).optional().describe('Why it is being undone, kept with the ledger entry'),
  }),
  output: z.object({
    actionId: z.number().int(),
    undoneAt: z.string(),
    result: z.string().describe('What the undo did, in words'),
    steps: z.array(z.string()),
  }),
  permission: 'artifacts:publish',
  effect: 'publish',
  humansOnly: true,
  target: (i) => `agent_action:${i.actionId}`,
  handler: async (input, ctx) => undoAgentAction(ctx.tx, ctx, input.actionId, ctx.principal.userId, input.note),
});
