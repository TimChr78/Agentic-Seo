import { describe, expect, it } from 'vitest';
import { checks, freshnessRules, ruleById } from '../src';

// Freshness rules are how a dated Google change becomes a visible judgement instead of a silent
// assumption. A malformed or future review date fails the build.

describe('freshness rules', () => {
  it('have unique ids and a statement, a source and a valid review date', () => {
    expect(new Set(freshnessRules.map((rule) => rule.id)).size).toBe(freshnessRules.length);
    for (const rule of freshnessRules) {
      expect(rule.statement.length, rule.id).toBeGreaterThan(40);
      expect(rule.source, rule.id).toMatch(/^https:\/\//);
      expect(rule.reviewedAt, rule.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const reviewed = new Date(`${rule.reviewedAt}T00:00:00Z`);
      expect(Number.isNaN(reviewed.getTime()), rule.id).toBe(false);
      expect(reviewed.toISOString().slice(0, 10), rule.id).toBe(rule.reviewedAt);
    }
  });

  it('never has a review date in the future', () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const rule of freshnessRules) expect(rule.reviewedAt <= today, rule.id).toBe(true);
  });

  it('is looked up by id', () => {
    expect(ruleById.get('faq_rich_results_retired')).toMatchObject({ reviewedAt: '2026-11-15' });
  });

  it('is the only source of the rule ids checks reference', () => {
    const referenced = new Set(checks.flatMap((check) => check.rules ?? []));
    for (const id of referenced) expect(ruleById.has(id), id).toBe(true);
  });
});
