import { randomBytes } from 'node:crypto';
import type { CommandContext } from '@agentic-seo/commands';
import { userPrincipal } from '@agentic-seo/commands';
import type { Db } from '@agentic-seo/db';
import { type KeyProvider, localKeyProvider, sealJson } from '@agentic-seo/secrets';
import { afterAll, describe, expect, it } from 'vitest';
import { createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { aiUsage } from '../src/commands';
import { listAiProviders, reserveTokens, usedThisMonth } from '../src/providers';

// The budget's invariants at its entry points, under the interleavings that broke them:
//
//  - the month's usage and its live holds are read as one snapshot, so a settlement committing in
//    between is never invisible to both (#941);
//  - a hold outlives the process that took it, so a provider that billed a call whose worker died
//    is still covered instead of freeing that budget after five minutes (#941);
//  - usage is charged to the month the provider billed it, not the month the call was queued in.
//
// Interleavings are placed, not timed: a hook runs after each statement the caller writes, and the
// settlement commits from its own connection exactly there.

const open: DisposableDb[] = [];
afterAll(async () => {
  for (const db of open) await db.close().catch(() => {});
});

const newKeyProvider = (): KeyProvider => localKeyProvider(randomBytes(32).toString('base64'));

async function seedProvider(d: DisposableDb, opts: { monthlyTokenBudget: number | null }): Promise<string> {
  const kp = newKeyProvider();
  const id = `aip_${randomBytes(16).toString('hex')}`;
  const sealed = await d.db.withWorkspace(d.workspace, (tx) => sealJson(tx, d.workspace, kp, { apiKey: 'test-key' }));
  await d.db.admin.query(
    `INSERT INTO ai_providers (workspace_id, id, name, kind, base_url, models, use_for, monthly_token_budget, secrets, secrets_key_id)
     VALUES ($1, $2, 'Scripted', 'openai-compatible', 'https://api.example.com/v1', $3::jsonb, ARRAY['agents'], $4, $5, $6)`,
    [d.workspace, id, JSON.stringify({ default: 'm' }), opts.monthlyTokenBudget, sealed.blob, sealed.keyId],
  );
  return id;
}

function context(d: DisposableDb, tx: CommandContext['tx']): CommandContext {
  return {
    principal: userPrincipal('user_test', d.workspace, 'owner'),
    tx,
    services: { serverVersion: 'test', strictInputs: true, keyProvider: newKeyProvider() },
    surface: 'internal',
  };
}

/** A row of a settled call, with the timestamps its month attribution depends on. */
async function insertCall(
  d: DisposableDb,
  input: { id: string; providerId: string; inputTokens: number; createdAt: string; billedAt: string },
) {
  await d.db.admin.query(
    `INSERT INTO ai_calls (workspace_id, id, kind, status, provider_id, model, input_tokens, output_tokens, created_at, billed_at, finished_at)
     VALUES ($1, $2, 'test', 'done', $3, 'm', $4, 0, ${input.createdAt}, ${input.billedAt}, now())`,
    [d.workspace, input.id, input.providerId, input.inputTokens],
  );
}

interface QueryClient {
  query: (...args: unknown[]) => Promise<unknown>;
  release: (err?: Error) => void;
}

/** Statements the command layer did not write: the transaction's own framing. */
const framing = (text: string) => /^\s*(BEGIN|COMMIT|ROLLBACK|SELECT set_config)\b/i.test(text);

/**
 * A hook after every statement that runs through `db`'s application pool, so a test can commit a
 * settlement at an exact point in a read. Returns the undo.
 */
function gateQueries(db: Db, after: (text: string, n: number) => Promise<void>): () => void {
  const pool = db.app as unknown as { connect(): Promise<QueryClient> };
  const connect = pool.connect.bind(pool);
  const statements: string[] = [];
  pool.connect = async () => {
    const client = await connect();
    const query = client.query.bind(client);
    client.query = async (...args: unknown[]) => {
      const result = await query(...args);
      const text = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string } | undefined)?.text ?? '');
      if (!framing(text)) {
        statements.push(text);
        await after(text, statements.length);
      }
      return result;
    };
    return client;
  };
  return () => {
    delete (pool as { connect?: unknown }).connect;
  };
}

