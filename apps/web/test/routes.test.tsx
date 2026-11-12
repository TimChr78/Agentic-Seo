import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Routes } from '../src/app/routes';
import { SessionContext, type SessionValue } from '../src/app/session';

const session: SessionValue = {
  status: 'ready',
  user: { id: 'usr_1', name: 'Alex Rivera', email: 'alex@martechsignal.com' },
  workspace: { id: 'ws_1', name: 'Workspace', timeZone: 'UTC', role: 'owner', permissions: [] },
  sites: [],
  site: null,
  can: () => true,
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

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(
    <SessionContext.Provider value={session}>
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

  it('renders a not-found page for an unknown address', () => {
    renderAt('/not-a-page');
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(screen.getByText('This page does not exist')).toBeTruthy();
  });
});
