import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type CommandCall, createCommandApi, serverReachable } from '../src/app/api';

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
