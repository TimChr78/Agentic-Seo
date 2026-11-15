import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Approval,
  type ApprovalDetail,
  type Audit,
  type AuditProgress,
  type AuditScore,
  type ChangeSetDetail,
  type ChangeSetStatus,
  createDemoApi,
  type GithubStatus,
  type Issue,
  type IssueDetail,
  type RecommendationDetail,
  type Site,
  setApiClient,
} from '../src/app/api';
import { CrumbsProvider } from '../src/app/page';
import { SessionContext, type SessionValue } from '../src/app/session';
import AuditPage from '../src/pages/AuditPage';
import AuditsPage from '../src/pages/AuditsPage';
import ChangePage from '../src/pages/ChangePage';
import ChangesPage from '../src/pages/ChangesPage';
import ConnectionsPage from '../src/pages/ConnectionsPage';
import InboxPage from '../src/pages/InboxPage';
import IssuePage from '../src/pages/IssuePage';
import IssuesPage from '../src/pages/IssuesPage';
import RecommendationPage from '../src/pages/RecommendationPage';
import RecommendationsPage from '../src/pages/RecommendationsPage';
import { ToastProvider } from '../src/ui/toast';

// The Phase 1 screens, one state at a time: what a list shows when it has rows, when it is empty and
// when the read failed; what a detail says before the tabs; and which actions a role is offered.

const SITE: Site = {
  id: 'site_martechsignal',
  name: 'MartechSignal',
  domain: 'martechsignal.com',
  faviconUrl: null,
  verified: true,
  isLocalBusiness: false,
  role: 'owner',
};

const OWNER = [
  'workspace:admin',
  'artifacts:read',
  'artifacts:write',
  'artifacts:approve',
  'artifacts:publish',
  'sites:read',
  'sites:write',
  'audits:run',
  'changes:apply',
  'audit:read',
];
const APPROVER = ['artifacts:read', 'artifacts:approve', 'sites:read', 'audit:read'];
const VIEWER = ['artifacts:read', 'sites:read'];

function session(permissions: string[] = OWNER, overrides: Partial<SessionValue> = {}): SessionValue {
  return {
    status: 'ready',
    user: { id: 'usr_1', name: 'Alex Rivera', email: 'alex@martechsignal.com' },
    workspace: { id: 'ws_1', name: 'Workspace', timeZone: 'UTC', role: 'owner', permissions, approvalPolicy: 'none' },
    sites: [SITE],
    site: SITE,
    can: (permission) => permissions.includes(permission),
    refresh: async () => {},
    switchSite: async () => {},
    createSite: async () => SITE,
    signOut: async () => {},
    signOutError: null,
    pending: 0,
    demo: false,
    ...overrides,
  };
}

