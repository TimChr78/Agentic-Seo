import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Routes } from '../src/app/routes';
import { SessionContext, type SessionValue } from '../src/app/session';

function session(role = 'owner', permissions: string[] = []): SessionValue {
  return {
    status: 'ready',
    user: { id: 'usr_1', name: 'Alex Rivera', email: 'alex@martechsignal.com' },
    workspace: { id: 'ws_1', name: 'Workspace', timeZone: 'UTC', role, permissions },
    sites: [],
    site: null,
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
    <SessionContext.Provider value={value}>
      <Routes />
    </SessionContext.Provider>,
  );
}

describe('route table', () => {
  it('gives a built destination its own page and phase', () => {
    renderAt('/inbox');
    expect(screen.getByRole('heading', { level: 1, name: 'Inbox' })).toBeTruthy();
    expect(screen.getByText('Inbox arrives in Phase 1')).toBeTruthy();
    expect(screen.getByText(/Approvals, holds with veto windows/)).toBeTruthy();
  });

  it('renders Settings children inside the secondary navigation', () => {
    renderAt('/settings/providers');
    expect(screen.getByRole('heading', { level: 1, name: 'Providers and budgets' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByText('Providers and budgets arrives in Phase 3')).toBeTruthy();
  });

  it('opens /settings at the first section', async () => {
    renderAt('/settings');
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Site' })).toBeTruthy());
  });

  it('refuses a deep link the viewer role cannot open and names the role', () => {
    renderAt('/settings/site', session('viewer', VIEWER));
    expect(screen.getByText("Your role can't open this page")).toBeTruthy();
    expect(screen.getByText(/as Viewer/)).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Settings' })).toBeNull();
  });

  it('lets an editor open Site but not Providers and budgets or Users and roles', () => {
    renderAt('/settings/site', session('editor', EDITOR));
    expect(screen.getByText('Site arrives in Phase 0')).toBeTruthy();
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
