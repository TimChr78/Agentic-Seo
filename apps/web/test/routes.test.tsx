import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDemoApi, type Site, setApiClient } from '../src/app/api';
import { Routes } from '../src/app/routes';
import { SessionContext, type SessionValue } from '../src/app/session';
import { ToastProvider } from '../src/ui/toast';

const SITE: Site = {
  id: 'site_martechsignal',
  name: 'MartechSignal',
  domain: 'martechsignal.com',
  faviconUrl: null,
  verified: true,
  isLocalBusiness: false,
  role: 'owner',
};

function session(role = 'owner', permissions: string[] = [], site: Site | null = null): SessionValue {
  return {
    status: 'ready',
    user: { id: 'usr_1', name: 'Alex Rivera', email: 'alex@martechsignal.com' },
    workspace: { id: 'ws_1', name: 'Workspace', timeZone: 'UTC', role, permissions },
    sites: site ? [site] : [],
    site,
    can: (permission) => permissions.includes(permission),
    refresh: async () => {},
    switchSite: async () => {},
    createSite: async () => {
      throw new Error('not used');
    },
    signOut: async () => {},
    signOutError: null,
    pending: 0,
    demo: false,
  };
}

// Mirrors ROLE_PERMISSIONS in packages/commands/src/principal.ts.
const EDITOR = [
  'artifacts:read',
  'artifacts:write',
  'artifacts:publish',
  'sites:read',
  'sites:write',
  'audits:run',
  'research:spend',
  'changes:apply',
  'audit:read',
];
const VIEWER = ['artifacts:read', 'sites:read'];

function renderAt(path: string, value: SessionValue = session('owner', ['workspace:admin', 'sites:write'])) {
  window.history.replaceState(null, '', path);
  return render(
    <ToastProvider>
      <SessionContext.Provider value={value}>
        <Routes />
      </SessionContext.Provider>
    </ToastProvider>,
  );
}

beforeEach(() => setApiClient(createDemoApi()));
afterEach(() => setApiClient(null));

describe('route table', () => {
  it('gives a built destination its own page: the Inbox renders its empty state', async () => {
    renderAt('/inbox', session('owner', ['workspace:admin', 'sites:write'], SITE));
    expect(screen.getByRole('heading', { level: 1, name: 'Inbox' })).toBeTruthy();
    expect(await screen.findByText('Nothing is waiting for you')).toBeTruthy();
  });

  it('opens an issue detail deep link and says why it could not read it', async () => {
    renderAt('/issues/iss_missing', session('owner', ['workspace:admin', 'sites:write'], SITE));
    // While the read is pending the page keeps the detail geometry with no heading; the error state
    // then names the object and the server's own reason.
    expect(await screen.findByText('Couldn’t open this issue')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Issue' })).toBeTruthy();
    expect(screen.getByText(/The demo has no issue/)).toBeTruthy();
  });

  it('renders Connections inside Settings, with both connections not configured', async () => {
    renderAt('/settings/connections', session('owner', ['workspace:admin', 'sites:write'], SITE));
    expect(screen.getByRole('heading', { level: 1, name: 'Connections' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Settings' })).toBeTruthy();
    expect(await screen.findByText('Google Search Console')).toBeTruthy();
    expect(screen.getAllByText('Not connected').length).toBeGreaterThan(0);
  });

  it('renders Settings children inside the secondary navigation', () => {
    renderAt('/settings/providers');
    expect(screen.getByRole('heading', { level: 1, name: 'Providers and budgets' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByText('Providers and budgets arrives in Phase 3')).toBeTruthy();
  });

  it('opens /settings at the first section', async () => {
    renderAt('/settings', session('owner', ['workspace:admin', 'sites:write'], SITE));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Site' })).toBeTruthy());
  });

  it('refuses a deep link the viewer role cannot open and names the role', () => {
    renderAt('/settings/site', session('viewer', VIEWER));
    expect(screen.getByText("Your role can't open this page")).toBeTruthy();
    expect(screen.getByText(/as Viewer/)).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Settings' })).toBeNull();
  });

  it('lets an editor open Site but not Providers and budgets or Users and roles', async () => {
    renderAt('/settings/site', session('editor', EDITOR, SITE));
    expect(screen.getByRole('heading', { level: 1, name: 'Site' })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('DNS TXT record').length).toBeGreaterThan(0));
    cleanup();

    renderAt('/settings/providers', session('editor', EDITOR));
    expect(screen.getByText("Your role can't open this page")).toBeTruthy();
    expect(screen.getByText(/as Editor/)).toBeTruthy();
    cleanup();

    renderAt('/settings/users', session('editor', EDITOR));
    expect(screen.getByText("Your role can't open this page")).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: 'Users and roles' })).toBeNull();
  });

  it('keeps the account-accessible API tokens open to a viewer', () => {
    renderAt('/settings/api-tokens', session('viewer', VIEWER));
    expect(screen.getByRole('heading', { level: 1, name: 'API tokens' })).toBeTruthy();
  });

  it('renders a not-found page for an unknown address', () => {
    renderAt('/not-a-page');
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(screen.getByText('This page does not exist')).toBeTruthy();
  });
});
