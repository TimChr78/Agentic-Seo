import { type ActionClass, autonomySettings, type MandateView } from '@agentic-seo/commands';
import { schema, type Tx } from '@agentic-seo/db';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { type AgentMandate, artifactTypes, publishValidators } from './types';

// Mandates (agents-and-autonomy §4): the agent's active mandate for the policy engine, its working
// hours and the checks before one is published. Ported from Agentic Marketing 311460e
// packages/artifacts/src/mandates.ts. Only L0/L1 are enforced in Phase 0; an L2+ decision is
// degraded to "ask" by the executor until holds and veto windows arrive in Phase 7.

export interface ActiveMandate {
  view: MandateView;
  content: AgentMandate;
  /** Why now is outside the mandate's working hours or on a blackout date, or null. */
  outsideHours: string | null;
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** The day and HH:MM of `now` in a time zone. */
function localNow(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    day: get('weekday').toLowerCase().slice(0, 3),
    time: `${get('hour')}:${get('minute')}`,
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/** Why `now` is outside the mandate's working hours or on a blackout date (workspace time zone), or null. */
export function outsideWorkingHours(
  m: Pick<AgentMandate, 'workingHours' | 'blackoutDates'>,
  timeZone: string,
  now = new Date(),
): string | null {
  const local = localNow(now, timeZone);
  if (m.blackoutDates.includes(local.date)) return `${local.date} is a blackout date in the agent’s mandate.`;
  const w = m.workingHours;
  if (!w) return null;
  const overnight = w.start > w.end;
  const inside = overnight ? local.time >= w.start || local.time < w.end : local.time >= w.start && local.time < w.end;
  if (!inside) return `It is ${local.time} in ${timeZone}; the mandate allows work between ${w.start} and ${w.end}.`;
  // The part of an overnight window after midnight belongs to the day it started.
  const windowDay = overnight && local.time < w.end ? DAYS[(DAYS.indexOf(local.day as (typeof DAYS)[number]) + 6) % 7] : local.day;
  if (w.days?.length && !w.days.includes(windowDay as (typeof DAYS)[number]))
    return `The mandate allows work in windows starting on ${w.days.join(', ')} only (${timeZone}).`;
  return null;
}

/**
 * The active mandates of several agents in one grouped read, newest artifact first per agent.
 * Same terms as `activeMandate`: published, not archived, for the agent, not expired.
 */
export async function activeMandates(tx: Tx, agentIds: string[], now = new Date()): Promise<Map<string, ActiveMandate>> {
  const out = new Map<string, ActiveMandate>();
  if (!agentIds.length) return out;
  const rows = await tx
    .select({
      id: schema.artifacts.id,
      version: schema.artifacts.publishedVersion,
      content: schema.artifactVersions.content,
    })
    .from(schema.artifacts)
    .innerJoin(
      schema.artifactVersions,
      and(
        eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
        eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
      ),
    )
    .where(
      and(
        eq(schema.artifacts.type, 'agent_mandate'),
        eq(schema.artifacts.archived, false),
        isNotNull(schema.artifacts.publishedVersion),
        sql`${schema.artifactVersions.content}->>'agent' IN (${sql.join(
          agentIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      ),
    )
    .orderBy(desc(schema.artifacts.updatedAt));
  const [w] = await tx.select({ timeZone: schema.workspaces.timeZone }).from(schema.workspaces);
  for (const r of rows) {
    const parsed = artifactTypes.agent_mandate.content.safeParse(r.content);
    if (!parsed.success || new Date(parsed.data.expires) <= now) continue;
    const m = parsed.data;
    if (out.has(m.agent)) continue;
    out.set(m.agent, {
      content: m,
      outsideHours: outsideWorkingHours(m, w?.timeZone ?? 'UTC', now),
      view: {
        id: r.id,
        version: r.version!,
        levels: m.levels as Partial<Record<ActionClass, number>>,
        holdWindow: m.holdWindow,
        purpose: m.purpose,
      },
    });
  }
  return out;
}

/** The agent's mandate that applies now: published, not archived, for this agent, not expired. */
export async function activeMandate(tx: Tx, agentId: string, now = new Date()): Promise<ActiveMandate | null> {
  return (await activeMandates(tx, [agentId], now)).get(agentId) ?? null;
}

/**
 * Serialises mandate publishing for these agents until the transaction ends, in a stable order.
 * A command that publishes several mandates takes all of them here first, so two such commands
 * cannot each hold one and wait for the other.
 */
export async function lockMandateAgents(tx: Tx, agentIds: string[]) {
  for (const agentId of [...new Set(agentIds)].sort())
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('agent-mandate:' || current_setting('app.workspace_id') || ':' || ${agentId}, 0))`,
    );
}

/** The agents named by the mandates among these artifact contents. */
export function mandateAgentsOf(items: { type: string; content: unknown }[]): string[] {
  return items
    .filter((item) => item.type === 'agent_mandate')
    .map((item) => (item.content as { agent?: unknown } | null)?.agent)
    .filter((agent): agent is string => typeof agent === 'string');
}

// Before a mandate is published: the agent exists, the levels fit the workspace ceilings, it does
// not overlap another active mandate for the same agent, and it ends within a year.
publishValidators.set('agent_mandate', async (content, tx, artifact) => {
  const m = content as AgentMandate;
  const problems: string[] = [];
  // One mandate publish per agent at a time: two different mandate artifacts lock different rows,
  // so without this both would read "no active mandate" and both go live.
  await lockMandateAgents(tx, [m.agent]);
  const [agent] = await tx.select({ status: schema.agents.status }).from(schema.agents).where(eq(schema.agents.id, m.agent));
  if (!agent) problems.push(`agent ${m.agent} does not exist`);
  else if (agent.status === 'revoked') problems.push(`agent ${m.agent} is revoked`);
  const [w] = await tx.select({ settings: schema.workspaces.settings }).from(schema.workspaces);
  const settings = autonomySettings(w?.settings);
  for (const [cls, level] of Object.entries(m.levels)) {
    const ceiling = settings.maxLevel[cls as ActionClass] ?? 1;
    const effective = ceiling === 4 && !settings.allowLoops ? 3 : ceiling;
    if ((level ?? 0) > effective)
      problems.push(
        `levels.${cls} is ${level}, above the workspace ceiling of ${effective}${ceiling === 4 && !settings.allowLoops ? ' (loops are off, so level 4 is not available)' : ''}`,
      );
  }
  const until = new Date(m.expires).getTime();
  if (until <= Date.now()) problems.push('expires is in the past');
  if (until > Date.now() + 366 * 86_400_000) problems.push('expires is more than a year away; mandates are reviewed at least yearly');
  const others = await activeMandate(tx, m.agent);
  if (others && others.view.id !== artifact?.id)
    problems.push(`agent ${m.agent} already has an active mandate (${others.view.id}); archive it or let it expire first`);
  return problems;
});

/** ms of an ISO hold window such as PT2H. */
export function holdWindowMs(window: string): number {
  const m = /^PT(\d+)([HM])$/.exec(window);
  return m ? Number(m[1]) * (m[2] === 'H' ? 3_600_000 : 60_000) : 2 * 3_600_000;
}
