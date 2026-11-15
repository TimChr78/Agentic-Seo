import { artifactTypes, author, lockArtifacts, noteWithPolicy, publishArtifactVersion, validateContent } from '@agentic-seo/artifacts';
import { type Change, ChangeSchema, renderDiff, urlOf } from '@agentic-seo/changes';
import { type CommandContext, defineCommand } from '@agentic-seo/commands';
import { AppError, hashValue, newId } from '@agentic-seo/core';
import { schema, type Tx } from '@agentic-seo/db';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { activeConnection, commandClient, type GitHubConnection, githubAppError, slugOf } from './connector';
import { draftChanges, inverseOf } from './draft';
import { changeSetImpact, contentOfRun, sourcePathsOf } from './impact';
import { describeRevalidation, revalidateChangeSet } from './revalidate';
import {
  actorOf,
  type ChangeSetRun,
  eventsOf,
  findRun,
  latestVerifications,
  loadRun,
  lockRun,
  OPEN_STATES,
  recordEvent,
  transition,
} from './state';

const ChangeSetId = z.string().regex(/^chg_[0-9a-f]{32}$/, 'A change set id: chg_ followed by 32 hex characters');
const SiteId = z.string().uuid().describe('Site id');

const RefusalCodeEnum = z.enum(['not_found', 'ambiguous', 'stale', 'unsupported', 'invalid', 'conflict']);
const StateEnum = z.enum([
  'draft',
  'in_review',
  'approved',
  'applying',
  'pr_open',
  'merged',
  'deploying',
  'deployed',
  'verified',
  'verification_failed',
  'deploy_not_detected',
  'closed',
  'stale',
  'rolled_back',
  'superseded',
  'failed',
]);

/** States in which the change set is on its way through GitHub and must not be redrafted. */
const IN_FLIGHT = ['applying', 'pr_open', 'merged', 'deploying', 'deployed'] as const;

const RefusalView = z.object({
  index: z.number().int().describe('The position of the change in the request (0-based)'),
  url: z.string(),
  code: RefusalCodeEnum,
  reason: z.string().describe('What to fix, in one sentence'),
  details: z.record(z.string(), z.unknown()).optional(),
});

const ChangeView = z.object({
  index: z.number().int(),
  type: z.string(),
  url: z.string().describe('The URL the change is about (a redirect: the path it moves)'),
  source: z.object({
    path: z.string(),
    editor: z.string(),
    confidence: z.string(),
    affectedRoutes: z.array(z.string()),
  }),
  baseSha: z.string(),
  sourceHash: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  diff: z.string().describe('The unified diff of the source file for this change'),
});

const RunView = z.object({
  artifactId: z.string(),
  siteId: z.string(),
  state: StateEnum,
  approvedVersion: z.number().int().nullable(),
  approvedHeadSha: z.string().nullable(),
  approvalId: z.string().nullable(),
  branch: z.string().nullable(),
  prNumber: z.number().int().nullable(),
  prUrl: z.string().nullable(),
  headSha: z.string().nullable(),
  mergeCommitSha: z.string().nullable(),
  deployedSha: z.string().nullable(),
  rollbackOf: z.string().nullable(),
  rollbackChangeSetId: z.string().nullable(),
  uncoveredChanges: z
    .array(z.object({ index: z.number().int(), reason: z.string() }))
    .describe('For a rollback proposal: the original changes it cannot reverse, with the reason'),
  verificationAttempts: z.number().int(),
  lastError: z.string().nullable(),
  stateChangedAt: z.string(),
  draftedAt: z.string(),
  submittedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  appliedAt: z.string().nullable(),
  mergedAt: z.string().nullable(),
  deployedAt: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  failedAt: z.string().nullable(),
});

const EventView = z.object({
  at: z.string(),
  fromState: StateEnum.nullable(),
  toState: StateEnum,
  actor: z.object({ type: z.enum(['person', 'agent', 'system']), id: z.string().nullable() }),
  reason: z.string(),
  evidence: z.record(z.string(), z.unknown()),
});

const VerificationView = z.object({
  attempt: z.number().int(),
  changeIndex: z.number().int(),
  url: z.string(),
  changeType: z.string(),
  result: z.enum(['pass', 'fail', 'unknown']),
  detail: z.string(),
  evidence: z.record(z.string(), z.unknown()),
  deployedSha: z.string(),
  fetchedAt: z.string(),
});

const ReachView = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unknown'), reason: z.string() }),
  z.object({
    kind: z.literal('known'),
    affectedUrls: z.number().int(),
    clicksAtRisk: z.number().nullable(),
    impressionsAtRisk: z.number().nullable().optional(),
    clicksAtRiskLastYear: z.number().nullable().optional(),
    impressionsAtRiskLastYear: z.number().nullable().optional(),
    criticalPages: z.array(z.string()),
    dataThrough: z.string().optional(),
  }),
]);

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

function runView(run: ChangeSetRun): z.output<typeof RunView> {
  return {
    artifactId: run.artifactId,
    siteId: run.siteId,
    state: run.state,
    approvedVersion: run.approvedVersion,
    approvedHeadSha: run.approvedHeadSha,
    approvalId: run.approvalId,
    branch: run.branch,
    prNumber: run.prNumber,
    prUrl: run.prUrl,
    headSha: run.headSha,
    mergeCommitSha: run.mergeCommitSha,
    deployedSha: run.deployedSha,
    rollbackOf: run.rollbackOf,
    rollbackChangeSetId: run.rollbackChangeSetId,
    uncoveredChanges: run.uncoveredChanges,
    verificationAttempts: run.verificationAttempts,
    lastError: run.lastError,
    stateChangedAt: run.stateChangedAt.toISOString(),
    draftedAt: run.draftedAt.toISOString(),
    submittedAt: iso(run.submittedAt),
    approvedAt: iso(run.approvedAt),
    appliedAt: iso(run.appliedAt),
    mergedAt: iso(run.mergedAt),
    deployedAt: iso(run.deployedAt),
    verifiedAt: iso(run.verifiedAt),
    closedAt: iso(run.closedAt),
    failedAt: iso(run.failedAt),
  };
}

async function loadSite(tx: Tx, workspaceId: string, siteId: string) {
  const [site] = await tx
    .select()
    .from(schema.sites)
    .where(and(eq(schema.sites.workspaceId, workspaceId), eq(schema.sites.id, siteId)));
  if (!site) throw new AppError('not_found', `Site ${siteId} does not exist in this workspace.`);
  if (site.archived) throw new AppError('conflict', `Site “${site.name}” (${site.primaryDomain}) is archived, so it cannot be changed.`);
  return site;
}

