import { AppError, canonicalJson, hashValue, redactCredentials, safeErrorText, sha256 } from '@agentic-seo/core';
import { type Db, schema, type Tx } from '@agentic-seo/db';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { IDEMPOTENCY_KEY_MAX, isValidIdempotencyKey } from './idempotency';
import {
  type ActionClass,
  type AgentCounters,
  autonomySettings,
  decide,
  estimateImpact,
  type Impact,
  type MandateView,
  type PolicyInput,
  type PolicyOutcome,
} from './policy';
import type { Permission, Principal } from './principal';
import { type AgentUndo, createUndoCollector, type UndoCollector } from './undo';
import { findUnknownInputKeys, type UnknownInputKey, unknownKeyMessages } from './unknownKeys';

// The command registry (ADR-0006): every capability is a command. REST, MCP and the typed UI
// client are generated from these definitions, and `execute` is the only way to run one, so
// validation, authorization, idempotency and audit cannot be skipped by any surface.

export type Effect = 'read' | 'write' | 'publish' | 'destructive';
/**
 * Where a request came in. `internal` is a path with no request behind it (a scheduler job, the
 * password reset a worker performs); `cli` is an operator running `aseo` on the host (#913).
 */
export type Surface = 'rest' | 'mcp' | 'scim' | 'internal' | 'cli';

/** One agent write, recorded in the action ledger; the server wires this once agents land (task C). */
export interface AgentActionEntry {
  agentId: string;
  command: string;
  actionClass: ActionClass;
  decision: PolicyOutcome['decision'];
  reasons: string[];
  impact: Impact;
  ok: boolean;
  error: string | null;
  target: string | null;
  surface: Surface;
  level: number | null;
  intent: string | null;
  undo: AgentUndo | null;
  /** The mandate version that decided, for the ledger. */
  mandateId?: string | null;
  mandateVersion?: number | null;
}

/** Extension point for dependencies commands need (key providers, clocks…). Packages augment it. */
export interface Services {
  /** Version of the running server, so command output can show it. */
  serverVersion: string;
  /** Whether unknown input keys are rejected rather than warned about. */
  strictInputs: boolean;
  /** Public URL of the server, so command output can carry admin deep links. */
  publicUrl?: string;
  /** The agent's active mandate; registered by the server through the artifacts package. */
  activeMandate?: (tx: Tx, agentId: string) => Promise<{ view: MandateView; outsideHours: string | null } | null>;
  /** What an agent did in the last 24 hours, from the ledger; wired by the server. */
  agentCounters?: (tx: Tx, agentId: string) => Promise<AgentCounters>;
  /** Records one agent write in the action ledger; wired by the server. */
  onAgentAction?: (tx: Tx, entry: AgentActionEntry) => Promise<void>;
}

export interface CommandContext {
  principal: Principal;
  tx: Tx;
  services: Services;
  /** The surface the command came in on, for commands that append their own audit entries. */
  surface?: Surface;
  /** Runs `fn` once the command's transaction has committed (e.g. to invalidate caches); errors are logged, not thrown. */
  afterCommit?: (fn: () => Promise<void>) => void;
  /** The policy engine's decision for an agent write (ADR-0006). "ask" means the change must wait for a person. */
  policy?: PolicyOutcome;
  /**
   * How to reverse what this handler does (ADR-0006 §5.4). Set it where the change goes live; the
   * executor records it in the agent ledger. Only agent writes keep it.
   */
  undo?: UndoCollector;
}

export interface CommandDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType, N extends string = string> {
  name: N;
  title: string;
  description: string;
  input: I;
  output: O;
  /** null only for internal commands that are not in the public registry (e.g. accepting an invitation). */
  permission: Permission | null;
  /**
   * A second permission (never for agents) that also runs the command when `allows` confirms the input
   * only touches the caller, e.g. an approver previewing a change set that cannot affect anyone else.
   */
  selfService?: {
    permission: Permission;
    allows: (input: z.output<I>, principal: Principal) => boolean;
  };
  effect: Effect;
  /** Agents may never run it, whatever their scopes (approving, managing members…). */
  humansOnly?: boolean;
  /**
   * What the command changes in the world (ADR-0006, design §3). Required for every write an agent
   * may run (a registry test checks it); people-only commands default from `effect`.
   */
  actionClass?: ActionClass;
  /** Estimates what one call would do (traffic at risk, URLs), before it runs. */
  impact?: (input: z.output<I>, ctx: CommandContext) => Promise<Impact>;
  /** The command can wait for an approval when the policy engine says "ask" (it reads ctx.policy). */
  approvable?: boolean;
  /** Top-level input fields that must never be hashed into the audit log or idempotency store (secret values). */
  sensitive?: readonly string[];
  /** Top-level output fields shown once (e.g. an invitation token): an idempotent replay returns them redacted. */
  sensitiveOutput?: readonly string[];
  /** Audit successful calls of a read command too (e.g. reads of personal data). Writes and all failures are always audited. */
  auditReads?: boolean;
  /**
   * The handler appends its own audit entries (one per item it changed) instead of the executor
   * appending one for the whole call. A call that throws is still audited by the executor.
   */
  auditsItself?: boolean;
  /**
   * Run the handler again when Postgres aborts its transaction as a deadlock victim. Set it only on
   * a write whose handler does everything inside the transaction: a rollback cannot take back a
   * call to a key service or a provider, and a second run would repeat it. Without it a deadlock
   * is answered with a conflict. Reads are always retried.
   */
  retryOnDeadlock?: boolean;
  /** What the command acts on, for the audit log (e.g. an artifact id). */
  target?: (input: z.output<I>) => string | undefined;
  /**
   * What the audit log records as the target when the id is only known after the handler ran, e.g.
   * a freshly created token or invitation, or the row a lookup resolved (#763). Falls back to
   * `target` when it returns undefined.
   */
  auditTarget?: (output: z.output<O>) => string | undefined;
  /**
   * For a read that reached many targets (a list of pages, a sample): one audit entry per id, so
   * `audit.list` can answer "who accessed which row". The audit schema records a single target per
   * entry and has no details column, so the list becomes its own entries: deduplicated and capped
   * at {@link MAX_AUDIT_TARGETS} per call. Ignored for writes, whose audit row names what the write
   * changed.
   */
  auditTargets?: (output: z.output<O>) => readonly string[];
  /**
   * Facts about what the handler created, merged into the agent ledger's impact. The ledger is
   * written after the handler so it can link the action to the rows it produced.
   */
  ledgerImpact?: (output: z.output<O>) => Record<string, unknown> | undefined;
  handler: (input: z.output<I>, ctx: CommandContext) => Promise<z.input<O>>;
}

