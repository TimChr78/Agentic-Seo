import type { PolicyDecision } from '@agentic-seo/db';
import { z } from 'zod';

// The policy engine (ADR-0006): one decision for every agent write, measured in consequences.
// `decide` is pure so the rules can be tested without a database; the executor supplies the action
// class, the impact estimate, the workspace's autonomy settings and the agent's counters.
//
// Phase 0 needs levels 0 and 1 plus the workspace ceilings. The level 2–4 paths are kept generic
// because mandates arrive in Phase 7; SEO reach and the guardian's caps plug into the same
// decision then. Marketing's audience, message and consent limits are gone.

/** What a command changes in the world (docs/architecture/agents-and-autonomy.md §3). */
export const ACTION_CLASSES = [
  'read',
  'research.spend',
  'crawl',
  'draft',
  'report.share',
  'index.submit',
  'site.content',
  'site.structural',
  'settings',
  'destructive',
] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

/** Classes whose actions change the site and are measured in traffic at risk (Phase 7). */
export const REACH_CLASSES: readonly ActionClass[] = ['site.content', 'site.structural'];

/**
 * How much traffic one action puts at risk. Historical clicks alone undervalue new, seasonal and
 * currently broken pages, so this is structured rather than one number, and it is `unknown` until
 * GSC page aggregates exist (Phase 1–2). Unknown reach always requires approval; it never merely
 * drops one level.
 */
export type ReachEstimate =
  | { kind: 'unknown'; reason: string }
  | {
      kind: 'known';
      /** URLs named plus those reached through templates and internal links. */
      affectedUrls: number;
      /** GSC clicks at risk over 28 days, or null when the page has no search history. */
      clicksAtRisk: number | null;
      /** Key pages from site context (home, pricing, top converters), named for the approver. */
      criticalPages: string[];
    };

/** The Phase 0 answer: no page aggregate dataset exists yet, so reach is always unknown. */
export const UNKNOWN_REACH: ReachEstimate = {
  kind: 'unknown',
  reason: 'Page-level search data is not connected yet, so the traffic at risk cannot be estimated (Phase 1–2).',
};

/** An estimate of what one call would do, computed before it runs. */
export interface Impact {
  /** Overrides the command's class, e.g. a meta edit is `site.content` while a redirect set is structural. */
  actionClass?: ActionClass;
  /** SEO reach (traffic at risk); unknown until GSC page aggregates are wired in Phase 1–2. */
  reach?: ReachEstimate;
  /** Whether the action can be undone after it ran (a submitted index URL cannot). */
  reversible?: boolean;
  /** A short human description, shown with holds and in the ledger. */
  summary?: string;
  /** What the action touches, for a mandate's scope (design §3.4). */
  touches?: {
    sites?: string[];
    changeTypes?: string[];
    /** `created`: the action makes this artifact live for the first time (level 4 may create). */
    artifacts?: { id: string; type: string; created?: boolean }[];
  };
  /** Never autonomous whatever the mandate: credentials, connections, budgets (design §3.2). */
  needsPerson?: string;
}

export interface ImpactRequest {
  command: string;
  actionClass: ActionClass;
  input?: unknown;
}

/**
 * The typed hook for SEO reach. Phase 0 has no page-level search data, so it returns `unknown`;
 * Phase 1–2 replaces the body with the GSC page aggregate estimate without changing callers.
 */
export async function estimateImpact(_request: ImpactRequest): Promise<Impact> {
  return { reach: UNKNOWN_REACH };
}

export const AutonomySwitch = z.enum(['on', 'propose_only', 'off']);
export type AutonomySwitch = z.infer<typeof AutonomySwitch>;

/** Workspace autonomy ceilings (ADR-0006). Stored in workspaces.settings; missing keys take defaults. */
export const AutonomySettings = z.object({
  switch: AutonomySwitch.default('on').describe(
    'on: agents work as their grants allow; propose_only: every agent change beyond a draft needs a person; off: agents can only read',
  ),
  maxLevel: z
    .partialRecord(z.enum(ACTION_CLASSES), z.number().int().min(0).max(4))
    .default({})
    .describe(
      'Highest autonomy level a mandate may grant per action class (0 observe … 4 run the loop). Missing classes: 1 (propose). Applies to mandates (Phase 7); agents without a mandate follow the approval policy',
    ),
  allowLoops: z.boolean().default(false).describe('Whether any mandate may grant level 4 (run the loop)'),
  limits: z
    .object({
      changesPerDay: z.number().int().min(0).default(500).describe('Agent changes (beyond drafts) per agent per 24 hours'),
    })
    .default({ changesPerDay: 500 }),
});
export type AutonomySettings = z.output<typeof AutonomySettings>;

