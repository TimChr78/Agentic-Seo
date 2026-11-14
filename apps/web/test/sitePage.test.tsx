import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createDemoApi, type Site, type SiteVerification, setApiClient, type VerifyResult } from '../src/app/api';
import { SessionContext, type SessionValue } from '../src/app/session';
import SitePage from '../src/pages/SitePage';

const SITE: Site = {
  id: 'site_martechsignal',
  name: 'MartechSignal',
  domain: 'martechsignal.com',
  faviconUrl: null,
  verified: false,
  isLocalBusiness: false,
  role: 'owner',
};

const TOKEN = 'token_for_the_test';
const VALUE = `aseo-site-verification=${TOKEN}`;

function verification(overrides: Partial<SiteVerification> = {}): SiteVerification {
  return {
    siteId: SITE.id,
    domain: SITE.domain,
    token: TOKEN,
    dns: {
      type: 'TXT',
      name: SITE.domain,
      value: VALUE,
      instructions: `Add a TXT record named “${SITE.domain}” (the root, often shown as @) with the value “${VALUE}”.`,
    },
    meta: {
      name: 'aseo-site-verification',
      content: TOKEN,
      instructions: `Add <meta name="aseo-site-verification" content="${TOKEN}"> inside the <head> of https://${SITE.domain}/, then deploy the page.`,
    },
    verified: false,
    verifiedAt: null,
    verificationMethod: null,
    lastCheckAt: null,
    lastCheckError: null,
    ...overrides,
  };
}

function session(refresh = async () => {}): SessionValue {
  return {
    status: 'ready',
    user: { id: 'usr_1', name: 'Alex Rivera', email: 'alex@martechsignal.com' },
    workspace: {
      id: 'ws_1',
      name: 'Workspace',
      timeZone: 'UTC',
      role: 'owner',
      permissions: ['artifacts:read', 'sites:read', 'sites:write'],
    },
    sites: [SITE],
    site: SITE,
    can: () => true,
    refresh,
    switchSite: async () => {},
    createSite: async () => SITE,
    signOut: async () => {},
    signOutError: null,
    pending: 0,
    demo: false,
  };
}

function renderPage(value: SessionValue = session()) {
  return render(
    <SessionContext.Provider value={value}>
      <SitePage />
    </SessionContext.Provider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => setApiClient(null));

describe('the site verification screen', () => {
  it('shows the DNS record and the meta tag the server published', async () => {
    setApiClient({ ...createDemoApi(), getVerification: async () => verification() });
    renderPage();

    expect(await screen.findByText(VALUE)).toBeTruthy();
    expect(screen.getByText('TXT')).toBeTruthy();
    expect(screen.getAllByText(SITE.domain).length).toBeGreaterThan(0);
    expect(screen.getByText(`<meta name="aseo-site-verification" content="${TOKEN}">`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy();
  });

  it("shows the server's own reason when a check does not verify the site", async () => {
    const reason =
      'Ownership of martechsignal.com is not verified yet. DNS: No DNS TXT records were found on martechsignal.com (ENODATA). Add a TXT record with the value “aseo-site-verification=token_for_the_test”, wait for its TTL, then check again. Meta tag: https://martechsignal.com/ could not be fetched.';
    const failed: VerifyResult = { siteId: SITE.id, verified: false, method: null, checkedAt: '2026-11-14T10:00:00.000Z', error: reason };
    const verifySite = vi.fn(async () => failed);
    setApiClient({ ...createDemoApi(), getVerification: async () => verification(), verifySite });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Check now' }));

    expect(await screen.findByText(reason)).toBeTruthy();
    expect(screen.getByText('Not verified yet')).toBeTruthy();
    expect(verifySite).toHaveBeenCalledWith(SITE.id);
  });

  it('reports a verification with its method and time, and refreshes the session', async () => {
    const refresh = vi.fn(async () => {});
    const verified: VerifyResult = {
      siteId: SITE.id,
      verified: true,
      method: 'dns',
      checkedAt: '2026-11-14T10:00:00.000Z',
      error: null,
    };
    setApiClient({
      ...createDemoApi(),
      getVerification: async () => verification({ verified: true, verifiedAt: '2026-11-14T10:00:00.000Z', verificationMethod: 'dns' }),
      verifySite: async () => verified,
    });
    renderPage(session(refresh));

    await userEvent.click(await screen.findByRole('button', { name: 'Check now' }));

    expect(await screen.findByText('Ownership verified with the DNS TXT record')).toBeTruthy();
    expect(screen.getAllByText('Verified').length).toBeGreaterThan(0);
    expect(refresh).toHaveBeenCalled();
  });

  it('reports a check the server refused with the refused reason', async () => {
    setApiClient({
      ...createDemoApi(),
      getVerification: async () => verification(),
      verifySite: async () => {
        throw new ApiError(403, 'forbidden', 'Only editors and admins can check ownership.');
      },
    });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Check now' }));

    expect(await screen.findByText('Only editors and admins can check ownership.')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy());
  });

  it("keeps the server's last check failure visible before another check runs", async () => {
    const lastError = 'Ownership of martechsignal.com is not verified yet. DNS: no record.';
    setApiClient({
      ...createDemoApi(),
      getVerification: async () => verification({ lastCheckAt: '2026-11-13T08:00:00.000Z', lastCheckError: lastError }),
    });
    renderPage();

    expect(await screen.findByText(lastError)).toBeTruthy();
    expect(screen.getByText('The last check did not verify this site')).toBeTruthy();
  });

  it('never shows a check of the previous site after switching, finished or still running', async () => {
    const other: Site = { ...SITE, id: 'site_oresund', name: 'Oresund Live', domain: 'oresund.live' };
    const verified: VerifyResult = { siteId: SITE.id, verified: true, method: 'dns', checkedAt: '2026-11-14T10:00:00.000Z', error: null };
    let finish: (value: VerifyResult) => void = () => {};
    const verifySite = vi
      .fn<(siteId: string) => Promise<VerifyResult>>()
      .mockResolvedValueOnce(verified)
      .mockImplementationOnce(() => new Promise<VerifyResult>((resolve) => (finish = resolve)));
    setApiClient({
      ...createDemoApi(),
      getVerification: async (siteId: string) =>
        siteId === other.id ? verification({ siteId: other.id, domain: other.domain }) : verification(),
      verifySite,
    });
    const onSite = (site: Site): SessionValue => ({ ...session(), sites: [SITE, other], site });
    const view = renderPage(onSite(SITE));

    // A finished check on the first site.
    await userEvent.click(await screen.findByRole('button', { name: 'Check now' }));
    expect((await screen.findAllByText('Verified')).length).toBeGreaterThan(0);
    view.rerender(
      <SessionContext.Provider value={onSite(other)}>
        <SitePage />
      </SessionContext.Provider>,
    );
    expect((await screen.findAllByText('Not verified')).length).toBeGreaterThan(0);
    expect(screen.queryAllByText('Verified')).toHaveLength(0);

    // A check still running on the first site when the person switches away.
    view.rerender(
      <SessionContext.Provider value={onSite(SITE)}>
        <SitePage />
      </SessionContext.Provider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Check now' }));
    view.rerender(
      <SessionContext.Provider value={onSite(other)}>
        <SitePage />
      </SessionContext.Provider>,
    );
    finish(verified);
    await waitFor(() => expect(screen.getAllByText('Not verified').length).toBeGreaterThan(0));
    expect(screen.queryAllByText('Verified')).toHaveLength(0);
  });
});