export function defineCommand<N extends string, I extends z.ZodType, O extends z.ZodType>(def: CommandDef<I, O, N>) {
  return def;
}

/** A command's class: declared, or derived from its effect for people-only commands. */
export function actionClassOf(cmd: Pick<AnyCommand, 'actionClass' | 'effect'>): ActionClass {
  if (cmd.actionClass) return cmd.actionClass;
  if (cmd.effect === 'read') return 'read';
  if (cmd.effect === 'destructive') return 'destructive';
  return 'settings';
}

/**
 * The registry's action-class rule (ADR-0006): every write an agent may run declares what it
 * changes in the world. The server's registry test calls this with its command list; a missing
 * class fails the build, so the policy engine never has to guess.
 */
export function missingActionClasses(commands: readonly AnyCommand[]): string[] {
  return commands.filter((c) => c.permission && !c.humansOnly && c.effect !== 'read' && !c.actionClass).map((c) => c.name);
}

/** The policy engine's refusal, with its reasons for the caller. */
export class PolicyDeniedError extends AppError {
  constructor(readonly outcome: PolicyOutcome) {
    super('forbidden', outcome.reasons.join(' '), { decision: 'deny', actionClass: outcome.actionClass, reasons: outcome.reasons });
  }
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous command lists
export type AnyCommand = CommandDef<any, any, string>;

export interface ExecuteOptions {
  surface: Surface;
  idempotencyKey?: string;
}

export interface ExecutorOptions {
  /** Reject unknown input keys instead of ignoring them with a warning (strict input mode). */
  strictInputs?: boolean;
  /** Called with the unknown keys a non-strict executor ignored, e.g. to log and persist them. */
  onUnknownKeys?: (command: string, unknown: UnknownInputKey[], principal: Principal) => void;
  /**
   * Called once after every command execution, with its outcome, so a host can count and time
   * commands (e.g. the server's `/metrics`). Purely a callback: this package depends on no
   * metrics library, and a throwing callback never changes the command's result.
   */
  onCommand?: (event: { command: string; effect: Effect; outcome: 'ok' | 'error'; durationMs: number }) => void;
}

const tracer = trace.getTracer('@agentic-seo/commands');

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Adds the unknown-key warnings to a command result without overwriting a command's own warnings. */
function withInputWarnings<T>(out: T, messages: string[]): T {
  if (!messages.length || !isPlainObject(out)) return out;
  const existing = out.warnings;
  if (existing === undefined) return { ...out, warnings: messages };
  // Some commands (artifacts.create/updateDraft) use warnings for structured draft findings; keep those.
  if (Array.isArray(existing) && existing.every((warning) => typeof warning === 'string'))
    return { ...out, warnings: [...existing, ...messages] };
  return out;
}

function redact(input: unknown, fields?: readonly string[]) {
  if (!fields?.length || !input || typeof input !== 'object') return input;
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, fields.includes(k) ? '[redacted]' : v]));
}

/**
 * How many targets one audited read may name in the audit log (#763). A page is bounded already;
 * the cap keeps a large unfiltered read from adding an unbounded chain of rows. The first ids in
 * the output's own order are recorded, so the rows cover what the caller saw.
 */
export const MAX_AUDIT_TARGETS = 50;

/** The targets of one audited read: its single target first, then the extras, deduplicated and capped. */
function auditTargetList(single: string | undefined, extra: readonly string[]): (string | undefined)[] {
  const out: (string | undefined)[] = [];
  for (const candidate of [single, ...extra]) {
    if (candidate === undefined || out.includes(candidate)) continue;
    if (out.length >= MAX_AUDIT_TARGETS) break;
    out.push(candidate);
  }
  return out.length ? out : [undefined];
}

/**
 * Appends one entry to a workspace's audit log, keeping its hash chain. The executor calls this for
 * every command; a command that records several items itself calls it directly and declares
 * `auditsItself`.
 */
