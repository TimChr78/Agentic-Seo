/**
 * The admin UI's API seam. Pages call `api` and never branch on the mode; the selected client
 * answers. The production client is the typed command client from `@agentic-seo/client`, so a
 * command's schema change breaks this file at compile time. The demo client answers with fixed
 * sample data for sample mode, local development without a server and the component tests.
 *
 * The session cookie and the `Origin`/CSRF rules belong to the server (`apps/server/src/app.ts`,
 * `http/csrf.ts`): the client sends cookies (`credentials: 'include'`), the browser sends `Origin`,
 * and a refused request arrives here as the server's own message.
 */

import { ApiError, type CommandInput, type CommandOutput, createClient } from '@agentic-seo/client';
import type { Commands } from '@agentic-seo/server/src/registry';

export { ApiError };

export type CommandName = Commands[number]['name'];
export type In<N extends CommandName> = CommandInput<Commands, N>;
export type Out<N extends CommandName> = CommandOutput<Commands, N>;

export interface User {
  id: string;
  name: string;
  email: string;
}

/** The principal behind the request: who acts, in which workspace, with which permissions. */
export type Identity = Out<'whoami'>;
/** One workspace the person belongs to. */
export type Membership = Out<'workspace.memberships'>['workspaces'][number];
/** The verification token and both ways to publish it, as the server reports them. */
export type SiteVerification = Out<'sites.verification'>;
/** What a check found: verified with its method, or the server's reason it is not. */
export type VerifyResult = Out<'sites.verify'>;

export interface Site {
  id: string;
  name: string;
  /** The primary domain, shown beside the name in the site switcher. */
  domain: string;
  /** A site favicon or logo, or null for the initial tile. Phase 0 stores none. */
  faviconUrl: string | null;
  /** Ownership verified. A fact from the server, never inferred in the UI. */
  verified: boolean;
  /** Local is hidden from the navigation unless this is true. */
  isLocalBusiness: boolean;
  /** The signed-in person's role on this site. */
  role: string;
}

export interface Workspace {
  id: string;
  name: string;
  timeZone: string;
  role: string;
  permissions: string[];
}

/** The setup checklist's facts, read from current configuration rather than stored on the server. */
export interface ChecklistFacts {
  siteVerified: boolean;
  searchConsole: boolean;
  competitors: number;
  audits: number;
  dataForSeoKey: boolean;
  siteConnector: boolean;
}

export interface KpiMetric {
  value: number | null;
  previousValue: number | null;
  /** What the source says when there is no value, e.g. "Connect Search Console". */
  noDataReason?: string;
  updatedAt: string | null;
}

export interface HealthSnapshot {
  score: number | null;
  delta: number | null;
  pagesEvaluated: number | null;
  categories: { key: string; label: string; score: number | null }[];
  notEvaluated: string[];
}

export interface HomeData {
  siteId: string;
  fetchedAt: string;
  health: HealthSnapshot;
  clicks: KpiMetric & { periodDays: number };
  averagePosition: KpiMetric & { periodDays: number };
  aiCitations: KpiMetric & {
    cited: number | null;
    prompts: number | null;
    engines: number | null;
    periodDays: number;
  };
  /** Daily clicks; empty until Search Console is connected. */
  clicksSeries: { labels: string[]; values: (number | null)[] };
  checklist: ChecklistFacts;
  /** Phase 0 has no recommendation or agent reads yet; the arrays stay empty rather than faked. */
  recommendations: { id: string; title: string; expected: string }[];
  agentActivity: { id: string; name: string; summary: string }[];
}

export interface CreateSiteInput {
  name: string;
  domain: string;
}

export interface SignInInput {
  email: string;
  password: string;
}

export interface Api {
  getSession(): Promise<User | null | 'offline'>;
  signIn(input: SignInInput): Promise<User>;
  signOut(): Promise<void>;
  /** The principal the server resolved: person or agent, workspace, role and effective permissions. */
  getIdentity(): Promise<Identity>;
  getMemberships(): Promise<Membership[]>;
  getWorkspace(): Promise<Workspace>;
  listSites(): Promise<Site[]>;
  createSite(input: CreateSiteInput): Promise<Site>;
  getHome(siteId: string): Promise<HomeData>;
  /** The DNS TXT record and the meta tag to publish, plus the last check's outcome. */
  getVerification(siteId: string): Promise<SiteVerification>;
  /** Check ownership now: DNS first, then the home page's meta tag. */
  verifySite(siteId: string): Promise<VerifyResult>;
}

const DEMO_USER: User = { id: 'usr_demo', name: 'Alex Rivera', email: 'alex@martechsignal.com' };

