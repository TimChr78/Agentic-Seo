import { randomUUID } from 'node:crypto';
import { AppError, canonicalJson, sha256 } from '@agentic-seo/core';
import { createDb } from '@agentic-seo/db';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { APP_ROLE, createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { agentPrincipal, type Principal, ROLE_PERMISSIONS, userPrincipal } from '../src';
import { createExecutor, defineCommand } from '../src/registry';

// The executor is the only way to run a command (ADR-0006), so these tests pin the guards that
// every surface inherits: an agent principal must carry an identity, idempotency must serialise
// concurrent retries, and the audit log must stay a verifiable hash chain.

const appUrl = (url: URL) => {
  const u = new URL(url.toString());
  u.username = APP_ROLE.appRole;
  u.password = APP_ROLE.appRolePassword;
  return u.toString();
};

const services = { serverVersion: 'test', strictInputs: false };

const readCommand = defineCommand({
  name: 'test.read',
  title: 'Read',
  description: 'A read for the executor tests.',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  permission: null,
  effect: 'read',
  handler: async () => ({ ok: true }),
});

let readRuns = 0;
const slowRead = defineCommand({
  name: 'test.slowRead',
  title: 'Slow read',
  description: 'A read whose handler counts how often it runs.',
  input: z.object({}),
  output: z.object({ runs: z.number() }),
  permission: null,
  effect: 'read',
  handler: async () => {
    readRuns += 1;
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { runs: readRuns };
  },
});

const crashingWrite = defineCommand({
  name: 'test.crash',
  title: 'Crash',
  description: 'A write whose handler throws an unexpected (non-AppError) exception.',
  input: z.object({}),
  output: z.object({}),
  permission: null,
  effect: 'write',
  actionClass: 'crawl',
  handler: async () => {
    throw new Error('connection reset: password=hunter2');
  },
});

let runs = 0;
const slowWrite = defineCommand({
  name: 'test.slowWrite',
  title: 'Slow write',
  description: 'A write whose handler counts how often it runs.',
  input: z.object({ value: z.string() }),
  output: z.object({ value: z.string(), runs: z.number() }),
  permission: null,
  effect: 'write',
  actionClass: 'crawl',
  approvable: true,
  handler: async (input) => {
    runs += 1;
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { value: input.value, runs };
  },
});

const writeCommand = defineCommand({
  name: 'test.write',
  title: 'Write',
  description: 'A quick write for the audit-chain test.',
  input: z.object({ value: z.string() }),
  output: z.object({ value: z.string() }),
  permission: null,
  effect: 'write',
  actionClass: 'crawl',
  approvable: true,
  handler: async (input) => ({ value: input.value }),
});

const failingWrite = defineCommand({
  name: 'test.failingWrite',
  title: 'Failing write',
  description: 'A write that refuses, so its failure is audited.',
  input: z.object({}),
  output: z.object({}),
  permission: null,
  effect: 'write',
  actionClass: 'crawl',
  approvable: true,
  handler: async () => {
    throw new AppError('not_found', 'Nothing to change.');
  },
});

const agentWithoutIdentity = (workspaceId: string): Principal =>
  ({
    type: 'agent',
    userId: 'user_1',
    clientId: 'client_1',
    workspaceId,
    role: 'editor',
    permissions: new Set(ROLE_PERMISSIONS.editor),
  }) as unknown as Principal;

describe.skipIf(!hasTestDatabase())('the command executor', () => {
  let disposable: Awaited<ReturnType<typeof createDisposableDb>> | undefined;

  afterAll(async () => {
    await disposable?.close();
  });

  const setCurrent = async () => {
    const current = await createDisposableDb('executor');
    disposable = current;
    return current;
  };

  it('refuses every non-read command from an agent principal without an agent identity', async () => {
    const current = await setCurrent();
    const db = createDb({ adminUrl: current.url.toString(), appUrl: appUrl(current.url), poolSize: 4 });
    try {
      const executor = createExecutor(db, services);
      const principal = agentWithoutIdentity(current.workspace);

      // Reads are harmless without an identity; they still run.
      await expect(executor.execute(readCommand, {}, principal, { surface: 'rest' })).resolves.toEqual({ ok: true });

      const refused = await executor.execute(slowWrite, { value: 'x' }, principal, { surface: 'rest' }).then(
        () => null,
        (err) => err as AppError,
      );
      expect(refused).toBeInstanceOf(AppError);
      expect(refused?.code).toBe('forbidden');
      expect(refused?.message).toMatch(/agent identity/);
      expect(runs).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('runs an idempotent request once and returns the same response to both callers', async () => {
    const current = await setCurrent();
    const db = createDb({ adminUrl: current.url.toString(), appUrl: appUrl(current.url), poolSize: 4 });
    try {
      const executor = createExecutor(db, services);
      const principal = userPrincipal('user_1', current.workspace, 'owner');
      runs = 0;
      const key = randomUUID();
      const [a, b] = await Promise.all([
        executor.execute(slowWrite, { value: 'same' }, principal, { surface: 'rest', idempotencyKey: key }),
        executor.execute(slowWrite, { value: 'same' }, principal, { surface: 'rest', idempotencyKey: key }),
      ]);
      expect(runs).toBe(1);
      expect(a).toEqual({ value: 'same', runs: 1 });
      expect(b).toEqual(a);
    } finally {
      await db.close();
    }
  });

  it('runs a concurrent idempotent read once: the waiter sees the committed key', async () => {
    const current = await setCurrent();
    const db = createDb({ adminUrl: current.url.toString(), appUrl: appUrl(current.url), poolSize: 4 });
    try {
      const executor = createExecutor(db, services);
      const principal = userPrincipal('user_1', current.workspace, 'owner');
      readRuns = 0;
      const key = randomUUID();
      const [a, b] = await Promise.all([
        executor.execute(slowRead, {}, principal, { surface: 'rest', idempotencyKey: key }),
        executor.execute(slowRead, {}, principal, { surface: 'rest', idempotencyKey: key }),
      ]);
      expect(readRuns).toBe(1);
      expect(b).toEqual(a);
    } finally {
      await db.close();
    }
  });

  it('audits an unexpected exception as a sanitized internal failure', async () => {
    const current = await setCurrent();
    const db = createDb({ adminUrl: current.url.toString(), appUrl: appUrl(current.url), poolSize: 4 });
    try {
      const executor = createExecutor(db, services);
      const principal = userPrincipal('user_1', current.workspace, 'owner');
      await expect(executor.execute(crashingWrite, {}, principal, { surface: 'rest' })).rejects.toThrow('connection reset');
      const { rows } = await current.db.admin.query<{ ok: boolean; error: string }>(
        "SELECT ok, error FROM audit_log WHERE workspace_id = $1 AND command = 'test.crash'",
        [current.workspace],
      );
      expect(rows).toEqual([{ ok: false, error: 'internal: The command failed with an unexpected error.' }]);
    } finally {
      await db.close();
    }
  });

  it('forgets what a rolled-back attempt created when a retried command then fails', async () => {
    const current = await setCurrent();
    const db = createDb({ adminUrl: current.url.toString(), appUrl: appUrl(current.url), poolSize: 4 });
    try {
      let handlerRuns = 0;
      const creating = defineCommand({
        name: 'test.createThenFail',
        title: 'Create',
        description: 'Creates something on the first run and fails on the second.',
        input: z.object({}),
        output: z.object({ id: z.string() }),
        permission: null,
        effect: 'write',
        actionClass: 'draft',
        retryOnDeadlock: true,
        auditTarget: (out) => out.id,
        handler: async () => {
          if (++handlerRuns > 1) throw new AppError('conflict', 'second attempt refused');
          return { id: 'created-in-attempt-1' };
        },
      });
      // The first attempt gets as far as its ledger row, then loses a deadlock and is rolled back.
      let ledgerCalls = 0;
      const executor = createExecutor(db, {
        ...services,
        onAgentAction: async () => {
          if (++ledgerCalls === 1) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
        },
      });
      const agent = { id: `agt_${'a'.repeat(32)}`, name: 'Retry agent', status: 'active' as const, statusReason: null };
      const principal = agentPrincipal(agent as never, 'user_1', 'token:x', current.workspace, 'owner', []);
      await expect(executor.execute(creating, {}, principal, { surface: 'rest' })).rejects.toThrow('second attempt refused');
      expect(handlerRuns).toBe(2);
      const { rows } = await current.db.admin.query<{ target: string | null; ok: boolean }>(
        "SELECT target, ok FROM audit_log WHERE workspace_id = $1 AND command = 'test.createThenFail'",
        [current.workspace],
      );
      expect(rows).toEqual([{ target: null, ok: false }]);
    } finally {
      await db.close();
    }
  });

  it('keeps the audit log a continuous hash chain, and a tampered row breaks it', async () => {
    const current = await setCurrent();
    const db = createDb({ adminUrl: current.url.toString(), appUrl: appUrl(current.url), poolSize: 4 });
    try {
      const executor = createExecutor(db, services);
      const principal = userPrincipal('user_1', current.workspace, 'owner');
      const write = (value: string) => executor.execute(writeCommand, { value }, principal, { surface: 'rest' });
      await write('one');
      await write('two');
      await Promise.all([write('three'), write('four'), write('five')]);
      await expect(executor.execute(failingWrite, {}, principal, { surface: 'rest' })).rejects.toBeInstanceOf(AppError);

      interface Row {
        seq: string;
        workspace_id: string;
        principal_type: string;
        principal_id: string;
        client_id: string | null;
        surface: string;
        command: string;
        effect: string;
        target: string | null;
        input_hash: string;
        ok: boolean;
        error: string | null;
        prev_hash: string | null;
        hash: string;
        ip: string | null;
      }
      const chain = async () => {
        const { rows } = await current.db.admin.query<Row>('SELECT * FROM audit_log WHERE workspace_id = $1 ORDER BY seq', [
          current.workspace,
        ]);
        return rows.map((row, i) => {
          const entry = {
            workspaceId: row.workspace_id,
            principalType: row.principal_type,
            principalId: row.principal_id,
            clientId: row.client_id,
            surface: row.surface,
            command: row.command,
            effect: row.effect,
            target: row.target,
            inputHash: row.input_hash,
            ok: row.ok,
            error: row.error,
            prevHash: row.prev_hash,
            ...(row.ip ? { ip: row.ip } : {}),
          };
          return {
            seq: row.seq,
            linkOk: row.prev_hash === (i === 0 ? null : rows[i - 1]?.hash),
            hashOk: sha256(canonicalJson(entry)) === row.hash,
          };
        });
      };

      const rows = await chain();
      // Five writes plus the failed one, every one of them audited.
      expect(rows).toHaveLength(6);
      expect(rows.every((row) => row.linkOk && row.hashOk)).toBe(true);
      expect(rows.filter((row) => row.linkOk)).toHaveLength(6);

      // Rewriting history through the owner connection is exactly what the chain must expose.
      await current.db.admin.query('UPDATE audit_log SET error = $1 WHERE seq = $2', ['tampered', rows[1]?.seq]);
      const after = await chain();
      expect(after.some((row) => !row.hashOk)).toBe(true);
    } finally {
      await db.close();
    }
  });

  it('runs a write for an agent that has an identity', async () => {
    const current = await setCurrent();
    const db = createDb({ adminUrl: current.url.toString(), appUrl: appUrl(current.url), poolSize: 2 });
    try {
      const executor = createExecutor(db, services);
      const principal = agentPrincipal(
        { id: 'agent_1', name: 'Technical fixer', status: 'active', statusReason: null },
        'user_1',
        'client_1',
        current.workspace,
        'editor',
        ROLE_PERMISSIONS.editor,
      );
      await expect(executor.execute(writeCommand, { value: 'ok' }, principal, { surface: 'mcp' })).resolves.toEqual({ value: 'ok' });
    } finally {
      await db.close();
    }
  });
});