/**
 * What the audit log records about a failure: an AppError's code and message, or, for an
 * unexpected exception, a fixed internal marker. The original exception is never written to the
 * log (it can carry SQL, secrets or stack details); it stays on the span for diagnostics.
 */
export type AuditedError = { code: string; message: string };
const UNEXPECTED_FAILURE: AuditedError = { code: 'internal', message: 'The command failed with an unexpected error.' };

/**
 * The sanitised copy of an AppError (#885): its message redacted while it is still complete, so a
 * command that built it from a provider's answer or an exception cannot leak a credential to the
 * caller, the audit log or the agent ledger. The executor is the last line of defence: it sanitises
 * once, here, rather than trusting every message a handler writes. An error with nothing to redact
 * is returned untouched, so its identity (and a PolicyDeniedError's outcome) survives.
 */
export function sanitizeAppError(err: AppError): AppError {
  const message = redactCredentials(err.message);
  if (err instanceof PolicyDeniedError) {
    const reasons = err.outcome.reasons.map(redactCredentials);
    const changed = message !== err.message || reasons.some((r, i) => r !== err.outcome.reasons[i]);
    return changed ? new PolicyDeniedError({ ...err.outcome, reasons }) : err;
  }
  return message === err.message ? err : new AppError(err.code, message, err.details);
}

export async function appendAuditEntry(
  tx: Tx,
  p: Principal,
  surface: Surface,
  cmd: { name: string; effect: string },
  inputHash: string,
  target: string | undefined,
  error?: AuditedError,
  ip?: string | null,
) {
  // Serialise appends per workspace so the hash chain never forks under concurrency.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`audit:${p.workspaceId}`}, 0))`);
  const [prev] = await tx
    .select({ hash: schema.auditLog.hash })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.workspaceId, p.workspaceId))
    .orderBy(desc(schema.auditLog.seq))
    .limit(1);
  const entry = {
    workspaceId: p.workspaceId,
    principalType: p.type,
    principalId: p.userId,
    clientId: p.clientId ?? null,
    surface,
    command: cmd.name,
    effect: cmd.effect,
    target: target ?? null,
    inputHash,
    ok: !error,
    error: error ? `${error.code}: ${error.message}` : null,
    prevHash: prev?.hash ?? null,
    ...(ip ? { ip } : {}),
  };
  await tx.insert(schema.auditLog).values({ ...entry, hash: sha256(canonicalJson(entry)) });
}