const DEMO_WORKSPACE: Workspace = {
  id: 'ws_demo',
  name: 'Agentic SEO demo',
  timeZone: 'UTC',
  role: 'owner',
  // The canonical owner set (packages/commands/src/principal.ts: owners hold every permission).
  permissions: [
    'workspace:admin',
    'artifacts:read',
    'artifacts:write',
    'artifacts:approve',
    'artifacts:publish',
    'secrets:read',
    'secrets:write',
    'sites:read',
    'sites:write',
    'audits:run',
    'research:spend',
    'changes:apply',
    'audit:read',
  ],
};

/** The instant the demo's verified sample site carries; sample data is fixed, never "now". */
const DEMO_VERIFIED_AT = '2026-11-01T09:00:00.000Z';

/**
 * The two pilot sites (the roadmap's MartechSignal and oresund.live). They are sample data, not
 * live reads; no metric is invented for them — Home shows the "No data" and "Not evaluated" states.
 */
function demoSites(): Site[] {
  return [
    {
      id: 'site_martechsignal',
      name: 'MartechSignal',
      domain: 'martechsignal.com',
      faviconUrl: null,
      verified: true,
      isLocalBusiness: false,
      role: 'owner',
    },
    {
      id: 'site_oresund',
      name: 'Øresund Live',
      domain: 'oresund.live',
      faviconUrl: null,
      verified: false,
      isLocalBusiness: true,
      role: 'owner',
    },
  ];
}

/**
 * Home with no source connected. Every tile keeps its period and names why it has no value: Phase 0
 * has no audit and no Search Console or AI-visibility source, so a number here would be a claim the
 * server cannot support.
 */
export function emptyHome(site: { id: string }, checklist: ChecklistFacts): HomeData {
  const categories = [
    { key: 'crawlability', label: 'Crawlability', score: null },
    { key: 'indexability', label: 'Indexability', score: null },
    { key: 'on-page', label: 'On-page', score: null },
    { key: 'structured-data', label: 'Structured data', score: null },
    { key: 'performance', label: 'Performance', score: null },
  ];
  return {
    siteId: site.id,
    fetchedAt: new Date().toISOString(),
    health: {
      score: null,
      delta: null,
      pagesEvaluated: null,
      categories,
      notEvaluated: categories.map((category) => category.label),
    },
    clicks: {
      value: null,
      previousValue: null,
      noDataReason: 'Connect Search Console to collect clicks.',
      updatedAt: null,
      periodDays: 28,
    },
    averagePosition: {
      value: null,
      previousValue: null,
      noDataReason: 'Connect Search Console to collect positions.',
      updatedAt: null,
      periodDays: 28,
    },
    aiCitations: {
      value: null,
      previousValue: null,
      cited: null,
      prompts: null,
      engines: null,
      noDataReason: 'AI visibility arrives in Phase 5.',
      updatedAt: null,
      periodDays: 28,
    },
    clicksSeries: { labels: [], values: [] },
    checklist,
    recommendations: [],
    agentActivity: [],
  };
}

function demoIdentity(): Identity {
  return {
    type: 'user',
    userId: DEMO_USER.id,
    workspaceId: DEMO_WORKSPACE.id,
    role: 'owner',
    permissions: [...DEMO_WORKSPACE.permissions],
  };
}

function demoVerification(site: Site): SiteVerification {
  const token = `demo-verification-token-${site.id}`;
  const value = `aseo-site-verification=${token}`;
  return {
    siteId: site.id,
    domain: site.domain,
    token,
    dns: {
      type: 'TXT',
      name: site.domain,
      value,
      instructions: `Add a TXT record named “${site.domain}” (the root, often shown as @) with the value “${value}”. Keep any existing records apart from this one.`,
    },
    meta: {
      name: 'aseo-site-verification',
      content: token,
      instructions: `Add <meta name="aseo-site-verification" content="${token}"> inside the <head> of https://${site.domain}/, then deploy the page.`,
    },
    verified: site.verified,
    verifiedAt: site.verified ? DEMO_VERIFIED_AT : null,
    verificationMethod: site.verified ? 'dns' : null,
    lastCheckAt: null,
    lastCheckError: null,
  };
}

/**
 * A fixed, in-memory API for `VITE_API_MODE=demo`, local development without a server, and the
 * component tests. It is sample data, never a claim about a real site: the ownership check says it
 * cannot reach DNS, rather than pretending a record was found.
 */