/** The GitHub mapping and a client at the base branch's head: the pair every draft needs. */
async function draftingContext(ctx: CommandContext, siteId: string, siteName: string) {
  const connection = await activeConnection(ctx.tx, {
    workspaceId: ctx.principal.workspaceId,
    siteId,
    kp: ctx.services.keyProvider,
    siteName: `“${siteName}”`,
  });
  const client = await commandClient(ctx, connection);
  const base = await client.getBranchHead(connection.settings.baseBranch).catch((error: unknown) => {
    throw githubAppError(error);
  });
  return {
    connection,
    client,
    baseSha: base.sha,
    mapping: connection.settings.mapping,
    listFiles: async (prefix: string) =>
      (
        await client.listTree(base.sha, prefix).catch((error: unknown) => {
          throw githubAppError(error);
        })
      ).paths,
    readFile: async (path: string) =>
      (
        await client.getFile(path, base.sha).catch((error: unknown) => {
          throw githubAppError(error);
        })
      ).content,
  };
}

interface DraftInput {
  siteId: string;
  siteName: string;
  title: string;
  summary: string;
  changes: Change[];
  verificationPlan: string;
  rollbackPlan: string;
  recommendationId?: string;
  allowPartial?: boolean;
  rollbackOf?: string;
}

/**
 * Re-derives every server-owned field of a stored change set from the repository at the commit it
 * was drafted from. Approval and the apply worker both run this: the generic artifact commands
 * cannot write these fields, but a database write or an older client must still not be able to
 * smuggle a path, hash or diff past the reviewer.
 */
async function revalidationProblems(
  ctx: CommandContext,
  input: { siteId: string; siteName: string; content: Parameters<typeof revalidateChangeSet>[0] },
) {
  const connection = await activeConnection(ctx.tx, {
    workspaceId: ctx.principal.workspaceId,
    siteId: input.siteId,
    kp: ctx.services.keyProvider,
    siteName: `“${input.siteName}”`,
  });
  const client = await commandClient(ctx, connection);
  return revalidateChangeSet(input.content, {
    mapping: connection.settings.mapping,
    listFiles: async (prefix, ref) =>
      (
        await client.listTree(ref, prefix).catch((error: unknown) => {
          throw githubAppError(error);
        })
      ).paths,
    readFile: async (path, ref) =>
      (
        await client.getFile(path, ref).catch((error: unknown) => {
          throw githubAppError(error);
        })
      ).content,
  });
}

/** Resolves and applies every change; the content is only built when something can be written. */
async function draftFor(ctx: CommandContext, input: DraftInput) {
  const drafting = await draftingContext(ctx, input.siteId, input.siteName);
  const draft = await draftChanges(input.changes, {
    mapping: drafting.mapping,
    baseSha: drafting.baseSha,
    listFiles: drafting.listFiles,
    readFile: drafting.readFile,
  });
  const accepted = draft.drafted;
  const keepGoing = accepted.length > 0 && (draft.refusals.length === 0 || input.allowPartial === true);
  const content = keepGoing
    ? {
        connector: 'github' as const,
        title: input.title,
        summary: input.summary,
        ...(input.recommendationId ? { recommendationId: input.recommendationId } : {}),
        changes: accepted,
        verificationPlan: input.verificationPlan,
        rollbackPlan: input.rollbackPlan,
      }
    : null;
  return { drafting, draft, content };
}

const changeViews = (content: {
  changes: {
    change: Change;
    source: { path: string; editor: string; confidence: string; affectedRoutes: string[] };
    baseSha: string;
    sourceHash: string;
    diff: { unified: string; additions: number; deletions: number };
  }[];
}): z.output<typeof ChangeView>[] =>
  content.changes.map((drafted, index) => ({
    index,
    type: drafted.change.type,
    url: urlOf(drafted.change),
    source: {
      path: drafted.source.path,
      editor: drafted.source.editor,
      confidence: drafted.source.confidence,
      affectedRoutes: drafted.source.affectedRoutes,
    },
    baseSha: drafted.baseSha,
    sourceHash: drafted.sourceHash,
    additions: drafted.diff.additions,
    deletions: drafted.diff.deletions,
    diff: drafted.diff.unified,
  }));

/** What the caller should do next, per outcome. */
const nextFor = (created: boolean, refusals: number): string =>
  created
    ? 'Review it with changes.get, then changes.requestApply.'
    : refusals > 0
      ? 'Every refusal above is per change: fix it and draft again, or pass allowPartial to keep the changes that can be applied.'
      : 'Nothing could be drafted; check the source mapping with connectors.github.status.';

/**
 * The changes stored in a version. Drafted versions store each change as a wrapper with its source,
 * base commit, hash and diff ({ change, source, … }); a redraft without new changes must read the
 * `.change` out of those wrappers, not hand the wrapper to the editor. Plain changes are accepted
 * too, so a version written by a test or an import still redrafts.
 */
function storedChanges(content: Record<string, unknown>): Change[] | undefined {
  const raw = content.changes;
  if (!Array.isArray(raw)) return undefined;
  const changes: Change[] = [];
  for (const entry of raw) {
    const candidate = typeof entry === 'object' && entry !== null && 'change' in entry ? (entry as { change: unknown }).change : entry;
    const parsed = ChangeSchema.safeParse(candidate);
    if (parsed.success) changes.push(parsed.data);
  }
  return changes.length ? changes : undefined;
}

