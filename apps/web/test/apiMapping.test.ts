import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type CommandCall, createCommandApi, getWorkspaceId, httpApi, serverReachable, setWorkspaceId } from '../src/app/api';

// The mapping from command outputs to the UI's shapes. Phase 0 has no audit, Search Console or
// AI-visibility source, so Home must carry nulls with a reason — never a zero that reads as healthy.

const SITE_OUT = {
  id: 'site_1',
  name: 'MartechSignal',
  domain: 'martechsignal.com',
  hosts: [],
  businessType: null,
  isLocalBusiness: false,
  verified: false,
  verifiedAt: null,
  verificationMethod: null,
  archived: false,
  createdAt: '2026-11-01T09:00:00.000Z',
};

const CHECKLIST = {
  siteVerified: false,
  searchConsole: false,
  competitors: 2,
  audits: 0,
  dataForSeoKey: false,
  siteConnector: false,
};

function fakeCall(answers: Record<string, unknown>): CommandCall {
  return (async (name: string) => {
    if (!(name in answers)) throw new Error(`unexpected command ${name}`);
    return answers[name];
  }) as CommandCall;
}

describe('the command mapping', () => {
  it('answers Home from the checklist with no-data reasons instead of zeroes', async () => {
    const api = createCommandApi(
      fakeCall({ 'sites.checklist': CHECKLIST, 'sites.get': { site: { ...SITE_OUT, contextArtifactId: null } } }),
    );

    const home = await api.getHome('site_1');

    expect(home.siteId).toBe('site_1');
    expect(home.checklist).toEqual(CHECKLIST);
    expect(home.health.score).toBeNull();
    expect(home.health.notEvaluated).toEqual(['Crawlability', 'Indexability', 'On-page', 'Structured data', 'Performance']);
    expect(home.clicks.value).toBeNull();
    expect(home.clicks.noDataReason).toBe('Connect Search Console to collect clicks.');
    expect(home.averagePosition.value).toBeNull();
    expect(home.averagePosition.noDataReason).toBe('Connect Search Console to collect positions.');
    expect(home.aiCitations.value).toBeNull();
    expect(home.aiCitations.noDataReason).toMatch(/Phase 5/);
    expect(home.clicksSeries.values).toEqual([]);
    // Recommendations and agent activity have no Phase 0 source; empty, not invented.
    expect(home.recommendations).toEqual([]);
    expect(home.agentActivity).toEqual([]);
  });

  it('maps sites, keeps the server’s verification fact and sends no invented favicon', async () => {
    const api = createCommandApi(
      fakeCall({
        'workspace.get': { id: 'ws_1', name: 'Workspace', approvalPolicy: 'none', timeZone: 'UTC', role: 'editor', permissions: [] },
        'sites.list': { sites: [SITE_OUT] },
        'sites.create': { site: { ...SITE_OUT, id: 'site_2', domain: 'second.example' } },
      }),
    );

    await api.getWorkspace();
    const [site] = await api.listSites();
    const created = await api.createSite({ name: 'Second', domain: 'second.example' });

    expect(site).toEqual({
      id: 'site_1',
      name: 'MartechSignal',
      domain: 'martechsignal.com',
      faviconUrl: null,
      verified: false,
      isLocalBusiness: false,
      role: 'editor',
    });
    expect(created.domain).toBe('second.example');
  });

  it("keeps the server's message and status on a failed call", async () => {
    const api = createCommandApi((async () => {
      throw new ApiError(409, 'conflict', 'This workspace already tracks example.com as “Example” (site_1).');
    }) as CommandCall);

    await expect(api.createSite({ name: 'Example', domain: 'example.com' })).rejects.toMatchObject({
      status: 409,
      message: 'This workspace already tracks example.com as “Example” (site_1).',
    });
  });

  it('passes the verification facts straight through', async () => {
    const verification = {
      siteId: 'site_1',
      domain: 'martechsignal.com',
      token: 'tok',
      dns: { type: 'TXT', name: 'martechsignal.com', value: 'aseo-site-verification=tok', instructions: 'Add it.' },
      meta: { name: 'aseo-site-verification', content: 'tok', instructions: 'Add it.' },
      verified: false,
      verifiedAt: null,
      verificationMethod: null,
      lastCheckAt: null,
      lastCheckError: null,
    };
    const api = createCommandApi(fakeCall({ 'sites.verification': verification }));

    expect(await api.getVerification('site_1')).toBe(verification);
  });
});

