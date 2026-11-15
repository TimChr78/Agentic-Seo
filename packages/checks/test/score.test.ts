import { describe, expect, it } from 'vitest';
import { computeScore, type ScoreIssue } from '../src';

// The health score's arithmetic (crawler-and-audits.md §6), tested on the pure function: no pages
// means no score, severity is monotonic, GSC clicks change the weight, and one category cannot zero
// the score.

const pages = (count: number): string[] => Array.from({ length: count }, (_, index) => `https://example.com/p${index + 1}`);

const issue = (overrides: Partial<ScoreIssue> = {}): ScoreIssue => ({
  category: 'indexability',
  severity: 'medium',
  affectedUrls: ['https://example.com/p1'],
  affectedPages: 1,
  ...overrides,
});

describe('the health score', () => {
  it('is null, with a reason, when no page was evaluated', () => {
    const result = computeScore({ issues: [], pages: [], clicks: null });
    expect(result.score).toBeNull();
    expect(result.reason).toMatch(/No page was evaluated/);
    expect(result.pagesEvaluated).toBe(0);
  });

  it('is 100 when pages were evaluated and nothing failed', () => {
    const result = computeScore({ issues: [], pages: pages(10), clicks: null });
    expect(result.score).toBe(100);
    expect(result.categories.find((category) => category.category === 'indexability')?.penalty).toBe(0);
  });

  it('falls monotonically as severity rises', () => {
    const scores = (['info', 'low', 'medium', 'high', 'critical'] as const).map(
      (severity) => computeScore({ issues: [issue({ severity })], pages: pages(2), clicks: null }).score as number,
    );
    for (let index = 1; index < scores.length; index += 1) expect(scores[index]).toBeLessThanOrEqual(scores[index - 1] as number);
    expect(scores.at(-1)).toBeLessThan(scores[0] as number);
  });

  it('caps a category, so one broken category cannot zero the score', () => {
    // A critical issue covering every evaluated page exhausts the category's cap.
    const all = pages(10);
    const result = computeScore({
      issues: [issue({ severity: 'critical', affectedUrls: all, affectedPages: all.length })],
      pages: all,
      clicks: null,
    });
    const category = result.categories.find((entry) => entry.category === 'indexability');
    expect(category?.penalty).toBe(100);
    expect(result.score).toBe(76);
  });

  it('weights a page by its GSC clicks: a low-traffic page costs less', () => {
    const visited = {
      issues: [issue({ severity: 'high', affectedUrls: ['https://example.com/a'], affectedPages: 1 })],
      pages: ['https://example.com/a', 'https://example.com/b'],
    };
    const unweighted = computeScore({ ...visited, clicks: null });
    const weighted = computeScore({
      ...visited,
      clicks: new Map([
        ['https://example.com/a', 10],
        ['https://example.com/b', 90],
      ]),
    });
    expect(unweighted.gscWeighted).toBe(false);
    expect(weighted.gscWeighted).toBe(true);
    expect(weighted.score as number).toBeGreaterThan(unweighted.score as number);
  });

  it('ignores a click map with no clicks and weights every page equally', () => {
    const result = computeScore({
      issues: [issue({ severity: 'high' })],
      pages: pages(2),
      clicks: new Map([
        ['https://example.com/p1', 0],
        ['https://example.com/p2', 0],
      ]),
    });
    expect(result.gscWeighted).toBe(false);
    expect(result.score).toBe(computeScore({ issues: [issue({ severity: 'high' })], pages: pages(2), clicks: null }).score);
  });

  it('sums the categories into one 0–100 score', () => {
    const result = computeScore({
      issues: [issue({ category: 'crawlability', severity: 'critical' }), issue({ category: 'on_page', severity: 'high' })],
      pages: pages(4),
      clicks: null,
    });
    const contributions = result.categories.reduce((sum, entry) => sum + entry.contribution, 0);
    expect(result.score).toBe(Math.max(0, Math.min(100, Math.round(100 - contributions))));
    expect(result.score as number).toBeGreaterThanOrEqual(0);
    expect(result.score as number).toBeLessThanOrEqual(100);
  });
});
