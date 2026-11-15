import { type Change, checkPageAgainst, expectedAfter, urlOf } from '@agentic-seo/changes';
import type { Db } from '@agentic-seo/db';
import { schema } from '@agentic-seo/db';
import { logger } from '@agentic-seo/telemetry';
import { and, eq } from 'drizzle-orm';
import { contentOfRun } from './impact';
import { loadRun, recordEvent, settleRollbackOf, transition } from './state';
import { fetchPageFacts } from './verify-fetch';

// After a deploy is detected, verification re-fetches every affected URL and compares the page the
// deploy actually serves with what the change promised (`checkPageAgainst`). It runs against the
// **deployed commit**, never the merge: that distinction is the whole point of deploy detection.
//
// A fetch that fails is not a failed change: it is retried with backoff three times, and only then
// recorded as `verification_failed` with "could not fetch" evidence, so a flaky site does not make a
// good change look broken on the first attempt.

/** Fetch failures tolerated before the verification is recorded as failed. */
export const MAX_VERIFY_ATTEMPTS = 3;

/** The backoff between verification attempts: a minute, then five. */
export const VERIFY_RETRY_MS = [60_000, 300_000] as const;

/**
 * The URL a change is verified against. A redirect change names `from` as a path (that is what the
 * redirects file holds), so it is resolved against the site's own origin before fetching: asking
 * the crawler for "/old-page/" would try to fetch a bare path, and the redirect would never be seen.
 */
export function verifyUrlOf(change: Change, siteUrl: string): string {
  if (change.type !== 'redirect') return urlOf(change);
  try {
    return new URL(change.from, `${siteUrl.replace(/\/+$/, '')}/`).toString();
  } catch {
    return change.from;
  }
}

export interface VerifyDeps {
  userAgent?: string;
  now?: () => Date;
  /**
   * The URL a redirect source is resolved against, from the site's primary domain. Production uses
   * `https://<domain>`; a test points it at its fixture site, whose port a domain cannot carry.
   */
  siteUrlFor?: (domain: string) => string;
}

export type VerifyResult =
  | { status: 'skipped'; reason: string }
  | { status: 'retry'; reason: string; retryAfterMs: number; attempt: number }
  | { status: 'verified' }
  | { status: 'verification_failed'; reason: string };

/** One change's fetched page, or why it could not be fetched. */
interface FetchOutcome {
  fetchError: string | null;
}

function summarise(results: { url: string; detail: string }[]): string {
  const first = results.slice(0, 3).map((result) => `${result.url}: ${result.detail}`);
  const more = results.length > 3 ? ` (and ${results.length - 3} more)` : '';
  return `${first.join(' ')}${more}`;
}

/**
 * One verification run for one change set. The state must be `deployed`: a verification for a merge
 * that is not live would measure the old page and call the change broken.
 */
