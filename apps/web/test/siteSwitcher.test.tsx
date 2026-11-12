import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { Site } from '../src/app/api';
import { NoSite } from '../src/app/Root';
import { Shell, SiteSwitcher } from '../src/app/Shell';
import { SessionContext, type SessionValue } from '../src/app/session';
import { ToastProvider } from '../src/ui';

const SITES: Site[] = [
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

function session(overrides: Partial<SessionValue> = {}): SessionValue {
  return {
    status: 'ready',
    user: { id: 'usr_1', name: 'Alex Rivera', email: 'alex@martechsignal.com' },
    workspace: {
      id: 'ws_1',
      name: 'Workspace',
      timeZone: 'UTC',
      role: 'owner',
      permissions: ['sites:read', 'sites:write'],
    },
    sites: SITES,
    site: SITES[0],
    can: () => true,
    refresh: async () => {},
    switchSite: vi.fn(async () => {}),
    createSite: vi.fn(async ({ name, domain }) => ({
      id: 'site_new',
      name,
      domain,
      faviconUrl: null,
      verified: false,
      isLocalBusiness: false,
      role: 'owner',
    })),
    signOut: async () => {},
    signOutError: null,
    pending: 0,
    demo: false,
    ...overrides,
  };
}

function renderSwitcher(value: SessionValue) {
  return render(
    <ToastProvider>
      <SessionContext.Provider value={value}>
        <SiteSwitcher />
      </SessionContext.Provider>
    </ToastProvider>,
  );
}

describe('site switcher', () => {
  it('shows the current site name and primary domain in place of a brand', () => {
    renderSwitcher(session());
    expect(screen.getByText('MartechSignal')).toBeTruthy();
    expect(screen.getByText('martechsignal.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: /MartechSignal[\s\S]*martechsignal\.com[\s\S]*Switch site/ })).toBeTruthy();
  });

  it('lists every site and offers New site', async () => {
    renderSwitcher(session());
    await userEvent.click(screen.getByRole('button', { name: /Switch site/ }));
    expect(screen.getByRole('menuitem', { name: /MartechSignal/ })).toBeTruthy();
    const other = screen.getByRole('menuitem', { name: /Øresund Live/ });
    expect(other.textContent).toContain('oresund.live');
    expect(screen.getByRole('menuitem', { name: 'New site…' })).toBeTruthy();
  });

  it('switches site through the session', async () => {
    const value = session();
    renderSwitcher(value);
    await userEvent.click(screen.getByRole('button', { name: /Switch site/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Øresund Live/ }));
    expect(value.switchSite).toHaveBeenCalledWith('site_oresund');
  });

  it('renders the shell with the site switcher and remembers a collapsed navigation', async () => {
    localStorage.setItem('as.theme.user', 'usr_1');
    render(
      <ToastProvider>
        <SessionContext.Provider value={session()}>
          <Shell>
            <p>Page</p>
          </Shell>
        </SessionContext.Provider>
      </ToastProvider>,
    );
    const sidebar = () => document.getElementById('app-sidebar')!;
    expect(sidebar().className).toContain('w-[232px]');
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
    expect(sidebar().className).toContain('w-16');
    expect(localStorage.getItem('as.nav.usr_1')).toBe('collapsed');
    expect(screen.getByRole('button', { name: 'Expand navigation' })).toBeTruthy();
  });

  it('offers New site to a role that may write sites', async () => {
    renderSwitcher(session({ can: (permission) => permission === 'sites:write' }));
    await userEvent.click(screen.getByRole('button', { name: /Switch site/ }));
    expect(screen.getByRole('menuitem', { name: 'New site…' })).toBeTruthy();
  });

  it('hides New site from a role that may only read sites', async () => {
    renderSwitcher(session({ can: (permission) => permission === 'sites:read' }));
    await userEvent.click(screen.getByRole('button', { name: /Switch site/ }));
    expect(screen.queryByRole('menuitem', { name: 'New site…' })).toBeNull();
  });

  it('disables the first-site CTA with a reason when the role cannot write sites', () => {
    render(
      <SessionContext.Provider value={session({ status: 'no-site', sites: [], site: null, can: () => false })}>
        <NoSite />
      </SessionContext.Provider>,
    );
    const button = screen.getByRole('button', { name: 'Add your first site' });
    expect(button).toHaveProperty('disabled', true);
    expect(screen.getByText(/Ask a workspace admin to add the first one/)).toBeTruthy();
  });

  it('offers the first-site CTA to a role that may write sites', () => {
    render(
      <SessionContext.Provider
        value={session({ status: 'no-site', sites: [], site: null, can: (permission) => permission === 'sites:write' })}
      >
        <NoSite />
      </SessionContext.Provider>,
    );
    expect(screen.getByRole('button', { name: 'Add your first site' })).toHaveProperty('disabled', false);
  });

  it('creates a site from the New site dialog with a name and a domain', async () => {
    const value = session();
    renderSwitcher(value);
    await userEvent.click(screen.getByRole('button', { name: /Switch site/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'New site…' }));

    expect(screen.getByRole('dialog', { name: 'New site' })).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Site name'), 'Second Site');
    await userEvent.type(screen.getByLabelText('Primary domain'), 'second.example');
    await userEvent.click(screen.getByRole('button', { name: 'Add site' }));

    await waitFor(() => expect(value.createSite).toHaveBeenCalledWith({ name: 'Second Site', domain: 'second.example' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New site' })).toBeNull());
  });
});
