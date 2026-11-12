import {
  Bot,
  BriefcaseBusiness,
  Building2,
  Cable,
  ChartLine,
  ChartNoAxesColumn,
  ChartNoAxesCombined,
  FileChartColumn,
  Files,
  Gauge,
  GitPullRequestArrow,
  HeartPulse,
  House,
  Inbox,
  KeyRound,
  Lightbulb,
  Link2,
  ListOrdered,
  type LucideIcon,
  MapPin,
  Network,
  NotebookPen,
  Plug,
  Radar,
  ScanEye,
  ScanSearch,
  Settings,
  ShieldCheck,
  Swords,
  Tags,
  Telescope,
  TriangleAlert,
  Trophy,
  UsersRound,
} from 'lucide-react';

// The navigation from docs/design/DESIGN.md §3. Every path here is canonical; a destination that a
// later phase has not built yet still exists as a route with an honest "what will be here" page.
// Entries name the permissions that show them, so a role is never offered a page it cannot read.

export interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Any one of these permissions shows the entry. Empty: everyone in the workspace. */
  needs: string[];
  /** Shown only for a site that is a local business (Local, under Search). */
  localOnly?: boolean;
}

export interface NavGroup {
  key: string;
  label: string;
  icon: LucideIcon;
  /** A destination for the group itself (Settings is the only one); work groups have none. */
  path?: string;
  items: NavItem[];
}

export interface NavVisibility {
  /** Whether the current site is a local business. Local is hidden otherwise. */
  localBusiness?: boolean;
}

const ANYONE: string[] = [];

export const NAV: NavGroup[] = [
  {
    key: 'work',
    label: 'Work',
    icon: BriefcaseBusiness,
    items: [
      { path: '/', label: 'Home', icon: House, needs: ANYONE },
      { path: '/inbox', label: 'Inbox', icon: Inbox, needs: ANYONE },
      { path: '/agents', label: 'Agents', icon: Bot, needs: ANYONE },
    ],
  },
  {
    key: 'site-health',
    label: 'Site health',
    icon: HeartPulse,
    items: [
      { path: '/audits', label: 'Audits', icon: ScanSearch, needs: ANYONE },
      { path: '/issues', label: 'Issues', icon: TriangleAlert, needs: ANYONE },
      { path: '/performance', label: 'Performance', icon: Gauge, needs: ANYONE },
      { path: '/changes', label: 'Changes', icon: GitPullRequestArrow, needs: ANYONE },
    ],
  },
  {
    key: 'search',
    label: 'Search',
    icon: ChartNoAxesCombined,
    items: [
      { path: '/search/performance', label: 'Search performance', icon: ChartLine, needs: ANYONE },
      { path: '/search/opportunities', label: 'Opportunities', icon: Lightbulb, needs: ANYONE },
      { path: '/search/rankings', label: 'Rankings', icon: Trophy, needs: ANYONE },
      { path: '/search/ai-visibility', label: 'AI visibility', icon: ScanEye, needs: ANYONE },
      { path: '/search/local', label: 'Local', icon: MapPin, needs: ANYONE, localOnly: true },
    ],
  },
  {
    key: 'research',
    label: 'Research',
    icon: Telescope,
    items: [
      { path: '/research/keywords', label: 'Keywords', icon: Tags, needs: ANYONE },
      { path: '/research/competitors', label: 'Competitors', icon: Swords, needs: ANYONE },
      { path: '/research/serp', label: 'SERP explorer', icon: ListOrdered, needs: ANYONE },
      { path: '/research/backlinks', label: 'Backlinks', icon: Link2, needs: ANYONE },
    ],
  },
  {
    key: 'content',
    label: 'Content',
    icon: Files,
    items: [
      { path: '/content/briefs', label: 'Briefs', icon: NotebookPen, needs: ANYONE },
      { path: '/content/clusters', label: 'Clusters', icon: Network, needs: ANYONE },
      { path: '/content/reports', label: 'Reports', icon: FileChartColumn, needs: ANYONE },
    ],
  },
];

/**
 * Settings is pinned at the bottom of the shell, outside the collapsible work groups. Its children
 * are the secondary navigation (`ui/SettingsLayout.tsx`); they never appear in the main nav. The
 * gates follow the server's permission matrix: editing the site needs `sites:write`, workspace
 * configuration needs `workspace:admin`, and API tokens are the person's own account surface.
 */
export const SETTINGS_GROUP: NavGroup = {
  key: 'settings',
  label: 'Settings',
  path: '/settings',
  icon: Settings,
  items: [
    { path: '/settings/site', label: 'Site', icon: Building2, needs: ['sites:write'] },
    { path: '/settings/connections', label: 'Connections', icon: Cable, needs: ['workspace:admin'] },
    { path: '/settings/providers', label: 'Providers and budgets', icon: Plug, needs: ['workspace:admin'] },
    { path: '/settings/crawler-access', label: 'Crawler access', icon: Radar, needs: ['workspace:admin'] },
    { path: '/settings/users', label: 'Users and roles', icon: UsersRound, needs: ['workspace:admin'] },
    { path: '/settings/api-tokens', label: 'API tokens', icon: KeyRound, needs: ANYONE },
    {
      path: '/settings/approval-policy',
      label: 'Approval policy and agent autonomy',
      icon: ShieldCheck,
      needs: ['artifacts:read'],
    },
    { path: '/settings/usage', label: 'Usage', icon: ChartNoAxesColumn, needs: ['workspace:admin'] },
  ],
};

export const SETTINGS_ITEMS = SETTINGS_GROUP.items;

/** Whether this role may open the entry: one of its permissions is enough. */
export const canOpen = (item: NavItem, can: (p: string) => boolean) => !item.needs.length || item.needs.some(can);

const permitted = (item: NavItem, can: (p: string) => boolean, visibility: NavVisibility) =>
  canOpen(item, can) && (!item.localOnly || visibility.localBusiness === true);

/** The work groups this role and site can use, with empty groups removed. */
export function visibleNav(can: (p: string) => boolean, visibility: NavVisibility = {}): NavGroup[] {
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => permitted(i, can, visibility)) })).filter((g) => g.items.length > 0);
}

/** The Settings secondary items this role can open. */
export function visibleSettings(can: (p: string) => boolean): NavItem[] {
  return SETTINGS_ITEMS.filter((i) => canOpen(i, can));
}

/** The first page a role can open in Settings; API tokens is the fallback everyone reaches. */
export function settingsPath(can: (p: string) => boolean): string {
  return visibleSettings(can)[0]?.path ?? '/settings/api-tokens';
}

const matches = (itemPath: string, path: string) =>
  itemPath === '/' ? path === '/' : path === itemPath || path.startsWith(`${itemPath}/`);

/**
 * The group and item for a path, for breadcrumbs and the active state. Item prefix matching chooses
 * the longest path, so `/settings/providers/123` stays under its own entry rather than a sibling.
 */
export function navFor(path: string): { group?: NavGroup; item?: NavItem } {
  let best: { group: NavGroup; item: NavItem } | undefined;
  for (const group of [...NAV, SETTINGS_GROUP]) {
    for (const item of group.items) {
      if (!matches(item.path, path)) continue;
      if (!best || item.path.length > best.item.path.length) best = { group, item };
    }
  }
  if (best) return best;
  if (path === '/settings') return { group: SETTINGS_GROUP };
  return {};
}

/** The first main destination for a role. `/` itself is Home for every signed-in member. */
export function homePath(_can: (p: string) => boolean): string {
  return '/';
}