export const changesCreate = defineCommand({
  name: 'changes.create',
  title: 'Draft a change set',
  description:
    'Resolves each change through the site’s GitHub source mapping, applies it in memory to prove it can be written, and stores the change set as a draft artifact with the base commit, each file’s sha256 and the diff. A change the library refuses is returned with its reason and nothing is created unless every change applies (pass allowPartial to keep the rest). Nothing is written to the site: applying needs a person’s approval. Free.',
  input: z.object({
    siteId: SiteId,
    title: z.string().trim().min(1).max(200).describe('What this change set does, in one line; the pull request title'),
    summary: z.string().trim().min(1).max(2000).describe('Why these changes, and what evidence backs them'),
    changes: z.array(ChangeSchema).min(1).max(50).describe('The edits, in the order they should be applied'),
    verificationPlan: z.string().trim().min(1).max(2000).describe('What a re-fetch after deployment must show'),
    rollbackPlan: z.string().trim().min(1).max(2000).describe('How to undo this change set'),
    recommendationId: z
      .string()
      .regex(/^rcm_[0-9a-f]{32}$/, 'A recommendation id')
      .optional(),
    allowPartial: z.boolean().default(false).describe('Draft the changes that apply even when another is refused'),
    note: z.string().max(500).optional().describe('Why this draft was made, shown to reviewers'),
  }),
  output: z.object({
    created: z.boolean(),
    changeSetId: z.string().nullable(),
    version: z.number().int().nullable(),
    refusals: z.array(RefusalView),
    changes: z.array(ChangeView),
    next: z.string(),
  }),
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'draft',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const site = await loadSite(ctx.tx, ctx.principal.workspaceId, input.siteId);
    const { drafting, draft, content } = await draftFor(ctx, { ...input, siteName: site.name });
    if (!content) {
      return {
        created: false,
        changeSetId: null,
        version: null,
        refusals: draft.refusals,
        changes: [],
        next: nextFor(false, draft.refusals.length),
      };
    }
    const validated = (await validateContent('change_set', content, 'draft')) as unknown as typeof content;
    const id = newId(artifactTypes.change_set.prefix);
    await ctx.tx.insert(schema.artifacts).values({
      workspaceId: ctx.principal.workspaceId,
      id,
      type: 'change_set',
      name: input.title,
      siteId: site.id,
      latestVersion: 1,
      ownerAgentId: ctx.principal.type === 'agent' ? (ctx.principal.agent?.id ?? null) : null,
    });
    await ctx.tx.insert(schema.artifactVersions).values({
      workspaceId: ctx.principal.workspaceId,
      artifactId: id,
      number: 1,
      state: 'draft',
      content: validated,
      contentHash: hashValue(validated),
      note: input.note ?? null,
      ...author(ctx),
    });
    await ctx.tx.insert(schema.changeSetRuns).values({
      workspaceId: ctx.principal.workspaceId,
      artifactId: id,
      siteId: site.id,
      state: 'draft',
      draftedAt: new Date(),
    });
    await recordEvent(ctx.tx, {
      workspaceId: ctx.principal.workspaceId,
      artifactId: id,
      fromState: null,
      toState: 'draft',
      actor: actorOf(ctx),
      reason: `Drafted ${validated.changes.length} change${validated.changes.length === 1 ? '' : 's'} against ${slugOf(drafting.connection.settings)}.`,
      evidence: { baseSha: validated.changes[0]?.baseSha ?? null, paths: sourcePathsOf(validated) },
    });
    return {
      created: true,
      changeSetId: id,
      version: 1,
      refusals: draft.refusals,
      changes: changeViews(validated),
      next: nextFor(true, draft.refusals.length),
    };
  },
});

export const changesUpdateDraft = defineCommand({
  name: 'changes.updateDraft',
  title: 'Redraft a change set',
  description:
    'Re-resolves every change against the repository’s current base head and writes a new draft version. Use it when a source changed after drafting (the change set is then stale), when a reviewer asked for an edit, or to try again after a verification failure. Refused while the change set is applying or has an open pull request. Free.',
  input: z.object({
    changeSetId: ChangeSetId,
    title: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().min(1).max(2000).optional(),
    changes: z.array(ChangeSchema).min(1).max(50).optional().describe('Replace the changes; omit to keep the current ones'),
    verificationPlan: z.string().trim().min(1).max(2000).optional(),
    rollbackPlan: z.string().trim().min(1).max(2000).optional(),
    recommendationId: z
      .string()
      .regex(/^rcm_[0-9a-f]{32}$/)
      .optional(),
    allowPartial: z.boolean().default(false),
    note: z.string().max(500).optional(),
  }),
  output: z.object({
    changeSetId: z.string(),
    version: z.number().int(),
    created: z.boolean(),
    refusals: z.array(RefusalView),
    changes: z.array(ChangeView),
    next: z.string(),
  }),
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'draft',
  target: (input) => input.changeSetId,
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const [artifact] = await ctx.tx
      .select()
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.workspaceId, ws), eq(schema.artifacts.id, input.changeSetId)))
      .for('update');
    if (!artifact) throw new AppError('not_found', `Change set ${input.changeSetId} does not exist in this workspace.`);
    if (artifact.type !== 'change_set')
      throw new AppError('invalid_input', `${input.changeSetId} is a ${artifact.type}, not a change set.`);
    if (artifact.archived) throw new AppError('conflict', 'This change set is archived, so it cannot be redrafted.');
    if (!artifact.siteId) throw new AppError('conflict', 'This change set has no site, so its sources cannot be resolved.');
    const run = await loadRun(ctx.tx, ws, artifact.id);
    if ((IN_FLIGHT as readonly string[]).includes(run.state)) {
      throw new AppError(
        'conflict',
        `This change set is ${run.state.replace('_', ' ')}, so its content is what GitHub holds. Wait for the pull request to close or merge, or roll it back, before redrafting.`,
      );
    }
    const pending = await ctx.tx
      .select({ id: schema.approvalRequests.id })
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.workspaceId, ws),
          eq(schema.approvalRequests.artifactId, artifact.id),
          eq(schema.approvalRequests.status, 'pending'),
        ),
      );
    if (pending.length) {
      throw new AppError(
        'conflict',
        `This change set is waiting for approval (${pending[0]!.id}). Have it rejected, or approve it, before redrafting it.`,
      );
    }
    const latest = await ctx.tx
      .select()
      .from(schema.artifactVersions)
      .where(
        and(
          eq(schema.artifactVersions.workspaceId, ws),
          eq(schema.artifactVersions.artifactId, artifact.id),
          eq(schema.artifactVersions.number, artifact.latestVersion),
        ),
      );
    const previous = latest[0];
    const parsed = previous ? z.record(z.string(), z.unknown()).safeParse(previous.content) : null;
    const old = parsed?.success ? parsed.data : {};
    const site = await loadSite(ctx.tx, ws, artifact.siteId);
    const changes = input.changes ?? storedChanges(old);
    if (!changes?.length) throw new AppError('invalid_input', 'This change set has no changes to redraft; pass them explicitly.');
    const recommendationId = input.recommendationId ?? (old.recommendationId as string | undefined);
    const { draft, content } = await draftFor(ctx, {
      siteId: site.id,
      siteName: site.name,
      title: input.title ?? String(old.title ?? artifact.name),
      summary: input.summary ?? String(old.summary ?? ''),
      changes,
      verificationPlan: input.verificationPlan ?? String(old.verificationPlan ?? ''),
      rollbackPlan: input.rollbackPlan ?? String(old.rollbackPlan ?? ''),
      ...(recommendationId ? { recommendationId } : {}),
      allowPartial: input.allowPartial,
      ...(run.rollbackOf ? { rollbackOf: run.rollbackOf } : {}),
    });
    if (!content) {
      return {
        changeSetId: artifact.id,
        version: artifact.latestVersion,
        created: false,
        refusals: draft.refusals,
        changes: [],
        next: nextFor(false, draft.refusals.length),
      };
    }
    const validated = (await validateContent('change_set', content, 'draft')) as unknown as typeof content;
    let version: number;
    if (previous?.state === 'draft') {
      // An unreviewed draft is edited in place, exactly like artifacts.updateDraft.
      await ctx.tx
        .update(schema.artifactVersions)
        .set({
          content: validated,
          contentHash: hashValue(validated),
          note: input.note ?? previous.note,
          updatedAt: new Date(),
          ...author(ctx),
        })
        .where(
          and(
            eq(schema.artifactVersions.workspaceId, ws),
            eq(schema.artifactVersions.artifactId, artifact.id),
            eq(schema.artifactVersions.number, previous.number),
          ),
        );
      version = previous.number;
    } else {
      version = artifact.latestVersion + 1;
      await ctx.tx.insert(schema.artifactVersions).values({
        workspaceId: ws,
        artifactId: artifact.id,
        number: version,
        state: 'draft',
        content: validated,
        contentHash: hashValue(validated),
        basedOn: artifact.latestVersion,
        note: input.note ?? null,
        ...author(ctx),
      });
      await ctx.tx
        .update(schema.artifacts)
        .set({ latestVersion: version, updatedAt: new Date() })
        .where(and(eq(schema.artifacts.workspaceId, ws), eq(schema.artifacts.id, artifact.id)));
    }
    await ctx.tx
      .update(schema.artifacts)
      .set({ name: input.title ?? artifact.name, updatedAt: new Date() })
      .where(and(eq(schema.artifacts.workspaceId, ws), eq(schema.artifacts.id, artifact.id)));
    const backToDraft = await transition(ctx.tx, run, 'draft', {
      reason: `Redrafted as version ${version} against ${validated.changes[0]?.baseSha ?? 'the base branch'}.`,
      actor: actorOf(ctx),
      evidence: { version, baseSha: validated.changes[0]?.baseSha ?? null },
      set: { approvedVersion: null, approvedHeadSha: null, approvalId: null, lastError: null },
    });
    if (!backToDraft && run.state !== 'draft') {
      throw new AppError('conflict', 'The change set moved while it was being redrafted. Reload it with changes.get and try again.');
    }
    return {
      changeSetId: artifact.id,
      version,
      created: true,
      refusals: draft.refusals,
      changes: changeViews(validated),
      next: nextFor(true, draft.refusals.length),
    };
  },
});

