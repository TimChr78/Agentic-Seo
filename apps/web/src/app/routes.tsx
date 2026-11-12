import { useEffect } from 'react';
import HomePage from '../pages/HomePage';
import { NotFound, PlannedPage } from '../pages/PlannedPage';
import { LoadingBlock } from '../ui';
import { pageWidth } from '../ui/layout';
import { SettingsLayout } from '../ui/SettingsLayout';
import { SETTINGS_ITEMS, settingsPath } from './nav';
import { PLANNED } from './planned';
import { redirectTarget } from './redirects';
import { navigate, useLocation } from './router';
import { useSession } from './session';

// The route table. Home is the only built screen in Phase 0; every other canonical destination
// from DESIGN.md §3 has a real page that names what will be there and which phase delivers it.
// Settings children render inside the Settings secondary navigation.

const PLANNED_SETTINGS = new Set(SETTINGS_ITEMS.map((item) => item.path));

export function Routes() {
  const { path, search } = useLocation();

  // A legacy address is rewritten before any page mounts, so a redirect never fetches the old page.
  const legacy = redirectTarget(path, search);
  useEffect(() => {
    if (legacy) navigate(legacy, { replace: true });
  }, [legacy]);
  if (legacy) return null;

  if (path === '/settings') return <SettingsIndex />;
  if (PLANNED_SETTINGS.has(path))
    return (
      <SettingsLayout>
        <PlannedPage path={path} />
      </SettingsLayout>
    );
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
