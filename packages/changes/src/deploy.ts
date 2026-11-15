import type { FetchAllowList, HostResolver } from '@agentic-seo/fetch';
import { safeFetch } from '@agentic-seo/fetch';
import type { CompareStatus, GitHubClient } from './github';

// Deployment detection (ADR-0007 review update: merge is not deployment). Two adapters:
//
// - version_file: the pilot publishes /version.txt, whose first line is the deployed commit SHA.
//   This is the only signal that works for a direct-upload deploy (martechsignal's deploy.sh runs
//   `wrangler pages deploy`), where GitHub never sees the deploy.
// - github_deployments: the GitHub Deployments API, for repositories whose deploy is integrated.
//
// Both answer the same three states. A transient failure never throws: it is `unknown` with the
// reason, because a worker job that cannot reach GitHub must not mark a change as failed. The
// caller combines `pending` with `timeoutAfter` to raise `deploy_not_detected`.

export type DeployDetectorName = 'version_file' | 'github_deployments';

/** The deployed commit contains the merge commit (or is it). */
export interface DeployDeployed {
  state: 'deployed';
  detector: DeployDetectorName;
  deployedSha: string;
}

/** The merge is not live yet; `deployedSha` is what is live, when the detector could tell. */
export interface DeployPending {
  state: 'pending';
  detector: DeployDetectorName;
  deployedSha?: string;
  reason?: string;
}

/** The detector could not tell: no version file, an unreachable site, a rate limit. */
export interface DeployUnknown {
  state: 'unknown';
  detector: DeployDetectorName;
  reason: string;
}

export type DeployResult = DeployDeployed | DeployPending | DeployUnknown;

/** The change set waited longer than its deploy window. */
export interface DeployTimeout {
  code: 'deploy_not_detected';
  reason: string;
}

export interface CommitComparison {
  status: CompareStatus;
}

export interface VersionFileOptions {
  /** The site's origin or any page URL; only the origin is used. */
  siteUrl: string;
  /** The merge commit whose deployment is awaited. */
  mergeSha: string;
  /** Default `/version.txt`. */
  versionPath?: string;
  /** Compares the two commits; production passes `github.compareCommits`. */
  compare: (base: string, head: string) => Promise<CommitComparison>;
  /** Test seam; production is {@link safeFetch}, so the site URL keeps the SSRF guard. */
  fetch?: typeof safeFetch;
  resolver?: HostResolver;
  allow?: FetchAllowList;
  /** Default 10 seconds; a version file is tiny. */
  timeoutMs?: number;
}

const SHA_LINE = /^([0-9a-f]{40})\b/i;

/** A version file's first line as a commit SHA, or null when it is not one. */
export function parseVersionFile(text: string): string | null {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return SHA_LINE.exec(firstLine)?.[1]?.toLowerCase() ?? null;
}

function explain(status: CompareStatus, mergeSha: string, deployedSha: string): string | undefined {
  if (status === 'behind') return `The deployed commit ${deployedSha} is behind the merge commit ${mergeSha}.`;
  if (status === 'diverged')
    return `The deployed commit ${deployedSha} has diverged from the merge commit ${mergeSha}; the deployed history does not contain it.`;
  return undefined;
}

