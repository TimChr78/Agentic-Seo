import { AppError, canonicalJson, hashValue, sha256 } from '@agentic-seo/core';
import { type Db, schema, type Tx } from '@agentic-seo/db';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
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
export type Surface = 'rest' | 'mcp' | 'scim' | 'internal';

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
  /** What the command acts on, for the audit log (e.g. an artifact id). */
  target?: (input: z.output<I>) => string | undefined;
  /**
   * What the audit log records as the target when the id is only known after the handler ran, e.g.
   * a freshly created token or invitation. Falls back to `target` when it returns undefined.
   */
  auditTarget?: (output: z.output<O>) => string | undefined;
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
        // The main transaction rolled back; record the failed attempt in its own.
        await db.withWorkspace(principal.workspaceId, (tx) => appendAudit(tx, principal, opts.surface, cmd, inputHash, target, err));
        report('error');
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.code });
        span.end();
        throw err;
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

      const committed: (() => Promise<void>)[] = [];
      let policy: PolicyOutcome | undefined;
      try {
        const result = await retrySnapshotConflicts(cmd.effect === 'read', () =>
          db.withWorkspace(
            principal.workspaceId,
            async (tx) => {
              committed.length = 0;
              policy = undefined;
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
              if (opts.idempotencyKey) {
                // Serialise retries of one (workspace, key) before the lookup. Two concurrent
                // requests must not both miss and both run the handler: the second waits here,
                // then sees the response the first committed.
                await tx.execute(
                  sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${principal.workspaceId}:${opts.idempotencyKey}`}, 0))`,
                );
                const [hit] = await tx
                  .select()
                  .from(schema.idempotencyKeys)
                  .where(
                    and(eq(schema.idempotencyKeys.workspaceId, principal.workspaceId), eq(schema.idempotencyKeys.key, opts.idempotencyKey)),
                  );
                if (hit) {
                  if (hit.command !== cmd.name || hit.inputHash !== inputHash)
                    throw new AppError('conflict', 'This idempotency key was already used for a different request. Use a new key.');
                  return hit.response as z.output<C['output']>;
                }
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
                await tx.insert(schema.idempotencyKeys).values({
                  workspaceId: principal.workspaceId,
                  key: opts.idempotencyKey,
                  command: cmd.name,
                  inputHash,
                  response: redact(out, cmd.sensitiveOutput) as object,
                });
              if (cmd.effect !== 'read') target = cmd.auditTarget?.(out) ?? target;
              if (cmd.effect !== 'read' && !cmd.auditsItself) await appendAudit(tx, principal, opts.surface, cmd, inputHash, target);
              if (agent && policy && services.onAgentAction)
                await services.onAgentAction(tx, {
                  agentId: agent.id,
                  command: cmd.name,
                  actionClass: policy.actionClass,
                  decision: policy.decision,
                  reasons: policy.reasons,
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
        );
        // An audited read is recorded in its own transaction: the hash chain must be appended under
        // its lock with the latest entries visible, which a snapshot taken earlier would not show.
        if (cmd.effect === 'read' && cmd.auditReads)
          await db.withWorkspace(principal.workspaceId, (tx) => appendAudit(tx, principal, opts.surface, cmd, inputHash, target));
        for (const fn of committed) await fn().catch((err) => span.recordException(err as Error));
        report('ok');
        span.end();
        return result;
      } catch (err) {
        // The transaction rolled back: keep the agent's attempt (a refusal or a failed write) in the ledger.
        if (agent && policy && services.onAgentAction)
          await db
            .withWorkspace(principal.workspaceId, (tx) =>
              services.onAgentAction!(tx, {
                agentId: agent.id,
                command: cmd.name,
                actionClass: policy!.actionClass,
                decision: policy!.decision,
                reasons: policy!.reasons,
                impact: policy!.impact,
                ok: false,
                error: err instanceof Error ? err.message.slice(0, 1000) : String(err).slice(0, 1000),
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
        if (err instanceof AppError) return fail(err);
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
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-policy:${principal.workspaceId}:${agent.id}`}, 0))`);
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
    return { ...policy, decision: 'ask', reasons: [...policy.reasons, 'Holds arrive in Phase 7.'] };
  return policy;
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
async function retrySnapshotConflicts<T>(isRead: boolean, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!isRead || attempt >= 2 || !isSerializationFailure(err)) throw err;
    }
  }
}

/** Postgres SQLSTATE 40001, directly or as the cause of a Drizzle query error. */
export function isSerializationFailure(err: unknown): boolean {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined, depth = 0; e && depth < 5; e = e.cause as typeof e, depth++)
    if (e.code === '40001') return true;
  return false;
}
