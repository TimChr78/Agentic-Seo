import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UrlCell } from '../src/ui/seo/evidence';
import { type PipelineStep, PipelineStrip } from '../src/ui/seo/PipelineStrip';
import { AuditStatePill, ChangeStatePill, IssueStatePill, RecommendationStatusPill, SeverityPill } from '../src/ui/seo/pills';
import { type Reach, TrafficAtRisk } from '../src/ui/seo/reach';

// The SEO components (DESIGN.md §5) are the only way their patterns are built, so their states are
// tested here once: the words, the tones, and the honest "unknown" that is never a zero.

const KNOWN: Reach = { kind: 'known', affectedUrls: 12, clicksAtRisk: 860, dataThrough: '2026-11-10' };

describe('the SEO state pills', () => {
  it('names every severity in words, critical included', () => {
    render(
      <div>
        <SeverityPill severity="critical" />
        <SeverityPill severity="high" />
        <SeverityPill severity="low" />
      </div>,
    );
    expect(screen.getByText('Critical')).toBeTruthy();
    expect(screen.getByText('High')).toBeTruthy();
    expect(screen.getByText('Low')).toBeTruthy();
  });

  it('reports a regressed issue as regressed, with the count available', () => {
    render(<IssueStatePill state="open" regressed={2} />);
    const pill = screen.getByText('Regressed');
    expect(pill).toBeTruthy();
    expect(pill.closest('span[title]')?.getAttribute('title')).toContain('Came back 2 times');
  });

  it('says an open issue was not re-checked when a later audit did not evaluate it', () => {
    render(<IssueStatePill state="open" unchecked />);
    expect(screen.getByText('Not re-checked')).toBeTruthy();
  });

  it('keeps an unknown state neutral and shows the server’s own word', () => {
    render(<AuditStatePill state="quarantined" />);
    expect(screen.getByText('quarantined')).toBeTruthy();
  });

  it('uses the pipeline words for each change state', () => {
    render(
      <div>
        <ChangeStatePill state="pr_open" />
        <ChangeStatePill state="verification_failed" />
        <RecommendationStatusPill status="implemented" />
      </div>,
    );
    expect(screen.getByText('PR open')).toBeTruthy();
    expect(screen.getByText('Verification failed')).toBeTruthy();
    expect(screen.getByText('Implemented')).toBeTruthy();
  });
});

describe('traffic at risk', () => {
  it('shows the number, its period and its source', () => {
    render(<TrafficAtRisk reach={KNOWN} />);
    expect(screen.getByText('860 clicks/28d')).toBeTruthy();
    expect(screen.getByText(/Search Console · data through/)).toBeTruthy();
  });

  it('says unknown with the reason instead of showing a zero', () => {
    render(<TrafficAtRisk reach={{ kind: 'unknown', reason: 'Search Console is not connected.' }} />);
    expect(screen.getByText('Unknown')).toBeTruthy();
    expect(screen.getByText('Search Console is not connected.')).toBeTruthy();
    expect(screen.queryByText(/0 clicks/)).toBeNull();
  });

  it('says the pages have no clicks rather than implying a measurement of zero', () => {
    render(<TrafficAtRisk reach={{ kind: 'known', affectedUrls: 3, clicksAtRisk: null }} />);
    expect(screen.getByText('No Search Console clicks')).toBeTruthy();
  });
});

describe('the pipeline strip', () => {
  it('names each step with its time and marks the current and failed steps', () => {
    const steps: PipelineStep[] = [
      { key: 'draft', label: 'Draft', state: 'done', at: '2026-11-12T09:00:00.000Z', actor: 'a person' },
      { key: 'approved', label: 'Approved', state: 'done', at: '2026-11-12T10:00:00.000Z', actor: 'a person' },
      { key: 'merged', label: 'Merged', state: 'current' },
      { key: 'verified', label: 'Verification failed', state: 'failed', detail: 'The title did not change.' },
    ];
    render(<PipelineStrip label="Change set pipeline" steps={steps} />);
    expect(screen.getByRole('list', { name: 'Change set pipeline' })).toBeTruthy();
    expect(screen.getByText('Draft')).toBeTruthy();
    expect(screen.getByText('Merged')).toBeTruthy();
    expect(screen.getByText('(current step)')).toBeTruthy();
    expect(screen.getByText('Verification failed')).toBeTruthy();
    expect(screen.getByText('The title did not change.')).toBeTruthy();
  });
});

describe('the URL cell', () => {
  it('shows the path, not the host, when the page is on the site’s own host', () => {
    render(<UrlCell url="https://martechsignal.com/pricing?plan=pro" siteHost="martechsignal.com" />);
    expect(screen.getByText('/pricing?plan=pro')).toBeTruthy();
  });

  it('shows the host when it differs, and keeps the full URL in the tooltip', () => {
    render(<UrlCell url="https://blog.martechsignal.com/post" siteHost="martechsignal.com" />);
    const link = screen.getByRole('link');
    expect(link.textContent).toContain('blog.martechsignal.com/post');
    expect(link.getAttribute('title')).toBe('https://blog.martechsignal.com/post');
  });
});
