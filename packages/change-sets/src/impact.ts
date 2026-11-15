import { type ChangeSetContent, changeSetContentSchema, publishValidators, registerChangeSetImpactEstimator } from '@agentic-seo/artifacts';
import { actionClassFor, type Change, urlOf } from '@agentic-seo/changes';
import type { ActionClass, Impact, ReachEstimate } from '@agentic-seo/commands';
import { AppError } from '@agentic-seo/core';
import { schema, type Tx } from '@agentic-seo/db';
import { estimateReach } from '@agentic-seo/search-data';
import { and, eq, inArray } from 'drizzle-orm';
import { findGitHubConnection, GITHUB_CONNECTOR_ID } from './connector';
import { type ChangeSetRun, OPEN_STATES } from './state';

// What a change set does to the world (agents-and-autonomy §3): the action class of its strongest
// change, the traffic at risk over every URL it touches, and the fixed rules that make a person's
// approval mandatory whatever an agent was granted.
//
// Two callers need this answer: `changes.requestApply` (which builds the impact itself so it can add
// the conflict hold) and `artifacts.requestPublish`, which asks the estimator registered here. One
// function, so publishing a change set through either door is judged the same way.

/** The strongest class in a set of changes: `site.structural` beats `site.content`. */
const CLASS_ORDER: ActionClass[] = ['draft', 'site.content', 'site.structural'];

export function strongestClass(changes: readonly Change[]): ActionClass {
  let strongest: ActionClass = 'draft';
  for (const change of changes) {
    const cls = actionClassFor(change);
    if (CLASS_ORDER.indexOf(cls) > CLASS_ORDER.indexOf(strongest)) strongest = cls;
  }
  return strongest;
}

/** Every URL a change set touches: what each change is about, plus the routes its source reaches. */
export function affectedUrlsOf(content: ChangeSetContent): string[] {
  const urls = new Set<string>();
  for (const drafted of content.changes) {
    urls.add(urlOf(drafted.change));
    for (const route of drafted.source.affectedRoutes) urls.add(route);
  }
  return [...urls];
}

/** Every repository file a change set writes. */
export function sourcePathsOf(content: ChangeSetContent): string[] {
  return [...new Set(content.changes.map((drafted) => drafted.source.path))];
}

/** Routes of a redirect change set, for the "more than 20 redirects needs a person" fixed rule. */
const redirectCount = (content: ChangeSetContent) => content.changes.filter((drafted) => drafted.change.type === 'redirect').length;

/** The fixed-rule limit on redirects in one change set (agents-and-autonomy §3). */
export const MAX_REDIRECTS_PER_CHANGE_SET = 20;

export interface ChangeSetConflict {
  artifactId: string;
  title: string;
  /** The URLs both change sets touch. */
  urls: string[];
  /** The source files both change sets write. */
  paths: string[];
}

/**
 * Another open change set on the same site that touches the same URL or the same source file. Two
 * changes to one file drafted against the same base commit race: whichever is applied second
 * overwrites the other's edit, so the second needs a person's decision with the first named.
 */
export async function conflictsFor(
  tx: Tx,
  input: { workspaceId: string; siteId: string; artifactId: string; content: ChangeSetContent },
): Promise<ChangeSetConflict[]> {
  const rows = await tx
    .select()
    .from(schema.changeSetRuns)
    .where(
      and(
        eq(schema.changeSetRuns.workspaceId, input.workspaceId),
        eq(schema.changeSetRuns.siteId, input.siteId),
        inArray(schema.changeSetRuns.state, [...OPEN_STATES]),
      ),
    );
  const others = rows.filter((row) => row.artifactId !== input.artifactId);
  if (!others.length) return [];

  const urls = new Set(affectedUrlsOf(input.content));
  const paths = new Set(sourcePathsOf(input.content));
  const conflicts: ChangeSetConflict[] = [];
  for (const other of others) {
    const content = await contentOfRun(tx, other);
    if (!content) continue;
    const sharedUrls = affectedUrlsOf(content).filter((url) => urls.has(url));
    const sharedPaths = sourcePathsOf(content).filter((path) => paths.has(path));
    if (sharedUrls.length || sharedPaths.length) {
      conflicts.push({ artifactId: other.artifactId, title: content.title, urls: sharedUrls, paths: sharedPaths });
    }
  }
  return conflicts;
}

