import type { ActionClass, CommandContext, Impact, ReachEstimate } from '@agentic-seo/commands';
import { schema, type Tx } from '@agentic-seo/db';
import { and, eq } from 'drizzle-orm';
import { artifactTypes } from './types';

// What publishing an artifact changes in the world, for the policy engine (agents-and-autonomy §3).
//
// SEO has no `content.publish` class: publishing an artifact is its own decision. The mapping below
// translates upstream's type → class table:
//   - site memory and saved crawl settings (`site_context`, `audit_profile`) and the mandate /
//     hosted-agent definitions change how the workspace behaves, so they are `settings` and always
//     need a person (`site.content` is deliberately not used: that class is a change to the site);
//   - trackers are a recurring spend commitment, so `research.spend`;
//   - reports are shared outward, so `report.share`;
//   - notes, briefs, recommendations, schema templates, skills and prompts are reviewable work
//     products that change nothing live by themselves, so `draft`;
//   - a **change set** is not a draft: publishing it is the moment its edits may go to the site, so
//     its class comes from the changes it holds (`actionClassFor`, the strongest wins) and its
//     reach from the URLs those changes touch. The class needs the content, so it is computed by an
//     estimator the change-sets package registers at startup (`registerChangeSetImpactEstimator`).
//     Unknown reach always requires a person, so without a registered estimator publishing stays
//     as strict as `estimateImpact`'s default.
// The default for a type added later is `draft`: refusing to decide would let a new type publish
// without the engine seeing it.
const CLASS_BY_TYPE: Record<string, ActionClass> = {
  site_context: 'settings',
  audit_profile: 'settings',
  agent_mandate: 'settings',
  hosted_agent: 'settings',
  rank_tracker: 'research.spend',
  ai_visibility_tracker: 'research.spend',
  report: 'report.share',
  report_template: 'report.share',
};

/** Types whose publishing a mandate can never make autonomous (the fixed rule, design §3.2). */
const NEEDS_PERSON = ['agent_mandate', 'hosted_agent'];

/** The class of publishing an artifact of this type, when the type alone decides it. */
export const publishClass = (type: string): ActionClass => CLASS_BY_TYPE[type] ?? 'draft';

/**
 * What publishing a change set does, computed from its content: the action class of its strongest
 * change and the traffic at risk over every affected URL. Registered by packages/change-sets, which
 * owns the mapping from changes to classes and the reach estimate.
 */
export interface ChangeSetImpact {
  actionClass: ActionClass;
  reach?: ReachEstimate;
  /** Why a person must approve it whatever the agent was granted (a fixed rule, a conflict). */
  needsPerson?: string;
}

export type ChangeSetImpactEstimator = (input: {
  tx: Tx;
  workspaceId: string;
  siteId: string | null;
  content: unknown;
  /** The artifact being published, so a rollback can be judged by the change set it reverses. */
  artifactId?: string;
}) => Promise<ChangeSetImpact>;

let changeSetEstimator: ChangeSetImpactEstimator | undefined;

/** Registers the one estimator that understands change-set content (called once, at package load). */
export function registerChangeSetImpactEstimator(estimator: ChangeSetImpactEstimator): void {
  changeSetEstimator = estimator;
}

/** The estimator's answer, or the strict default when change-sets is not part of the build. */
async function impactOfChangeSet(input: Parameters<ChangeSetImpactEstimator>[0]): Promise<ChangeSetImpact> {
  if (!changeSetEstimator) return { actionClass: 'draft' };
  return changeSetEstimator(input);
}

// When several artifacts are published together, the bundle counts as its riskiest member. The two
// site classes sit above `research.spend` because a bundle that changes the site outranks one that
// spends money; `settings` still outranks everything.
const RANK: ActionClass[] = ['draft', 'report.share', 'research.spend', 'site.content', 'site.structural', 'settings'];

export async function publishImpact(
  ctx: Pick<CommandContext, 'tx' | 'services'> & { principal?: CommandContext['principal'] },
  members: { id: string; type: string; version: number }[],
): Promise<Impact> {
  let actionClass: ActionClass = 'draft';
  let reach: ReachEstimate | undefined;
  const needsPersonReasons: string[] = [];
  const summaries: string[] = [];
  const touches: Required<NonNullable<Impact['touches']>> = { sites: [], changeTypes: [], artifacts: [] };
  for (const m of members) {
    let cls = publishClass(m.type);
    const [live] = await ctx.tx
      .select({ publishedVersion: schema.artifacts.publishedVersion, siteId: schema.artifacts.siteId })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, m.id));
    if (m.type === 'change_set') {
      const [version] = await ctx.tx
        .select({ content: schema.artifactVersions.content })
        .from(schema.artifactVersions)
        .where(and(eq(schema.artifactVersions.artifactId, m.id), eq(schema.artifactVersions.number, m.version)));
      const estimated = await impactOfChangeSet({
        tx: ctx.tx,
        workspaceId: ctx.principal?.workspaceId ?? '',
        siteId: live?.siteId ?? null,
        content: version?.content ?? null,
        artifactId: m.id,
      });
      cls = estimated.actionClass;
      if (estimated.reach) reach = estimated.reach;
      if (estimated.needsPerson) needsPersonReasons.push(estimated.needsPerson);
    }
    if (RANK.indexOf(cls) > RANK.indexOf(actionClass)) actionClass = cls;
    touches.artifacts.push({ id: m.id, type: m.type, created: live?.publishedVersion == null && (await draftedByCaller(ctx, m.id)) });
    if (live?.siteId) touches.sites.push(live.siteId);
    summaries.push(`${artifactTypes[m.type as keyof typeof artifactTypes]?.label ?? m.type} ${m.id} v${m.version}`);
  }
  const needsPerson = members.some((m) => NEEDS_PERSON.includes(m.type))
    ? 'Only a person can publish an agent mandate or a hosted agent.'
    : needsPersonReasons.length
      ? needsPersonReasons.join(' ')
      : undefined;
  return {
    actionClass,
    reversible: true,
    ...(reach ? { reach } : {}),
    ...(summaries.length ? { summary: `publish ${summaries.join(', ')}` } : {}),
    touches,
    ...(needsPerson ? { needsPerson } : {}),
  };
}

/**
 * Whether the calling agent drafted this artifact's first version itself. Level 4 may create new
 * artifacts outside the mandate's artifact list, but only its own: a never-published draft by a
 * person or another agent is not a creation of this agent and stays in the list's scope.
 */
async function draftedByCaller(
  ctx: { tx: CommandContext['tx']; principal?: CommandContext['principal'] },
  artifactId: string,
): Promise<boolean> {
  const p = ctx.principal;
  if (p?.type !== 'agent' || !p.clientId) return false;
  const [first] = await ctx.tx
    .select({ authorType: schema.artifactVersions.authorType, authorClient: schema.artifactVersions.authorClient })
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, artifactId), eq(schema.artifactVersions.number, 1)));
  return first?.authorType === 'agent' && first.authorClient === p.clientId;
}

/** The approval note, with why the policy engine sent the change to a person. */
export function noteWithPolicy(note: string, ctx: Pick<CommandContext, 'policy'>): string {
  if (ctx.policy?.decision === 'ask') return `${note}\n\nNeeds a person: ${ctx.policy.reasons.join(' ')}`.slice(0, 2000);
  return note;
}