function renderPage(ui: ReactElement, value: SessionValue = session()) {
  return render(
    <ToastProvider>
      <SessionContext.Provider value={value}>
        <CrumbsProvider onChange={() => {}}>{ui}</CrumbsProvider>
      </SessionContext.Provider>
    </ToastProvider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => setApiClient(null));

const AUDIT: Audit = {
  id: 'adt_0192f3c2b4a1',
  siteId: SITE.id,
  scope: 'site',
  section: null,
  urls: null,
  limits: { maxPages: 5_000, maxDepth: 10, maxDurationMs: 1_800_000 },
  renderMode: 'never',
  state: 'completed',
  stateReason: null,
  coverage: { scope: 'site', graph: 'complete', reasons: [], pagesCrawled: 3, pagesDiscovered: 3 },
  pagesCrawled: 3,
  pagesDiscovered: 3,
  pagesFailed: 0,
  requestedByType: 'user',
  requestedById: 'usr_1',
  startedAt: '2026-11-12T09:00:00.000Z',
  finishedAt: '2026-11-12T09:05:00.000Z',
  lastProgressAt: '2026-11-12T09:05:00.000Z',
  createdAt: '2026-11-12T08:59:00.000Z',
};

const RUNNING: Audit = { ...AUDIT, id: 'adt_running', state: 'running', pagesCrawled: 1_240, pagesDiscovered: 9_800, finishedAt: null };

const SCORE: AuditScore = {
  auditId: AUDIT.id,
  siteId: SITE.id,
  state: 'completed',
  score: 82,
  reason: null,
  categories: [
    { category: 'on_page', weight: 0.4, penalty: 6.5, contribution: 2.6, issues: 2, affectedPages: 3 },
    { category: 'structured_data', weight: 0.1, penalty: 0, contribution: 0, issues: 0, affectedPages: 0 },
  ],
  notEvaluated: [{ category: 'performance', reason: 'No renderer is configured.' }],
  skippedChecks: [{ checkId: 'perf.lcp', reason: 'Performance needs CrUX.' }],
  pagesEvaluated: 3,
  pagesCrawled: 3,
  uncheckedIssues: 4,
  gscWeighted: false,
  computedAt: '2026-11-12T09:05:10.000Z',
};

const ISSUE: Issue = {
  id: 'iss_0192f3c2b4a1',
  checkId: 'title.too_long',
  title: 'Page title is too long',
  category: 'on_page',
  severity: 'high',
  subject: 'https://martechsignal.com/pricing',
  state: 'open',
  regressed: 0,
  lastRegressedAt: null,
  affectedPages: 12,
  evaluatedPages: 120,
  evidenceTotal: 12,
  evidenceTruncated: false,
  clicks28d: null,
  firstSeenAuditId: AUDIT.id,
  lastSeenAuditId: AUDIT.id,
  lastCheckedAuditId: AUDIT.id,
  resolvedAuditId: null,
  ignored: null,
  createdAt: '2026-11-12T09:05:00.000Z',
  updatedAt: '2026-11-12T09:05:00.000Z',
};

const ISSUE_DETAIL: IssueDetail = {
  issue: { ...ISSUE, evidence: [] },
  check: {
    id: 'title.too_long',
    title: 'Page title is too long',
    category: 'on_page',
    severity: 'high',
    scope: 'page',
    evaluator: 'page',
    explain: 'A title longer than the pixel width search engines show is cut off in the result.',
    fix: { change: 'meta.title' },
    references: ['https://developers.google.com/search/docs/appearance/title-link'],
    definition: null,
    rules: [{ id: 'title.width', statement: 'Titles stay within 580 px.', source: 'Google documentation', reviewedAt: '2026-10-01' }],
  },
  history: [{ auditId: AUDIT.id, at: '2026-11-12T09:05:00.000Z', evidenceTotal: 12, evidenceItems: 12 }],
  pages: [
    { url: 'https://martechsignal.com/pricing', value: 'A very long title that is cut off', expected: 'At most 580 px', detail: null },
  ],
};

const RECOMMENDATION: RecommendationDetail = {
  id: 'rcm_0123456789abcdef0123456789abcdef',
  siteId: SITE.id,
  title: 'Shorten the pricing page titles',
  status: 'proposed',
  latestVersion: 2,
  publishedVersion: null,
  versionState: 'draft',
  trafficAtStakeComputedAt: '2026-11-12T09:05:00.000Z',
  priority: null,
  ownerAgentId: null,
  content: {
    rationale: 'Twelve titles are cut off in the result.',
    hypothesis: 'If we shorten them, the full title is shown.',
    evidence: [{ kind: 'issue', id: ISSUE.id, note: 'Twelve titles are too long.' }],
    expectedImpact: {
      summary: 'Expected: CTR +5–10% on 12 pages',
      confidence: 'medium',
      trafficAtStake: { kind: 'unknown', reason: 'Search Console is not connected.', computedAt: '2026-11-12T09:05:00.000Z' },
    },
    effort: 'small',
    dependsOn: [],
    verificationPlan: { recheck: 'Re-crawl the twelve pages.', when: '28 days after the deploy' },
    falsificationCheck: 'We will know this failed if CTR is unchanged after 28 days.',
    leadingIndicator: 'impressions-weighted CTR, daily',
    proposedChanges: [{ type: 'meta.title', url: 'https://martechsignal.com/pricing', summary: 'Shorten the title.' }],
    author: { kind: 'specialist', specialist: 'technical' },
  },
  evidence: [
    {
      kind: 'issue',
      id: ISSUE.id,
      note: 'Twelve titles are too long.',
      issue: {
        title: ISSUE.title,
        severity: 'high',
        category: 'on_page',
        state: 'open',
        affectedPages: 12,
        evaluatedPages: 120,
        affectedUrls: [],
        fixChange: 'meta.title',
      },
    },
  ],
  changeSets: [],
  updatedAt: '2026-11-13T09:00:00.000Z',
};

const CHANGE: ChangeSetDetail = {
  run: {
    artifactId: 'chg_0123456789abcdef0123456789abcdef',
    siteId: SITE.id,
    state: 'draft',
    approvedVersion: null,
    approvedHeadSha: null,
    approvalId: null,
    branch: null,
    prNumber: null,
    prUrl: null,
    headSha: null,
    mergeCommitSha: null,
    deployedSha: null,
    rollbackOf: null,
    rollbackChangeSetId: null,
    uncoveredChanges: [],
    verificationAttempts: 0,
    lastError: null,
    stateChangedAt: '2026-11-13T09:00:00.000Z',
    draftedAt: '2026-11-13T09:00:00.000Z',
    submittedAt: null,
    approvedAt: null,
    appliedAt: null,
    mergedAt: null,
    deployedAt: null,
    verifiedAt: null,
    closedAt: null,
    failedAt: null,
  },
  name: 'Shorten the pricing page titles',
  siteId: SITE.id,
  latestVersion: 1,
  publishedVersion: null,
  version: 1,
  content: {},
  changes: [
    {
      index: 0,
      type: 'meta.title',
      url: 'https://martechsignal.com/pricing',
      source: { path: 'pricing/index.html', editor: 'html', confidence: 'exact', affectedRoutes: ['/pricing'] },
      baseSha: 'a'.repeat(40),
      sourceHash: 'b'.repeat(64),
      additions: 1,
      deletions: 1,
      diff: '',
    },
  ],
};

const CHANGE_STATUS: ChangeSetStatus = {
  run: CHANGE.run,
  events: [
    {
      at: '2026-11-13T09:00:00.000Z',
      fromState: null,
      toState: 'draft',
      actor: { type: 'person', id: 'usr_1' },
      reason: 'Drafted 1 change.',
      evidence: {},
    },
  ],
  verification: { attempt: null, results: [] },
};

const APPROVAL: Approval = {
  id: 'apr_1',
  artifactId: CHANGE.run.artifactId,
  artifactName: CHANGE.name,
  artifactType: 'change_set',
  version: 1,
  status: 'pending',
  requestedBy: { type: 'user', id: 'usr_1', client: null },
  requester: { kind: 'person', displayName: 'Alex Rivera', personName: 'Alex Rivera', tokenName: null, tokenId: null, clientName: null },
  note: 'Shortens twelve titles, backed by the issue.',
  decidedBy: null,
  decisionNote: null,
  createdAt: '2026-11-13T09:10:00.000Z',
  holdUntil: null,
  artifactLatestVersion: 1,
  artifactPublishedVersion: null,
  reviewUrl: null,
  bundle: null,
};

const APPROVAL_DETAIL: ApprovalDetail = {
  ...APPROVAL,
  content: {},
  publishedContent: null,
  publishedVersion: null,
  diff: { from: null, to: 1, changes: [{ path: 'title', kind: 'changed', before: 'Old', after: 'New' }] },
  history: [],
};

const APPROVAL_B: Approval = {
  ...APPROVAL,
  id: 'apr_2',
  artifactId: 'chg_0123456789abcdef0123456789abcdef',
  artifactName: 'Rewrite the other title',
  note: 'A second request, with its own diff.',
};
const APPROVAL_DETAIL_B: ApprovalDetail = {
  ...APPROVAL_DETAIL,
  ...APPROVAL_B,
  diff: { from: null, to: 1, changes: [{ path: 'title', kind: 'changed', before: 'Old B', after: 'New B' }] },
};

const GITHUB_CONNECTION = {
  id: 'con_github',
  siteId: SITE.id,
  connector: 'github',
  label: 'GitHub pull request',
  settings: {},
  state: 'active' as const,
  lastError: null,
  tokenExpiresAt: null,
  createdAt: '2026-11-01T09:00:00.000Z',
};

const GITHUB_ACTIVE: GithubStatus = {
  connection: GITHUB_CONNECTION,
  repository: 'acme/site',
  baseBranch: 'main',
  deploy: { detector: 'version_file', detail: '/version.txt' },
  deployTimeoutHours: 48,
  hasToken: true,
  sourceRules: 2,
};

const GITHUB_REVOKED: GithubStatus = {
  connection: { ...GITHUB_CONNECTION, state: 'revoked' },
  repository: 'acme/site',
  baseBranch: 'main',
  deploy: { detector: 'version_file', detail: '/version.txt' },
  deployTimeoutHours: 48,
  hasToken: false,
  sourceRules: 2,
};

function apiWith(overrides: Partial<Record<string, unknown>> = {}) {
  const base = createDemoApi();
  return { ...base, ...(overrides as object) } as typeof base;
}

describe('the issues list', () => {
  it('shows the traffic it has and says No GSC when Search Console is absent', async () => {
    setApiClient(
      apiWith({
        listIssues: async () => ({
          issues: [ISSUE],
          nextCursor: null,
          summary: { open: 1, resolved: 0, ignored: 0, total: 1 },
          hasGsc: false,
        }),
      }),
    );
    renderPage(<IssuesPage />);
    // The template renders a table and a summary list; CSS shows one, the query sees both.
    expect((await screen.findAllByText('Page title is too long')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('No GSC').length).toBeGreaterThan(0);
    expect(screen.getByText('1 total · 1 open')).toBeTruthy();
    expect(screen.getAllByText('12 of 120').length).toBeGreaterThan(0);
  });

  it('passes the filters it is given to the command', async () => {
    const listIssues = vi.fn(async () => ({
      issues: [],
      nextCursor: null,
      summary: { open: 0, resolved: 0, ignored: 0, total: 0 },
      hasGsc: true,
    }));
    setApiClient(apiWith({ listIssues }));
    renderPage(<IssuesPage />);

    await userEvent.selectOptions(await screen.findByLabelText('Severity'), 'high');
    await waitFor(() => expect(listIssues).toHaveBeenCalledWith(expect.objectContaining({ severity: 'high', siteId: SITE.id })));
  });

  it('names what fills an empty list', async () => {
    renderPage(<IssuesPage />);
    expect(await screen.findByText('No issue has been found yet')).toBeTruthy();
    expect(screen.getByText(/An audit turns failing checks into issues/)).toBeTruthy();
  });

  it('keeps the server’s reason when the read fails, and Retry repeats it and recovers', async () => {
    let attempts = 0;
    setApiClient(
      apiWith({
        listIssues: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('The site has no audit yet.');
          return { issues: [ISSUE], nextCursor: null, summary: { open: 1, resolved: 0, ignored: 0, total: 1 }, hasGsc: false };
        },
      }),
    );
    renderPage(<IssuesPage />);
    expect(await screen.findByText('Couldn’t load the issues')).toBeTruthy();
    expect(screen.getByText('The site has no audit yet.')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect((await screen.findAllByText('Page title is too long')).length).toBeGreaterThan(0);
    expect(attempts).toBe(2);
  });

  it('marks an issue not re-checked only when a newer audit finished after its last check', async () => {
    const newer: Audit = { ...AUDIT, id: 'adt_newer', createdAt: '2026-11-14T09:00:00.000Z', finishedAt: '2026-11-14T09:05:00.000Z' };
    const listIssues = async () => ({
      issues: [ISSUE],
      nextCursor: null,
      summary: { open: 1, resolved: 0, ignored: 0, total: 1 },
      hasGsc: false,
    });
    setApiClient(apiWith({ listIssues, listAudits: async () => ({ rows: [newer], nextCursor: null }) }));
    const stale = renderPage(<IssuesPage />);
    expect((await screen.findAllByText('Not re-checked')).length).toBeGreaterThan(0);
    stale.unmount();

    // The newest finished audit is the one that checked it: the state is current, not stale.
    setApiClient(
      apiWith({ listIssues, listAudits: async () => ({ rows: [{ ...AUDIT, id: ISSUE.lastCheckedAuditId }], nextCursor: null }) }),
    );
    renderPage(<IssuesPage />);
    await screen.findAllByText('Page title is too long');
    expect(screen.queryByText('Not re-checked')).toBeNull();
  });
});

describe('the issue detail', () => {
  it('leads with the consequence and the pages with value versus expected', async () => {
    setApiClient(
      apiWith({
        getIssue: async () => ISSUE_DETAIL,
        listRecommendations: async () => ({ recommendations: [], total: 0, nextCursor: null }),
      }),
    );
    renderPage(<IssuePage issueId={ISSUE.id} />);

    expect(await screen.findByRole('heading', { level: 1, name: ISSUE.title })).toBeTruthy();
    expect(screen.getByText(/on 12 of 120 pages/)).toBeTruthy();
    expect(screen.getByText(/traffic unknown: Search Console is not connected/)).toBeTruthy();
    expect(await screen.findByText('A very long title that is cut off')).toBeTruthy();
    expect(screen.getByText('At most 580 px')).toBeTruthy();
  });

  it('shows the not-re-checked state on the detail from the newest finished audit', async () => {
    const newer: Audit = { ...AUDIT, id: 'adt_newer', createdAt: '2026-11-14T09:00:00.000Z', finishedAt: '2026-11-14T09:05:00.000Z' };
    setApiClient(
      apiWith({
        getIssue: async () => ISSUE_DETAIL,
        listAudits: async () => ({ rows: [newer], nextCursor: null }),
        listRecommendations: async () => ({ recommendations: [], total: 0, nextCursor: null }),
      }),
    );
    renderPage(<IssuePage issueId={ISSUE.id} />);
    expect(await screen.findByText('Not re-checked')).toBeTruthy();
  });

  it('prefills a recommendation with this issue as its evidence', async () => {
    const createRecommendation = vi.fn(async () => ({
      recommendationId: RECOMMENDATION.id,
      version: 1,
      state: 'draft' as const,
      status: 'proposed' as const,
      trafficAtStake: { kind: 'unknown' as const, reason: 'Search Console is not connected.', computedAt: '2026-11-12T09:05:00.000Z' },
      warnings: [],
    }));
    setApiClient(
      apiWith({
        getIssue: async () => ISSUE_DETAIL,
        listRecommendations: async () => ({ recommendations: [], total: 0, nextCursor: null }),
        createRecommendation,
      }),
    );
    renderPage(<IssuePage issueId={ISSUE.id} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Create recommendation' }));
    const dialog = screen.getByRole('dialog', { name: 'Create recommendation' });
    expect(dialog).toBeTruthy();
    expect((screen.getByLabelText(/^What to do/) as HTMLInputElement).value).toBe(ISSUE.title);

    await userEvent.type(screen.getByLabelText(/^Rationale/), 'Why now.');
    await userEvent.type(screen.getByLabelText(/^Hypothesis/), 'If we fix it, CTR rises.');
    await userEvent.type(screen.getByLabelText(/^Expected impact/), 'Expected: CTR +5%');
    await userEvent.type(screen.getByLabelText(/^What a re-fetch must show/), 'The title is short.');
    await userEvent.type(screen.getByLabelText(/^Falsification check/), 'CTR is unchanged.');
    await userEvent.type(screen.getByLabelText(/^Leading indicator/), 'CTR, daily');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create recommendation' }));

    await waitFor(() => expect(createRecommendation).toHaveBeenCalled());
    expect(createRecommendation).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: SITE.id, evidence: [expect.objectContaining({ kind: 'issue', id: ISSUE.id })] }),
    );
  });

  it('includes an optional proposed change from the create form', async () => {
    const createRecommendation = vi.fn(async () => ({
      recommendationId: RECOMMENDATION.id,
      version: 1,
      state: 'draft' as const,
      status: 'proposed' as const,
      trafficAtStake: { kind: 'unknown' as const, reason: 'Search Console is not connected.', computedAt: '2026-11-12T09:05:00.000Z' },
      warnings: [],
    }));
    setApiClient(
      apiWith({
        getIssue: async () => ISSUE_DETAIL,
        listRecommendations: async () => ({ recommendations: [], total: 0, nextCursor: null }),
        createRecommendation,
      }),
    );
    renderPage(<IssuePage issueId={ISSUE.id} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Create recommendation' }));
    const dialog = screen.getByRole('dialog', { name: 'Create recommendation' });
    await userEvent.type(within(dialog).getByLabelText(/^Rationale/), 'Why now.');
    await userEvent.type(within(dialog).getByLabelText(/^Hypothesis/), 'If we fix it, CTR rises.');
    await userEvent.type(within(dialog).getByLabelText(/^Expected impact/), 'Expected: CTR +5%');
    await userEvent.type(within(dialog).getByLabelText(/^What a re-fetch must show/), 'The title is short.');
    await userEvent.type(within(dialog).getByLabelText(/^Falsification check/), 'CTR is unchanged.');
    await userEvent.type(within(dialog).getByLabelText(/^Leading indicator/), 'CTR, daily');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add a proposed change' }));
    await userEvent.type(within(dialog).getByLabelText('Change 1 page URL'), 'https://martechsignal.com/pricing');
    await userEvent.type(within(dialog).getByLabelText('Change 1 summary'), 'Shorten the title.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create recommendation' }));

    await waitFor(() => expect(createRecommendation).toHaveBeenCalled());
    expect(createRecommendation).toHaveBeenCalledWith(
      expect.objectContaining({
        proposedChanges: [{ type: 'meta.title', url: 'https://martechsignal.com/pricing', summary: 'Shorten the title.' }],
      }),
    );
  });

  it('refuses an ignore without a reason and sends one with it', async () => {
    const ignoreIssue = vi.fn(async () => ({ issue: ISSUE }));
    setApiClient(
      apiWith({
        getIssue: async () => ISSUE_DETAIL,
        listRecommendations: async () => ({ recommendations: [], total: 0, nextCursor: null }),
        ignoreIssue,
      }),
    );
    renderPage(<IssuePage issueId={ISSUE.id} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Ignore' }));
    const ignore = screen.getByRole('button', { name: 'Ignore issue' });
    expect(ignore.hasAttribute('disabled')).toBe(true);
    await userEvent.type(screen.getByLabelText(/Why is this accepted/), 'The staging host is noindex on purpose.');
    await userEvent.click(ignore);
    await waitFor(() => expect(ignoreIssue).toHaveBeenCalledWith(ISSUE.id, 'The staging host is noindex on purpose.'));
  });

  it('does not offer a write a viewer cannot make', async () => {
    setApiClient(
      apiWith({
        getIssue: async () => ISSUE_DETAIL,
        listRecommendations: async () => ({ recommendations: [], total: 0, nextCursor: null }),
      }),
    );
    renderPage(<IssuePage issueId={ISSUE.id} />, session(VIEWER));

    const create = await screen.findByRole('button', { name: 'Create recommendation' });
    expect(create.hasAttribute('disabled')).toBe(true);
    expect(create.getAttribute('title')).toContain('Only editors');
    expect(screen.getByRole('button', { name: 'Ignore' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('the audits list', () => {
  it('refuses to run on an unverified site, with the reason', async () => {
    setApiClient(apiWith({ listAudits: async () => ({ rows: [], nextCursor: null }), getAuditScore: async () => SCORE }));
    renderPage(<AuditsPage />, session(OWNER, { site: { ...SITE, verified: false }, sites: [{ ...SITE, verified: false }] }));
    const run = await screen.findByRole('button', { name: 'Run audit' });
    expect(run.hasAttribute('disabled')).toBe(true);
    expect(run.getAttribute('title')).toContain('Verify ownership');
  });

  it('shows a running crawl as pages read of pages found, with no percentage', async () => {
    setApiClient(apiWith({ listAudits: async () => ({ rows: [RUNNING], nextCursor: null }), getAuditScore: async () => SCORE }));
    renderPage(<AuditsPage />);
    expect(await screen.findByText('Crawling · 1,240 of ≈ 9,800 pages')).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('names what a site without a run can do first', async () => {
    setApiClient(apiWith({ listAudits: async () => ({ rows: [], nextCursor: null }), getAuditScore: async () => SCORE }));
    renderPage(<AuditsPage />);
    expect(await screen.findByText('No audit has run for this site yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run the first audit' })).toBeTruthy();
  });
});

describe('the audit detail', () => {
  it('says what the score did not cover and how many issues were outside the run', async () => {
    const progress: AuditProgress = { audit: AUDIT, progress: { crawled: 3, discovered: 3, failed: 0, pending: 0, leased: 0, skipped: 0 } };
    setApiClient(
      apiWith({
        getAuditProgress: async () => progress,
        getAuditScore: async () => SCORE,
        listAuditFindings: async () => ({ rows: [], nextCursor: null }),
        listAuditPages: async () => ({ rows: [], nextCursor: null }),
      }),
    );
    renderPage(<AuditPage auditId={AUDIT.id} />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Site audit of 3 pages' })).toBeTruthy();
    // The score's categories are the catalogue's own; "performance" is not one of them, so the
    // skip reason is what the overview must show.
    expect(await screen.findByText(/Not evaluated: performance/)).toBeTruthy();
    expect(screen.getByText(/were outside this audit/)).toBeTruthy();
    expect(screen.getByText('perf.lcp')).toBeTruthy();
  });

  it('refetches the score when the polled run finishes', async () => {
    let progress: AuditProgress = {
      audit: RUNNING,
      progress: { crawled: 1_240, discovered: 9_800, failed: 0, pending: 8_560, leased: 0, skipped: 0 },
    };
    const getAuditScore = vi.fn(async () => {
      if (progress.audit.state !== 'completed') throw new Error('The audit has not finalized.');
      return SCORE;
    });
    setApiClient(
      apiWith({
        getAuditProgress: async () => progress,
        getAuditScore,
        listAuditFindings: async () => ({ rows: [], nextCursor: null }),
        listAuditPages: async () => ({ rows: [], nextCursor: null }),
      }),
    );
    // The poll interval is short here, so the test does not wait five seconds for the transition.
    renderPage(<AuditPage auditId={RUNNING.id} pollMs={20} />);
    expect(await screen.findByText('No score yet')).toBeTruthy();
    expect(getAuditScore).toHaveBeenCalledTimes(1);

    // The poll answers with the finished run; the score read runs again rather than staying on the
    // pre-completion error.
    progress = {
      audit: { ...AUDIT, id: RUNNING.id },
      progress: { crawled: 9_800, discovered: 9_800, failed: 0, pending: 0, leased: 0, skipped: 0 },
    };
    expect(await screen.findByText('/100', undefined, { timeout: 3_000 })).toBeTruthy();
    await waitFor(() => expect(getAuditScore.mock.calls.length).toBeGreaterThan(1));
  });

  it('does not call an empty finding list nothing to fix while running or after a failure', async () => {
    const running: AuditProgress = {
      audit: RUNNING,
      progress: { crawled: 1_240, discovered: 9_800, failed: 0, pending: 8_560, leased: 0, skipped: 0 },
    };
    setApiClient(
      apiWith({
        getAuditProgress: async () => running,
        getAuditScore: async () => {
          throw new Error('The audit has not finalized.');
        },
        listAuditFindings: async () => ({ rows: [], nextCursor: null }),
        listAuditPages: async () => ({ rows: [], nextCursor: null }),
      }),
    );
    const view = renderPage(<AuditPage auditId={RUNNING.id} />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Issues' }));
    expect(await screen.findByText('No findings yet')).toBeTruthy();
    expect(screen.queryByText('This run found nothing to fix')).toBeNull();
    view.unmount();

    const failed: Audit = { ...AUDIT, state: 'failed', stateReason: 'The crawl could not reach the site.' };
    setApiClient(
      apiWith({
        getAuditProgress: async () => ({
          audit: failed,
          progress: { crawled: 0, discovered: 0, failed: 0, pending: 0, leased: 0, skipped: 0 },
        }),
        getAuditScore: async () => {
          throw new Error('The audit did not finalize.');
        },
        listAuditFindings: async () => ({ rows: [], nextCursor: null }),
        listAuditPages: async () => ({ rows: [], nextCursor: null }),
      }),
    );
    renderPage(<AuditPage auditId={failed.id} />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Issues' }));
    expect(await screen.findByText('Findings are unavailable')).toBeTruthy();
    expect(screen.getAllByText(/The crawl could not reach the site/).length).toBeGreaterThan(0);
    expect(screen.queryByText('This run found nothing to fix')).toBeNull();
  });

  it('carries a partial run’s reason beside its state', async () => {
    const partial: Audit = { ...AUDIT, state: 'partial', stateReason: 'The crawl stopped at the time budget.' };
    setApiClient(
      apiWith({
        getAuditProgress: async () => ({
          audit: partial,
          progress: { crawled: 3, discovered: 3, failed: 0, pending: 0, leased: 0, skipped: 0 },
        }),
      }),
    );
    renderPage(<AuditPage auditId={AUDIT.id} />);
    expect(await screen.findByText('The crawl stopped at the time budget.')).toBeTruthy();
  });
});

describe('the recommendations', () => {
  it('offers Generate to an editor and not to an approver', async () => {
    setApiClient(apiWith({ listRecommendations: async () => ({ recommendations: [], total: 0, nextCursor: null }) }));
    const view = renderPage(<RecommendationsPage />);
    expect((await screen.findByRole('button', { name: 'Generate recommendations' })).hasAttribute('disabled')).toBe(false);
    view.unmount();

    renderPage(<RecommendationsPage />, session(APPROVER));
    expect((await screen.findByRole('button', { name: 'Generate recommendations' })).hasAttribute('disabled')).toBe(true);
  });

  it('shows the traffic as unknown with its reason, never as a zero', async () => {
    setApiClient(
      apiWith({
        getRecommendation: async () => RECOMMENDATION,
        listApprovals: async () => ({ approvals: [], total: 0, nextCursor: null }),
        getArtifactHistory: async () => [],
        listRecommendations: async () => ({ recommendations: [], total: 0, nextCursor: null }),
      }),
    );
    renderPage(<RecommendationPage recommendationId={RECOMMENDATION.id} />);

    expect(await screen.findByRole('heading', { level: 1, name: RECOMMENDATION.title })).toBeTruthy();
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Search Console is not connected.').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Expected:/).length).toBeGreaterThan(0);
    expect(screen.getByText('Pages touched: Unknown')).toBeTruthy();
    // When the estimate was made (it moves with Search Console data every day).
    expect(screen.getByText(/Traffic at stake computed .* from the Search Console data then available/)).toBeTruthy();
    expect(screen.getByText(/draft a change set from the proposed changes/)).toBeTruthy();
  });

  it('drafts a change set from an empty change list when the recommendation proposes none', async () => {
    const withoutProposed: RecommendationDetail = {
      ...RECOMMENDATION,
      content: { ...(RECOMMENDATION.content as Record<string, unknown>), proposedChanges: [] },
    };
    const createChangeSet = vi.fn(async () => ({
      created: true,
      changeSetId: null,
      version: 1,
      refusals: [],
      changes: [],
      next: '',
    }));
    setApiClient(
      apiWith({
        getRecommendation: async () => withoutProposed,
        listApprovals: async () => ({ approvals: [], total: 0, nextCursor: null }),
        getArtifactHistory: async () => [],
        listRecommendations: async () => ({ recommendations: [], total: 0, nextCursor: null }),
        createChangeSet,
      }),
    );
    renderPage(<RecommendationPage recommendationId={RECOMMENDATION.id} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Draft change set' }));
    const dialog = screen.getByRole('dialog', { name: 'Draft a change set' });
    await userEvent.type(within(dialog).getByLabelText(/^Page URL/), 'https://martechsignal.com/pricing');
    await userEvent.type(within(dialog).getByLabelText('Value now'), 'Old title');
    await userEvent.type(within(dialog).getByLabelText(/^Value to write/), 'New title');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Draft change set' }));

    await waitFor(() => expect(createChangeSet).toHaveBeenCalled());
    expect(createChangeSet).toHaveBeenCalledWith(
      expect.objectContaining({
        recommendationId: RECOMMENDATION.id,
        changes: [{ type: 'meta.title', url: 'https://martechsignal.com/pricing', before: 'Old title', after: 'New title' }],
      }),
    );
  });

  it('does not offer Draft change set to a role without artifacts:write', async () => {
    setApiClient(
      apiWith({
        getRecommendation: async () => RECOMMENDATION,
        listApprovals: async () => ({ approvals: [], total: 0, nextCursor: null }),
        getArtifactHistory: async () => [],
      }),
    );
    renderPage(<RecommendationPage recommendationId={RECOMMENDATION.id} />, session(APPROVER));
    const draft = await screen.findByRole('button', { name: 'Draft change set' });
    expect(draft.hasAttribute('disabled')).toBe(true);
    expect(draft.getAttribute('title')).toContain('Only editors');
  });
});

describe('the change sets', () => {
  it('lists a change set with its pull request and state', async () => {
    setApiClient(
      apiWith({
        listChangeSets: async () => ({
          changes: [{ ...CHANGE.run, state: 'pr_open', prNumber: 42, prUrl: 'https://github.com/acme/site/pull/42' }],
          total: 1,
          nextCursor: null,
        }),
        getChangeSet: async () => CHANGE,
      }),
    );
    renderPage(<ChangesPage />);
    expect((await screen.findAllByText('Shorten the pricing page titles')).length).toBeGreaterThan(0);
    expect(screen.getByText('#42')).toBeTruthy();
    expect(screen.getAllByText('PR open').length).toBeGreaterThan(0);
  });

  it('shows the pipeline, the diff per page and the connector', async () => {
    setApiClient(
      apiWith({
        getChangeSet: async () => CHANGE,
        getChangeSetStatus: async () => CHANGE_STATUS,
        getChangeSetDiff: async () => ({
          version: 1,
          files: [{ path: 'pricing/index.html', status: 'modified' as const, unified: '--- a\n+++ b\n', additions: 1, deletions: 1 }],
          urls: [{ url: 'https://martechsignal.com/pricing', changes: [{ type: 'meta.title', before: 'Old title', after: 'New title' }] }],
        }),
        getGithubStatus: async () => ({
          connection: null,
          repository: 'acme/site',
          baseBranch: 'main',
          deploy: { detector: 'version_file' as const, detail: '/version.txt' },
          deployTimeoutHours: 48,
          hasToken: true,
          sourceRules: 2,
        }),
        listApprovals: async () => ({ approvals: [], total: 0, nextCursor: null }),
      }),
    );
    renderPage(<ChangePage changeSetId={CHANGE.run.artifactId} />);

    expect(await screen.findByRole('heading', { level: 1, name: CHANGE.name })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Change set pipeline' })).toBeTruthy();
    expect(screen.getByText('GitHub · acme/site')).toBeTruthy();
    expect(await screen.findByText('Old title')).toBeTruthy();
    expect(screen.getByText('New title')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request apply' })).toBeTruthy();
  });

  it('counts the pages a change set touches, not its edits', async () => {
    const twoEdits: ChangeSetDetail = {
      ...CHANGE,
      changes: [CHANGE.changes[0]!, { ...CHANGE.changes[0]!, index: 1, type: 'meta.description', additions: 1, deletions: 1, diff: '' }],
    };
    setApiClient(
      apiWith({
        getChangeSet: async () => twoEdits,
        getChangeSetStatus: async () => CHANGE_STATUS,
        getChangeSetDiff: async () => ({ version: 1, files: [], urls: [] }),
        listApprovals: async () => ({ approvals: [], total: 0, nextCursor: null }),
      }),
    );
    renderPage(<ChangePage changeSetId={CHANGE.run.artifactId} />);
    expect(await screen.findByText('1 page touched')).toBeTruthy();
  });

  it('shows a secondary read’s error with Retry instead of loading forever', async () => {
    let diffAttempts = 0;
    setApiClient(
      apiWith({
        getChangeSet: async () => CHANGE,
        getChangeSetStatus: async () => {
          throw new Error('The status could not be read.');
        },
        getChangeSetDiff: async () => {
          diffAttempts += 1;
          if (diffAttempts === 1) throw new Error('The diff could not be read.');
          return {
            version: 1,
            files: [],
            urls: [
              { url: 'https://martechsignal.com/pricing', changes: [{ type: 'meta.title', before: 'Old title', after: 'New title' }] },
            ],
          };
        },
        listApprovals: async () => ({ approvals: [], total: 0, nextCursor: null }),
      }),
    );
    renderPage(<ChangePage changeSetId={CHANGE.run.artifactId} />);

    expect(await screen.findByText('Couldn’t load the diff')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('New title')).toBeTruthy();
    expect(diffAttempts).toBe(2);

    await userEvent.click(screen.getByRole('tab', { name: 'Verification' }));
    expect(await screen.findByText('Couldn’t load the verification')).toBeTruthy();
  });

  it('offers Apply to an approver as a read-only request, with the reason', async () => {
    setApiClient(
      apiWith({
        getChangeSet: async () => CHANGE,
        getChangeSetStatus: async () => CHANGE_STATUS,
        getChangeSetDiff: async () => ({ version: 1, files: [], urls: [] }),
        getGithubStatus: async () => ({
          connection: null,
          repository: 'acme/site',
          baseBranch: 'main',
          deploy: null,
          deployTimeoutHours: null,
          hasToken: false,
          sourceRules: 0,
        }),
        listApprovals: async () => ({ approvals: [APPROVAL], total: 1, nextCursor: null }),
      }),
    );
    renderPage(<ChangePage changeSetId={CHANGE.run.artifactId} />, session(APPROVER));

    const apply = await screen.findByRole('button', { name: 'Request apply' });
    expect(apply.hasAttribute('disabled')).toBe(true);
    // The approval bar is the approver's surface, and it names the policy in words.
    expect(await screen.findByText(/Policy:/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });
});

describe('the inbox', () => {
  it('lists the pending request and approves it', async () => {
    const approve = vi.fn(async () => ({
      status: 'approved' as const,
      artifactId: APPROVAL.artifactId,
      version: 1,
      published: [],
      reason: null,
    }));
    setApiClient(
      apiWith({
        listApprovals: async () => ({ approvals: [APPROVAL], total: 1, nextCursor: null }),
        getApproval: async () => APPROVAL_DETAIL,
        listRecommendations: async () => ({ recommendations: [], total: 0, nextCursor: null }),
        approve,
      }),
    );
    renderPage(<InboxPage />, session(APPROVER));

    expect(await screen.findByText(CHANGE.name)).toBeTruthy();
    expect(screen.getByText(/Version 1 of 1/)).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Review' })[0]!);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve and publish' }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith(APPROVAL.id, undefined));
  });

  it('withholds the previous request’s diff while another request loads', async () => {
    // B's read does not answer until the test says so; a stale A diff must not show in the meantime,
    // and no decision button may exist with B's id and A's content on screen.
    let resolveB: (detail: ApprovalDetail) => void = () => {};
    const b = new Promise<ApprovalDetail>((resolve) => {
      resolveB = resolve;
    });
    setApiClient(
      apiWith({
        listApprovals: async () => ({ approvals: [APPROVAL, APPROVAL_B], total: 2, nextCursor: null }),
        getApproval: async (id: string) => (id === APPROVAL.id ? APPROVAL_DETAIL : b),
        listRecommendations: async () => ({ recommendations: [], total: 0, nextCursor: null }),
      }),
    );
    renderPage(<InboxPage />, session(APPROVER));

    const reviews = await screen.findAllByRole('button', { name: 'Review' });
    await userEvent.click(reviews[0]!);
    expect(await screen.findByText('Old')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    await userEvent.click(reviews[1]!);
    expect(screen.queryByText('Old')).toBeNull();
    expect(screen.queryByText('New')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve and publish' })).toBeNull();
    expect(screen.getByText('Loading the request…')).toBeTruthy();

    await act(async () => {
      resolveB(APPROVAL_DETAIL_B);
    });
    expect(await screen.findByText('Old B')).toBeTruthy();
    expect(screen.queryByText('Old')).toBeNull();
  });

  it('names what will arrive when nothing is waiting', async () => {
    setApiClient(apiWith({ listRecommendations: async () => ({ recommendations: [], total: 0, nextCursor: null }) }));
    renderPage(<InboxPage />);
    expect(await screen.findByText('Nothing is waiting for you')).toBeTruthy();
    expect(screen.getByText(/When a change set is submitted for approval/)).toBeTruthy();
  });
});

describe('the connections screen', () => {
  it('says neither connection exists yet and offers both', async () => {
    renderPage(<ConnectionsPage />);
    expect(await screen.findByText('Google Search Console')).toBeTruthy();
    expect(screen.getAllByText('Not connected').length).toBe(2);
    expect(screen.getByRole('button', { name: 'Connect Search Console' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeTruthy();
  });

  it('refuses a mapping that is not JSON before it calls the server', async () => {
    const connectGithub = vi.fn();
    setApiClient(
      apiWith({
        getGithubStatus: async () => ({
          connection: null,
          repository: null,
          baseBranch: null,
          deploy: null,
          deployTimeoutHours: null,
          hasToken: false,
          sourceRules: 0,
        }),
        connectGithub,
      }),
    );
    renderPage(<ConnectionsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));
    await userEvent.type(screen.getByLabelText(/^Owner/), 'acme');
    await userEvent.type(screen.getByLabelText(/^Repository/), 'site');
    await userEvent.type(screen.getByLabelText(/^Personal access token/), 'ghp_0123456789012345678901');
    const mapping = screen.getByLabelText(/^Source mapping/);
    await userEvent.clear(mapping);
    await userEvent.type(mapping, 'not json');
    await userEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));

    expect(await screen.findByText(/The mapping is not valid JSON/)).toBeTruthy();
    expect(connectGithub).not.toHaveBeenCalled();
  });

  it('offers Connect, not Change settings, after a disconnect left the settings behind', async () => {
    setApiClient(apiWith({ getGithubStatus: async () => GITHUB_REVOKED }));
    renderPage(<ConnectionsPage />);

    // The stored repository alone is not a connection: the token is gone and update would refuse.
    expect(await screen.findByRole('button', { name: 'Connect GitHub' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change settings' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    const token = screen.getByLabelText(/^Personal access token/);
    expect(token).toBeTruthy();
    // The revoked settings are still a useful starting point for reconnecting.
    expect((screen.getByLabelText(/^Owner/) as HTMLInputElement).value).toBe('acme');
  });

  it('offers Change settings without a token field while the connection is active', async () => {
    setApiClient(apiWith({ getGithubStatus: async () => GITHUB_ACTIVE }));
    renderPage(<ConnectionsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Change settings' }));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
    expect(screen.queryByLabelText(/^Personal access token/)).toBeNull();
  });

  it('clears the token from state after a failed connect, keeping the other fields', async () => {
    const connectGithub = vi.fn(async () => {
      throw new Error('The token cannot read the repository.');
    });
    setApiClient(apiWith({ getGithubStatus: async () => ({ ...GITHUB_REVOKED, connection: null }), connectGithub }));
    renderPage(<ConnectionsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));
    // The stored repository prefills owner and repo; only the credential is typed.
    const token = screen.getByLabelText(/^Personal access token/);
    await userEvent.type(token, 'ghp_0123456789012345678901');
    await userEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));

    expect(await screen.findByText('The token cannot read the repository.')).toBeTruthy();
    expect((screen.getByLabelText(/^Personal access token/) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/^Owner/) as HTMLInputElement).value).toBe('acme');
    expect(connectGithub).toHaveBeenCalled();
  });

  it('hides the people-only actions from an agent and says why', async () => {
    setApiClient(
      apiWith({
        getSearchConsoleStatus: async () => ({ connection: null, property: null, datasets: [] }),
        getGithubStatus: async () => ({
          connection: null,
          repository: null,
          baseBranch: null,
          deploy: null,
          deployTimeoutHours: null,
          hasToken: false,
          sourceRules: 0,
        }),
      }),
    );
    renderPage(<ConnectionsPage />, session(OWNER, { agent: true }));
    const connect = await screen.findByRole('button', { name: 'Connect Search Console' });
    expect(connect.hasAttribute('disabled')).toBe(true);
    expect(connect.getAttribute('title')).toContain('An agent cannot change a connection');
  });
});
