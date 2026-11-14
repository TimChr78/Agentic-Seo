import { type Auth, inAuthTransaction } from '@agentic-seo/auth';
import { appendAuditEntry, type Principal } from '@agentic-seo/commands';
import { sha256 } from '@agentic-seo/core';
import type { Db } from '@agentic-seo/db';
import { logger } from '@agentic-seo/telemetry';

// The operator-initiated password reset (#913), the break-glass path of `aseo reset-password`.
//
// Agentic Marketing's file also carries the self-service web flow (request → sealed address →
// delivery queue → Better Auth token). None of that is ported, so this file keeps the CLI half: the
// password write and the end of every session of that person in **one** transaction, and the same
// audit entry the web flow wrote, marked `cli` because there is no request and no client IP.

/** How a reset ended, as the audit entry records it. The CLI only writes `ok`. */
export type ResetOutcome = 'ok' | 'failed';

/**
 * Appends the audit entry for a reset: person, outcome and (for the web flow) the client IP, never
 * the token or the password. The audit log is per workspace, so the entry lands in the person's
 * oldest workspace; someone without one is only in the server log. The hash chain is kept like a
 * command's entry.
 */
export async function recordPasswordResetAudit(
  db: Db,
  entry: { userId: string | null; ip: string | null; command: 'auth.passwordReset'; outcome: ResetOutcome; surface?: 'cli' },
): Promise<void> {
  const userId = entry.userId;
  if (!userId) {
    logger.info({ command: entry.command, ip: entry.ip }, 'password reset event that cannot be attributed to an account');
    return;
  }
  try {
    const { rows } = await db.admin.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM workspace_members WHERE user_id = $1 ORDER BY created_at, workspace_id LIMIT 1',
      [userId],
    );
    const workspaceId = rows[0]?.workspace_id;
    if (!workspaceId) {
      logger.info({ command: entry.command, userId, ip: entry.ip }, 'password reset event for a person without a workspace');
      return;
    }
    // The shared append helper, so the entry is shaped (and hashed) exactly like every other audit
    // entry: an absent IP is omitted from the hash, which a hand-built entry got wrong (#913).
    // The principal is audit-only; no permission is evaluated when an entry is appended.
    const principal: Principal = { type: 'user', userId, workspaceId, role: 'viewer', permissions: new Set() };
    await db.withWorkspace(workspaceId, (tx) =>
      appendAuditEntry(
        tx,
        principal,
        'cli',
        { name: entry.command, effect: 'write' },
        // What happened and from where, never the token or the password.
        sha256(`${entry.command}:${userId}:${entry.ip}:${entry.outcome}`),
        userId,
        entry.outcome === 'ok' ? undefined : { code: 'password_reset', message: entry.outcome },
        entry.ip,
      ),
    );
  } catch (err) {
    // An audit write must never break the flow; the request outcome is already logged above.
    logger.warn({ err, command: entry.command, userId }, 'could not append the password reset audit entry');
  }
}

/** What an operator-initiated reset needs; the two writes are seams for tests. */
export interface AdminResetDeps {
  db: Db;
  auth: Auth;
  /** Deletes every session of the person. Defaults to Better Auth's internal adapter. */
  revokeSessions?: (userId: string) => Promise<void>;
  /** Writes the new credential, updating the password account or linking one. Same default. */
  writeCredential?: (target: { userId: string; credentialId: string | null; hashed: string }) => Promise<void>;
}

/**
 * `aseo reset-password` (#913): set a new password and end every session of that person in **one**
 * transaction, so a crash between the two cannot leave a stolen cookie valid behind a password the
 * operator was told was updated. The order matches Better Auth's own reset (revoke, then write):
 * on an adapter without transactions the old password still stands rather than a new one shipping
 * next to live sessions. The audit entry is the one the web reset writes, marked `cli` because
 * there is no request and no client IP.
 */
export async function resetPasswordForEmail(deps: AdminResetDeps, email: string, password: string): Promise<{ userId: string }> {
  const context = await deps.auth.$context;
  const found = await context.internalAdapter.findUserByEmail(email, { includeAccounts: true });
  if (!found) throw new Error(`reset-password: no user with email ${email}`);
  const hashed = await context.password.hash(password);
  const credential = found.accounts.find((account) => account.providerId === 'credential');
  const revokeSessions = deps.revokeSessions ?? ((userId: string) => context.internalAdapter.deleteUserSessions(userId));
  const writeCredential =
    deps.writeCredential ??
    (async ({ userId, credentialId, hashed: passwordHash }: { userId: string; credentialId: string | null; hashed: string }) => {
      if (credentialId) await context.internalAdapter.updateAccount(credentialId, { password: passwordHash });
      else
        await context.internalAdapter.linkAccount({
          userId,
          providerId: 'credential',
          accountId: userId,
          password: passwordHash,
        });
    });
  await inAuthTransaction(deps.auth, async () => {
    await revokeSessions(found.user.id);
    await writeCredential({ userId: found.user.id, credentialId: credential?.id ?? null, hashed });
  });
  await recordPasswordResetAudit(deps.db, {
    userId: found.user.id,
    ip: null,
    command: 'auth.passwordReset',
    outcome: 'ok',
    surface: 'cli',
  });
  return { userId: found.user.id };
}
