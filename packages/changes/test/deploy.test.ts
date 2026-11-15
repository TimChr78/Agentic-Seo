import { afterEach, describe, expect, it } from 'vitest';
import { detectGitHubDeployment, detectVersionFile, parseVersionFile, timeoutAfter, withDeployTimeout } from '../src/deploy';
import { closeFakeServers, startFakeServer, tableResolver } from './support';

const MERGE = 'a'.repeat(40);
const DEPLOYED = 'b'.repeat(40);

afterEach(closeFakeServers);

const loopback = [{ address: '127.0.0.1', family: 4 as const }];

describe('version_file deploy detection', () => {
  it('reports the deployed commit from the first line of version.txt', async () => {
    const site = await startFakeServer(() => ({ text: `${DEPLOYED}\nbuilt 2026-11-15T09:00:00Z\n` }));
    const result = await detectVersionFile({
      siteUrl: `http://site.test:${site.port}`,
      mergeSha: MERGE,
      compare: async () => ({ status: 'identical' }),
      resolver: tableResolver({ 'site.test': loopback }),
      allow: { privateHosts: ['site.test'], ports: [site.port] },
    });
    expect(result).toEqual({ state: 'deployed', detector: 'version_file', deployedSha: DEPLOYED });
    expect(site.calls[0]!.path).toBe('/version.txt');
  });

  it('reads a configurable version path', async () => {
    const site = await startFakeServer(() => ({ text: MERGE }));
    const result = await detectVersionFile({
      siteUrl: `http://site.test:${site.port}/about/`,
      versionPath: '/build-info.txt',
      mergeSha: MERGE,
      compare: async () => ({ status: 'ahead' }),
      resolver: tableResolver({ 'site.test': loopback }),
      allow: { privateHosts: ['site.test'], ports: [site.port] },
    });
    expect(result).toMatchObject({ state: 'deployed', deployedSha: MERGE });
    expect(site.calls[0]!.path).toBe('/build-info.txt');
  });

  it('is pending while the deployed commit is behind the merge', async () => {
    const site = await startFakeServer(() => ({ text: `${DEPLOYED}\nbuilt 2026-11-15T09:00:00Z` }));
    const result = await detectVersionFile({
      siteUrl: `http://site.test:${site.port}`,
      mergeSha: MERGE,
      compare: async () => ({ status: 'behind' }),
      resolver: tableResolver({ 'site.test': loopback }),
      allow: { privateHosts: ['site.test'], ports: [site.port] },
    });
    expect(result).toMatchObject({ state: 'pending', detector: 'version_file', deployedSha: DEPLOYED });
    if (result.state !== 'pending') return;
    expect(result.reason).toContain('behind');
  });

  it('is unknown when the version file is missing', async () => {
    const site = await startFakeServer(() => ({ status: 404, text: 'not found' }));
    const result = await detectVersionFile({
      siteUrl: `http://site.test:${site.port}`,
      mergeSha: MERGE,
      compare: async () => ({ status: 'identical' }),
      resolver: tableResolver({ 'site.test': loopback }),
      allow: { privateHosts: ['site.test'], ports: [site.port] },
    });
    expect(result).toMatchObject({ state: 'unknown', detector: 'version_file' });
    if (result.state !== 'unknown') return;
    expect(result.reason).toContain('404');
  });

  it('is unknown when the body is not a commit SHA', async () => {
    const site = await startFakeServer(() => ({ text: '<!DOCTYPE html><title>Not found</title>' }));
    const result = await detectVersionFile({
      siteUrl: `http://site.test:${site.port}`,
      mergeSha: MERGE,
      compare: async () => ({ status: 'identical' }),
      resolver: tableResolver({ 'site.test': loopback }),
      allow: { privateHosts: ['site.test'], ports: [site.port] },
    });
    expect(result).toMatchObject({ state: 'unknown' });
    if (result.state !== 'unknown') return;
    expect(result.reason).toContain('40-character commit SHA');
  });

  it('is unknown, not thrown, when the comparison fails', async () => {
    const site = await startFakeServer(() => ({ text: DEPLOYED }));
    const result = await detectVersionFile({
      siteUrl: `http://site.test:${site.port}`,
      mergeSha: MERGE,
      compare: async () => {
        throw new Error('GitHub answered 503');
      },
      resolver: tableResolver({ 'site.test': loopback }),
      allow: { privateHosts: ['site.test'], ports: [site.port] },
    });
    expect(result).toMatchObject({ state: 'unknown' });
  });

  it('refuses a version URL that resolves to a private address (SSRF guard)', async () => {
    const result = await detectVersionFile({
      siteUrl: 'http://internal-name.test',
      mergeSha: MERGE,
      compare: async () => ({ status: 'identical' }),
      resolver: tableResolver({ 'internal-name.test': [{ address: '10.1.2.3', family: 4 }] }),
    });
    expect(result).toMatchObject({ state: 'unknown' });
    if (result.state !== 'unknown') return;
    expect(result.reason).toMatch(/private, loopback or metadata address/);
  });

  it('parses only the first line', () => {
    expect(parseVersionFile(`${MERGE}\nbuilt 2026-11-15`)).toBe(MERGE);
    expect(parseVersionFile('')).toBeNull();
    expect(parseVersionFile('abc123\nbuilt')).toBeNull();
  });
});

