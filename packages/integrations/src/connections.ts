import { AppError, newId } from '@agentic-seo/core';
import { schema, type Tx } from '@agentic-seo/db';
import { type KeyProvider, openJson, sealJson } from '@agentic-seo/secrets';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

// Connections are per site and per connector (domain-model.md §1): the settings a person chose and
// the sealed credential the provider needs. A revoked connection is kept as history; connecting
// again makes a new row. No command returns the sealed bytes.

export const ConnectionId = z.string().regex(/^con_[0-9a-f]{32}$/, 'A connection id: con_ followed by 32 hex characters');

export type ConnectionRow = typeof schema.connections.$inferSelect;

export function newConnectionId(): string {
  return newId('con');
}

/** The connection shape every search command returns: never the sealed secrets or the OAuth state. */
export const ConnectionView = z.object({
  id: z.string(),
  siteId: z.string(),
  connector: z.string(),
  label: z.string(),
  settings: z.record(z.string(), z.unknown()),
  state: z.enum(['pending', 'active', 'error', 'revoked']),
  lastError: z.string().nullable(),
  tokenExpiresAt: z.string().nullable(),
  createdAt: z.string(),
});

export type ConnectionView = z.infer<typeof ConnectionView>;

export function connectionView(row: ConnectionRow): ConnectionView {
  return {
    id: row.id,
    siteId: row.siteId,
    connector: row.connector,
    label: row.label,
    settings: row.settings,
    state: row.state,
    lastError: row.lastError,
    tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A connection by id in this workspace, or a request-shaped not-found error. */
export async function getConnection(tx: Tx, workspaceId: string, id: string): Promise<ConnectionRow> {
  const [row] = await tx
    .select()
    .from(schema.connections)
    .where(and(eq(schema.connections.workspaceId, workspaceId), eq(schema.connections.id, id)));
  if (!row) throw new AppError('not_found', `Connection ${id} does not exist in this workspace.`);
  return row;
}

/** The site's live (not revoked) connection for a connector, locked for the caller's write. */
export async function liveConnection(tx: Tx, workspaceId: string, siteId: string, connector: string): Promise<ConnectionRow | null> {
  const [row] = await tx
    .select()
    .from(schema.connections)
    .where(
      and(
        eq(schema.connections.workspaceId, workspaceId),
        eq(schema.connections.siteId, siteId),
        eq(schema.connections.connector, connector),
      ),
    )
    .for('update');
  return row && row.state !== 'revoked' ? row : null;
}

/**
 * The site's connection for a connector, creating a pending row when there is none. A row in
 * `error` is reused, so reconnecting replaces the failed authorization instead of leaving it
 * beside a second row (the live unique index allows only one).
 */
export async function connectionForSite(
  tx: Tx,
  input: { workspaceId: string; siteId: string; connector: string; label: string },
): Promise<ConnectionRow> {
  const existing = await liveConnection(tx, input.workspaceId, input.siteId, input.connector);
  if (existing) return existing;
  const id = newConnectionId();
  const [inserted] = await tx
    .insert(schema.connections)
    .values({
      workspaceId: input.workspaceId,
      id,
      siteId: input.siteId,
      connector: input.connector,
      label: input.label,
      state: 'pending',
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  // Two connects raced: the loser reads the winner's row.
  const winner = await liveConnection(tx, input.workspaceId, input.siteId, input.connector);
  if (!winner)
    throw new AppError('conflict', 'Another connection for this site and connector was created at the same time. Run the command again.');
  return winner;
}

/** The connection's sealed JSON, or an empty object before anything was stored. */
export async function connectionSecrets(tx: Tx, row: ConnectionRow, kp: KeyProvider): Promise<Record<string, unknown>> {
  if (!row.secrets || !row.secretsKeyId) return {};
  return openJson<Record<string, unknown>>(tx, row.workspaceId, kp, row.secrets, row.secretsKeyId);
}

/** Seals and stores the connection's secrets; the caller writes the other columns itself. */
export async function sealConnectionSecrets(tx: Tx, row: ConnectionRow, kp: KeyProvider, secrets: Record<string, unknown>) {
  return sealJson(tx, row.workspaceId, kp, secrets);
}

/** Drops the sealed credential (disconnect) and returns the columns to write. */
export function clearedSecrets() {
  return { secrets: null, secretsKeyId: null };
}