export const changesGet = defineCommand({
  name: 'changes.get',
  title: 'Get a change set',
  description:
    'The change set with its lifecycle row (state, pull request, commits, timestamps), the content of one version (default: the latest) and the sites it touches. Use it to read what will be applied and where it is in the pipeline. Free.',
  input: z.object({ changeSetId: ChangeSetId, version: z.number().int().positive().optional() }),
  output: z.object({
    run: RunView,
    name: z.string(),
    siteId: z.string(),
    latestVersion: z.number().int(),
    publishedVersion: z.number().int().nullable(),
    version: z.number().int(),
    content: z.unknown(),
    changes: z.array(ChangeView),
  }),
  permission: 'sites:read',
  effect: 'read',
  actionClass: 'read',
  target: (input) => input.changeSetId,
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const run = await getRun(ctx, input.changeSetId);
    const [artifact] = await ctx.tx
      .select()
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.workspaceId, ws), eq(schema.artifacts.id, input.changeSetId)));
    if (!artifact) throw new AppError('not_found', `Change set ${input.changeSetId} does not exist in this workspace.`);
    const number = input.version ?? artifact.latestVersion;
    const [version] = await ctx.tx
      .select()
      .from(schema.artifactVersions)
      .where(
        and(
          eq(schema.artifactVersions.workspaceId, ws),
          eq(schema.artifactVersions.artifactId, artifact.id),
          eq(schema.artifactVersions.number, number),
        ),
      );
    if (!version) throw new AppError('not_found', `Version ${number} of change set ${artifact.id} does not exist.`);
    const content = version.content as { changes?: Parameters<typeof changeViews>[0]['changes'] };
    return {
      run: runView(run),
      name: artifact.name,
      siteId: run.siteId,
      latestVersion: artifact.latestVersion,
      publishedVersion: artifact.publishedVersion,
      version: number,
      content: version.content,
      changes: content?.changes ? changeViews({ changes: content.changes }) : [],
    };
  },
});

/** The run row or the request-shaped not-found error a read returns. */
async function getRun(ctx: CommandContext, artifactId: string): Promise<ChangeSetRun> {
  const run = await findRun(ctx.tx, ctx.principal.workspaceId, artifactId);
  if (!run) throw new AppError('not_found', `${artifactId} is not a change set in this workspace.`);
  return run;
}

/** Cursors are opaque: base64url of the keyset position, so no caller depends on the shape. */
function encodeCursor(createdAt: string, artifactId: string): string {
  return Buffer.from(JSON.stringify({ at: createdAt, id: artifactId }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown };
    if (typeof parsed.at !== 'string' || typeof parsed.id !== 'string') throw new Error('shape');
    return { at: parsed.at, id: parsed.id };
  } catch {
    throw new AppError('invalid_input', 'The cursor is not one this command returned. Leave it out to start from the first page.');
  }
}