export function createDemoApi(): Api {
  const user = { ...DEMO_USER };
  const sites = demoSites();
  const siteOf = (siteId: string) => {
    const site = sites.find((candidate) => candidate.id === siteId);
    if (!site) throw new ApiError(404, 'not_found', 'That site is not in this workspace.');
    return site;
  };
  return {
    getSession: async () => user,
    signIn: async () => user,
    signOut: async () => {},
    getIdentity: async () => demoIdentity(),
    getMemberships: async () => [{ id: DEMO_WORKSPACE.id, name: DEMO_WORKSPACE.name, role: 'owner' }],
    getWorkspace: async () => ({ ...DEMO_WORKSPACE }),
    listSites: async () => sites.map((site) => ({ ...site })),
    createSite: async ({ name, domain }) => {
      const host = domain
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/\/.*$/, '');
      if (!name.trim()) throw new ApiError(400, 'invalid_input', 'Enter a site name.');
      if (!host) throw new ApiError(400, 'invalid_input', 'Enter the site’s primary domain.');
      if (sites.some((site) => site.domain === host)) throw new ApiError(409, 'conflict', `${host} is already in this workspace.`);
      const site: Site = {
        id: `site_${sites.length + 1}`,
        name: name.trim(),
        domain: host,
        faviconUrl: null,
        verified: false,
        isLocalBusiness: false,
        role: 'owner',
      };
      sites.push(site);
      return { ...site };
    },
    getHome: async (siteId) => {
      const site = siteOf(siteId);
      return emptyHome(site, {
        siteVerified: site.verified,
        searchConsole: false,
        competitors: 0,
        audits: 0,
        dataForSeoKey: false,
        siteConnector: false,
      });
    },
    getVerification: async (siteId) => demoVerification(siteOf(siteId)),
    verifySite: async (siteId) => {
      const site = siteOf(siteId);
      return {
        siteId: site.id,
        verified: site.verified,
        method: site.verified ? 'dns' : null,
        checkedAt: new Date().toISOString(),
        error: site.verified
          ? null
          : 'Sample data cannot check DNS or the home page. On a real server this reads the TXT record, then the meta tag.',
      };
    },
  };
}

/** The shared demo instance; tests use `createDemoApi()` for an isolated copy. */
export const demoApi = createDemoApi();

/** The workspace every command call acts in; the session chooses it and stores it per device. */
const WORKSPACE_KEY = 'as.workspace';

function readWorkspaceId(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
}

let actingWorkspaceId: string | null = readWorkspaceId();
/** The role the server reported for this person in the acting workspace, for the site label. */
let actingRole = '';

/**
 * Chooses the workspace every call acts in. The server picks the person's first membership when the
 * header is absent; the UI sends the one it resolved so a multi-workspace person stays where they were.
 */
export function setWorkspaceId(id: string | null, opts: { persist?: boolean } = {}) {
  actingWorkspaceId = id;
  actingRole = '';
  if (opts.persist === false) return;
  try {
    if (id) localStorage.setItem(WORKSPACE_KEY, id);
    else localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    // Private mode or blocked storage: the choice lasts this page view only.
  }
}

export const getWorkspaceId = () => actingWorkspaceId;

const fetchWithWorkspace: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  if (actingWorkspaceId) headers.set('x-workspace-id', actingWorkspaceId);
  return fetch(input, { ...init, headers });
};

const client = createClient<Commands>({ credentials: 'include', fetch: fetchWithWorkspace });

/** One command call, typed from the command definitions. */
export type CommandCall = <N extends CommandName>(name: N, input: In<N>) => Promise<Out<N>>;

// The published client types its `call` with the same generics, but TypeScript does not narrow a
// generic through a wrapper's own type parameter, so the contract is named once here.
const callCommand = client.call as CommandCall;

/** One command call; a transport failure becomes the UI error the server could not send. */
async function rpc<N extends CommandName>(name: N, input: In<N>): Promise<Out<N>> {
  try {
    return await callCommand(name, input);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, 'offline', 'The server did not answer. Check that it is running and try again.');
  }
}

/**
 * The mapping from command outputs to the UI's own shapes. It takes the command transport, so the
 * mapping is testable without a server: the tests pass a fake that answers the commands.
 */
export function createCommandApi(
  call: CommandCall,
): Pick<
  Api,
  'getIdentity' | 'getMemberships' | 'getWorkspace' | 'listSites' | 'createSite' | 'getHome' | 'getVerification' | 'verifySite'