describe.skipIf(!hasTestDatabase())('the monthly budget read', () => {
  it('counts a settlement that commits while the month is read: one snapshot, never neither', async () => {
    const d = await createDisposableDb('ai_budget_race');
    open.push(d);
    const providerId = await seedProvider(d, { monthlyTokenBudget: 1_000 });
    // A call in flight holds 700 tokens of the 1,000-token month.
    const reservation = await reserveTokens(d.db, d.workspace, providerId, 700);

    // Its settlement: the usage row and the hold's release in one committed transaction.
    const settle = async () => {
      const callId = `aic_${randomBytes(16).toString('hex')}`;
      const client = await d.db.admin.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO ai_calls (workspace_id, id, kind, status, provider_id, model, input_tokens, output_tokens, billed_at, finished_at)
           VALUES ($1, $2, 'test', 'done', $3, 'm', 700, 0, now(), now())`,
          [d.workspace, callId, providerId],
        );
        await client.query('DELETE FROM ai_token_reservations WHERE workspace_id = $1 AND id = $2', [d.workspace, reservation]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    };

    let settled = false;
    const undo = gateQueries(d.db, async () => {
      if (settled) return;
      settled = true;
      await settle();
    });
    let read: number;
    try {
      read = await d.db.withWorkspace(d.workspace, (tx) => usedThisMonth(tx, providerId));
    } finally {
      undo();
    }
    // The hold was live when the read began and the usage is committed now: either is 700, a gap is 0.
    expect(read).toBe(700);
    expect(settled).toBe(true);
    expect(await d.db.withWorkspace(d.workspace, (tx) => usedThisMonth(tx, providerId))).toBe(700);
    // The budget check reads the same way: what was settled is spent, so 400 more does not fit.
    await expect(reserveTokens(d.db, d.workspace, providerId, 400)).rejects.toMatchObject({ reason: 'budget' });
  });

  it('reads the month and its holds in one statement', async () => {
    const d = await createDisposableDb('ai_budget_snapshot');
    open.push(d);
    const providerId = await seedProvider(d, { monthlyTokenBudget: null });
    const statements: string[] = [];
    const undo = gateQueries(d.db, async (text) => {
      statements.push(text);
    });
    try {
      await d.db.withWorkspace(d.workspace, (tx) => usedThisMonth(tx, providerId));
    } finally {
      undo();
    }
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/ai_calls/);
    expect(statements[0]).toMatch(/ai_token_reservations/);
  });
});

describe.skipIf(!hasTestDatabase())('a crashed attempt’s hold', () => {
  it('still counts six minutes later, and the retry cannot spend that budget again', async () => {
    const d = await createDisposableDb('ai_crash_hold');
    open.push(d);
    const providerId = await seedProvider(d, { monthlyTokenBudget: 1_000 });
    const callId = `aic_${randomBytes(16).toString('hex')}`;
    await d.db.admin.query(
      `INSERT INTO ai_calls (workspace_id, id, kind, status, attempts, lease_until, provider_id)
       VALUES ($1, $2, 'test', 'running', 1, now() - interval '1 minute', $3)`,
      [d.workspace, callId, providerId],
    );
    // The attempt reserved before its model call and the process died before settling it.
    const reservation = await reserveTokens(d.db, d.workspace, providerId, 700, { callId });

    const [hold] = (
      await d.db.admin.query<{ call_id: string; expires_at: Date }>(
        'SELECT call_id, expires_at FROM ai_token_reservations WHERE workspace_id = $1 AND id = $2',
        [d.workspace, reservation],
      )
    ).rows;
    // The hold names its attempt and lasts past the old five-minute deadline.
    expect(hold?.call_id).toBe(callId);
    expect(hold?.expires_at.getTime()).toBeGreaterThan(Date.now() + 5 * 60_000);

    // Six minutes on, the month still counts the billed attempt.
    const sixMinutesLater = new Date(Date.now() + 6 * 60_000);
    expect(await d.db.withWorkspace(d.workspace, (tx) => usedThisMonth(tx, providerId, sixMinutesLater))).toBe(700);
    // And a retry of that attempt may not spend the same 700 tokens of the 1,000 again.
    await expect(reserveTokens(d.db, d.workspace, providerId, 700, { callId })).rejects.toMatchObject({ reason: 'budget' });
  });
});

describe.skipIf(!hasTestDatabase())('month attribution', () => {
  it('charges a call to the month it was billed, not the month it was queued', async () => {
    const d = await createDisposableDb('ai_billed_at');
    open.push(d);
    const providerId = await seedProvider(d, { monthlyTokenBudget: 1_000 });
    // Queued last month, billed today: this month's usage.
    await insertCall(d, {
      id: `aic_${randomBytes(16).toString('hex')}`,
      providerId,
      inputTokens: 400,
      createdAt: `now() - interval '40 days'`,
      billedAt: 'now()',
    });
    // Queued today, billed last month: last month's usage, and it must not be charged twice.
    await insertCall(d, {
      id: `aic_${randomBytes(16).toString('hex')}`,
      providerId,
      inputTokens: 900,
      createdAt: 'now()',
      billedAt: `now() - interval '40 days'`,
    });

    const listed = await d.db.withWorkspace(d.workspace, (tx) => listAiProviders.handler({}, context(d, tx)));
    expect(listed.providers[0]?.usedThisMonth).toBe(400);

    // The budget check agrees: 400 spent leaves room for 600, not for 700.
    await expect(reserveTokens(d.db, d.workspace, providerId, 700)).rejects.toMatchObject({ reason: 'budget' });
    expect(await reserveTokens(d.db, d.workspace, providerId, 600)).toMatch(/^rsv_/);

    // And the usage report puts the call on the day it was billed.
    const usage = await d.db.withWorkspace(d.workspace, (tx) => aiUsage.handler({ days: 7 }, context(d, tx)));
    expect(usage.days).toHaveLength(1);
    expect(usage.days[0]).toMatchObject({
      day: new Date().toISOString().slice(0, 10),
      kind: 'test',
      calls: 1,
      inputTokens: 400,
    });
  });
});