export const changesList = defineCommand({
  name: 'changes.list',
  title: 'List change sets',
  description:
    'The site’s change sets, oldest first, optionally filtered by state, with the lifecycle row of each (state, pull request, deployed commit). Use it to find work that is waiting for approval, in review, or failed. Free.',
  input: z.object({
    siteId: SiteId,
    state: StateEnum.optional().describe('Only change sets in this state'),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().max(500).optional().describe('Opaque nextCursor from the previous page; omit for the first page'),
  }),
  output: z.object({
    changes: z.array(RunView),
    total: z.number().int(),
    nextCursor: z.string().nullable(),
  }),
  permission: 'sites:read',
  effect: 'read',
  actionClass: 'read',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    await loadSite(ctx.tx, ws, input.siteId);
    const cursor = decodeCursor(input.cursor);
    const filters = and(
      eq(schema.changeSetRuns.workspaceId, ws),
      eq(schema.changeSetRuns.siteId, input.siteId),
      input.state ? eq(schema.changeSetRuns.state, input.state) : undefined,
    );
    const pageFilter = cursor
      ? and(
          filters,
          // Keyset on (created_at, artifact_id): the row-wise comparison keeps the cursor exact
          // through equal timestamps, and the id tie-break makes the order total.
          sql`(${schema.changeSetRuns.createdAt}, ${schema.changeSetRuns.artifactId}) > (${cursor.at}::timestamptz, ${cursor.id})`,
        )
      : filters;
    const rows = await ctx.tx
      .select()
      .from(schema.changeSetRuns)
      .where(pageFilter)
      .orderBy(schema.changeSetRuns.createdAt, schema.changeSetRuns.artifactId)
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const [counted] = await ctx.tx.select({ n: count() }).from(schema.changeSetRuns).where(filters);
    const last = page[page.length - 1];
    return {
      changes: page.map(runView),
      total: Number(counted?.n ?? 0),
      nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt.toISOString(), last.artifactId) : null,
    };
  },
});

export const changesDiff = defineCommand({
  name: 'changes.diff',
  title: 'Change set diff',
  description:
    'The per-URL before/after pairs and the source-file diffs of one change set version (default: the latest). This is what the review screen shows; nothing is fetched. Free.',
  input: z.object({ changeSetId: ChangeSetId, version: z.number().int().positive().optional() }),
  output: z.object({
    version: z.number().int(),
    files: z.array(
      z.object({
        path: z.string(),
        status: z.enum(['added', 'modified', 'deleted']),
        unified: z.string(),
        additions: z.number().int(),
        deletions: z.number().int(),
      }),
    ),
    urls: z.array(z.object({ url: z.string(), changes: z.array(z.object({ type: z.string(), before: z.unknown(), after: z.unknown() })) })),
  }),
  permission: 'sites:read',
  effect: 'read',
  actionClass: 'read',
  target: (input) => input.changeSetId,
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const run = await getRun(ctx, input.changeSetId);
    const [artifact] = await ctx.tx
      .select()
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.workspaceId, ws), eq(schema.artifacts.id, run.artifactId)));
    if (!artifact) throw new AppError('not_found', `Change set ${run.artifactId} does not exist in this workspace.`);
    const number = input.version ?? artifact.latestVersion;
    const [version] = await ctx.tx
      .select()
      .from(schema.artifactVersions)
      .where(
        and(
          eq(schema.artifactVersions.workspaceId, ws),
          eq(schema.artifactVersions.artifactId, artifact.id),
          eq(schema.artifactVersions.number, number),
        ),
      );
    if (!version) throw new AppError('not_found', `Version ${number} of change set ${artifact.id} does not exist.`);
    const content = version.content as {
      changes?: {
        change: Change;
        diff: { path: string; status: 'added' | 'modified' | 'deleted'; unified: string; additions: number; deletions: number };
      }[];
    };
    const drafted = content.changes ?? [];
    const rendered = renderDiff({ changes: drafted.map((entry) => entry.change) });
    return {
      version: number,
      files: drafted.map((entry) => ({
        path: entry.diff.path,
        status: entry.diff.status,
        unified: entry.diff.unified,
        additions: entry.diff.additions,
        deletions: entry.diff.deletions,
      })),
      urls: rendered.urls,
    };
  },
});

export const changesStatus = defineCommand({
  name: 'changes.status',
  title: 'Change set status',
  description:
    'Where one change set is: its lifecycle row, every recorded transition with its reason and evidence, and the latest verification results per change (pass, fail or unknown, with what the deployed page showed). Use it to explain a failed deploy or verification. Free.',
  input: z.object({ changeSetId: ChangeSetId }),
  output: z.object({
    run: RunView,
    events: z.array(EventView),
    verification: z.object({ attempt: z.number().int().nullable(), results: z.array(VerificationView) }),
  }),
  permission: 'sites:read',
  effect: 'read',
  actionClass: 'read',
  target: (input) => input.changeSetId,
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const run = await getRun(ctx, input.changeSetId);
    const events = await eventsOf(ctx.tx, ws, run.artifactId);
    const verification = await latestVerifications(ctx.tx, ws, run.artifactId);
    return {
      run: runView(run),
      events: events.map((event) => ({
        at: event.at.toISOString(),
        fromState: event.fromState as z.output<typeof EventView>['fromState'],
        toState: event.toState as z.output<typeof EventView>['toState'],
        actor: { type: event.actorType, id: event.actorId },
        reason: event.reason,
        evidence: event.evidence,
      })),
      verification: {
        attempt: verification.attempt,
        results: verification.rows.map((row) => ({
          attempt: row.attempt,
          changeIndex: row.changeIndex,
          url: row.url,
          changeType: row.changeType,
          result: row.result,
          detail: row.detail,
          evidence: row.evidence,
          deployedSha: row.deployedSha,
          fetchedAt: row.fetchedAt.toISOString(),
        })),
      },
    };
  },
});

