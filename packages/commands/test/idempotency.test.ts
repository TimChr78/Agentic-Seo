import type { AppError } from '@agentic-seo/core';
import { createDb } from '@agentic-seo/db';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { APP_ROLE, createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { agentPrincipal, ROLE_PERMISSIONS, userPrincipal } from '../src';
import { createExecutor, defineCommand, lockAgentPolicy } from '../src/registry';

// #906, #930 and #905: an idempotency key is bound to its caller, an empty key is refused, a
// replayed agent write never reaches the policy engine again, and a replayed audited read keeps the
// targets its first call recorded.

const appUrl = (url: URL) => {
  const u = new URL(url.toString());
  u.username = APP_ROLE.appRole;
  u.password = APP_ROLE.appRolePassword;
  return u.toString();
};

const services = { serverVersion: 'test', strictInputs: false };

let runs = 0;
const countedWrite = defineCommand({
  name: 'test.countedWrite',
  title: 'Counted write',
  description: 'A write whose handler counts how often it runs.',
  input: z.object({ value: z.string() }),
  output: z.object({ value: z.string(), runs: z.number() }),
  permission: null,
  effect: 'write',
  actionClass: 'crawl',
  approvable: true,
  handler: async (input) => {
    runs += 1;
    return { value: input.value, runs };
  },
});

let impacts = 0;
const agentWrite = defineCommand({
  name: 'test.agentWrite',
  title: 'Agent write',
  description: 'A write whose impact is counted, as the policy engine sees it once per decision.',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  permission: null,
  effect: 'write',
  actionClass: 'crawl',
  approvable: true,
  impact: async () => {
    impacts += 1;
    return {};
  },
  handler: async () => ({ ok: true }),
});

const LOCK_AGENT = `agt_${'d'.repeat(32)}`;
const personPause = defineCommand({
  name: 'test.personPause',
  title: 'Person pause',
  description: 'A person-only write that takes the agent-policy lock in its handler, as agents.pause does.',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  permission: null,
  effect: 'write',
  humansOnly: true,
  handler: async (_input, ctx) => {
    await lockAgentPolicy(ctx.tx, ctx.principal.workspaceId, LOCK_AGENT);
    return { ok: true };
  },
});

const auditedRead = defineCommand({
  name: 'test.auditedRead',
  title: 'Audited read',
  description: 'A read that names the row it resolved, so its audit row can be checked.',
  input: z.object({ id: z.string() }),
  output: z.object({ id: z.string() }),
  permission: null,
  effect: 'read',
  auditReads: true,
  auditTarget: (out) => out.id,
  handler: async (input) => ({ id: input.id }),
});

describe.skipIf(!hasTestDatabase())('an idempotency key is bound to its caller (#906)', () => {
  let disposable: Awaited<ReturnType<typeof createDisposableDb>> | undefined;
  afterAll(async () => {
    await disposable?.close();
  });

  const setup = async () => {
    disposable = await createDisposableDb('idempotency');
    return { current: disposable, db: createDb({ adminUrl: disposable.url.toString(), appUrl: appUrl(disposable.url), poolSize: 2 }) };
  };

  it('replays for the same person and refuses another person using the same key', async () => {
    const { current, db } = await setup();
    try {
      const executor = createExecutor(db, services);
      const alice = userPrincipal('user_alice', current.workspace, 'owner');
      const bob = userPrincipal('user_bob', current.workspace, 'owner');
      runs = 0;
      const first = await executor.execute(countedWrite, { value: 'same' }, alice, { surface: 'rest', idempotencyKey: 'shared-key' });
      const replay = await executor.execute(countedWrite, { value: 'same' }, alice, { surface: 'rest', idempotencyKey: 'shared-key' });
      expect(replay).toEqual(first);
      const refused = await executor.execute(countedWrite, { value: 'same' }, bob, { surface: 'rest', idempotencyKey: 'shared-key' }).then(
        () => null,
        (err) => err as AppError,
      );
      expect(refused?.code).toBe('conflict');
      expect(refused?.details).toEqual({ reason: 'idempotency_key_reused' });
      expect(runs).toBe(1);
    } finally {
      await db.close();
    }
  });

  it('refuses an empty key instead of running without one', async () => {
    const { current, db } = await setup();
    try {
      const executor = createExecutor(db, services);
      const principal = userPrincipal('user_alice', current.workspace, 'owner');
      runs = 0;
      const err = await executor.execute(countedWrite, { value: 'x' }, principal, { surface: 'rest', idempotencyKey: '' }).then(
        () => null,
        (e) => e as AppError,
      );
      expect(err?.code).toBe('invalid_input');
      expect(runs).toBe(0);
      const refused = await executor
        .execute(countedWrite, { value: 'x' }, principal, { surface: 'rest', idempotencyKey: 'two words' })
        .then(
          () => null,
          (e) => e as AppError,
        );
      expect(refused?.code).toBe('invalid_input');
      expect(runs).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('answers a replayed agent write without deciding policy again (#930)', async () => {
    const { current, db } = await setup();
    try {
      const executor = createExecutor(db, services);
      const principal = agentPrincipal(
        { id: `agt_${'c'.repeat(32)}`, name: 'Replay agent', status: 'active', statusReason: null },
        'user_1',
        'token:y',
        current.workspace,
        'editor',
        ROLE_PERMISSIONS.editor,
      );
      impacts = 0;
      const opts = { surface: 'mcp' as const, idempotencyKey: 'agent-write' };
      const first = await executor.execute(agentWrite, {}, principal, opts);
      const replay = await executor.execute(agentWrite, {}, principal, opts);
      expect(replay).toEqual(first);
      // The policy engine (and with it the command's impact) ran once, for the first call only.
      expect(impacts).toBe(1);
    } finally {
      await db.close();
    }
  });

  it('keeps the targets of a replayed audited read (#905)', async () => {
    const { current, db } = await setup();
    try {
      const executor = createExecutor(db, services);
      const principal = userPrincipal('user_alice', current.workspace, 'owner');
      const opts = { surface: 'rest' as const, idempotencyKey: 'read-replay' };
      const first = await executor.execute(auditedRead, { id: 'not_abc' }, principal, opts);
      const replay = await executor.execute(auditedRead, { id: 'not_abc' }, principal, opts);
      expect(replay).toEqual(first);
      const { rows } = await current.db.admin.query<{ target: string | null }>(
        "SELECT target FROM audit_log WHERE workspace_id = $1 AND command = 'test.auditedRead' ORDER BY seq",
        [current.workspace],
      );
      expect(rows).toHaveLength(2);
      // The replay returns before the handler, so its target comes from the stored response.
      expect(rows.map((row) => row.target)).toEqual(['not_abc', 'not_abc']);
    } finally {
      await db.close();
    }
  });

  it('takes the key lock before the agent-policy lock, so a person and an agent sharing a key cannot deadlock', async () => {
    const { current, db } = await setup();
    const holder = await current.db.admin.connect();
    try {
      const executor = createExecutor(db, services);
      const agent = agentPrincipal(
        { id: LOCK_AGENT, name: 'Lock agent', status: 'active', statusReason: null },
        'user_1',
        'token:z',
        current.workspace,
        'editor',
        ROLE_PERMISSIONS.editor,
      );
      const person = userPrincipal('user_alice', current.workspace, 'owner');
      const waiting = async (n: number) => {
        for (let i = 0; i < 200; i++) {
          const { rows } = await current.db.admin.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
          );
          if ((rows[0]?.n ?? 0) >= n) return;
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error(`fewer than ${n} sessions ever waited on a lock`);
      };
      // Stall the agent write at its status read, after the locks it takes first.
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE agents IN ACCESS EXCLUSIVE MODE');
      const agentRun = executor.execute(agentWrite, {}, agent, { surface: 'mcp', idempotencyKey: 'shared-lock-key' });
      await waiting(1);
      // The person's command needs the agent-policy lock in its handler, with the same key.
      const personRun = executor.execute(personPause, {}, person, { surface: 'rest', idempotencyKey: 'shared-lock-key' }).then(
        () => null,
        (err: AppError) => err,
      );
      await waiting(2);
      await holder.query('COMMIT');
      // Agent-policy before the key lock would let the person hold the key while waiting for the
      // agent's policy lock, and the agent wait for the key: a deadlock that aborts one of them.
      // In the one order the agent finishes first and the person's reuse of its key is refused.
      expect(await agentRun).toEqual({ ok: true });
      const err = await personRun;
      expect(err?.code).toBe('conflict');
      expect(err?.message).toContain('already used for a different request');
    } finally {
      holder.release();
      await db.close();
    }
  });
});