export function createExecutor(db: Db, services: Services, options: ExecutorOptions = {}) {
  const appendAudit = (
    tx: Tx,
    p: Principal,
    surface: Surface,
    cmd: AnyCommand,
    inputHash: string,
    target: string | undefined,
    error?: AuditedError,
  ) => appendAuditEntry(tx, p, surface, cmd, inputHash, target, error);

  /** Validate → authorize → idempotency → handler → validate output → audit (writes and failures), in one transaction. */
  async function execute<C extends AnyCommand>(
    cmd: C,
    rawInput: unknown,
    principal: Principal,
    opts: ExecuteOptions,
  ): Promise<z.output<C['output']>> {
    return tracer.startActiveSpan(`command ${cmd.name}`, async (span) => {
      span.setAttributes({
        'command.name': cmd.name,
        'command.effect': cmd.effect,
        'command.surface': opts.surface,
        'principal.type': principal.type,
      });
      const input = rawInput ?? {};
      const inputHash = hashValue(redact(input, cmd.sensitive));
      let target: string | undefined;
      /** Targets an audited read reached besides `target` (#763); one audit row each. */
      let extraTargets: readonly string[] = [];
      const startedAt = Date.now();
      // Metrics or logging hooks are observers: they must never fail a command or mask its error.
      const report = (outcome: 'ok' | 'error') => {
        try {
          options.onCommand?.({ command: cmd.name, effect: cmd.effect, outcome, durationMs: Date.now() - startedAt });
        } catch {
          // Ignored on purpose.
        }
      };
      const unknown = findUnknownInputKeys(cmd.input, input);
      const unknownMessages = unknownKeyMessages(cmd.name, unknown);

      const fail = async (err: AppError): Promise<never> => {
        // Every AppError leaving the executor is redacted first (#885): the message may have been
        // assembled from a provider body or an exception, and it is about to be returned to the
        // caller and written to the audit log.
        const safe = sanitizeAppError(err);
        // The main transaction rolled back; record the failed attempt in its own.
        await db.withWorkspace(principal.workspaceId, (tx) => appendAudit(tx, principal, opts.surface, cmd, inputHash, target, safe));
        report('error');
        span.setStatus({ code: SpanStatusCode.ERROR, message: safe.code });
        span.end();
        throw safe;
      };

      if (unknown.length) {
        if (options.strictInputs) return fail(new AppError('invalid_input', unknownMessages.join(' '), { unknownKeys: unknown }));
      }
      const parsed = cmd.input.safeParse(input);
      if (!parsed.success)
        return fail(new AppError('invalid_input', 'The input does not match the command schema.', z.treeifyError(parsed.error)));
      if (unknown.length) options.onUnknownKeys?.(cmd.name, unknown, principal);
      target = cmd.target?.(parsed.data);
      if (cmd.humansOnly && principal.type !== 'user')
        return fail(new AppError('forbidden', `${cmd.name} can only be run by a person, not by an agent.`));
      if (cmd.permission && !principal.permissions.has(cmd.permission)) {
        const selfService =
          principal.type === 'user' &&
          cmd.selfService !== undefined &&
          principal.permissions.has(cmd.selfService.permission) &&
          cmd.selfService.allows(parsed.data, principal);
        if (!selfService)
          return fail(
            new AppError(
              'forbidden',
              principal.type === 'agent'
                ? `This agent was not granted the "${cmd.permission}" permission. The person can grant it when connecting the agent.`
                : `Your role (${principal.role}) does not include the "${cmd.permission}" permission.`,
            ),
          );
      }

      const agent = principal.type === 'agent' ? principal.agent : undefined;
      // Fail closed. The type requires an identity, but a token or OAuth client is built from stored
      // data, so a principal that lost its agent row must not slip past the policy engine: reads
      // stay available, anything that changes something needs the identity the policy judges.
      if (principal.type === 'agent' && !agent) {
        if (cmd.effect !== 'read')
          return fail(
            new AppError(
              'forbidden',
              `${cmd.name} needs an agent identity: this credential is an agent without one, so it may only run read commands. Reconnect the agent.`,
            ),
          );
      }
      if (agent && agent.status !== 'active')
        return fail(
          new AppError(
            'forbidden',
            `This agent (${agent.name}) is ${agent.status}${agent.statusReason ? `: ${agent.statusReason}` : ''}. ${
              agent.status === 'paused' ? 'A person can resume it in Settings → Agents.' : 'Its credentials no longer work.'
            }`,
          ),
        );

      // An empty key is present but means nothing: refuse it instead of silently running without a
      // key, or a retry could execute twice (#906).
      if (opts.idempotencyKey !== undefined && !isValidIdempotencyKey(opts.idempotencyKey))
        return fail(
          new AppError('invalid_input', `An idempotency key must be 1 to ${IDEMPOTENCY_KEY_MAX} printable characters without spaces.`),
        );

      // An idempotency key is scoped to the caller as well as the workspace (#906): a person is
      // their user id (the same across sessions); an agent is its agent record, and an API token or
      // OAuth connection is its own agent. The audit log keeps the call's `inputHash`; the
      // idempotency row stores this principal-bound hash instead. Derived here, after the
      // missing-record guard: a read from such an agent is supported and must not dereference
      // `principal.agent`, so it is named by its client id and user id instead.
      const idempotencyHash = opts.idempotencyKey ? hashValue({ principal: callerIdentity(principal), input: inputHash }) : inputHash;

      const committed: (() => Promise<void>)[] = [];
      let policy: PolicyOutcome | undefined;
      try {
        const inputTarget = target;
        const result = await retrySnapshotConflicts(
          cmd.effect === 'read',
          () =>
            db.withWorkspace(
              principal.workspaceId,
              async (tx) => {
                committed.length = 0;
                policy = undefined;
                // A rolled-back attempt may have named what it created; that no longer exists.
                target = inputTarget;
                extraTargets = [];
                // The idempotency key's lock is the first lock any command takes. It serialises
                // retries of one (workspace, key) before the lookup: two concurrent requests must
                // not both miss and both run the handler; the second waits here, then sees the
                // response the first committed. Keyed by workspace + key only (#906): every caller
                // presenting one key serialises before any handler runs, or two callers could both
                // run handlers and the loser's external effects would survive its rolled-back
                // transaction. The caller is still bound by `idempotencyHash`: after the lock,
                // another caller's row is a reused conflict. It comes before the agent-policy lock
                // below because handlers (agents.pause, approvals.approve) take agent-policy locks
                // themselves: taking this one later would let an agent write and a person's command
                // sharing a key lock in opposite orders and deadlock.
                if (opts.idempotencyKey)
                  await tx.execute(
                    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`idempotency:${principal.workspaceId}:${opts.idempotencyKey}`}, 0))`,
                  );
                // The agent-policy lock comes first for every agent write (#907, #922): before a
                // command's `impact`, which may lock artifacts. See lockAgentPolicy for the one
                // global order; a path that takes these locks the other way round can deadlock.
                if (agent && cmd.effect !== 'read') await lockAgentPolicy(tx, principal.workspaceId, agent.id);
                // The agent was resolved when the request began; a pause or revoke committed since
                // then stops this command too (#275). Read under the lock above, so a pause that
                // commits first is seen and one that commits after waits for this command.
                if (agent) {
                  const [current] = await tx
                    .select({ status: schema.agents.status, statusReason: schema.agents.statusReason })
                    .from(schema.agents)
                    .where(and(eq(schema.agents.workspaceId, principal.workspaceId), eq(schema.agents.id, agent.id)));
                  if (current && current.status !== 'active')
                    throw new AppError(
                      'forbidden',
                      `This agent (${agent.name}) is ${current.status}${current.statusReason ? `: ${current.statusReason}` : ''}. ${
                        current.status === 'paused' ? 'A person can resume it in Settings → Agents.' : 'Its credentials no longer work.'
                      }`,
                    );
                }
                // The idempotency replay comes before the policy engine (#930). A retry of a write
                // that already ran must answer the stored response: re-deciding would count the
                // first action against the limits, could refuse the retry, and would bill a second
                // check. Authentication, permission, the missing-record guard, input validation and
                // this agent's status (under the lock above) still ran, so a paused or revoked agent
                // gets its usual refusal instead of a replay.
                if (opts.idempotencyKey) {
                  const [hit] = await tx
                    .select()
                    .from(schema.idempotencyKeys)
                    .where(
                      and(
                        eq(schema.idempotencyKeys.workspaceId, principal.workspaceId),
                        eq(schema.idempotencyKeys.key, opts.idempotencyKey),
                      ),
                    );
                  if (hit) {
                    // `idempotencyHash` binds the caller too, so another principal presenting the
                    // key is a conflict, never the first caller's stored response.
                    if (hit.command !== cmd.name || hit.inputHash !== idempotencyHash)
                      throw new AppError('conflict', 'This idempotency key was already used for a different request. Use a new key.', {
                        reason: 'idempotency_key_reused',
                      });
                    const replay = hit.response as z.output<C['output']>;
                    // A replay returns before the handler, so computing targets only on the handler
                    // path left the replay's audit row without them (#905). Compute them from the
                    // stored response the same way. Every audited read stores its full output: the
                    // commands with `auditTarget`/`auditTargets` and a `sensitiveOutput` are writes,
                    // and the reads' targets are plain ids, so redaction never removes them.
                    target = cmd.auditTarget?.(replay) ?? target;
                    if (cmd.effect === 'read' && cmd.auditTargets) extraTargets = cmd.auditTargets(replay);
                    return replay;
                  }
                }
                // ADR-0006: every agent write passes the policy engine before the handler runs.
                if (agent && cmd.effect !== 'read') {
                  const impact = cmd.impact
                    ? await cmd.impact(parsed.data, { principal, tx, services })
                    : await estimateImpact({
                        command: cmd.name,
                        actionClass: actionClassOf(cmd),
                        input: parsed.data,
                      });
                  policy = await agentPolicy(tx, services, principal, {
                    command: cmd.name,
                    actionClass: impact.actionClass ?? actionClassOf(cmd),
                    impact,
                    approvable: cmd.approvable === true,
                  });
                  if (policy.decision === 'deny') throw new PolicyDeniedError(policy);
                }
                const undo = createUndoCollector();
                const out = withInputWarnings(
                  cmd.output.parse(
                    await cmd.handler(parsed.data, {
                      principal,
                      tx,
                      services,
                      surface: opts.surface,
                      policy,
                      undo,
                      afterCommit: (fn) => committed.push(fn),
                    }),
                  ),
                  unknownMessages,
                ) as z.output<C['output']>;
                // The handler ran: let it link the ledger row to what it created, while the policy
                // decision itself stays the one made before the change.
                if (agent && policy && cmd.ledgerImpact) {
                  const extra = cmd.ledgerImpact(out);
                  if (extra) policy = { ...policy, impact: { ...policy.impact, ...extra } };
                }
                if (opts.idempotencyKey)
                  try {
                    await tx.insert(schema.idempotencyKeys).values({
                      workspaceId: principal.workspaceId,
                      key: opts.idempotencyKey,
                      command: cmd.name,
                      inputHash: idempotencyHash,
                      response: redact(out, cmd.sensitiveOutput) as object,
                    });
                  } catch (err) {
                    // Two different principals can use one key; the unique (workspace, key) decides
                    // when they do not serialise after all. The loser's whole transaction rolls back
                    // and answers the same clean conflict as a sequential reuse, never a 500 or a
                    // silent second run.
                    if (isIdempotencyKeyConflict(err))
                      throw new AppError('conflict', 'This idempotency key was already used for a different request. Use a new key.', {
                        reason: 'idempotency_key_reused',
                      });
                    throw err;
                  }
                // A read's target can only come from its output too (#763): a lookup resolves the
                // thing it found, a list returns the rows it showed.
                target = cmd.auditTarget?.(out) ?? target;
                if (cmd.effect === 'read' && cmd.auditTargets) extraTargets = cmd.auditTargets(out);
                if (cmd.effect !== 'read' && !cmd.auditsItself) await appendAudit(tx, principal, opts.surface, cmd, inputHash, target);
                if (agent && policy && services.onAgentAction)
                  await services.onAgentAction(tx, {
                    agentId: agent.id,
                    command: cmd.name,
                    actionClass: policy.actionClass,
                    decision: policy.decision,
                    // Reasons quote names, inputs and exceptions, and this column is exposed to
                    // readers, so they are redacted before they are stored (#885).
                    reasons: policy.reasons.map(redactCredentials),
                    impact: policy.impact,
                    ok: true,
                    error: null,
                    target: target ?? null,
                    surface: opts.surface,
                    level: policy.level ?? null,
                    intent: intentOf(parsed.data),
                    undo: undo.get(),
                    mandateId: policy.mandate?.id ?? null,
                    mandateVersion: policy.mandate?.version ?? null,
                  });
                return out;
              },
              // Reads see one consistent snapshot; writes keep read-committed so their locks see the latest rows.
              // An idempotent request also runs read-committed: its key lock may wait for another
              // request, and only a statement snapshot taken after the wait sees the committed key.
              { snapshot: cmd.effect === 'read' && !opts.idempotencyKey },
            ),
          cmd.effect === 'read' || cmd.retryOnDeadlock === true,
        );
        // An audited read is recorded in its own transaction: the hash chain must be appended under
        // its lock with the latest entries visible, which a snapshot taken earlier would not show.
        // A read that reached several targets gets one entry per target (#763).
        if (cmd.effect === 'read' && cmd.auditReads)
          await db.withWorkspace(principal.workspaceId, async (tx) => {
            for (const readTarget of auditTargetList(target, extraTargets))
              await appendAudit(tx, principal, opts.surface, cmd, inputHash, readTarget);
          });
        for (const fn of committed) await fn().catch((err) => span.recordException(err as Error));
        report('ok');
        span.end();
        return result;
      } catch (thrown) {
        // A known scheduling conflict takes the AppError path once, so the ledger and the audit log
        // record the readable conflict instead of an internal failure (#867, #871, #912).
        const conflict = knownConflict(thrown);
        if (conflict) span.recordException(thrown as Error);
        const err = conflict ?? thrown;
        // An AppError is written for a person; anything else is unexpected and its text may carry
        // SQL, secrets or driver details, so the ledger stores the same fixed failure as the audit
        // log. The original exception stays on the span for diagnostics. An AppError's own message
        // is redacted before it is stored (#885): it may name a credential a provider echoed.
        const safe = err instanceof AppError ? sanitizeAppError(err) : null;
        const failure = safe ? safe.message : UNEXPECTED_FAILURE.message;
        // The transaction rolled back: keep the agent's attempt (a refusal or a failed write) in the ledger.
        if (agent && policy && services.onAgentAction)
          await db
            .withWorkspace(principal.workspaceId, (tx) =>
              services.onAgentAction!(tx, {
                agentId: agent.id,
                command: cmd.name,
                actionClass: policy!.actionClass,
                decision: policy!.decision,
                reasons: policy!.reasons.map(redactCredentials),
                impact: policy!.impact,
                ok: false,
                // Redacted before it is cut (#885): the column is exposed to readers.
                error: safeErrorText(failure, 1000),
                target: target ?? null,
                surface: opts.surface,
                level: policy!.level ?? null,
                intent: intentOf(parsed.data),
                undo: null,
                mandateId: policy!.mandate?.id ?? null,
                mandateVersion: policy!.mandate?.version ?? null,
              }),
            )
            .catch((e) => span.recordException(e as Error));
        if (safe) return fail(safe);
        // An unexpected exception is audited too (as a sanitized internal failure): a write that
        // failed must leave a trace whatever the cause.
        await db
          .withWorkspace(principal.workspaceId, (tx) =>
            appendAudit(tx, principal, opts.surface, cmd, inputHash, target, UNEXPECTED_FAILURE),
          )
          .catch((e) => span.recordException(e as Error));
        report('error');
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        throw err;
      }
    });
  }

  return { execute };
}

export type Executor = ReturnType<typeof createExecutor>;

/**
 * The policy decision for one agent write (ADR-0006): the workspace settings, the agent's active
 * mandate, and its counters. Used by the executor for every command. Holds a per-agent transaction
 * lock first, so two concurrent requests from the same agent cannot both read counters below a
 * limit and both run.
 */
/**
 * What the other agents have on the artifacts this action changes, before the policy engine
 * decides: the owner of an artifact when it belongs to another agent, and any pending change (an
 * open approval request) from a different agent. The executor only calls this for changes beyond a
 * draft; people never reach it. The artifact rows are locked for update (in id order) so the
 * decision and the write see the same owner, and `artifacts.setOwner` cannot slip between them.
 */
export async function coordinationFor(
  tx: Tx,
  workspaceId: string,
  agentId: string,
  actionClass: ActionClass,
  impact: Impact,
): Promise<{ ownership: NonNullable<PolicyInput['ownership']> | null; conflicts: string[] }> {
  const touched = impact.touches?.artifacts ?? [];
  if (!touched.length || actionClass === 'draft' || actionClass === 'read') return { ownership: null, conflicts: [] };
  const ids = [...new Set(touched.map((a) => a.id))];
  const rows = await tx
    .select({ id: schema.artifacts.id, name: schema.artifacts.name, ownerAgentId: schema.artifacts.ownerAgentId })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.workspaceId, workspaceId), inArray(schema.artifacts.id, ids)))
    .orderBy(asc(schema.artifacts.id))
    .for('update');
  const names = new Map(rows.map((a) => [a.id, a.name]));

  let ownership: NonNullable<PolicyInput['ownership']> | null = null;
  for (const a of rows) {
    if (!a.ownerAgentId || a.ownerAgentId === agentId) continue;
    const [owner] = await tx
      .select({ id: schema.agents.id, name: schema.agents.name, status: schema.agents.status })
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.id, a.ownerAgentId)));
    const candidate: NonNullable<PolicyInput['ownership']> = {
      agentId: a.ownerAgentId,
      // A deleted owner is reported as retired; it never blocks.
      agentName: owner?.name ?? 'a retired agent',
      active: owner?.status === 'active',
      artifactId: a.id,
      artifactName: a.name,
    };
    // An active owner anywhere is the one worth explaining; keep the first if all are inactive.
    if (!ownership || (candidate.active && !ownership.active)) ownership = candidate;
    if (ownership.active) break;
  }

  // Pending approvals from another agent on the same artifacts. The requesting agent comes from
  // the credential the request recorded, exactly as approval looks it up.
  const pending = await tx.execute<{ artifact_id: string; hold_until: Date | string | null; agent_name: string }>(sql`
    SELECT ar.artifact_id, ar.hold_until, a.name AS agent_name
    FROM approval_requests ar
    JOIN agent_credentials c ON c.workspace_id = ar.workspace_id AND (
      (c.kind = 'api_token' AND ar.requested_by_client = 'token:' || c.credential_id)
      OR (c.kind = 'oauth_client' AND ar.requested_by_client = c.credential_id))
    JOIN agents a ON a.workspace_id = c.workspace_id AND a.id = c.agent_id
    WHERE ar.workspace_id = ${workspaceId}
      AND ar.status = 'pending' AND ar.requested_by_type = 'agent'
      AND ar.artifact_id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
      AND a.id <> ${agentId}
    ORDER BY ar.created_at`);
  const conflicts: string[] = [];
  const seen = new Set<string>();
  for (const row of pending.rows) {
    const key = `${row.artifact_id}:${row.agent_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = names.get(row.artifact_id) ? `“${names.get(row.artifact_id)}”` : row.artifact_id;
    const until = row.hold_until ? new Date(row.hold_until) : null;
    const what =
      until && until > new Date()
        ? `a hold until ${until.toISOString()}`
        : until
          ? 'a hold whose veto window has ended and now waits for a person'
          : 'an open approval request';
    conflicts.push(`${label} already has ${what} from agent ${row.agent_name}.`);
  }
  return { ownership, conflicts };
}

/**
 * The policy decision for one agent write (ADR-0006): the workspace settings, the agent's active
 * mandate, its counters and what other agents have on the same artifacts. Used by the executor for
 * every command. Holds a per-agent transaction lock first, so two concurrent requests from the same
 * agent cannot both read counters below a limit and both run.
 */
export async function agentPolicy(
  tx: Tx,
  services: Services,
  principal: Principal,
  req: { command: string; actionClass: ActionClass; impact: Impact; approvable: boolean },
): Promise<PolicyOutcome> {
  const agent = principal.agent;
  if (!agent) throw new Error('agentPolicy needs an agent principal');
  await lockAgentPolicy(tx, principal.workspaceId, agent.id);
  const [ws] = await tx.select({ settings: schema.workspaces.settings }).from(schema.workspaces);
  const mandate = req.actionClass === 'read' ? null : ((await services.activeMandate?.(tx, agent.id)) ?? null);
  const counters = (await services.agentCounters?.(tx, agent.id)) ?? { changes: 0 };
  const coordination = await coordinationFor(tx, principal.workspaceId, agent.id, req.actionClass, req.impact);
  const policy = decide({
    command: req.command,
    actionClass: req.actionClass,
    impact: req.impact,
    settings: autonomySettings(ws?.settings),
    counters,
    approvable: req.approvable,
    ...(coordination.ownership ? { ownership: coordination.ownership } : {}),
    ...(coordination.conflicts.length ? { conflicts: coordination.conflicts } : {}),
    ...(mandate ? { mandate: mandate.view } : {}),
  });
  // Holds and veto windows arrive in Phase 7. Until then an L2 decision keeps its level and reasons
  // but is degraded to an ordinary approval request, so nothing runs without a person.
  if (policy.decision === 'hold')
    return redactPolicyReasons({ ...policy, decision: 'ask', reasons: [...policy.reasons, 'Holds arrive in Phase 7.'] });
  return redactPolicyReasons(policy);
}

/**
 * The policy with its reasons credential-redacted. Reasons quote names, inputs and exceptions, and
 * they leave here for a successful response, the approval note and the agent ledger, none of which
 * pass through AppError sanitising, so they are redacted once, where the policy is made (#885).
 * Unchanged when clean.
 */
export function redactPolicyReasons(policy: PolicyOutcome): PolicyOutcome {
  const reasons = policy.reasons.map(redactCredentials);
  return reasons.some((r, i) => r !== policy.reasons[i]) ? { ...policy, reasons } : policy;
}

/**
 * The caller an idempotency key belongs to (#906): a person is their user id (the same across
 * sessions); an agent is its agent record, and an API token or OAuth connection is its own agent.
 * A read from an agent without a record (supported) is named by its client id and user id.
 */
export function callerIdentity(principal: Principal) {
  if (principal.type === 'user') return { kind: 'user' as const, userId: principal.userId };
  // A surface may build an agent principal without its record (the executor refuses its writes but
  // supports its reads), which the union does not model; read the fields defensively.
  const agent = principal.agent as { id: string } | undefined;
  if (agent) return { kind: 'agent' as const, agentId: agent.id };
  const unregistered = principal as { clientId?: string; userId?: string };
  // Named fields, never one joined string: an unregistered agent's client id and user id are
  // separate values, so `{userId: 'alice'}` cannot hash like `{clientId: 'alice', userId: 'bob'}`.
  return { kind: 'agent-unregistered' as const, clientId: unregistered.clientId ?? null, userId: unregistered.userId ?? null };
}

/**
 * The per-agent transaction lock that serialises every decision about one agent's writes: the
 * policy engine and a person's pause/resume/revoke, so a pause or a refusal committed by one is
 * visible to the other and cannot interleave with it (#240, #907).
 *
 * THE ONE LOCK ORDER on these paths, everywhere:
 *   0. the idempotency key's lock (the executor, before anything else),
 *   1. this agent-policy lock,
 *   2. approval_requests rows (`lockApproval`),
 *   3. singleton and artifact-id advisory locks, each sorted (`config.import`, `artifacts.create`),
 *   4. artifact rows in id order (`lockArtifacts`, `coordinationFor`),
 *   5. agent-mandate locks, sorted (`lockMandateAgents`, also inside `publishVersion`).
 * Take it before a command's `impact`, before any status read that gates a write, and before
 * approval or artifact locks. The executor (agent writes), `approvals.approve` (an agent's request)
 * and `agents.pause`/`resume`/`revoke` follow this order; a path that needs two of these locks must
 * not take them the other way round.
 *
 * Transaction-scoped and reentrant; the key string must stay identical everywhere.
 */
export async function lockAgentPolicy(tx: Tx, workspaceId: string, agentId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-policy:${workspaceId}:${agentId}`}, 0))`);
}

/** What the agent said it is doing: an explicit intent, else the reviewer note or reason most commands take. */
function intentOf(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  for (const key of ['intent', 'note', 'reason']) if (typeof i[key] === 'string' && i[key]) return i[key] as string;
  return null;
}

/**
 * A read runs in a repeatable-read snapshot. The few writes a read can make (a workspace's data
 * key, created on first use) fail with a serialization error when another transaction wrote the
 * same row after the snapshot began, and the snapshot cannot see the winner. Run the read again
 * in a fresh snapshot, which does: twice at most.
 */
export async function retrySnapshotConflicts<T>(isRead: boolean, run: () => Promise<T>, retryDeadlock = isRead): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      // A deadlock victim was rolled back whole, so a command that works only inside its
      // transaction can run again (`retryOnDeadlock`). Commands take their locks in a fixed order;
      // this is for the orders nobody thought of. Either way the caller gets a conflict, not a 500.
      if (isDeadlock(err)) {
        if (retryDeadlock && attempt < 2) continue;
        throw new AppError('conflict', 'Another change to the same data was in progress. Nothing was changed; try again.');
      }
      if (!isRead || attempt >= 2 || !isSerializationFailure(err)) throw err;
    }
  }
}

/** Postgres SQLSTATE 40P01 (this transaction was chosen as the deadlock victim), directly or as a cause. */
export function isDeadlock(err: unknown): boolean {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined, depth = 0; e && depth < 5; e = e.cause as typeof e, depth++)
    if (e.code === '40P01') return true;
  return false;
}