export const changesRequestApply = defineCommand({
  name: 'changes.requestApply',
  title: 'Submit a change set for approval',
  description:
    'Publishes the change set’s latest draft through the approval flow with the impact the policy engine judges: the action class of its strongest change, the traffic at risk over every affected URL, and the fixed rules (an unverified site refuses, more than 20 redirects needs a person, a conflicting open change set holds it with the other set named). A person’s request publishes it; an agent’s goes to review unless its mandate allows it. Free.',
  input: z.object({
    changeSetId: ChangeSetId,
    note: z.string().min(1).max(1000).describe('What changed and why, for the reviewer'),
  }),
  output: z.object({
    status: z.enum(['published', 'in_review']),
    version: z.number().int(),
    approvalId: z.string().nullable(),
    reviewUrl: z.string().nullable(),
    policy: z.string(),
    actionClass: z.string(),
    reach: ReachView,
    heldBecause: z.array(z.string()).describe('Why a person must approve it, from the fixed rules or a conflict; empty when none applied'),
    next: z.string(),
  }),
  permission: 'changes:apply',
  effect: 'publish',
  actionClass: 'draft',
  approvable: true,
  target: (input) => input.changeSetId,
  impact: async (input, ctx) => {
    // Lock the artifact row before policy: a concurrent redraft must not change the version the
    // policy judges while the handler reads it. The version is passed explicitly below, because the
    // run's approved version is the previous one after a redraft, and the handler publishes latest.
    await lockArtifacts(ctx, [input.changeSetId]);
    const run = await getRun(ctx, input.changeSetId);
    const [artifact] = await ctx.tx
      .select({ latestVersion: schema.artifacts.latestVersion })
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.workspaceId, ctx.principal.workspaceId), eq(schema.artifacts.id, input.changeSetId)));
    const content = artifact ? await contentOfRun(ctx.tx, run, artifact.latestVersion) : null;
    if (!content) return { actionClass: 'draft', reach: { kind: 'unknown', reason: 'The change set content is not readable.' } };
    const impact = await changeSetImpact(ctx.tx, {
      workspaceId: ctx.principal.workspaceId,
      siteId: run.siteId,
      artifactId: run.artifactId,
      content,
      rollbackOf: run.rollbackOf,
    });
    return {
      actionClass: impact.actionClass,
      reach: impact.reach,
      reversible: true,
      summary: `apply change set ${run.artifactId}`,
      ...(impact.needsPerson.length ? { needsPerson: impact.needsPerson.join(' ') } : {}),
    };
  },
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    await lockArtifacts(ctx, [input.changeSetId]);
    const [artifact] = await ctx.tx
      .select()
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.workspaceId, ws), eq(schema.artifacts.id, input.changeSetId)));
    if (!artifact) throw new AppError('not_found', `Change set ${input.changeSetId} does not exist in this workspace.`);
    if (artifact.type !== 'change_set')
      throw new AppError('invalid_input', `${input.changeSetId} is a ${artifact.type}, not a change set.`);
    if (artifact.archived) throw new AppError('conflict', 'This change set is archived, so it cannot be applied.');
    const run = await loadRun(ctx.tx, ws, artifact.id);
    if ((IN_FLIGHT as readonly string[]).includes(run.state)) {
      throw new AppError('conflict', `This change set is already ${run.state.replace('_', ' ')}; it cannot be submitted again.`);
    }
    // The fixed rule, checked before an approval request exists: nothing may be applied to a site
    // whose ownership nobody has proved. The publish validator repeats it for the other door.
    const site = await loadSite(ctx.tx, ws, run.siteId);
    if (site.verifiedAt === null) {
      throw new AppError(
        'precondition_failed',
        `Site “${site.name}” (${site.primaryDomain}) is not verified, so no change can be applied to it. Verify ownership with sites.verify first.`,
      );
    }
    const [version] = await ctx.tx
      .select()
      .from(schema.artifactVersions)
      .where(
        and(
          eq(schema.artifactVersions.workspaceId, ws),
          eq(schema.artifactVersions.artifactId, artifact.id),
          eq(schema.artifactVersions.number, artifact.latestVersion),
        ),
      );
    if (!version) throw new AppError('not_found', `The latest version of change set ${artifact.id} does not exist.`);
    if (version.state !== 'draft') {
      throw new AppError(
        'conflict',
        `Version ${version.number} is ${version.state.replace('_', ' ')}, not a draft. Redraft it with changes.updateDraft first.`,
      );
    }
    const content = await contentOfRun(ctx.tx, run, version.number);
    if (!content) throw new AppError('invalid_input', 'The change set content is not readable; redraft it with changes.updateDraft.');
    // The source details are server-owned: re-derive them from the repository at the commit this
    // version was drafted from. A forged path, hash or diff never reaches a policy decision or an
    // approval request.
    const problems = await revalidationProblems(ctx, { siteId: run.siteId, siteName: site.name, content });
    if (problems.length) {
      throw new AppError(
        'precondition_failed',
        `This change set’s stored source details do not match the repository at its base commit: ${describeRevalidation(problems)} Redraft it with changes.updateDraft so the paths, hashes and diff are derived again.`,
      );
    }
    const impact = await changeSetImpact(ctx.tx, {
      workspaceId: ws,
      siteId: run.siteId,
      artifactId: artifact.id,
      content,
      rollbackOf: run.rollbackOf,
    });

    const [workspace] = await ctx.tx
      .select({ policy: schema.workspaces.approvalPolicy })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, ws));
    const policy = workspace?.policy ?? 'none';
    const agentPolicyAsks = ctx.policy?.decision === 'ask';
    const autonomous = ctx.policy?.decision === 'allow' && ctx.policy.autonomous === true && impact.needsPerson.length === 0;
    const needsApproval =
      policy === 'all_publishes' ||
      (policy === 'agent_changes' && (ctx.principal.type === 'agent' || version.authorType === 'agent')) ||
      agentPolicyAsks ||
      impact.needsPerson.length > 0;

    // A conflict hold keeps the approval request even when the policy would publish directly: the
    // conflict is the reason the person is here.
    if (autonomous || !needsApproval) {
      await publishArtifactVersion(ctx, artifact.id, version.number);
      return {
        status: 'published' as const,
        version: version.number,
        approvalId: null,
        reviewUrl: null,
        policy,
        actionClass: impact.actionClass,
        reach: impact.reach,
        heldBecause: ctx.policy?.decision === 'ask' ? ctx.policy.reasons : [],
        next: 'Published. The apply job opens the pull request; watch it with changes.status.',
      };
    }

    const approvalId = newId('apr');
    await ctx.tx
      .update(schema.artifactVersions)
      .set({ state: 'in_review', updatedAt: new Date() })
      .where(
        and(
          eq(schema.artifactVersions.workspaceId, ws),
          eq(schema.artifactVersions.artifactId, artifact.id),
          eq(schema.artifactVersions.number, version.number),
        ),
      );
    const note = noteWithPolicy(input.note, ctx);
    const withConflicts = impact.needsPerson.length ? `${note}\n\nHeld: ${impact.needsPerson.join(' ')}`.slice(0, 2000) : note;
    await ctx.tx.insert(schema.approvalRequests).values({
      workspaceId: ws,
      id: approvalId,
      artifactId: artifact.id,
      version: version.number,
      status: 'pending',
      requestedByType: ctx.principal.type,
      requestedById: ctx.principal.userId,
      requestedByClient: ctx.principal.clientId ?? null,
      note: withConflicts,
    });
    const moved = await transition(ctx.tx, run, 'in_review', {
      reason: impact.needsPerson.length
        ? `Submitted for approval; a person is required: ${impact.needsPerson.join(' ')}`
        : 'Submitted for approval.',
      actor: actorOf(ctx),
      evidence: {
        version: version.number,
        approvalId,
        actionClass: impact.actionClass,
        reach: impact.reach,
        conflicts: impact.conflicts.map((conflict) => conflict.artifactId),
      },
      set: { approvalId, approvedVersion: null, lastError: null },
    });
    if (!moved)
      throw new AppError('conflict', 'The change set moved while it was being submitted. Reload it with changes.status and try again.');
    const reviewUrl = ctx.services.publicUrl ? `${ctx.services.publicUrl}/approvals/${approvalId}` : null;
    return {
      status: 'in_review' as const,
      version: version.number,
      approvalId,
      reviewUrl,
      policy,
      actionClass: impact.actionClass,
      reach: impact.reach,
      heldBecause: [...impact.needsPerson, ...(ctx.policy?.decision === 'ask' ? ctx.policy.reasons : [])],
      next: reviewUrl
        ? `A person must approve it: ${reviewUrl}. Check progress with changes.status.`
        : 'A person must approve it. Check progress with changes.status.',
    };
  },
});