export async function runChangesVerify(
  db: Db,
  payload: { workspaceId: string; artifactId: string },
  deps: VerifyDeps = {},
): Promise<VerifyResult> {
  const now = deps.now ?? (() => new Date());

  // Read the run, its content and the site's hosts in one transaction.
  const prepared = await db.withWorkspace(payload.workspaceId, async (tx) => {
    const run = await loadRun(tx, payload.workspaceId, payload.artifactId);
    if (run.state !== 'deployed') return { ok: false as const, reason: `the change set is ${run.state}, not deployed` };
    if (!run.deployedSha) return { ok: false as const, reason: 'the change set has no deployed commit recorded' };
    const content = await contentOfRun(tx, run);
    if (!content) return { ok: false as const, reason: 'the change set content is not readable' };
    const [site] = await tx
      .select({ domain: schema.sites.primaryDomain, hosts: schema.sites.hosts })
      .from(schema.sites)
      .where(and(eq(schema.sites.workspaceId, payload.workspaceId), eq(schema.sites.id, run.siteId)));
    return {
      ok: true as const,
      run,
      content,
      hosts: site ? [site.domain, ...site.hosts] : [],
      domain: site?.domain ?? null,
      attempt: run.verificationAttempts + 1,
    };
  });
  if (!prepared.ok) return { status: 'skipped', reason: prepared.reason };
  const { content, hosts, attempt, domain } = prepared;
  // Redirect sources are paths in the redirects file; verification needs the site's origin to fetch
  // them (primary domain, https), while every other change already names an absolute URL.
  const siteUrl = domain ? (deps.siteUrlFor?.(domain) ?? `https://${domain}`) : null;

  // Fetch each distinct URL once; several changes may name one page.
  const urls = [...new Set(content.changes.map((drafted) => (siteUrl ? verifyUrlOf(drafted.change, siteUrl) : urlOf(drafted.change))))];
  const pages = new Map<string, Awaited<ReturnType<typeof fetchPageFacts>>>();
  const failures: FetchOutcome[] = [];
  for (const url of urls) {
    const facts = await fetchPageFacts(url, { hosts, ...(deps.userAgent ? { userAgent: deps.userAgent } : {}) });
    pages.set(url, facts);
    if (facts.fetchError) failures.push({ fetchError: facts.fetchError });
  }

  const checks = content.changes.map((drafted: { change: Change; source: { path: string } }, index: number) => {
    const url = siteUrl ? verifyUrlOf(drafted.change, siteUrl) : urlOf(drafted.change);
    const facts = pages.get(url)!;
    const check = checkPageAgainst(drafted.change, facts);
    return {
      index,
      url,
      type: drafted.change.type,
      ok: check.ok,
      detail: check.detail,
      fetchFailed: Boolean(facts.fetchError) || (facts.status === 0 && check.detail.includes('could not be fetched')),
      evidence: {
        expectation: expectedAfter(drafted.change),
        status: facts.status,
        fetchError: facts.fetchError,
        finalUrl: facts.finalUrl,
        redirects: facts.redirects,
        path: drafted.source.path,
      },
    };
  });

  const failuresWithDetail = checks.filter((check) => check.fetchFailed && !check.ok);

  return db.withWorkspace(payload.workspaceId, async (tx) => {
    const current = await loadRun(tx, payload.workspaceId, payload.artifactId);
    if (current.state !== 'deployed') {
      return { status: 'skipped' as const, reason: `the change set moved to ${current.state} while verifying` };
    }
    for (const check of checks) {
      await tx.insert(schema.changeSetVerifications).values({
        workspaceId: payload.workspaceId,
        artifactId: payload.artifactId,
        attempt,
        changeIndex: check.index,
        url: check.url,
        changeType: check.type,
        result: check.ok ? 'pass' : check.fetchFailed ? 'unknown' : 'fail',
        detail: check.detail,
        evidence: check.evidence,
        deployedSha: current.deployedSha ?? '',
        fetchedAt: now(),
      });
    }

    const at = now();
    if (failures.length) {
      const reason = `Verification could not fetch ${failures.length} of ${urls.length} pages (${summarise(
        checks.filter((check) => check.fetchFailed).map((check) => ({ url: check.url, detail: check.detail })),
      )}).`;
      if (attempt < MAX_VERIFY_ATTEMPTS) {
        await tx
          .update(schema.changeSetRuns)
          .set({ verificationAttempts: attempt, lastError: reason, updatedAt: at })
          .where(and(eq(schema.changeSetRuns.workspaceId, payload.workspaceId), eq(schema.changeSetRuns.artifactId, payload.artifactId)));
        await recordEvent(tx, {
          workspaceId: payload.workspaceId,
          artifactId: payload.artifactId,
          fromState: current.state,
          toState: current.state,
          actor: { type: 'system' },
          reason: `Verification could not fetch every page; attempt ${attempt} of ${MAX_VERIFY_ATTEMPTS} will be retried.`,
          evidence: { fetchFailures: failuresWithDetail.map((check) => ({ url: check.url, detail: check.detail })) },
          at,
        });
        return {
          status: 'retry' as const,
          reason,
          attempt,
          retryAfterMs: VERIFY_RETRY_MS[Math.min(attempt - 1, VERIFY_RETRY_MS.length - 1)]!,
        };
      }
      const moved = await transition(tx, current, 'verification_failed', {
        reason: `Could not fetch the affected pages after ${MAX_VERIFY_ATTEMPTS} attempts. ${reason}`,
        actor: { type: 'system' },
        evidence: { attempts: attempt, fetchFailures: failuresWithDetail.map((check) => ({ url: check.url, detail: check.detail })) },
        at,
        set: { verificationAttempts: attempt, lastError: reason },
      });
      if (!moved) return { status: 'skipped' as const, reason: 'the change set moved while verifying' };
      logger.warn({ artifactId: payload.artifactId, attempt }, 'change set verification could not fetch its pages');
      return { status: 'verification_failed' as const, reason };
    }

    const failed = checks.filter((check) => !check.ok);
    if (failed.length) {
      const reason = summarise(failed.map((check) => ({ url: check.url, detail: check.detail })));
      const moved = await transition(tx, current, 'verification_failed', {
        reason: `The deployed page does not match ${failed.length} of ${checks.length} changes. ${reason}`,
        actor: { type: 'system' },
        evidence: { attempt, failed: failed.map((check) => ({ url: check.url, detail: check.detail })) },
        at,
        set: { verificationAttempts: attempt, lastError: reason },
      });
      if (!moved) return { status: 'skipped' as const, reason: 'the change set moved while verifying' };
      return { status: 'verification_failed' as const, reason };
    }

    const moved = await transition(tx, current, 'verified', {
      reason: `Every affected page shows its change on the deployed commit ${current.deployedSha ?? ''}.`.trim(),
      actor: { type: 'system' },
      evidence: { attempt, changes: checks.length, urls },
      at,
      set: { verificationAttempts: attempt, lastError: null },
    });
    if (!moved) return { status: 'skipped' as const, reason: 'the change set moved while verifying' };
    // A rollback change set completes its original only now: proposing it or opening its pull
    // request changed nothing live, so `rolled_back` means the revert is verified on the site.
    await settleRollbackOf(tx, moved);
    return { status: 'verified' as const };
  });
}