> {
  const siteView = (site: Out<'sites.list'>['sites'][number]): Site => ({
    id: site.id,
    name: site.name,
    domain: site.domain,
    // Phase 0 stores no site favicon; the switcher falls back to the name's initial tile.
    faviconUrl: null,
    verified: site.verified,
    isLocalBusiness: site.isLocalBusiness,
    role: actingRole,
  });

  return {
    getIdentity: async () => {
      const identity = await call('whoami', {});
      actingRole = identity.role;
      return identity;
    },
    getMemberships: async () => (await call('workspace.memberships', {})).workspaces,
    getWorkspace: async () => {
      const workspace = await call('workspace.get', {});
      actingRole = workspace.role;
      return {
        id: workspace.id,
        name: workspace.name,
        timeZone: workspace.timeZone,
        role: workspace.role,
        permissions: workspace.permissions,
      };
    },
    listSites: async () => (await call('sites.list', { includeArchived: false })).sites.map(siteView),
    createSite: async (input) => siteView((await call('sites.create', { name: input.name, domain: input.domain })).site),
    getHome: async (siteId) => {
      // The checklist is the server's read of current configuration; the site read supplies the
      // verification fact the checklist repeats and the domain a tile would name.
      const [checklist, site] = await Promise.all([call('sites.checklist', { siteId }), call('sites.get', { siteId })]);
      return emptyHome(site.site, checklist);
    },
    getVerification: (siteId) => call('sites.verification', { siteId }),
    verifySite: (siteId) => call('sites.verify', { siteId }),
  };
}

const BASE = '/api';

async function authRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      credentials: 'include',
      ...init,
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'offline', 'The server did not answer. Check that it is running and try again.');
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new ApiError(response.status, body?.error ?? 'error', body?.message ?? 'The request failed.');
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const commandApi = createCommandApi(rpc);

/**
 * The real client. Better Auth's session endpoints are not commands (they are the server's own auth
 * surface); everything else is one command call through the typed client.
 */
export const httpApi: Api = {
  ...commandApi,
  getSession: async () => {
    let response: Response;
    try {
      response = await fetch(`${BASE}/auth/get-session`, { credentials: 'include' });
    } catch {
      return 'offline';
    }
    if (response.status === 401) return null;
    if (!response.ok) return 'offline';
    const body = (await response.json().catch(() => null)) as {
      user?: { id: string; name?: string; email?: string };
    } | null;
    return body?.user ? { id: body.user.id, name: body.user.name ?? '', email: body.user.email ?? '' } : null;
  },
  signIn: async (input) => {
    const body = await authRequest<{ user?: { id: string; name?: string; email?: string } }>('/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    if (!body.user) throw new ApiError(500, 'no_session', 'The server did not return a session.');
    return { id: body.user.id, name: body.user.name ?? '', email: body.user.email ?? '' };
  },
  signOut: async () => {
    await authRequest<void>('/auth/sign-out', { method: 'POST', body: '{}' });
  },
};

let installed: Api | null = null;
let resolved: Promise<Api> | null = null;

/**
 * Installs a client (the demo entry and tests) and returns an uninstall that restores the previous
 * one. `null` drops the installed client so the next call resolves the default again.
 */
export function setApiClient(client: Api | null): () => void {
  const previous = installed;
  installed = client;
  resolved = null;
  return () => {
    installed = previous;
    resolved = null;
  };
}

/** True when the API server answers; a dev server with no backend behind its proxy does not. */
export async function serverReachable(): Promise<boolean> {
  try {
    const response = await fetch('/healthz', { credentials: 'include' });
    if (!response.ok) return false;
    // Without a backend, a dev server can answer any path with its HTML fallback and a 200: only the
    // API's own JSON answer counts.
    const body = (await response.json().catch(() => null)) as { ok?: unknown } | null;
    return body?.ok === true;
  } catch {
    return false;
  }
}

/**
 * The client in use. `VITE_API_MODE=demo` selects the demo outright; otherwise the HTTP client is
 * used, and only in development does an unreachable server fall back to the demo.
 */
export function resolveApi(): Promise<Api> {
  if (installed) return Promise.resolve(installed);
  resolved ??= (async () => {
    if (import.meta.env.VITE_API_MODE === 'demo') return demoApi;
    if (import.meta.env.DEV && !(await serverReachable())) return demoApi;
    return httpApi;
  })();
  return resolved;
}

/** True when the selected client is the demo. The shell says so instead of pretending it is live. */
export async function apiIsDemo(): Promise<boolean> {
  return (await resolveApi()) === demoApi;
}

/** The single entry point pages use; every method waits for the selected client. */
export const api: Api = {
  getSession: async () => (await resolveApi()).getSession(),
  signIn: async (input) => (await resolveApi()).signIn(input),
  signOut: async () => (await resolveApi()).signOut(),
  getIdentity: async () => (await resolveApi()).getIdentity(),
  getMemberships: async () => (await resolveApi()).getMemberships(),
  getWorkspace: async () => (await resolveApi()).getWorkspace(),
  listSites: async () => (await resolveApi()).listSites(),
  createSite: async (input) => (await resolveApi()).createSite(input),
  getHome: async (siteId) => (await resolveApi()).getHome(siteId),
  getVerification: async (siteId) => (await resolveApi()).getVerification(siteId),
  verifySite: async (siteId) => (await resolveApi()).verifySite(siteId),
};

/** The message to show for a failed call: the server's own reason. */
export const errText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
