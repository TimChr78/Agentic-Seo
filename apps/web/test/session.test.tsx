import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Api,
  type CreateSiteInput,
  createDemoApi,
  getWorkspaceId,
  type Site,
  setApiClient,
  setWorkspaceId,
} from '../src/app/api';
import { SessionProvider, useSession } from '../src/app/session';

function Probe() {
  const { status, site, sites, createSite } = useSession();
  return (
    <>
      <p data-testid="status">{status}</p>
      <p data-testid="site">{site?.name ?? 'none'}</p>
      <p data-testid="count">{sites.length}</p>
      <button type="button" onClick={() => void createSite({ name: 'Second Site', domain: 'second.example' })}>
        Add site
      </button>
    </>
  );
}

/** A workspace whose first site is created during the test. */
function firstRunApi(): Api {
  const sites: Site[] = [];
  const demo = createDemoApi();
  return {
    ...demo,
    getSession: async () => ({ id: 'usr_1', name: 'Alex Rivera', email: 'alex@martechsignal.com' }),
    getWorkspace: async () => ({
      id: 'ws_1',
      name: 'Workspace',
      timeZone: 'UTC',
      role: 'owner',
      permissions: ['sites:read', 'sites:write'],
    }),
    listSites: async () => sites.map((site) => ({ ...site })),
    createSite: async ({ name, domain }: CreateSiteInput) => {
      const site: Site = {
        id: `site_${sites.length + 1}`,
        name,
        domain,
        faviconUrl: null,
        verified: false,
        isLocalBusiness: false,
        role: 'owner',
      };
      sites.push(site);
      return { ...site };
    },
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => setApiClient(null));

describe('session', () => {
  it('opens the app once the first site is created', async () => {
    setApiClient(firstRunApi());
    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('no-site'));

    await userEvent.click(screen.getByRole('button', { name: 'Add site' }));

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('site').textContent).toBe('Second Site');
    expect(screen.getByTestId('count').textContent).toBe('1');
  });

  it('falls back to a remaining workspace when the one saved on this device was left', async () => {
    const api = firstRunApi();
    setWorkspaceId('ws_gone');
    setApiClient({
      ...api,
      getMemberships: async () => [{ id: 'ws_2', name: 'Still here', role: 'owner' }],
      getIdentity: async () => ({ ...(await api.getIdentity()), workspaceId: 'ws_2' }),
    });
    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('no-site'));
    expect(getWorkspaceId()).toBe('ws_2');
  });
});