/** The sentence the policy engine and the approval note carry for a conflict. */
export function conflictReason(conflict: ChangeSetConflict): string {
  const what = [
    conflict.paths.length ? `the file ${conflict.paths.join(', ')}` : null,
    conflict.urls.length ? `the URL ${conflict.urls.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join(' and ');
  return `Change set ${conflict.artifactId} (“${conflict.title}”) is open on this site and already changes ${what}. Two change sets that touch the same source need a person, not two agents.`;
}

/**
 * The content of one version of a run: the one named, or the approved version, or the latest draft.
 *
 * The version is explicit because the policy engine and the handler must judge the same content
 * (#854): a change set that was published, went stale and was redrafted has `published_version`
 * pointing at the old version while `latest_version` is the draft a person is about to approve.
 * Reading `publishedVersion` first would estimate the old change (a title edit) while the handler
 * publishes the new one (a structural redirect). A caller that knows which version it publishes
 * passes it; otherwise the approved version, then the latest, is the one that would be applied.
 */
export async function contentOfRun(tx: Tx, run: ChangeSetRun, version?: number): Promise<ChangeSetContent | null> {
  const [artifact] = await tx
    .select({ latestVersion: schema.artifacts.latestVersion })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.workspaceId, run.workspaceId), eq(schema.artifacts.id, run.artifactId)));
  if (!artifact) return null;
  const number = version ?? run.approvedVersion ?? artifact.latestVersion;
  const [row] = await tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(
      and(
        eq(schema.artifactVersions.workspaceId, run.workspaceId),
        eq(schema.artifactVersions.artifactId, run.artifactId),
        eq(schema.artifactVersions.number, number),
      ),
    );
  const parsed = changeSetContentSchema.safeParse(row?.content);
  return parsed.success ? parsed.data : null;
}

export interface ChangeSetImpactResult {
  actionClass: ActionClass;
  reach: ReachEstimate;
  /** Why a person must approve it however the policy would otherwise decide. */
  needsPerson: string[];
  conflicts: ChangeSetConflict[];
}

/** The impact of publishing one change set, from its content. */
export async function changeSetImpact(
  tx: Tx,
  input: { workspaceId: string; siteId: string; artifactId: string; content: ChangeSetContent },
): Promise<ChangeSetImpactResult> {
  const urls = affectedUrlsOf(input.content);
  const reach = await estimateReach(tx, { workspaceId: input.workspaceId, siteId: input.siteId, urls });
  const conflicts = await conflictsFor(tx, input);
  const needsPerson: string[] = [];
  const redirects = redirectCount(input.content);
  if (redirects > MAX_REDIRECTS_PER_CHANGE_SET) {
    needsPerson.push(
      `This change set redirects ${redirects} URLs; more than ${MAX_REDIRECTS_PER_CHANGE_SET} in one change set always needs a person.`,
    );
  }
  for (const conflict of conflicts) needsPerson.push(conflictReason(conflict));
  return { actionClass: strongestClass(input.content.changes.map((drafted) => drafted.change)), reach, needsPerson, conflicts };
}

/** The estimator packages/artifacts asks for when a change set is published through any door. */
registerChangeSetImpactEstimator(async ({ tx, workspaceId, siteId, content }) => {
  const parsed = changeSetContentSchema.safeParse(content);
  if (!parsed.success || !siteId) return { actionClass: 'draft' as const };
  const impact = await changeSetImpact(tx, { workspaceId, siteId, artifactId: '', content: parsed.data });
  return {
    actionClass: impact.actionClass,
    reach: impact.reach,
    ...(impact.needsPerson.length ? { needsPerson: impact.needsPerson.join(' ') } : {}),
  };
});

// Publishing a change set is only possible when the site's ownership is verified (the fixed rule:
// "anything on a site whose ownership is not verified" always needs a person, and a change set has
// no other meaning) and a GitHub connection exists to apply it through. Refusing at publish time
// means a stack of approvals cannot pile up behind a site that can never apply them.
publishValidators.set('change_set', async (content: unknown, tx, artifact) => {
  const parsed = changeSetContentSchema.safeParse(content);
  if (!parsed.success) return [];
  if (!artifact) return [];
  const [row] = await tx
    .select({ siteId: schema.artifacts.siteId, name: schema.artifacts.name })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.workspaceId, artifact.workspaceId), eq(schema.artifacts.id, artifact.id)));
  if (!row?.siteId) return ['A change set must belong to a site; pass siteId when creating it.'];
  const [site] = await tx
    .select({
      name: schema.sites.name,
      domain: schema.sites.primaryDomain,
      verifiedAt: schema.sites.verifiedAt,
      archived: schema.sites.archived,
    })
    .from(schema.sites)
    .where(and(eq(schema.sites.workspaceId, artifact.workspaceId), eq(schema.sites.id, row.siteId)));
  if (!site) return ['The site this change set belongs to does not exist any more.'];
  if (site.archived) return [`Site “${site.name}” (${site.domain}) is archived, so nothing can be applied to it.`];
  if (site.verifiedAt === null) {
    return [
      `Site “${site.name}” (${site.domain}) is not verified, so no change can be applied to it. Verify ownership with sites.verify first.`,
    ];
  }
  const connection = await findGitHubConnection(tx, artifact.workspaceId, row.siteId);
  if (connection?.state !== 'active') {
    return [
      'The GitHub connector is not connected to this site, so the change set could never be applied. Run connectors.github.connect first.',
    ];
  }
  return [];
});

/** Refuses a publish that the fixed rules make impossible, with the message the validator produced. */
export function assertPublishable(problems: string[]): void {
  if (problems.length) throw new AppError('invalid_input', `This change set cannot be published: ${problems.join(' ')}`);
}

/** The connector a change set applies through; Phase 1 has one. */
export const CHANGE_SET_CONNECTOR = GITHUB_CONNECTOR_ID;

/** The Impact shape `changes.requestApply` hands the policy engine. */
export function impactOf(result: ChangeSetImpactResult, summary: string): Impact {
  return {
    actionClass: result.actionClass,
    reach: result.reach,
    reversible: true,
    summary,
    ...(result.needsPerson.length ? { needsPerson: result.needsPerson.join(' ') } : {}),
  };
}
