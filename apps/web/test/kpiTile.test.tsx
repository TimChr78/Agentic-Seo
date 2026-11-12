import { cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { describeDelta, KpiTile } from '../src/ui/charts';

const toneOf = (text: RegExp) => screen.getByText(text).closest('p')?.className ?? '';

describe('KpiTile', () => {
  it('shows the value, period, denominator and freshness', () => {
    render(
      <KpiTile
        label="Clicks"
        value={1240}
        period="1–31 Oct 2026 · UTC"
        numerator={1240}
        denominator={12480}
        updatedAt={new Date().toISOString()}
      />,
    );
    expect(screen.getByText('Clicks')).toBeTruthy();
    expect(screen.getByText('1,240')).toBeTruthy();
    expect(screen.getByText('1–31 Oct 2026 · UTC')).toBeTruthy();
    expect(screen.getByText('1,240 / 12,480')).toBeTruthy();
    expect(screen.getByText('Updated just now')).toBeTruthy();
  });

  it('compares counts relatively and says when the direction is good', () => {
    render(<KpiTile label="Clicks" value={1240} previousValue={1103} favourableDirection="up" />);
    expect(screen.getByText('↑ 12.4% more')).toBeTruthy();
    expect(toneOf(/↑ 12\.4% more/)).toContain('text-good');
  });

  it('compares rates in percentage points and honours a favourable downward direction', () => {
    render(<KpiTile label="CTR" unit="%" value={28} previousValue={30} favourableDirection="down" />);
    expect(screen.getByText('↓ 2.0 pp lower')).toBeTruthy();
    expect(toneOf(/↓ 2\.0 pp lower/)).toContain('text-good');
  });

  it('marks a rise in a metric that should fall as bad', () => {
    render(<KpiTile label="Avg position" unit="%" value={32} previousValue={30} favourableDirection="down" />);
    expect(toneOf(/↑ 2\.0 pp higher/)).toContain('text-bad');
  });

  it('never divides by a zero baseline', () => {
    render(<KpiTile label="Conversions" value={12} previousValue={0} />);
    expect(screen.getByText('No comparable baseline')).toBeTruthy();
    expect(describeDelta({ value: 12, previousValue: 0 }).text).toBe('No comparable baseline');
  });

  it('says "No change" for an equal value', () => {
    render(<KpiTile label="Conversions" value={12} previousValue={12} />);
    expect(screen.getByText('No change')).toBeTruthy();
  });

  it('shows an em dash and no delta or sparkline when there is no data', () => {
    render(<KpiTile label="AI citations" value={null} sparkline={[1, 2, 3]} explanation="No prompts tracked in this period." />);
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByText('No prompts tracked in this period.')).toBeTruthy();
    expect(document.querySelector('svg[width="96"]')).toBeNull();
    expect(screen.queryByText(/No comparable baseline/)).toBeNull();
  });

  it('withholds a below-volume rate but keeps the threshold', () => {
    render(<KpiTile label="CTR" unit="%" value={38} numerator={38} denominator={100} dataState="below-volume" />);
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByText('Below evaluation volume · 38 / 100 required')).toBeTruthy();
    expect(document.querySelector('svg[width="96"]')).toBeNull();
  });

  it('never leaks a suppressed count through the denominator row', () => {
    render(
      <KpiTile
        label="Clicks"
        value={4}
        numerator={4}
        denominator={1200}
        dataState="suppressed"
        explanation="Suppressed · below the reporting threshold"
      />,
    );
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByText('Suppressed · below the reporting threshold')).toBeTruthy();
    expect(screen.queryByText('4 / 1,200')).toBeNull();
  });

  it('uses a same-height skeleton and aria-busy while loading', () => {
    const { container } = render(<KpiTile label="Clicks" value={null} dataState="loading" />);
    expect(container.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelectorAll('.as-skeleton').length).toBeGreaterThan(0);
    expect(screen.queryByText('—')).toBeNull();
  });

  it('never renders the epoch as freshness', () => {
    render(<KpiTile label="Clicks" value={1} updatedAt="1970-01-01T00:00:00.000Z" />);
    expect(screen.getByText('Updated time not available')).toBeTruthy();
    expect(screen.queryByText(/1970/)).toBeNull();
  });

  it('names event freshness as the latest event in the period when asked', () => {
    render(<KpiTile label="Clicks" value={1} updatedAt={new Date()} freshnessLabel="Latest event in period" />);
    expect(screen.getByText('Latest event in period just now')).toBeTruthy();
    cleanup();
    render(<KpiTile label="Clicks" value={1} updatedAt={null} freshnessLabel="Latest event in period" />);
    expect(screen.getByText('Latest event in period: unavailable')).toBeTruthy();
  });
});
