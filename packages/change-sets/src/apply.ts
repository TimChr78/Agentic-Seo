import { createHash } from 'node:crypto';
import type { ChangeSetContent } from '@agentic-seo/artifacts';
import { applyChange, type Change, type GitHubClient, GitHubError, sourceHashOf } from '@agentic-seo/changes';
import type { Db } from '@agentic-seo/db';
import { schema } from '@agentic-seo/db';
import type { KeyProvider } from '@agentic-seo/secrets';
import { logger } from '@agentic-seo/telemetry';
import { and, eq } from 'drizzle-orm';
import { activeConnection, clientFor, type GitHubSeam, slugOf } from './connector';
import { contentOfRun } from './impact';
import { describeRevalidation, revalidateChangeSet } from './revalidate';
import { invalidateApproval, loadRun, recordEvent, transition } from './state';

// Applying an approved change set (ADR-0007): re-read every source at the base branch's current
// head, refuse when a file moved on since drafting, then write one commit on a branch and open the
// pull request. The merge is the apply; this job stops at `pr_open`.
//
// Idempotency is the hard part. A job can die after GitHub created the branch (or the pull request)
// but before the response arrived, and Graphile then retries. So the job never assumes its own
// progress: it looks for the branch and for a pull request with that head first, adopts what it
// finds when the files are exactly what it would write, and only creates what is missing. A retried
// job therefore cannot leave two pull requests behind.

export interface ApplyDeps {
  kp: KeyProvider;
  /** Test seam for GitHub (a local fake server). */
  github?: GitHubSeam;
  now?: () => Date;
}

export type ApplyResult =
  | { status: 'skipped'; reason: string }
  | { status: 'stale'; reason: string; paths: string[] }
  | { status: 'failed'; reason: string }
  | { status: 'pr_open'; prNumber: number; prUrl: string; headSha: string; adopted: boolean };

/** The branch a change set's pull request lives on; stable across retries and versions. */
export const branchNameFor = (artifactId: string, version: number): string => `aseo/${artifactId}-v${version}`;

/** One line per change, for the pull request body and the approval note. */
export function describeChange(change: Change): string {
  switch (change.type) {
    case 'meta.title':
      return `page title: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`;
    case 'meta.description':
      return `meta description: ${change.before === null ? '(none)' : JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`;
    case 'image.alt':
      return `image alt (${change.resolvedSrc ?? change.src}): ${change.before === null ? '(missing)' : JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`;
    case 'schema.jsonld':
      return `structured data: ${change.operation} ${change.match['@type'] ?? change.match['@id'] ?? 'block'}`;
    case 'redirect':
      return change.operation === 'remove'
        ? `redirect: remove ${change.from} (was ${change.before?.status ?? '?'} → ${change.before?.to ?? '?'})`
        : `redirect: ${change.operation} ${change.from} → ${change.to} (${change.status})`;
  }
}

/** The pull request body: what, why, per-URL before/after, the verification plan and the footer. */
export function pullRequestBody(input: {
  content: ChangeSetContent;
  artifactId: string;
  version: number;
  siteDomain: string;
  siteUrl: string;
}): string {
  const { content } = input;
  const perUrl = new Map<string, string[]>();
  for (const drafted of content.changes) {
    const url = drafted.change.type === 'redirect' ? drafted.change.from : drafted.change.url;
    const line = `- \`${drafted.source.path}\` — ${describeChange(drafted.change)}`;
    const lines = perUrl.get(url);
    if (lines) lines.push(line);
    else perUrl.set(url, [line]);
  }
  const urls = [...perUrl].map(([url, lines]) => `**${url}**\n\n${lines.join('\n')}`).join('\n\n');
  const recommendation = content.recommendationId ? `\nRecommendation: \`${content.recommendationId}\`\n` : '';
  return [
    `## ${content.title}`,
    '',
    content.summary,
    recommendation,
    `Change set: \`${input.artifactId}\` v${input.version} for ${input.siteDomain}`,
    '',
    '### What changes',
    '',
    urls,
    '',
    '### Verification plan',
    '',
    content.verificationPlan,
    '',
    '### Rollback',
    '',
    content.rollbackPlan,
    '',
    '---',
    `Opened by Agentic SEO for ${input.siteUrl}. Merging applies the change; the deployed commit is detected and the affected pages are re-fetched before the change set is marked verified.`,
  ]
    .join('\n')
    .slice(0, 60_000);
}