describe('github_deployments detection', () => {
  type StatusEntry = string | { state: string; createdAt: string };

  function github(
    deployments: { id: number; sha: string }[],
    statuses: Record<number, StatusEntry[]>,
    compareStatus: 'ahead' | 'behind' | 'identical' | 'diverged',
  ) {
    return {
      listDeployments: async () =>
        deployments.map((deployment, index) => ({
          id: deployment.id,
          sha: deployment.sha,
          ref: 'main',
          environment: 'production',
          // Newest first, as GitHub returns them.
          createdAt: `2026-11-${20 - index}T00:00:00Z`,
        })),
      listDeploymentStatuses: async (id: number) =>
        (statuses[id] ?? []).map((entry, index) => {
          const status = typeof entry === 'string' ? { state: entry, createdAt: '2026-11-15T00:00:00Z' } : entry;
          return { id: index, state: status.state, description: null, createdAt: status.createdAt };
        }),
      compareCommits: async () => ({ status: compareStatus, aheadBy: 0, behindBy: 0, totalCommits: 0 }),
    };
  }

  it('is deployed when the newest successful deployment contains the merge', async () => {
    const result = await detectGitHubDeployment({
      mergeSha: MERGE,
      github: github([{ id: 1, sha: DEPLOYED }], { 1: ['success'] }, 'ahead'),
    });
    expect(result).toEqual({ state: 'deployed', detector: 'github_deployments', deployedSha: DEPLOYED });
  });

  it('is pending when the newest successful deployment is behind', async () => {
    const result = await detectGitHubDeployment({
      mergeSha: MERGE,
      github: github(
        [
          { id: 2, sha: DEPLOYED },
          { id: 1, sha: 'c'.repeat(40) },
        ],
        { 1: ['success'], 2: ['success'] },
        'behind',
      ),
    });
    expect(result).toMatchObject({ state: 'pending', deployedSha: DEPLOYED });
  });

  it('skips a failed newest deployment and uses the last successful one', async () => {
    const result = await detectGitHubDeployment({
      mergeSha: MERGE,
      github: github(
        [
          { id: 2, sha: 'd'.repeat(40) },
          { id: 1, sha: DEPLOYED },
        ],
        { 1: ['success'], 2: ['failure'] },
        'identical',
      ),
    });
    expect(result).toMatchObject({ state: 'deployed', deployedSha: DEPLOYED });
  });

  it('is unknown without a successful deployment', async () => {
    const result = await detectGitHubDeployment({
      mergeSha: MERGE,
      github: github([{ id: 1, sha: DEPLOYED }], { 1: ['failure', 'in_progress'] }, 'identical'),
    });
    expect(result).toMatchObject({ state: 'unknown' });
  });

  it('does not count a deployment that succeeded and was later deactivated', async () => {
    // GitHub returns statuses newest first: `inactive` is what the deployment is now.
    const result = await detectGitHubDeployment({
      mergeSha: MERGE,
      github: github([{ id: 1, sha: DEPLOYED }], { 1: ['inactive', 'success'] }, 'identical'),
    });
    expect(result).toMatchObject({ state: 'unknown' });
    if (result.state !== 'unknown') return;
    expect(result.reason).toContain('not a success');
  });

  it('orders statuses by created_at instead of trusting the array', async () => {
    // A success first in the array but older than the inactive status that followed it.
    const result = await detectGitHubDeployment({
      mergeSha: MERGE,
      github: github(
        [{ id: 1, sha: DEPLOYED }],
        {
          1: [
            { state: 'success', createdAt: '2026-11-14T00:00:00Z' },
            { state: 'inactive', createdAt: '2026-11-15T00:00:00Z' },
          ],
        },
        'identical',
      ),
    });
    expect(result).toMatchObject({ state: 'unknown' });
  });

  it('is unknown without any deployment', async () => {
    const result = await detectGitHubDeployment({ mergeSha: MERGE, github: github([], {}, 'identical') });
    expect(result).toMatchObject({ state: 'unknown' });
  });
});

describe('deploy timeout', () => {
  const now = new Date('2026-11-15T12:00:00Z');

  it('stays pending inside the window and becomes deploy_not_detected after it', () => {
    expect(timeoutAfter({ startedAt: new Date('2026-11-15T10:00:00Z'), hours: 4, now })).toBeNull();
    const timedOut = timeoutAfter({ startedAt: new Date('2026-11-15T02:00:00Z'), hours: 4, now });
    expect(timedOut).toMatchObject({ code: 'deploy_not_detected' });
    expect(timedOut?.reason).toContain('4 hours');
  });

  it('passes a deployed result through and turns an old pending result into a refusal', () => {
    const pending = { state: 'pending' as const, detector: 'version_file' as const, deployedSha: DEPLOYED };
    expect(withDeployTimeout(pending, { startedAt: new Date('2026-11-15T10:00:00Z'), hours: 4, now })).toBe(pending);
    expect(withDeployTimeout(pending, { startedAt: new Date('2026-11-14T10:00:00Z'), hours: 4, now })).toMatchObject({
      code: 'deploy_not_detected',
    });
    const deployed = { state: 'deployed' as const, detector: 'version_file' as const, deployedSha: DEPLOYED };
    expect(withDeployTimeout(deployed, { startedAt: new Date('2026-11-14T10:00:00Z'), hours: 4, now })).toBe(deployed);
  });
});
