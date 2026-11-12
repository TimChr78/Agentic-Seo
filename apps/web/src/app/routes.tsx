import { ArrowLeft } from 'lucide-react';
import { useEffect } from 'react';
import HomePage from '../pages/HomePage';
import { NotFound, PlannedPage } from '../pages/PlannedPage';
import { EmptyState, LoadingBlock } from '../ui';
import { pageWidth } from '../ui/layout';
import { SettingsLayout } from '../ui/SettingsLayout';
import { ButtonLink } from './links';
import { canOpen, SETTINGS_ITEMS, settingsPath } from './nav';
import { useCrumbs } from './page';
import { PLANNED } from './planned';
import { redirectTarget } from './redirects';
import { roleName } from './roles';
import { navigate, useLocation } from './router';
import { useSession } from './session';

// The route table. Home is the only built screen in Phase 0; every other canonical destination
// from DESIGN.md §3 has a real page that names what will be there and which phase delivers it.
// Settings children render inside the Settings secondary navigation, and every entry carries its
// permission gate here too, so a deep link to a denied section explains itself.

const PLANNED_SETTINGS = new Set(SETTINGS_ITEMS.map((item) => item.path));

export function Routes() {
  const { path, search } = useLocation();
  const { can } = useSession();

  // A legacy address is rewritten before any page mounts, so a redirect never fetches the old page.
  const legacy = redirectTarget(path, search);
  useEffect(() => {
    if (legacy) navigate(legacy, { replace: true });
  }, [legacy]);
  if (legacy) return null;

  if (path === '/settings') return <SettingsIndex />;
  if (PLANNED_SETTINGS.has(path)) {
    const item = SETTINGS_ITEMS.find((candidate) => candidate.path === path);
    if (item && !canOpen(item, can)) return <NoAccess />;
    return (
      <SettingsLayout>
        <PlannedPage path={path} />
      </SettingsLayout>
    );
  }
  if (path === '/') return <HomePage />;
  if (PLANNED[path])
    return (
      <div className={pageWidth('default')}>
        <PlannedPage path={path} />
      </div>
    );
  return (
    <div className={pageWidth('default')}>
      <NotFound />
    </div>
  );
}

/** `/settings` opens the first section the role can use. */
function SettingsIndex() {
  const { can } = useSession();
  const target = settingsPath(can);
  useEffect(() => navigate(target, { replace: true }), [target]);
  return <LoadingBlock lines={4} label="Opening settings" />;
}

/** A deep link to a section the role cannot open: say so, and name the role and workspace. */
function NoAccess() {
  const { workspace } = useSession();
  useCrumbs([{ label: 'No access' }]);
  return (
    <div className={pageWidth('default')}>
      <EmptyState
        title="Your role can't open this page"
        action={
          <ButtonLink to="/" variant="secondary" icon={<ArrowLeft size={14} />}>
            Go to Home
          </ButtonLink>
        }
      >
        You are signed in to {workspace?.name ?? 'this workspace'} as {roleName(workspace?.role ?? '')}. Ask a workspace admin if you need
        access.
      </EmptyState>
    </div>
  );
}