/** A branch's head SHA, or null when it does not exist yet. */
async function branchHeadOrNull(client: GitHubClient, branch: string): Promise<string | null> {
  try {
    return (await client.getBranchHead(branch)).sha;
  } catch (error) {
    if (error instanceof GitHubError && error.code === 'not_found') return null;
    throw error;
  }
}

/** The git object SHA of a text as GitHub stores it, so a tree entry can be compared without a read. */
export function gitBlobSha(text: string): string {
  return createHash('sha1')
    .update(`blob ${Buffer.byteLength(text, 'utf8')}\0`)
    .update(text, 'utf8')
    .digest('hex');
}

export type HeadCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether a commit is exactly the commit this apply would create: one parent, the expected base,
 * and a tree that is the base tree with our file contents at our paths and nothing else changed.
 *
 * A retried job must never adopt a branch or pull request that carries anything else — that would
 * turn "the response was lost" into "someone else's push was approved". A commit that differs in
 * any path, or whose parent is not the base, is refused; the caller invalidates the approval.
 */
export async function headMatchesPlan(
  client: GitHubClient,
  headSha: string,
  baseSha: string,
  texts: ReadonlyMap<string, string>,
): Promise<HeadCheck> {
  const commit = await client.getCommit(headSha);
  if (commit.parents.length !== 1 || commit.parents[0] !== baseSha) {
    const parents = commit.parents.length ? commit.parents.join(', ') : 'none';
    return {
      ok: false,
      reason: `its commit ${headSha} has ${commit.parents.length === 1 ? 'the parent' : 'the parents'} ${parents}, and the expected base is ${baseSha}`,
    };
  }
  const [baseTree, headTree] = await Promise.all([client.listTreeEntries(baseSha), client.listTreeEntries(headSha)]);
  if (baseTree.truncated || headTree.truncated) {
    return { ok: false, reason: 'GitHub truncated the file list, so the commit’s contents cannot be verified' };
  }
  const base = new Map(baseTree.entries.map((entry) => [entry.path, entry.sha]));
  const head = new Map(headTree.entries.map((entry) => [entry.path, entry.sha]));
  for (const path of head.keys()) {
    if (!base.has(path) && !texts.has(path)) {
      return { ok: false, reason: `it adds ${path}, which this change set does not write` };
    }
  }
  for (const path of base.keys()) {
    if (!head.has(path)) {
      return { ok: false, reason: `it deletes ${path}, which this change set does not touch` };
    }
  }
  for (const [path, text] of texts) {
    const entry = head.get(path);
    if (!entry) return { ok: false, reason: `it does not contain ${path}` };
    if (entry !== gitBlobSha(text)) {
      return { ok: false, reason: `the contents of ${path} are not the reviewed edit` };
    }
  }
  for (const [path, sha] of base) {
    if (!texts.has(path) && head.get(path) !== sha) {
      return { ok: false, reason: `it changes ${path}, which this change set does not touch` };
    }
  }
  return { ok: true };
}

/**
 * Applies one approved change set: stale check, one commit, one pull request, or an adopted pair
 * from an earlier attempt. Every outcome is recorded on the run row with an event.
 */