/** The workspace's settings with defaults filled in; unreadable stored values fall back to the defaults. */
export function autonomySettings(stored: unknown): AutonomySettings {
  const parsed = AutonomySettings.safeParse(stored ?? {});
  return parsed.success ? parsed.data : AutonomySettings.parse({});
}

/** What an agent did in the last 24 hours, from the action ledger. */
export interface AgentCounters {
  changes: number;
}

/**
 * The parts of an agent's active mandate the engine needs. A mandate is a versioned artifact
 * (Phase 7); Phase 0 only carries the type so the level paths stay exercised by tests.
 */
export interface MandateView {
  id: string;
  version: number;
  levels: Partial<Record<ActionClass, number>>;
  holdWindow: string;
  purpose: string;
}

/** Classes whose actions cannot be undone once they ran. */
export const IRREVERSIBLE: readonly ActionClass[] = ['research.spend', 'index.submit', 'destructive'];

/** Classes a mandate can never make autonomous (design §3.2, the fixed rule). */
const ALWAYS_A_PERSON: readonly ActionClass[] = ['destructive', 'settings'];

export interface PolicyInput {
  command: string;
  actionClass: ActionClass;
  impact: Impact;
  settings: AutonomySettings;
  counters: AgentCounters;
  /** The command can turn "ask" into an approval request. */
  approvable: boolean;
  /** The agent's active mandate, if any; without one the approval policy decides as before. */
  mandate?: MandateView;
  /**
   * Another agent's ownership of an artifact this action changes, computed by the executor. An
   * active owner caps the action at level 1 (or asks, without a mandate); a paused or retired owner
   * is reported but does not block.
   */
  ownership?: {
    agentId: string;
    agentName: string;
    active: boolean;
    artifactId?: string;
    artifactName?: string;
  } | null;
  /** Other agents' pending changes (holds or approval requests) on the same artifacts. */
  conflicts?: string[];
}

export interface PolicyOutcome {
  decision: PolicyDecision;
  actionClass: ActionClass;
  reasons: string[];
  impact: Impact;
  /** The level the mandate grants for this action after every cap (0–4); undefined without a mandate. */
  level?: number;
  /** Allowed by a mandate (level 3+): the action runs without the approval policy (ADR-0006). */
  autonomous?: boolean;
  mandate?: { id: string; version: number; holdWindow: string };
}

const fmt = (n: number) => n.toLocaleString('en-US');

const LEVEL_NAMES = ['observe', 'propose', 'act with veto', 'act within limits', 'run the loop'];

/** How an owned artifact is named in a reason: its name when the executor supplied it, else its id. */
const ownedLabel = (o: NonNullable<PolicyInput['ownership']>) =>
  o.artifactName ? `“${o.artifactName}”` : (o.artifactId ?? 'This artifact');

/** The reason an active owner blocks another agent, and the note when the owner is paused or retired. */
function ownershipReasons(o: NonNullable<PolicyInput['ownership']>) {
  const reason = `${ownedLabel(o)} is owned by agent ${o.agentName}.`;
  return o.active
    ? { block: reason, note: null }
    : {
        block: null,
        note: `${ownedLabel(o)} is owned by agent ${o.agentName}, which is not active; ownership does not block this change.`,
      };
}

export function decide(input: PolicyInput): PolicyOutcome {
  const { actionClass, impact, settings, mandate } = input;
  const out = (decision: PolicyDecision, reasons: string[], extra: Partial<PolicyOutcome> = {}): PolicyOutcome => ({
    decision,
    actionClass,
    reasons,
    impact,
    ...(mandate ? { mandate: { id: mandate.id, version: mandate.version, holdWindow: mandate.holdWindow } } : {}),
    ...extra,
  });
  if (actionClass === 'read') return out('allow', []);
  if (settings.switch === 'off')
    return out('deny', [
      'Agents are switched off in this workspace: they can only read. A person can switch them on in Settings → Agents.',
    ]);
  if (mandate && (mandate.levels.draft ?? 1) === 0 && actionClass === 'draft')
    return out('deny', ['This agent’s mandate is observe-only (level 0): it may read but not draft.'], { level: 0 });
  // The workspace ceiling applies to drafts as well: a ceiling of 0 makes every agent observe-only.
  if (actionClass === 'draft' && (settings.maxLevel.draft ?? 1) === 0)
    return out('deny', ['This workspace allows agents to observe only (draft ceiling 0): they may read but not draft.'], { level: 0 });
  if (actionClass === 'draft') return out('allow', []);
  if (mandate) return decideWithMandate(input, mandate, out);
  return decideWithoutMandate(input, out);
}

/**
 * The path for an agent with no mandate. The design puts such an agent at level 1 (propose) for
 * every write class, and applies the fixed rules and unknown reach here too: a rule that only
 * exists on the mandate path would be skipped by the very agents that have no mandate to judge.
 */
