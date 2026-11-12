// What every destination that Phase 0 does not build yet will hold, and which phase delivers it.
// The copy is specific: a placeholder names its object, its job and the next real step. A later
// task replaces an entry by mounting its page on the same canonical path.

export interface PlannedDestination {
  title: string;
  description: string;
  /** The phase that delivers the screen. */
  phase: string;
  /** The sentence under the empty-state title. */
  body: string;
}

export const PLANNED: Record<string, PlannedDestination> = {
  '/inbox': {
    title: 'Inbox',
    description: 'Approvals, holds with veto windows, and recommendations waiting for a decision.',
    phase: 'Phase 1',
    body: 'Recommendations from the first audit arrive here with their evidence, expected effect and a decision. The thin loop that produces them is Phase 1.',
  },
  '/agents': {
    title: 'Agents',
    description: 'The specialist agents, their mandates, holds and activity ledger.',
    phase: 'Phase 6',
    body: 'Each specialist, its mandate and its outcomes appear here once the agent programme ships in Phase 6. Phase 0 only establishes agents as principals.',
  },
  '/audits': {
    title: 'Audits',
    description: 'Audit runs, their coverage and per-category scores.',
    phase: 'Phase 1',
    body: 'The first crawl and its checks arrive in Phase 1. Phase 2 adds the full audit detail: rendering, CrUX, drift and crawler access.',
  },
  '/issues': {
    title: 'Issues',
    description: 'Issues found by audits, with severity, affected pages and traffic at risk.',
    phase: 'Phase 1',
    body: 'An audit turns failing checks into issues here, with coverage-aware resolution and a link to the evidence. Phase 1 delivers the list and issue detail.',
  },
  '/performance': {
    title: 'Performance',
    description: 'Field and lab performance by template, with CrUX and PSI thresholds.',
    phase: 'Phase 2',
    body: 'Core Web Vitals per template, with the source and evaluation thresholds, arrive with the Google data work in Phase 2.',
  },
  '/changes': {
    title: 'Changes',
    description: 'Change sets from draft to verified outcome, with their verification and rollbacks.',
    phase: 'Phase 1',
    body: 'Approved recommendations become change sets with per-page diffs, a connector PR and a verification plan. Phase 1 delivers the pipeline and detail.',
  },
  '/search/performance': {
    title: 'Search performance',
    description: 'Clicks, impressions, CTR and position from Search Console, with coverage shown.',
    phase: 'Phase 2',
    body: 'Once Search Console is connected, this page answers how organic search performed by page and query. Phase 2 delivers the data and the screen.',
  },
  '/search/opportunities': {
    title: 'Opportunities',
    description: 'Detectors ranked by expected impact, with their evidence and confidence.',
    phase: 'Phase 2',
    body: 'Striking-distance, cannibalisation and CTR gap detectors arrive with outcome measurement in Phase 2. Each opportunity names its evidence, not just a score.',
  },
  '/search/rankings': {
    title: 'Rankings',
    description: 'Tracked keywords, position history and local grids.',
    phase: 'Phase 4',
    body: 'Trackers, their monthly cost and position distributions arrive in Phase 4, including local grids for businesses that have one.',
  },
  '/search/ai-visibility': {
    title: 'AI visibility',
    description: 'How often AI engines mention and cite the site, per prompt and engine.',
    phase: 'Phase 5',
    body: 'Share of voice, prompt tables and cited sources arrive in Phase 5. Answers come from engine APIs and can differ from what signed-in users see.',
  },
  '/search/local': {
    title: 'Local',
    description: 'The business profile, reviews and the local ranking grid.',
    phase: 'Phase 4',
    body: 'Business search, reviews, updates and geo-grid tracking arrive in Phase 4. This entry is hidden unless the site is a local business.',
  },
  '/research/keywords': {
    title: 'Keywords',
    description: 'Keyword research with volume, difficulty, CPC, intent and trend.',
    phase: 'Phase 3',
    body: 'A seed, a market and a cost estimate, then results with source labels. The DataForSEO adapter and this screen arrive in Phase 3.',
  },
  '/research/competitors': {
    title: 'Competitors',
    description: 'Domain gap, share of voice and content overlap with each competitor.',
    phase: 'Phase 3',
    body: 'The gap table and overlap bars arrive with the market research work in Phase 3. Research works for any domain, not only the current site.',
  },
  '/research/serp': {
    title: 'SERP explorer',
    description: 'A search result snapshot with its features, AI Overview citations and a date comparison.',
    phase: 'Phase 3',
    body: 'The result list mirrors the search page, including the AI Overview and its sources. Phase 3 delivers the snapshot and the comparison.',
  },
  '/research/backlinks': {
    title: 'Backlinks',
    description: 'Referring domains, new and lost links, and the source of each row.',
    phase: 'Phase 3',
    body: 'Backlink totals and the referring-domain table arrive in Phase 3, with DataForSEO, Common Crawl or Bing labelled on every row.',
  },
  '/content/briefs': {
    title: 'Briefs',
    description: 'Content briefs built from evidence, clusters and search intent.',
    phase: 'Phase 6',
    body: 'Briefs are an agent artifact: the outline, evidence and falsifiable expectations arrive with the content specialists in Phase 6.',
  },
  '/content/clusters': {
    title: 'Clusters',
    description: 'SERP-overlap clusters and the pillar pages that hold them together.',
    phase: 'Phase 3',
    body: 'Cluster candidates come from SERP overlap in Phase 3. Saving one as a content plan follows with the briefs in Phase 6.',
  },
  '/content/reports': {
    title: 'Reports',
    description: 'Reports an agent writes, with share links and their measurement window.',
    phase: 'Phase 6',
    body: 'Weekly and monthly reports, their evidence and share links arrive with the agent reporting work in Phase 6.',
  },
  '/settings/site': {
    title: 'Site',
    description: 'Site details, markets, competitors and ownership verification.',
    phase: 'Phase 0',
    body: 'The sites and verification task adds the editor here. Until it lands, the switcher shows what exists and Home tracks the checklist.',
  },
  '/settings/connections': {
    title: 'Connections',
    description: 'Search Console, GitHub and the other connectors a site can use.',
    phase: 'Phase 1',
    body: 'The Search Console property and the GitHub pull-request connector are configured here. Phase 1 delivers both ends of the thin loop.',
  },
  '/settings/providers': {
    title: 'Providers and budgets',
    description: 'The provider gateway, its budgets and the spending limits per action class.',
    phase: 'Phase 3',
    body: 'Provider keys, per-market routing and budget ceilings arrive with the market research work in Phase 3. Paid actions show their estimate before they run.',
  },
  '/settings/crawler-access': {
    title: 'Crawler access',
    description: 'Crawler identity, allowed paths, rate limits and render mode.',
    phase: 'Phase 2',
    body: 'How the crawler introduces itself and what it may fetch arrives with audit breadth in Phase 2.',
  },
  '/settings/users': {
    title: 'Users and roles',
    description: 'Workspace members, their roles and the permissions each role holds.',
    phase: 'Phase 0',
    body: 'Invitations and role changes are part of the authentication task in Phase 0. The shell already hides what a role cannot read.',
  },
  '/settings/api-tokens': {
    title: 'API tokens',
    description: 'Personal access tokens for the API and MCP, with their scopes and last use.',
    phase: 'Phase 0',
    body: 'Token creation and revocation belong to the MCP and OAuth task in Phase 0. Tokens never appear in logs or ordinary page text.',
  },
  '/settings/approval-policy': {
    title: 'Approval policy and agent autonomy',
    description: 'Which changes need approval, which roles may approve them and how much autonomy an agent has.',
    phase: 'Phase 7',
    body: 'Phase 1 keeps every change at L1 and shows the policy on the change set. The policy editor and autonomy beyond L1 arrive in Phase 7.',
  },
  '/settings/usage': {
    title: 'Usage',
    description: 'Provider spend, usage by action and the state of each budget.',
    phase: 'Phase 3',
    body: 'Every paid action leaves a cost record; this page totals them by provider, action and month from Phase 3.',
  },
};
