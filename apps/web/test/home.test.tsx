import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDemoApi, type Site, setApiClient } from '../src/app/api';
import { SessionContext, type SessionValue } from '../src/app/session';
import HomePage from '../src/pages/HomePage';

const MARTECH: Site = {
  id: 'site_martechsignal',
  name: 'MartechSignal',
  domain: 'martechsignal.com',
  faviconUrl: null,
  verified: true,
  isLocalBusiness: false,
  role: 'owner',
};

const ORESUND: Site = {
  id: 'site_oresund',
  name: 'Øresund Live',
  domain: 'oresund.live',
  faviconUrl: null,
  verified: false,
  isLocalBusiness: true,
  role: 'owner',
};

function session(site: Site): SessionValue {
  return {
    status: 'ready',
    user: { id: 'usr_1', name: 'Alex Rivera', email: 'alex@martechsignal.com' },
    workspace: { id: 'ws_1', name: 'Workspace', timeZone: 'UTC', role: 'owner', permissions: ['site:read', 'site:write'] },
    sites: [MARTECH, ORESUND],
    site,
    can: () => true,
    refresh: async () => {},
    switchSite: async () => {},
    createSite: async () => site,
    signOut: async () => {},
    signOutError: null,
    pending: 0,
    demo: false,
  };
}

beforeEach(() => {
  localStorage.clear();
  setApiClient(createDemoApi());
});

describe('Home', () => {
  it('names the site and shows the six-step setup checklist', async () => {
    render(
      <SessionContext.Provider value={session(MARTECH)}>
        <HomePage />
      </SessionContext.Provider>,
    );
    expect(await screen.findByText('Set up MartechSignal')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
    for (const label of [
      'Verify site',
      'Connect Search Console',
      'Add competitors',
      'Run first audit',
      'Add DataForSEO key',
      'Connect a site connector',
    ])
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Optional').length).toBeGreaterThan(0);
    expect(screen.getByText(/based on current configuration/)).toBeTruthy();
  });

  it('shows No data and Not evaluated instead of invented numbers', async () => {
    render(
      <SessionContext.Provider value={session(MARTECH)}>
        <HomePage />
      </SessionContext.Provider>,
    );
    await screen.findByText('Set up MartechSignal');
    expect(screen.getByText('Health score')).toBeTruthy();
    expect(screen.getAllByText('Clicks').length).toBeGreaterThan(0);
    expect(screen.getByText('Avg position')).toBeTruthy();
    expect(screen.getByText('AI citations')).toBeTruthy();
    expect(screen.getByText('Not evaluated')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText('Connect Search Console to collect clicks.')).toBeTruthy();
    expect(screen.getByText('No recommendations yet')).toBeTruthy();
    expect(screen.getByText('No agent has run yet')).toBeTruthy();
    expect(screen.queryByText('18,402')).toBeNull();
  });

  it('restates the checklist for the selected site', async () => {
    render(
      <SessionContext.Provider value={session(ORESUND)}>
        <HomePage />
      </SessionContext.Provider>,
    );
    expect(await screen.findByText('Set up Øresund Live')).toBeTruthy();
    expect(screen.getByText('Not verified')).toBeTruthy();
    expect(screen.getByText('0 of 5 required steps confirmed · based on current configuration')).toBeTruthy();
  });
});