function decideWithoutMandate(
  input: PolicyInput,
  out: (decision: PolicyDecision, reasons: string[], extra?: Partial<PolicyOutcome>) => PolicyOutcome,
): PolicyOutcome {
  const { actionClass, impact, settings, counters } = input;
  const reasons: string[] = [];
  if (ALWAYS_A_PERSON.includes(actionClass)) reasons.push(`A ${actionClass} change always needs a person, whatever the agent was granted.`);
  if (impact.needsPerson) reasons.push(impact.needsPerson);
  // Unknown reach always requires approval, never a one-level drop (design §3).
  if (REACH_CLASSES.includes(actionClass) && impact.reach?.kind !== 'known')
    reasons.push(`The traffic at risk is unknown, so this change needs a person. ${impact.reach?.reason ?? ''}`.trim());
  // Several agents in one workspace: an active owner or another agent's pending change asks a person.
  if (input.ownership) {
    const own = ownershipReasons(input.ownership);
    if (own.block) reasons.push(own.block);
    if (own.note) reasons.push(own.note);
  }
  if (input.conflicts?.length) reasons.push(...input.conflicts);
  if (settings.switch === 'propose_only')
    reasons.push('This workspace is set to propose-only: every agent change beyond a draft needs a person.');
  if (counters.changes >= settings.limits.changesPerDay)
    reasons.push(
      `This agent made ${fmt(counters.changes)} changes in the last 24 hours, its limit is ${fmt(settings.limits.changesPerDay)}.`,
    );

  reasons.push(`This agent has no mandate, so ${actionClass} changes are level 1 (propose) and need a person.`);
  if (input.approvable) return out('ask', reasons);
  return out('deny', [...reasons, `${input.command} cannot wait for an approval, so a person has to do it.`]);
}

function decideWithMandate(
  input: PolicyInput,
  mandate: MandateView,
  out: (decision: PolicyDecision, reasons: string[], extra?: Partial<PolicyOutcome>) => PolicyOutcome,
): PolicyOutcome {
  const { actionClass, impact, settings, counters } = input;
  const reasons: string[] = [];
  const granted = mandate.levels[actionClass] ?? 1;
  let ceiling = settings.maxLevel[actionClass] ?? 1;
  if (ceiling === 4 && !settings.allowLoops) ceiling = 3;
  let level = Math.min(granted, ceiling);
  if (granted > ceiling)
    reasons.push(`The mandate grants level ${granted} (${LEVEL_NAMES[granted]}), the workspace allows at most ${ceiling}.`);
  const capAt = (max: number, reason: string) => {
    if (level > max) level = max;
    reasons.push(reason);
  };

  if (settings.switch === 'propose_only')
    capAt(1, 'This workspace is set to propose-only: every agent change beyond a draft needs a person.');
  if (ALWAYS_A_PERSON.includes(actionClass)) capAt(1, `A ${actionClass} change always needs a person, whatever the mandate.`);
  if (impact.needsPerson) capAt(1, impact.needsPerson);
  // Unknown reach always requires approval, never a one-level drop (design §3).
  if (REACH_CLASSES.includes(actionClass) && impact.reach?.kind !== 'known')
    capAt(1, `The traffic at risk is unknown, so this change needs a person. ${impact.reach?.reason ?? ''}`.trim());
  if (counters.changes >= settings.limits.changesPerDay)
    capAt(
      1,
      `This agent made ${fmt(counters.changes)} changes in the last 24 hours, the workspace limit is ${fmt(settings.limits.changesPerDay)}.`,
    );

  // Several agents in one workspace: an active owner or another agent's pending change caps at propose.
  if (input.ownership) {
    const own = ownershipReasons(input.ownership);
    if (own.block) capAt(1, own.block);
    if (own.note) reasons.push(own.note);
  }
  for (const conflict of input.conflicts ?? []) capAt(1, conflict);

  if (level <= 0) return out('deny', [...reasons, `The mandate gives this agent level 0 (observe) for ${actionClass}.`], { level });
  if (level === 1) {
    if (input.approvable)
      return out('ask', reasons.length ? reasons : [`The mandate gives level 1 (propose) for ${actionClass}.`], { level });
    return out('deny', [...reasons, `${input.command} cannot wait for an approval at level 1, so a person has to do it.`], { level });
  }
  if (level === 2) {
    if (input.approvable)
      return out('hold', [`Held for a veto window of ${mandate.holdWindow} (level 2, act with veto).`, ...reasons], { level });
    return out('deny', [...reasons, `${input.command} cannot be held for a veto window; level 3 is needed to run it, or a person can.`], {
      level,
    });
  }
  return out('allow', reasons, { level, autonomous: true });
}