/** Postgres SQLSTATE 40001, directly or as the cause of a Drizzle query error. */
export function isSerializationFailure(err: unknown): boolean {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined, depth = 0; e && depth < 5; e = e.cause as typeof e, depth++)
    if (e.code === '40001') return true;
  return false;
}

/**
 * A caught failure the executor answers as a readable conflict rather than an internal failure. A
 * deadlock is a scheduling conflict, not a server fault (#871): the work rolled back and the same
 * request can safely run again, so it is retried where the command allows it and answered as a
 * conflict otherwise. A singleton writer or a publish that raced another still reaches the partial
 * unique indexes (#867, #912): answer conflict, not a 500, and say what to do next. Mapped before
 * the ledger and audit so both record the readable conflict once, like any other AppError.
 */
function knownConflict(err: unknown): AppError | null {
  if (isDeadlock(err))
    return new AppError('conflict', 'Another change locked the same artifacts at the same time. Retry this action; nothing was written.', {
      retryable: true,
    });
  if (isSingletonConflict(err))
    return new AppError(
      'conflict',
      'This workspace already has an artifact of that type: another change created it at the same time. Nothing was written; retry and edit the existing artifact.',
    );
  if (isOnePublishedConflict(err))
    return new AppError(
      'conflict',
      'This artifact already has a published version: another change published one at the same time. Nothing was written; retry, then edit and publish the latest draft.',
    );
  return null;
}

/** Postgres 23505 on the unique index `index`, directly or as the cause of a query error. */
function uniqueViolationOn(err: unknown, index: string): boolean {
  for (
    let e = err as { code?: unknown; constraint?: unknown; cause?: unknown } | undefined, depth = 0;
    e && depth < 5;
    e = e.cause as typeof e, depth++
  )
    if (e.code === '23505' && e.constraint === index) return true;
  return false;
}

/** Postgres 23505 on the idempotency primary key, directly or as the cause of a query error. */
function isIdempotencyKeyConflict(err: unknown): boolean {
  return uniqueViolationOn(err, 'idempotency_keys_pkey');
}

/** Postgres 23505 on the singleton partial unique index, directly or as the cause of a query error. */
export function isSingletonConflict(err: unknown): boolean {
  return uniqueViolationOn(err, 'artifacts_singleton_type');
}

/** Postgres 23505 on the one-published-version partial unique index (#912). */
export function isOnePublishedConflict(err: unknown): boolean {
  return uniqueViolationOn(err, 'artifact_versions_one_published');
}