describe('the development reachability probe', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('counts only the API server’s own health answer, not a dev server’s HTML fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } })),
    );
    expect(await serverReachable()).toBe(false);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, version: 'test' })),
    );
    expect(await serverReachable()).toBe(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(await serverReachable()).toBe(false);
  });
});

describe('the workspace header', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setWorkspaceId(null, { persist: false });
  });

  it('is left off the memberships request only, while other commands keep the acting workspace', async () => {
    const seen: { command: string; workspace: string | null }[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        const command = url.slice(url.lastIndexOf('/') + 1);
        seen.push({ command, workspace: new Headers(init?.headers).get('x-workspace-id') });
        if (command === 'workspace.memberships') {
          await held;
          return Response.json({ workspaces: [{ id: 'ws_b', name: 'B', role: 'owner' }] });
        }
        return Response.json({ sites: [] });
      }),
    );
    setWorkspaceId('ws_b', { persist: false });
    // Memberships are still on their way when another command is sent.
    const memberships = httpApi.getMemberships();
    await httpApi.listSites();
    release();
    await memberships;
    expect(seen).toEqual([
      { command: 'workspace.memberships', workspace: null },
      { command: 'sites.list', workspace: 'ws_b' },
    ]);
    expect(getWorkspaceId()).toBe('ws_b');
  });
});

