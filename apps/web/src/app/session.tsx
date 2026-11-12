import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { setWorkspaceTimeZone } from '../ui/time';
import { api, apiIsDemo, errText, type Site, type User, type Workspace } from './api';
import { setThemeUser } from './theme';

// The signed-in person, their workspace and the site every screen acts in. Loaded once after
// sign-in; the UI uses `can()` to hide what the role cannot use, so it never offers a 403.
// The site choice is per person per device, beside the theme and navigation preferences.

export type { Site, User, Workspace } from './api';

type Status = 'loading' | 'signed-out' | 'offline' | 'no-workspace' | 'no-site' | 'ready';

export interface SessionValue {
  status: Status;
  user: User | null;
  workspace: Workspace | null;
  /** Every site the person can open in this workspace. */
  sites: Site[];
  /** The site the shell acts in. */
  site: Site | null;
  can: (permission: string) => boolean;
  refresh: () => Promise<void>;
  switchSite: (id: string) => Promise<void>;
  createSite: (input: { name: string; domain: string }) => Promise<Site>;
  signOut: () => Promise<void>;
  /** A sign-out the server did not confirm: the person is still signed in. */
  signOutError: string | null;
  /** Pending inbox decisions, for the nav badge. */
  pending: number;
  /** This session is the demo's fixed sample data, not a live workspace. */
  demo: boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

/** The session seam: tests and the demo supply a value through this provider. */
export { SessionContext };

function siteKey(userId: string) {
  return `as.site.${userId}`;
}

function readSiteId(userId: string): string | null {
  try {
    return localStorage.getItem(siteKey(userId));
  } catch {
    return null;
  }
}

function writeSiteId(userId: string, siteId: string | null) {
  try {
    if (siteId) localStorage.setItem(siteKey(userId), siteId);
    else localStorage.removeItem(siteKey(userId));
  } catch {
    // Private mode or blocked storage: the choice lasts this page view only.
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);

  const load = useCallback(async () => {
    setStatus('loading');
    let signedIn: User | null | 'offline';
    try {
      signedIn = await api.getSession();
    } catch {
      signedIn = 'offline';
    }
    if (signedIn === 'offline') return setStatus('offline');
    if (!signedIn) {
      setUser(null);
      setWorkspace(null);
      setSites([]);
      setSiteId(null);
      setThemeUser(null);
      return setStatus('signed-out');
    }

    setUser(signedIn);
    setThemeUser(signedIn.id);

    let nextWorkspace: Workspace;
    let nextSites: Site[];
    try {
      [nextWorkspace, nextSites] = await Promise.all([api.getWorkspace(), api.listSites()]);
    } catch {
      return setStatus('offline');
    }

    setDemo(await apiIsDemo());
    setWorkspace(nextWorkspace);
    setWorkspaceTimeZone(nextWorkspace.timeZone);
    setSites(nextSites);
    const stored = readSiteId(signedIn.id);
    const nextSite = nextSites.find((candidate) => candidate.id === stored) ?? nextSites[0] ?? null;
    setSiteId(nextSite?.id ?? null);
    if (nextSite) writeSiteId(signedIn.id, nextSite.id);
    setStatus(nextSites.length ? 'ready' : 'no-site');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const value = useMemo<SessionValue>(() => {
    const permissions = new Set(workspace?.permissions ?? []);
    return {
      status,
      user,
      workspace,
      sites,
      site: sites.find((candidate) => candidate.id === siteId) ?? null,
      can: (permission) => permissions.has(permission),
      pending: 0,
      demo,
      refresh: load,
      switchSite: async (id) => {
        if (!user || !sites.some((candidate) => candidate.id === id)) return;
        writeSiteId(user.id, id);
        setSiteId(id);
      },
      createSite: async (input) => {
        const created = await api.createSite(input);
        setSites((current) => [...current, created]);
        if (user) writeSiteId(user.id, created.id);
        setSiteId(created.id);
        return created;
      },
      signOutError,
      signOut: async () => {
        setSignOutError(null);
        try {
          await api.signOut();
        } catch (error) {
          // The request never reached the server: the session is still valid.
          setSignOutError(errText(error) || 'Sign-out did not go through. Your session is still active; try again.');
          return;
        }
        if (user) writeSiteId(user.id, null);
        setWorkspace(null);
        setSites([]);
        setSiteId(null);
        setUser(null);
        setThemeUser(null);
        setStatus('signed-out');
      },
    };
  }, [status, user, workspace, sites, siteId, load, signOutError, demo]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside SessionProvider');
  return session;
}

/** For pages inside the shell, where a site is always loaded. */
export function useSite() {
  const session = useSession();
  return { ...session, site: session.site!, workspace: session.workspace!, user: session.user! };
}
