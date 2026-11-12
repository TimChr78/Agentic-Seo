import { lazy, Suspense, useEffect, useState } from 'react';
import { Alert, AuthSkeleton, Button, EmptyState, LoadingBlock, ToastProvider, useToast } from '../ui';
import { BrandLockup } from './Brand';
import { NewSiteDialog } from './NewSiteDialog';
import { useLocation } from './router';
import { SignIn } from './SignIn';
import { SessionProvider, useSession } from './session';

// The signed-in shell is only needed after authentication, so the sign-in screen stays light and
// the shell and route table load as separate chunks after the session resolves.
const Shell = lazy(async () => ({ default: (await import('./Shell')).Shell }));
const Routes = lazy(async () => ({ default: (await import('./routes')).Routes }));

export function Root() {
  return (
    <ToastProvider>
      <SessionProvider>
        <Gate />
      </SessionProvider>
    </ToastProvider>
  );
}

function Gate() {
  const { status, refresh, signOut, user, signOutError } = useSession();
  const toast = useToast();
  const { path } = useLocation();
  // A refused or unreachable sign-out keeps the session and says so.
  useEffect(() => {
    if (signOutError) toast.error(signOutError);
  }, [signOutError, toast]);

  if (status === 'loading')
    return (
      <main className="min-h-screen bg-bg">
        <AuthSkeleton label="Loading your workspace" />
      </main>
    );
  if (status === 'signed-out') return <SignIn />;
  if (status === 'offline')
    return (
      <Centered>
        <Alert tone="bad" title="Can't reach the server" onRetry={() => void refresh()}>
          The API did not answer. Check that the server is running and that this page is served from it.
        </Alert>
      </Centered>
    );
  if (status === 'no-workspace')
    return (
      <Centered>
        <Alert tone="warn" title="You're not in a workspace yet">
          {user?.email} is signed in but is not a member of any workspace. Ask an admin to invite you, then open the link in the invitation.
        </Alert>
        <Button className="mt-4" onClick={() => void signOut()}>
          Sign out
        </Button>
      </Centered>
    );
  if (status === 'no-site') return <NoSite />;
  return (
    <Suspense fallback={<LoadingBlock lines={6} label="Loading the shell" />}>
      <Shell>
        <Suspense fallback={<LoadingBlock lines={6} label="Loading this page" />}>
          <Routes key={path} />
        </Suspense>
      </Shell>
    </Suspense>
  );
}

/** The first run: a workspace with no site yet. The switcher cannot help before a site exists. */
export function NoSite() {
  const { signOut, can } = useSession();
  const [open, setOpen] = useState(false);
  const canCreate = can('sites:write');
  return (
    <main className="flex min-h-screen flex-col bg-bg">
      <div className="flex h-14 items-center justify-between px-4 md:px-6">
        <BrandLockup />
        <Button size="sm" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
      <div className="mx-auto w-full max-w-[520px] px-4 pt-[12vh]">
        <EmptyState
          title="No sites yet"
          icon={<span className="text-[28px] font-semibold">+</span>}
          action={
            <Button
              variant="primary"
              onClick={() => setOpen(true)}
              disabled={!canCreate}
              title={canCreate ? undefined : 'Only editors and admins can add a site.'}
              aria-description={canCreate ? undefined : 'Your role cannot add sites.'}
            >
              Add your first site
            </Button>
          }
        >
          {canCreate
            ? 'Add the site you want to audit. Verification, Search Console and the first audit come after it exists.'
            : 'Your role cannot add sites. Ask a workspace admin to add the first one.'}
        </EmptyState>
      </div>
      {canCreate && open && <NewSiteDialog open onClose={() => setOpen(false)} />}
    </main>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-[480px] px-4 pt-[18vh]">{children}</div>;
}