/** Detect a direct-upload deploy from the site's version file. */
export async function detectVersionFile(options: VersionFileOptions): Promise<DeployResult> {
  const detector: DeployDetectorName = 'version_file';
  let url: URL;
  try {
    const origin = new URL(options.siteUrl).origin;
    url = new URL(options.versionPath ?? '/version.txt', `${origin}/`);
  } catch {
    return { state: 'unknown', detector, reason: `${options.siteUrl} is not a valid site URL.` };
  }

  let text: string;
  try {
    const fetchSite = options.fetch ?? safeFetch;
    const result = await fetchSite(url.href, {
      maxBytes: 4_096,
      totalTimeoutMs: options.timeoutMs ?? 10_000,
      ...(options.resolver ? { resolver: options.resolver } : {}),
      ...(options.allow ? { allow: options.allow } : {}),
    });
    if (result.status === 404) {
      return {
        state: 'unknown',
        detector,
        reason: `${url.href} answered 404. The site may not publish a version file; map it in the deploy settings.`,
      };
    }
    if (result.status < 200 || result.status >= 300) {
      return { state: 'unknown', detector, reason: `${url.href} answered ${result.status}, so the deployed commit could not be read.` };
    }
    text = result.text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { state: 'unknown', detector, reason: `${url.href} could not be fetched: ${message}` };
  }

  const deployedSha = parseVersionFile(text);
  if (!deployedSha) {
    return {
      state: 'unknown',
      detector,
      reason: `${url.href} does not start with a 40-character commit SHA, so it cannot identify the deployed commit.`,
    };
  }

  try {
    const comparison = await options.compare(options.mergeSha, deployedSha);
    if (comparison.status === 'identical' || comparison.status === 'ahead') return { state: 'deployed', detector, deployedSha };
    const reason = explain(comparison.status, options.mergeSha, deployedSha);
    return { state: 'pending', detector, deployedSha, ...(reason ? { reason } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { state: 'unknown', detector, reason: `The deployed commit was read but could not be compared with the merge: ${message}` };
  }
}

export interface GitHubDeploymentsOptions {
  mergeSha: string;
  /** The environment name, e.g. `production` or `github-pages`; all environments when omitted. */
  environment?: string;
  github: Pick<GitHubClient, 'listDeployments' | 'listDeploymentStatuses' | 'compareCommits'>;
  /** How many deployments to read, newest first. Default 20. */
  perPage?: number;
}

/** Detect a Git-integrated deploy from the GitHub Deployments API. */
export async function detectGitHubDeployment(options: GitHubDeploymentsOptions): Promise<DeployResult> {
  const detector: DeployDetectorName = 'github_deployments';
  try {
    const deployments = await options.github.listDeployments({
      perPage: options.perPage ?? 20,
      ...(options.environment ? { environment: options.environment } : {}),
    });
    if (deployments.length === 0) {
      return { state: 'unknown', detector, reason: 'The repository has no deployments, so there is nothing to compare the merge with.' };
    }

    let successful: { sha: string } | null = null;
    for (const deployment of deployments) {
      const statuses = await options.github.listDeploymentStatuses(deployment.id);
      if (!statuses.some((status) => status.state === 'success')) continue;
      successful = { sha: deployment.sha };
      break;
    }
    if (!successful) {
      return { state: 'unknown', detector, reason: 'No deployment in the recent history has a successful status.' };
    }

    const comparison = await options.github.compareCommits(options.mergeSha, successful.sha);
    if (comparison.status === 'identical' || comparison.status === 'ahead')
      return { state: 'deployed', detector, deployedSha: successful.sha };
    const reason = explain(comparison.status, options.mergeSha, successful.sha);
    return { state: 'pending', detector, deployedSha: successful.sha, ...(reason ? { reason } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { state: 'unknown', detector, reason: `The GitHub deployments could not be read: ${message}` };
  }
}

export interface TimeoutOptions {
  /** When the merge (or the PR) happened. */
  startedAt: Date;
  hours: number;
  now?: Date;
}

/**
 * `null` while the deploy is still inside its window; otherwise the `deploy_not_detected` refusal
 * the change-set state machine records. A pending deploy older than the window is not a transient
 * failure: something in the pipeline needs a person.
 */
export function timeoutAfter({ startedAt, hours, now = new Date() }: TimeoutOptions): DeployTimeout | null {
  const elapsedMs = now.getTime() - startedAt.getTime();
  if (elapsedMs <= hours * 3_600_000) return null;
  const elapsedHours = Math.round((elapsedMs / 3_600_000) * 10) / 10;
  return {
    code: 'deploy_not_detected',
    reason: `The change was merged ${elapsedHours} hours ago and the deployed site still does not show it after ${hours} hours. Check the deploy pipeline, then retry or roll back.`,
  };
}

/** Apply the deploy window to a pending result; a deployed or unknown result passes through. */
export function withDeployTimeout(result: DeployResult, options: TimeoutOptions): DeployResult | DeployTimeout {
  if (result.state !== 'pending') return result;
  return timeoutAfter(options) ?? result;
}
