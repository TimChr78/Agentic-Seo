import { AppError } from '@agentic-seo/core';
import { createDb } from '@agentic-seo/db';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { APP_ROLE, createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { agentPrincipal, ROLE_PERMISSIONS, userPrincipal } from '../src';
import type { AgentActionEntry } from '../src/registry';
import { createExecutor, defineCommand, redactPolicyReasons, sanitizeAppError } from '../src/registry';

// #885: an AppError is written for a person, but its message may have been assembled from a
// provider's answer or an exception. The executor redacts it once, before it is returned, audited
// or written to the agent ledger; policy reasons are redacted where the policy is made.

const appUrl = (url: URL) => {
  const u = new URL(url.toString());
  u.username = APP_ROLE.appRole;
  u.password = APP_ROLE.appRolePassword;
  return u.toString();
};

const services = { serverVersion: 'test', strictInputs: false };
const SECRET = 'password=hunter2';

const leakyWrite = defineCommand({
  name: 'test.leakyWrite',
  title: 'Leaky write',
  description: 'A write whose AppError quotes a credential, as a provider body would.',
  input: z.object({}),
  output: z.object({}),
  permission: null,
  effect: 'write',
  actionClass: 'crawl',
  approvable: true,
  handler: async () => {
    throw new AppError('conflict', `The provider refused the change: ${SECRET}`);
  },
});

describe.skipIf(!hasTestDatabase())('the executor redacts errors before they leave it', () => {
  let disposable: Awaited<ReturnType<typeof createDisposableDb>> | undefined;
  afterAll(async () => {
    await disposable?.close();
  });

  it('redacts an AppError the caller and the audit log receive', async () => {
    disposable = await createDisposableDb('redaction');
    const current = disposable;
    const db = createDb({ adminUrl: current.url.toString(), appUrl: appUrl(current.url), poolSize: 2 });
    try {
      const executor = createExecutor(db, services);
      const principal = userPrincipal('user_1', current.workspace, 'owner');
      const err = await executor.execute(leakyWrite, {}, principal, { surface: 'rest' }).then(
        () => null,
        (e) => e as AppError,
      );
      expect(err).toBeInstanceOf(AppError);
      expect(err?.code).toBe('conflict');
      expect(err?.message).toContain('password=[redacted]');
      expect(err?.message).not.toContain('hunter2');

      const { rows } = await current.db.admin.query<{ ok: boolean; error: string }>(
        "SELECT ok, error FROM audit_log WHERE workspace_id = $1 AND command = 'test.leakyWrite'",
        [current.workspace],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.ok).toBe(false);
      expect(rows[0]?.error).toContain('password=[redacted]');
      expect(rows[0]?.error).not.toContain('hunter2');
    } finally {
      await db.close();
    }
  });

  it('redacts the failure text and the reasons the agent ledger stores', async () => {
    const current = disposable!;
    const db = createDb({ adminUrl: current.url.toString(), appUrl: appUrl(current.url), poolSize: 2 });
    const ledger: AgentActionEntry[] = [];
    try {
      const executor = createExecutor(db, {
        ...services,
        onAgentAction: async (_tx, entry) => {
          ledger.push(entry);
        },
      });
      const principal = agentPrincipal(
        { id: `agt_${'b'.repeat(32)}`, name: 'Leaky agent', status: 'active', statusReason: null },
        'user_1',
        'token:x',
        current.workspace,
        'editor',
        ROLE_PERMISSIONS.editor,
      );
      await expect(executor.execute(leakyWrite, {}, principal, { surface: 'mcp' })).rejects.toBeInstanceOf(AppError);
      const failed = ledger.find((entry) => !entry.ok);
      expect(failed).toBeDefined();
      expect(failed?.error).toContain('password=[redacted]');
      expect(failed?.error).not.toContain('hunter2');
      expect(failed?.reasons.every((reason) => !reason.includes('hunter2'))).toBe(true);
    } finally {
      await db.close();
    }
  });
});

describe('redaction helpers', () => {
  it('redacts every policy reason where the policy is made', () => {
    const policy = {
      decision: 'ask' as const,
      actionClass: 'crawl' as const,
      reasons: [`The provider answered ${SECRET}`, 'The mandate allows 3 pages.'],
      impact: {},
    };
    const clean = redactPolicyReasons(policy);
    expect(clean.reasons[0]).toBe('The provider answered password=[redacted]');
    expect(clean.reasons[1]).toBe('The mandate allows 3 pages.');
    // A clean decision keeps its identity, so nothing downstream has to compare strings.
    const same = redactPolicyReasons({ ...policy, reasons: ['The mandate allows 3 pages.'] });
    expect(same.reasons).toEqual(['The mandate allows 3 pages.']);
  });

  it('keeps a clean AppError as it is and rebuilds only one that needed redaction', () => {
    const clean = new AppError('not_found', 'No such artifact.');
    expect(sanitizeAppError(clean)).toBe(clean);
    const leaky = new AppError('conflict', `Refused: ${SECRET}`);
    const safe = sanitizeAppError(leaky);
    expect(safe).not.toBe(leaky);
    expect(safe.code).toBe('conflict');
    expect(safe.message).not.toContain('hunter2');
  });
});
