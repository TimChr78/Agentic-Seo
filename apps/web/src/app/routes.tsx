import { ArrowLeft } from 'lucide-react';
import { type ReactElement, useEffect } from 'react';
import AuditPage from '../pages/AuditPage';
import AuditsPage from '../pages/AuditsPage';
import ChangePage from '../pages/ChangePage';
import ChangesPage from '../pages/ChangesPage';
import ConnectionsPage from '../pages/ConnectionsPage';
import HomePage from '../pages/HomePage';
import InboxPage from '../pages/InboxPage';
import IssuePage from '../pages/IssuePage';
import IssuesPage from '../pages/IssuesPage';
import { NotFound, PlannedPage } from '../pages/PlannedPage';
import RecommendationPage from '../pages/RecommendationPage';
import RecommendationsPage from '../pages/RecommendationsPage';
import SitePage from '../pages/SitePage';
import { EmptyState, LoadingBlock } from '../ui';
import { pageWidth } from '../ui/layout';
import { SettingsLayout } from '../ui/SettingsLayout';
import { ButtonLink } from './links';
import { canOpen, SETTINGS_ITEMS, settingsPath } from './nav';
import { useCrumbs } from './page';
import { PLANNED } from './planned';
import { redirectTarget } from './redirects';
import { roleName } from './roles';
import { match, navigate, useLocation } from './router';
import { useSession } from './session';

// The route table. Phase 1 builds the thin loop's screens; every other canonical destination from
// DESIGN.md §3 still has a real page that names what will be there and which phase delivers it.
// Settings children render inside the Settings secondary navigation, and every entry carries its
// permission gate here too, so a deep link to a denied section explains itself.

const PLANNED_SETTINGS = new Set(SETTINGS_ITEMS.map((item) => item.path));

/** The Settings sections that are built; every other one renders its planned page. */
const BUILT_SETTINGS: Record<string, () => ReactElement> = {
  '/settings/site': SitePage,
  '/settings/connections': ConnectionsPage,
};

/** The detail screens, each with the id its path carries. */
const DETAIL: { pattern: string; render: (id: string) => ReactElement }[] = [
  { pattern: '/audits/:id', render: (id) => <AuditPage auditId={id} /> },
  { pattern: '/issues/:id', render: (id) => <IssuePage issueId={id} /> },
  { pattern: '/recommendations/:id', render: (id) => <RecommendationPage recommendationId={id} /> },
  { pattern: '/changes/:id', render: (id) => <ChangePage changeSetId={id} /> },
];

/** The list screens that replaced their planned page. */
const LISTS: Record<string, () => ReactElement> = {
  '/inbox': () => <InboxPage />,
  '/audits': () => <AuditsPage />,
  '/issues': () => <IssuesPage />,
  '/recommendations': () => <RecommendationsPage />,
  '/changes': () => <ChangesPage />,
};

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
    const Built = BUILT_SETTINGS[path];
    return <SettingsLayout>{Built ? <Built /> : <PlannedPage path={path} />}</SettingsLayout>;
  }
  if (path === '/') return <HomePage />;

  // An approval has its own address so a review link survives: it opens the Inbox with that request.
  const approval = match('/approvals/:id', path);
  if (approval) return <InboxPage approvalId={approval.id} />;

  const list = LISTS[path];
  if (list) return list();

  for (const route of DETAIL) {
    const params = match(route.pattern, path);
    if (params) return route.render(params.id);
  }

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