describe('the Phase 1 command mapping', () => {
  // Every screen's read and write goes through one method here, so the mapping is checked against
  // the command's own input and output shape: a renamed command or a changed field breaks this file
  // at compile time, and a wrong command name breaks it here.
  const calls: { name: string; input: unknown }[] = [];
  const answered: Record<string, unknown> = {
    'audits.list': { audits: [{ id: 'adt_1' }], nextCursor: 'c1' },
    'audits.status': { audit: { id: 'adt_1' }, progress: { crawled: 1 } },
    'audits.pages': { pages: [{ snapshotId: 'p1' }], nextCursor: null },
    'audits.findings': { findings: [{ id: 'fnd_1' }], nextCursor: null },
    'audits.page': { page: { url: 'https://example.com/', status: 200 } },
    'audits.score': { auditId: 'adt_1', score: 82 },
    'audits.run': { audit: { id: 'adt_2' } },
    'audits.cancel': { audit: { id: 'adt_2' } },
    'audits.issues': { issues: [{ id: 'iss_1' }], nextCursor: null, summary: { open: 1 }, hasGsc: false },
    'audits.issue': { issue: { id: 'iss_1' }, pages: [] },
    'checks.ignore': { issue: { id: 'iss_1' } },
    'checks.unignore': { issue: { id: 'iss_1' } },
    'recommendations.list': { recommendations: [{ id: 'rcm_1' }], total: 1, nextCursor: null },
    'recommendations.get': { id: 'rcm_1', evidence: [] },
    'recommendations.create': { recommendationId: 'rcm_2' },
    'recommendations.runs': { runs: [{ id: 'rrun_1' }], total: 1 },
    'recommendations.run': { id: 'rrun_1', state: 'completed' },
    'recommendations.generate': { runId: 'rrun_2', state: 'queued' },
    'changes.list': { changes: [{ artifactId: 'chg_1' }], total: 1, nextCursor: null },
    'changes.get': { run: { artifactId: 'chg_1' }, name: 'A change' },
    'changes.status': { run: { artifactId: 'chg_1' }, events: [], verification: { attempt: null, results: [] } },
    'changes.diff': { version: 1, files: [], urls: [] },
    'changes.create': { created: true, changeSetId: 'chg_1' },
    'changes.requestApply': { status: 'in_review', approvalId: 'apr_1' },
    'changes.rollback': { changeSetId: 'chg_2', mode: 'exact' },
    'changes.updateDraft': { changeSetId: 'chg_1', version: 2 },
    'approvals.list': { approvals: [{ id: 'apr_1' }], total: 1, nextCursor: null },
    'approvals.get': { id: 'apr_1', diff: { changes: [] } },
    'approvals.approve': { status: 'approved' },
    'approvals.reject': { status: 'rejected' },
    'artifacts.history': { versions: [{ number: 1 }] },
    'search.gsc.status': { connection: null, property: null, datasets: [] },
    'search.gsc.properties': { properties: [], selected: null, suggested: null },
    'search.gsc.connect': { url: 'https://accounts.google.com/o/oauth2' },
    'search.gsc.select': { id: 'cnx_1' },
    'search.gsc.disconnect': { revoked: true },
    'search.gsc.sync': { enqueued: true },
    'connectors.github.status': { connection: null, repository: null, hasToken: false, sourceRules: 0 },
    'connectors.github.connect': { repository: 'acme/site' },
    'connectors.github.update': { repository: 'acme/site' },
    'connectors.github.disconnect': { revoked: true },
  };
  const call: CommandCall = (async (name: string, input: unknown) => {
    calls.push({ name, input });
    if (!(name in answered)) throw new Error(`unexpected command ${name}`);
    return answered[name];
  }) as CommandCall;
  const api = createCommandApi(call);

  it('pages the audits, findings, pages, issues, recommendations and change sets', async () => {
    expect(await api.listAudits({ siteId: 'site_1', state: 'completed' })).toEqual({
      rows: [{ id: 'adt_1' }],
      nextCursor: 'c1',
    });
    expect(await api.listAuditPages({ auditId: 'adt_1', status: 'ok', limit: 50 })).toEqual({
      rows: [{ snapshotId: 'p1' }],
      nextCursor: null,
    });
    expect(await api.listAuditFindings({ auditId: 'adt_1', limit: 200 })).toEqual({ rows: [{ id: 'fnd_1' }], nextCursor: null });
    // The page facts are the command's loose object, unwrapped from `page`.
    expect(await api.getAuditPage('adt_1', 'p1')).toEqual({ url: 'https://example.com/', status: 200 });
    // The score names the audit only when the page has one; the site read is the fallback.
    await api.getAuditScore('site_1');
    await api.getAuditScore('site_1', 'adt_1');
    expect(calls.slice(-2)).toEqual([
      { name: 'audits.score', input: { siteId: 'site_1' } },
      { name: 'audits.score', input: { siteId: 'site_1', auditId: 'adt_1' } },
    ]);
    expect(await api.listRecommendations({ siteId: 'site_1', status: 'proposed' })).toEqual({
      recommendations: [{ id: 'rcm_1' }],
      total: 1,
      nextCursor: null,
    });
    expect(await api.getArtifactHistory('rcm_1')).toEqual([{ number: 1 }]);
  });

  it('sends each write with the arguments its command declares', async () => {
    await api.ignoreIssue('iss_1', 'The staging host is noindex on purpose.');
    await api.createChangeSet({
      siteId: 'site_1',
      title: 'T',
      summary: 'S',
      changes: [],
      verificationPlan: 'V',
      rollbackPlan: 'R',
    });
    await api.requestApply('chg_1', 'Why');
    await api.rollbackChangeSet('chg_1', 'Because');
    await api.approve('apr_1');
    await api.reject('apr_1', 'Change the title first.');
    await api.selectSearchConsoleProperty('site_1', 'sc-domain:example.com');
    expect(calls.slice(-7).map((entry) => entry.name)).toEqual([
      'checks.ignore',
      'changes.create',
      'changes.requestApply',
      'changes.rollback',
      'approvals.approve',
      'approvals.reject',
      'search.gsc.select',
    ]);
    expect(calls.find((entry) => entry.name === 'checks.ignore')?.input).toEqual({
      issueId: 'iss_1',
      reason: 'The staging host is noindex on purpose.',
    });
    expect(calls.find((entry) => entry.name === 'approvals.reject')?.input).toEqual({
      approvalId: 'apr_1',
      note: 'Change the title first.',
    });
    expect(calls.find((entry) => entry.name === 'search.gsc.select')?.input).toEqual({
      siteId: 'site_1',
      property: 'sc-domain:example.com',
    });
  });
});