/**
 * The one refusal for a second open rollback of the same original, whether it was seen by the
 * in-flight check (which knows the proposal's id) or by the partial unique index (which does not).
 */
function rollbackInFlight(originalId: string, proposalId: string | null): AppError {
  return new AppError(
    'conflict',
    proposalId
      ? `Change set ${proposalId} is already a rollback of ${originalId}. Wait for it to be verified, or close it, before proposing another.`
      : `Another rollback of ${originalId} was proposed at the same moment. Wait for it to be verified, or close it, before proposing another.`,
  );
}

/** Whether a write lost a race on a unique index (`unique_violation`), e.g. 0010's rollback guard. */
function isUniqueViolation(error: unknown): boolean {
  const direct = (error as { code?: unknown } | null)?.code;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return direct === '23505' || cause === '23505';
}

export const changesRollback = defineCommand({
  name: 'changes.rollback',
  title: 'Propose a rollback',
  description:
    'Creates a new draft change set that reverses an applied change set. When every original change can be inverted and every touched file still matches the merge commit the inverse edits are exact; when later edits landed they are drafted against the current files, and a change that cannot be inverted from the change record (an inserted meta description, a replaced JSON-LD block) is listed in uncoveredChanges instead of being silently dropped. Such a proposal is never exact, is judged with the original change set’s action class and reach, and never marks the original rolled back. The rollback is a change set like any other: nothing is written to GitHub here, and its pull request opens only after a person approves it. Refused before the change set was merged, and refuses a second open rollback while one is still in flight. Free.',
  input: z.object({
    changeSetId: ChangeSetId,
    note: z.string().min(1).max(1000).describe('Why this is being rolled back, for the reviewer'),
  }),
  output: z.object({
    changeSetId: z.string().describe('The new draft rollback change set'),
    mode: z
      .enum(['exact', 'proposed'])
      .describe(
        'exact: every change is covered and every touched file still matches the merge; proposed: a file moved or a change cannot be inverted',
      ),
    filesUnchanged: z.boolean().describe('Whether every touched file still matches the merge commit'),
    actionClass: z.string().describe('The class the rollback inherits from the original change set'),
    reach: ReachView.describe('The traffic at risk, from the original change set’s affected URLs'),
    reason: z.string(),
    uncoveredChanges: z
      .array(z.object({ index: z.number().int(), reason: z.string() }))
      .describe(
        'Original changes this rollback cannot reverse, with the reason; any entry makes the proposal non-exact and blocks rolled_back',
      ),
    next: z.string(),
  }),
  permission: 'changes:apply',
  effect: 'write',
  actionClass: 'draft',
  target: (input) => input.changeSetId,
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    // Locked before the in-flight check: a second request waits here, then sees the first proposal.
    const run = await lockRun(ctx.tx, ws, input.changeSetId);
    if (!run.mergeCommitSha) {
      throw new AppError('conflict', `Change set ${input.changeSetId} has not been merged, so there is nothing to roll back.`);
    }
    if (run.state === 'rolled_back') throw new AppError('conflict', 'This change set was already rolled back.');

    // One open rollback at a time. A rejected, abandoned or failed proposal is terminal, so another
    // request is allowed while the original stays exactly as it was.
    const [inFlight] = await ctx.tx
      .select({ artifactId: schema.changeSetRuns.artifactId })
      .from(schema.changeSetRuns)
      .where(
        and(
          eq(schema.changeSetRuns.workspaceId, ws),
          eq(schema.changeSetRuns.rollbackOf, input.changeSetId),
          inArray(schema.changeSetRuns.state, [...OPEN_STATES]),
        ),
      );
    if (inFlight) throw rollbackInFlight(input.changeSetId, inFlight.artifactId);

    const content = await contentOfRun(ctx.tx, run);
    if (!content) throw new AppError('invalid_input', 'The change set content is not readable, so its changes cannot be reversed.');
    const [artifact] = await ctx.tx
      .select()
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.workspaceId, ws), eq(schema.artifacts.id, run.artifactId)));
    if (!artifact?.siteId) throw new AppError('conflict', 'The change set has no site, so nothing can be reverted.');
    const site = await loadSite(ctx.tx, ws, artifact.siteId);

    // Reads at the repository's current base head: a rollback is drafted like any other change set.
    const drafting = await draftingContext(ctx, site.id, site.name);
    const paths = sourcePathsOf(content);

    // The safe-rollback rule: an exact revert is possible only when nothing it touched moved since
    // the merge. The same check names the files that did move for a proposal.
    const moved: string[] = [];
    for (const path of paths) {
      try {
        const comparison = await drafting.client.fileUnchanged(path, run.mergeCommitSha, drafting.baseSha);
        if (!comparison.unchanged) moved.push(path);
      } catch (error) {
        throw githubAppError(error);
      }
    }

    // The inverse of each change, re-resolved and applied against the current files.
    const inverses: Change[] = [];
    const uncoveredChanges: { index: number; reason: string }[] = [];
    for (const [index, drafted] of content.changes.entries()) {
      // The file as it is now: the inverse's `before` has to be what the file carries today, or a
      // rollback proposed after a later edit would be refused by its own editor as stale.
      let currentText: string | null = null;
      try {
        currentText = (await drafting.client.getFile(drafted.source.path, drafting.baseSha)).content;
      } catch {
        currentText = null;
      }
      const inverse = inverseOf(drafted, currentText);
      if (inverse.ok) inverses.push(inverse.change);
      else uncoveredChanges.push({ index, reason: inverse.reason });
    }
    if (!inverses.length) {
      throw new AppError(
        'conflict',
        `None of this change set’s changes can be reversed from the change record (${uncoveredChanges.map((entry) => entry.reason).join(' ')}). Revert the merge commit ${run.mergeCommitSha} by hand.`,
      );
    }

    const title = `Revert: ${content.title}`.slice(0, 200);
    const summary = `Rolls back change set ${input.changeSetId}. ${input.note}`.slice(0, 2000);
    const { draft, content: drafted } = await draftFor(ctx, {
      siteId: site.id,
      siteName: site.name,
      title,
      summary,
      changes: inverses,
      verificationPlan: `Re-fetch ${[...new Set(inverses.map(urlOf))].join(', ')} and confirm each change from ${input.changeSetId} no longer holds.`,
      rollbackPlan: 'Re-apply the original change set if the rollback turns out to be wrong.',
      allowPartial: true,
      rollbackOf: input.changeSetId,
    });
    if (!drafted) {
      throw new AppError(
        'conflict',
        `The inverse edits could not be drafted (${draft.refusals.map((entry) => entry.reason).join(' ')}). Revert the merge commit ${run.mergeCommitSha} by hand.`,
      );
    }

    // The rollback inherits the original's action class and reach: approving it is judged exactly
    // like approving the original change again, even when this proposal covers only some of its
    // changes. `changeSetImpact` reads the original's own content for both.
    const impact = await changeSetImpact(ctx.tx, {
      workspaceId: ws,
      siteId: site.id,
      artifactId: run.artifactId,
      content: drafted,
      rollbackOf: input.changeSetId,
    });

    const validated = (await validateContent('change_set', drafted, 'draft')) as unknown as typeof drafted;
    const id = newId(artifactTypes.change_set.prefix);
    await ctx.tx.insert(schema.artifacts).values({
      workspaceId: ws,
      id,
      type: 'change_set',
      name: title,
      siteId: site.id,
      latestVersion: 1,
      ownerAgentId: ctx.principal.type === 'agent' ? (ctx.principal.agent?.id ?? null) : null,
    });
    await ctx.tx.insert(schema.artifactVersions).values({
      workspaceId: ws,
      artifactId: id,
      number: 1,
      state: 'draft',
      content: validated,
      contentHash: hashValue(validated),
      note: input.note,
      ...author(ctx),
    });

    const at = new Date();
    // Exact only when the rollback covers every original change AND every file it touches is still
    // the merge's version. A partial inverse is never exact, however still the files are.
    const exact = moved.length === 0 && uncoveredChanges.length === 0;
    try {
      await ctx.tx.insert(schema.changeSetRuns).values({
        workspaceId: ws,
        artifactId: id,
        siteId: site.id,
        state: 'draft',
        draftedAt: at,
        rollbackOf: input.changeSetId,
        uncoveredChanges,
      });
    } catch (error) {
      // The partial unique index from 0010: another request proposed a rollback in the meantime.
      if (isUniqueViolation(error)) throw rollbackInFlight(input.changeSetId, null);
      throw error;
    }
    await recordEvent(ctx.tx, {
      workspaceId: ws,
      artifactId: id,
      fromState: null,
      toState: 'draft',
      actor: actorOf(ctx),
      reason: exact
        ? `Rollback of ${input.changeSetId}: every change is covered and every touched file still matches the merge commit, so the inverse edits are exact.`
        : uncoveredChanges.length
          ? `Rollback of ${input.changeSetId}: ${uncoveredChanges.length} of ${content.changes.length} changes cannot be inverted from the change record (${uncoveredChanges.map((entry) => entry.reason).join(' ')}), so it is a proposal and cannot complete the rollback.`
          : `Rollback of ${input.changeSetId}: ${moved.join(', ')} changed after the merge, so the inverse edits are drafted against the current files.`,
      evidence: { rollbackOf: input.changeSetId, paths, moved, uncoveredChanges },
    });

    // Link the proposal on the original without moving it: only a verified rollback that covers
    // every original change makes the original `rolled_back` (ADR-0007, safe rollback).
    await ctx.tx
      .update(schema.changeSetRuns)
      .set({ rollbackChangeSetId: id, updatedAt: at })
      .where(and(eq(schema.changeSetRuns.workspaceId, ws), eq(schema.changeSetRuns.artifactId, input.changeSetId)));
    await recordEvent(ctx.tx, {
      workspaceId: ws,
      artifactId: input.changeSetId,
      fromState: run.state,
      toState: run.state,
      actor: actorOf(ctx),
      reason: `Rollback proposed as change set ${id} (${exact ? 'exact' : 'proposed'}). The original changes state only when a rollback that covers every change is verified.`,
      evidence: { rollbackArtifactId: id, mode: exact ? 'exact' : 'proposed', moved, uncoveredChanges },
    });

    return {
      changeSetId: id,
      mode: exact ? ('exact' as const) : ('proposed' as const),
      filesUnchanged: moved.length === 0,
      actionClass: impact.actionClass,
      reach: impact.reach,
      reason: exact
        ? 'Every change is covered and every touched file still matches the merge commit, so the rollback is an exact inverse. Review it and request approval; its pull request opens after approval.'
        : uncoveredChanges.length
          ? `${uncoveredChanges.length} of ${content.changes.length} changes cannot be inverted from the change record, so the rollback is a proposal: it reverses the rest and cannot mark the original rolled back. ${uncoveredChanges.map((entry) => entry.reason).join(' ')}`
          : `${moved.join(', ')} changed after the merge, so the rollback is drafted against the current files. Review it and request approval; its pull request opens after approval.`,
      uncoveredChanges,
      next: `Review it with changes.get, then submit it with changes.requestApply: ${id}.`,
    };
  },
});

export const changeCommands = [
  changesCreate,
  changesUpdateDraft,
  changesGet,
  changesList,
  changesDiff,
  changesStatus,
  changesRequestApply,
  changesRollback,
] as const;

export type { GitHubConnection };
