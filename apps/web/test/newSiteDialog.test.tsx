import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Site } from '../src/app/api';
import { NewSiteDialog } from '../src/app/NewSiteDialog';
import { SessionContext, type SessionValue } from '../src/app/session';
import { ToastProvider } from '../src/ui';

const CREATED: Site = {
  id: 'site_new',
  name: 'Second Site',
  domain: 'second.example',
  faviconUrl: null,
  verified: false,
  isLocalBusiness: false,
  role: 'owner',
};

function session(createSite: SessionValue['createSite']): SessionValue {
  return {
    status: 'no-site',
    user: { id: 'usr_1', name: 'Alex Rivera', email: 'alex@martechsignal.com' },
    workspace: {
      id: 'ws_1',
      name: 'Workspace',
      timeZone: 'UTC',
      role: 'owner',
      permissions: ['sites:read', 'sites:write'],
    },
    sites: [],
    site: null,
    can: (permission) => permission === 'sites:write',
    refresh: async () => {},
    switchSite: async () => {},
    createSite,
    signOut: async () => {},
    signOutError: null,
    pending: 0,
    demo: false,
  };
}

function renderDialog(createSite = vi.fn(async () => CREATED), onClose = vi.fn()) {
  render(
    <ToastProvider>
      <SessionContext.Provider value={session(createSite)}>
        <NewSiteDialog open onClose={onClose} />
      </SessionContext.Provider>
    </ToastProvider>,
  );
  return { createSite, onClose };
}

describe('New site dialog', () => {
  it('puts the footer button in the form as its submit control', () => {
    renderDialog();
    const button = screen.getByRole('button', { name: 'Add site' });
    expect(button.getAttribute('type')).toBe('submit');
    expect(button.getAttribute('form')).toBe('new-site-form');
  });

  it('submits from the form, which is what Enter triggers in the browser', async () => {
    const { createSite } = renderDialog();
    await userEvent.type(screen.getByLabelText('Site name'), 'Second Site');
    await userEvent.type(screen.getByLabelText('Primary domain'), 'second.example');
    // jsdom does not implement implicit submission for a submit control outside the form element,
    // so the Enter path is exercised through the form's own submit event.
    fireEvent.submit(document.getElementById('new-site-form')!);
    await waitFor(() => expect(createSite).toHaveBeenCalledWith({ name: 'Second Site', domain: 'second.example' }));
  });

  it('does not submit while the required fields are empty', async () => {
    const { createSite, onClose } = renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Add site' }));
    expect(createSite).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'New site' })).toBeTruthy();
  });
});