export async function runChangesApply(db: Db, payload: { workspaceId: string; artifactId: string }, deps: ApplyDeps): Promise<ApplyResult> {
  const now = deps.now ?? (() => new Date());

  type Prepared =
    | { ok: false; status: 'skipped' | 'failed'; reason: string }
    | { ok: true; run: Awaited<ReturnType<typeof loadRun>>; content: ChangeSetContent; site: { domain: string; name: string } };

  const prepared: Prepared = await db.withWorkspace(payload.workspaceId, async (tx) => {
    const run = await loadRun(tx, payload.workspaceId, payload.artifactId);
    if (run.state !== 'approved' && run.state !== 'applying') {
      return { ok: false, status: 'skipped' as const, reason: `the change set is ${run.state}; nothing to apply` };
    }
    const [artifact] = await tx
      .select()
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.workspaceId, payload.workspaceId), eq(schema.artifacts.id, payload.artifactId)));
    if (artifact?.type !== 'change_set') return { ok: false, status: 'skipped' as const, reason: 'the artifact is not a change set' };
    if (run.approvedVersion === null) return { ok: false, status: 'skipped' as const, reason: 'the change set has no approved version' };
    if (artifact.publishedVersion !== run.approvedVersion) {
      await transition(tx, run, 'in_review', {
        reason: `Version ${run.approvedVersion} is no longer the published version, so the approval does not cover what would be applied. Approve the current draft again.`,
        actor: { type: 'system' },
        at: now(),
      });
      return {
        ok: false,
        status: 'skipped' as const,
        reason: 'the approved version is no longer published; the change set is back in review',
      };
    }
    const content = await contentOfRun(tx, run);
    if (!content) return { ok: false, status: 'skipped' as const, reason: 'the change set content is not readable' };
    const [site] = await tx
      .select({
        domain: schema.sites.primaryDomain,
        name: schema.sites.name,
        archived: schema.sites.archived,
        verifiedAt: schema.sites.verifiedAt,
      })
      .from(schema.sites)
      .where(and(eq(schema.sites.workspaceId, payload.workspaceId), eq(schema.sites.id, run.siteId)));
    if (!site) return { ok: false, status: 'skipped' as const, reason: 'the site this change set belongs to does not exist' };
    if (site.archived || site.verifiedAt === null) {
      const reason = site.archived
        ? `Site “${site.name}” is archived, so nothing can be applied to it.`
        : `Site “${site.name}” (${site.domain}) is not verified, so nothing can be applied to it.`;
      await transition(tx, run, 'failed', { reason, actor: { type: 'system' }, at: now(), set: { lastError: reason } });
      return { ok: false, status: 'failed' as const, reason };
    }
    return { ok: true as const, run, content, site };
  });
  if (!prepared.ok) return { status: prepared.status, reason: prepared.reason };

  const { run, content, site } = prepared;
  const siteUrl = `https://${site.domain}`;
  const version = run.approvedVersion;
  if (version === null) return { status: 'skipped', reason: 'the change set has no approved version' };

  // The connection and its token, or a recorded failure rather than an endless retry.
  let client: GitHubClient;
  let settings: Awaited<ReturnType<typeof activeConnection>>['settings'];
  try {
    const connection = await db.withWorkspace(payload.workspaceId, (tx) =>
      activeConnection(tx, { workspaceId: payload.workspaceId, siteId: run.siteId, kp: deps.kp, siteName: `“${site.name}”` }),
    );
    settings = connection.settings;
    client = clientFor(settings, connection.token, deps.github);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await db.withWorkspace(payload.workspaceId, async (tx) => {
      const current = await loadRun(tx, payload.workspaceId, payload.artifactId);
      if (current.state !== 'applying' && current.state !== 'approved') return;
      await transition(tx, current, 'failed', { reason, actor: { type: 'system' }, at: now(), set: { lastError: reason } });
    });
    return { status: 'failed', reason };
  }

  // A move to `applying` is the first thing after the approval, so a status read shows work started.
  const applying = await db.withWorkspace(payload.workspaceId, async (tx) => {
    const current = await loadRun(tx, payload.workspaceId, payload.artifactId);
    if (current.state === 'applying') return current;
    const moved = await transition(tx, current, 'applying', {
      reason: `Applying version ${version} as a pull request against ${settings.baseBranch}.`,
      actor: { type: 'system' },
      evidence: { version, repository: slugOf(settings) },
      at: now(),
      set: { approvedVersion: version },
    });
    return moved ?? (await loadRun(tx, payload.workspaceId, payload.artifactId));
  });

  const fail = async (reason: string, code: 'stale' | 'failed', evidence: Record<string, unknown>): Promise<ApplyResult> => {
    await db.withWorkspace(payload.workspaceId, async (tx) => {
      const current = await loadRun(tx, payload.workspaceId, payload.artifactId);
      if (current.state !== 'applying') return;
      await transition(tx, current, code === 'stale' ? 'stale' : 'failed', {
        reason,
        actor: { type: 'system' },
        evidence,
        at: now(),
        set: { lastError: reason },
      });
    });
    return code === 'stale' ? { status: 'stale', reason, paths: (evidence.paths as string[]) ?? [] } : { status: 'failed', reason };
  };

  /**
   * Withdraws the approval when GitHub holds something that is not the reviewed change. The version
   * goes back to a draft, so the remedy is a redraft and a fresh approval, not a retry.
   */
  const invalidate = async (reason: string, evidence: Record<string, unknown>): Promise<ApplyResult> => {
    await db.withWorkspace(payload.workspaceId, async (tx) => {
      const current = await loadRun(tx, payload.workspaceId, payload.artifactId);
      if (current.state !== 'applying') return;
      await invalidateApproval(tx, current, { reason, evidence, at: now() });
    });
    return { status: 'skipped', reason };
  };

  try {
    const base = await client.getBranchHead(settings.baseBranch);

    // 0. The stored source details are server-owned. Re-derive them from the base commit before
    // anything is written: a path, hash or diff the caller forged is not the change a person saw.
    const problems = await revalidateChangeSet(content, {
      mapping: settings.mapping,
      listFiles: async (prefix, ref) => (await client.listTree(ref, prefix)).paths,
      readFile: async (path, ref) => (await client.getFile(path, ref)).content,
    });
    if (problems.length) {
      return await invalidate(
        `The stored change set details do not match the repository at the commit it was drafted from: ${describeRevalidation(problems)} Redraft this change set so its paths, hashes and diff are re-derived.`,
        { problems, baseSha: content.changes[0]?.baseSha ?? null },
      );
    }

    // 1. Nothing may have moved since drafting: the hash is the proof, not the `before` value.
    const expected = new Map<string, string>();
    for (const drafted of content.changes) {
      if (!expected.has(drafted.source.path)) expected.set(drafted.source.path, drafted.sourceHash);
    }
    const texts = new Map<string, string>();
    const changed: string[] = [];
    for (const [path, hash] of expected) {
      let file: { content: string };
      try {
        file = await client.getFile(path, base.sha);
      } catch (error) {
        if (error instanceof GitHubError && error.code === 'not_found') {
          changed.push(path);
          continue;
        }
        throw error;
      }
      if (sourceHashOf(file.content) !== hash) {
        changed.push(path);
        continue;
      }
      texts.set(path, file.content);
    }
    if (changed.length) {
      return await fail(
        `The file changed since this change set was drafted: ${changed.join(', ')}. Redraft it against the current ${settings.baseBranch}.`,
        'stale',
        { paths: changed, baseSha: base.sha },
      );
    }

    // 2. Re-apply the changes in order onto the base head, so the commit is the reviewed edit.
    for (const drafted of content.changes) {
      const text = texts.get(drafted.source.path);
      if (text === undefined)
        return await fail(`The file ${drafted.source.path} could not be read.`, 'stale', { paths: [drafted.source.path] });
      const applied = applyChange({
        editor: drafted.source.editor,
        text,
        change: drafted.change,
        ...(drafted.source.fields ? { fields: drafted.source.fields } : {}),
        ...(drafted.source.dialect ? { dialect: drafted.source.dialect } : {}),
      });
      if (!applied.ok) {
        return await fail(`The change to ${drafted.source.path} no longer applies (${applied.reason}). Redraft this change set.`, 'stale', {
          paths: [drafted.source.path],
          baseSha: base.sha,
        });
      }
      texts.set(drafted.source.path, applied.text);
    }

    // 3. Create or adopt the branch, the commit and the pull request.
    const branch = applying.branch ?? branchNameFor(payload.artifactId, version);
    const commitMessage = `Apply change set ${payload.artifactId} v${version}: ${content.title}`;
    let headSha: string;
    let adopted = false;
    let pr = await client.findPullRequestByHead(branch, { state: 'all' });

    if (pr) {
      // A previous attempt created it and lost the response. Adopt only when its head is exactly the
      // commit this run would write; anything else is not what approval covered.
      const prNumber = pr.number;
      const check = await headMatchesPlan(client, pr.headSha, base.sha, texts);
      if (!check.ok) {
        // The branch name is ours, so the pull request on it is the one this job opened.
        await client.closePullRequest(prNumber).catch((error: unknown) => {
          logger.warn({ artifactId: payload.artifactId, prNumber, err: error }, 'could not close the unapproved pull request');
        });
        return await invalidate(
          `The pull request #${prNumber} an earlier attempt opened is not the reviewed change: ${check.reason}. The approval was withdrawn; redraft and approve again.`,
          { branch, headSha: pr.headSha, approvedHeadSha: applying.approvedHeadSha, baseSha: base.sha, reason: check.reason },
        );
      }
      headSha = pr.headSha;
      adopted = true;
    } else {
      const existing = await branchHeadOrNull(client, branch);
      if (existing === base.sha) {
        // The branch was created and the job died before the commit: resume the multi-file commit
        // from the base (a fast-forward from the base head, never a force-move over other work).
        const committed = await client.commitFiles({
          branch,
          baseSha: base.sha,
          message: commitMessage,
          files: [...texts].map(([path, text]) => ({ path, content: text })),
        });
        headSha = committed.commitSha;
      } else if (existing) {
        const check = await headMatchesPlan(client, existing, base.sha, texts);
        if (!check.ok) {
          return await invalidate(
            `The branch ${branch} an earlier attempt created is not the reviewed change: ${check.reason}. The approval was withdrawn; delete the branch or redraft and approve again.`,
            { branch, headSha: existing, baseSha: base.sha, reason: check.reason },
          );
        }
        headSha = existing;
      } else {
        await client.createBranch(branch, base.sha);
        const committed = await client.commitFiles({
          branch,
          baseSha: base.sha,
          message: commitMessage,
          files: [...texts].map(([path, text]) => ({ path, content: text })),
        });
        headSha = committed.commitSha;
      }
      pr = await client.openPullRequest({
        title: content.title,
        body: pullRequestBody({ content, artifactId: payload.artifactId, version, siteDomain: site.domain, siteUrl }),
        head: branch,
        base: settings.baseBranch,
      });
    }

    const opened = { number: pr.number, url: pr.htmlUrl, headSha };

    // 4. Record it, unless another writer already did (then it is the same pull request).
    const recorded = await db.withWorkspace(payload.workspaceId, async (tx) => {
      const current = await loadRun(tx, payload.workspaceId, payload.artifactId);
      if (current.state === 'pr_open' && current.prNumber === opened.number) return current;
      if (current.state !== 'applying') return null;
      return transition(tx, current, 'pr_open', {
        reason: adopted
          ? `Adopted the pull request an earlier attempt opened: #${opened.number} on ${branch} at ${opened.headSha}.`
          : `Opened pull request #${opened.number} on ${branch} at ${opened.headSha}.`,
        actor: { type: 'system' },
        evidence: { branch, prNumber: opened.number, headSha: opened.headSha, baseSha: base.sha, files: [...texts.keys()] },
        at: now(),
        set: {
          branch,
          prNumber: opened.number,
          prUrl: opened.url,
          headSha: opened.headSha,
          // The SHA the approval covers. A later push makes the poller send this back to review.
          approvedHeadSha: opened.headSha,
        },
      });
    });
    if (!recorded) return { status: 'skipped', reason: 'the change set moved while opening the pull request' };
    logger.info({ artifactId: payload.artifactId, prNumber: opened.number, adopted }, 'change set applied as a pull request');
    return { status: 'pr_open', prNumber: opened.number, prUrl: opened.url, headSha: opened.headSha, adopted };
  } catch (error) {
    if (error instanceof GitHubError && (error.code === 'network' || error.code === 'rate_limit' || error.code === 'server')) {
      // Transient: leave the run in `applying` so the retry adopts whatever was created.
      await db.withWorkspace(payload.workspaceId, async (tx) => {
        const current = await loadRun(tx, payload.workspaceId, payload.artifactId);
        if (current.state !== 'applying') return;
        await recordEvent(tx, {
          workspaceId: payload.workspaceId,
          artifactId: payload.artifactId,
          fromState: current.state,
          toState: current.state,
          actor: { type: 'system' },
          reason: `GitHub did not answer; the job will retry and adopt anything the attempt created. ${error.message}`,
          at: now(),
        });
        await tx
          .update(schema.changeSetRuns)
          .set({ lastError: error.message, updatedAt: now() })
          .where(and(eq(schema.changeSetRuns.workspaceId, payload.workspaceId), eq(schema.changeSetRuns.artifactId, payload.artifactId)));
      });
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    return await fail(reason, 'failed', {});
  }
}
