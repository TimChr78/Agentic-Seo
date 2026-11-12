/**
 * The admin UI's API seam. The server (REST and MCP, auth) is built in a parallel task; this file
 * owns the typed interface the UI is written against, a demo implementation with fixed sample data,
 * and a thin HTTP implementation the integrator replaces with the generated client later. Pages never
 * branch on demo mode: they call `api`, and the client selected below answers.
 */

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface Site {
  id: string;
  name: string;
  /** The primary domain, shown beside the name in the site switcher. */
  domain: string;
  /** A site favicon or logo, or null for the initial tile. */
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
  aiCitations: KpiMetric & { cited: number | null; prompts: number | null; engines: number | null; periodDays: number };
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

/** A failed request the UI can show: the message is the server's own reason. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface Api {
  getSession(): Promise<User | null | 'offline'>;
  signIn(input: SignInInput): Promise<User>;
  signOut(): Promise<void>;
  getWorkspace(): Promise<Workspace>;
  listSites(): Promise<Site[]>;
  createSite(input: CreateSiteInput): Promise<Site>;
  getHome(siteId: string): Promise<HomeData>;
}

const DEMO_USER: User = { id: 'usr_demo', name: 'Alex Rivera', email: 'alex@martechsignal.com' };

const DEMO_WORKSPACE: Workspace = {
  id: 'ws_demo',
  name: 'Agentic SEO demo',
  timeZone: 'UTC',
  role: 'owner',
  permissions: ['site:read', 'site:write', 'research:spend', 'workspace:admin'],
};

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

function emptyHome(site: Site): HomeData {
  return {
    siteId: site.id,
    fetchedAt: new Date().toISOString(),
    health: {
      score: null,
      delta: null,
      pagesEvaluated: null,
      categories: [
        { key: 'crawlability', label: 'Crawlability', score: null },
        { key: 'indexability', label: 'Indexability', score: null },
        { key: 'on-page', label: 'On-page', score: null },
        { key: 'structured-data', label: 'Structured data', score: null },
        { key: 'performance', label: 'Performance', score: null },
      ],
      notEvaluated: ['Crawlability', 'Indexability', 'On-page', 'Structured data', 'Performance'],
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
      noDataReason: 'Add AI visibility prompts in Phase 5.',
      updatedAt: null,
      periodDays: 28,
    },
    clicksSeries: { labels: [], values: [] },
    checklist: {
      siteVerified: site.verified,
      searchConsole: false,
      competitors: 0,
      audits: 0,
      dataForSeoKey: false,
      siteConnector: false,
    },
    recommendations: [],
    agentActivity: [],
  };
}

/**
 * A fixed, in-memory API for `VITE_API_MODE=demo`, local development without a server, and the
 * component tests. It is sample data, never a claim about a real site.
 */
export function createDemoApi(): Api {
  const user = { ...DEMO_USER };
  const sites = demoSites();
  return {
    getSession: async () => user,
    signIn: async () => user,
    signOut: async () => {},
    getWorkspace: async () => ({ ...DEMO_WORKSPACE }),
    listSites: async () => sites.map((site) => ({ ...site })),
    createSite: async ({ name, domain }) => {
      const host = domain
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/\/.*$/, '');
      if (!name.trim()) throw new ApiError('Enter a site name.', 400);
      if (!host) throw new ApiError('Enter the site’s primary domain.', 400);
      if (sites.some((site) => site.domain === host)) throw new ApiError(`${host} is already in this workspace.`, 409);
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
      const site = sites.find((candidate) => candidate.id === siteId);
      if (!site) throw new ApiError('That site is not in this workspace.', 404);
      return emptyHome(site);
    },
  };
}

/** The shared demo instance; tests use `createDemoApi()` for an isolated copy. */
export const demoApi = createDemoApi();

const BASE = '/api';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      credentials: 'include',
      ...init,
      headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
  } catch {
    throw new ApiError('The server did not answer. Check that it is running and try again.', 0);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new ApiError(body?.message ?? body?.error ?? 'The request failed.', response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * The thin HTTP implementation of the same interface. The integrator replaces its bodies with the
 * generated command client; nothing in the UI changes when that happens.
 */
export const httpApi: Api = {
  getSession: async () => {
    const response = await fetch(`${BASE}/auth/get-session`, { credentials: 'include' });
    if (response.status === 401) return null;
    if (!response.ok) return 'offline';
    const body = (await response.json().catch(() => null)) as { user?: { id: string; name?: string; email?: string } } | null;
    return body?.user ? { id: body.user.id, name: body.user.name ?? '', email: body.user.email ?? '' } : null;
  },
  signIn: async (input) => {
    const body = await request<{ user?: User }>('/auth/sign-in/email', { method: 'POST', body: JSON.stringify(input) });
    if (!body.user) throw new ApiError('The server did not return a session.', 500);
    return body.user;
  },
  signOut: async () => {
    await request<void>('/auth/sign-out', { method: 'POST', body: '{}' });
  },
  getWorkspace: () => request<Workspace>('/workspace'),
  listSites: () => request<Site[]>('/sites'),
  createSite: (input) => request<Site>('/sites', { method: 'POST', body: JSON.stringify(input) }),
  getHome: (siteId) => request<HomeData>(`/sites/${encodeURIComponent(siteId)}/home`),
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
async function serverReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/health`, { credentials: 'include' });
    return response.status < 500;
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
  getWorkspace: async () => (await resolveApi()).getWorkspace(),
  listSites: async () => (await resolveApi()).listSites(),
  createSite: async (input) => (await resolveApi()).createSite(input),
  getHome: async (siteId) => (await resolveApi()).getHome(siteId),
};

/** The message to show for a failed call: the server's own reason. */
export const errText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
