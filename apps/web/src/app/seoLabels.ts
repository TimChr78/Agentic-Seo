// The SEO words the screens share: a category, a severity and a state are written the same way in a
// filter, a column and a detail page. The values are the server's enums; the labels are the copy
// contract's sentence case.

export const ISSUE_CATEGORIES = [
  'crawlability',
  'indexability',
  'status_links',
  'on_page',
  'structured_data',
  'images',
  'security',
  'international',
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  crawlability: 'Crawlability',
  indexability: 'Indexability',
  status_links: 'Status and links',
  on_page: 'On-page',
  structured_data: 'Structured data',
  images: 'Images',
  security: 'Security',
  international: 'International',
};

export const categoryLabel = (category: string) => CATEGORY_LABELS[category] ?? category;

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export const severityLabel = (severity: string) => severity.charAt(0).toUpperCase() + severity.slice(1);

export const ISSUE_STATES = ['open', 'resolved', 'ignored'] as const;

export const AUDIT_STATES = ['queued', 'running', 'finalizing', 'completed', 'partial', 'failed', 'cancelled'] as const;

export const CHANGE_STATES = [
  'draft',
  'in_review',
  'approved',
  'applying',
  'pr_open',
  'merged',
  'deploying',
  'deployed',
  'verified',
  'verification_failed',
  'deploy_not_detected',
  'closed',
  'stale',
  'rolled_back',
  'superseded',
  'failed',
] as const;

export const RECOMMENDATION_STATUSES = ['proposed', 'accepted', 'implemented', 'rejected', 'measured'] as const;

/** The recommendation author filter the command accepts. */
export const RECOMMENDATION_AUTHORS = ['person', 'agent', 'specialist', 'strategist', 'technical'] as const;

const AUTHOR_LABELS: Record<string, string> = {
  person: 'A person',
  agent: 'An agent',
  specialist: 'A specialist',
  strategist: 'Strategist',
  technical: 'Technical',
};

export const authorLabel = (author: string) => AUTHOR_LABELS[author] ?? author;

export const effortLabel = (effort: string) => (effort === 'small' ? 'Small' : effort === 'medium' ? 'Medium' : 'Large');

/** Why a page's traffic figure may be missing. The server says null when Search Console is absent. */
export const NO_GSC = 'No GSC';
