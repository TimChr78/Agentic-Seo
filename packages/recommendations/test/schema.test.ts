import { artifactTypes } from '@agentic-seo/artifacts';
import { CHANGE_TYPES } from '@agentic-seo/changes';
import { describe, expect, it } from 'vitest';

// The recommendation content schema (packages/artifacts): every author — a person writing one by
// hand as much as a specialist — must supply the synthesis fields, and the traffic at stake is a
// reach estimate, not a number someone typed.

const reach = {
  kind: 'known' as const,
  affectedUrls: 2,
  clicksAtRisk: 120,
  criticalPages: [],
  dataThrough: '2026-11-14',
  computedAt: '2026-11-15T09:00:00.000Z',
};

const valid = () => ({
  title: 'Rewrite the titles of 12 pages',
  rationale: 'The 12 pages this issue affects have no title, so the search snippet shows the URL.',
  evidence: [{ kind: 'issue' as const, id: 'iss_00000000000000000000000000000001', note: 'Titles are missing on 12 pages' }],
  hypothesis: 'If the pages carry a specific title, the snippet wins more clicks at the same position.',
  expectedImpact: { summary: 'Expected: more clicks on the 12 pages', trafficAtStake: reach, confidence: 'medium' as const },
  effort: 'small' as const,
  dependsOn: [],
  verificationPlan: { recheck: 'Re-fetch the 12 pages: each has a non-empty title', when: '7 days after the deploy' },
  falsificationCheck: 'We will know this failed if clicks do not move within 28 days.',
  leadingIndicator: 'Clicks on the 12 pages, daily',
  proposedChanges: [],
  author: { kind: 'person' as const },
});

const parse = (content: unknown) => artifactTypes.recommendation.content.safeParse(content);

const REQUIRED = [
  'title',
  'rationale',
  'evidence',
  'hypothesis',
  'expectedImpact',
  'effort',
  'verificationPlan',
  'falsificationCheck',
  'leadingIndicator',
  'author',
] as const;

describe('the recommendation content schema', () => {
  it('accepts a complete recommendation, authored by a person', () => {
    const parsed = parse(valid());
    expect(parsed.success).toBe(true);
  });

  it('refuses content that is missing any required field, whatever the author', () => {
    for (const author of [{ kind: 'person' }, { kind: 'agent' }, { kind: 'specialist', specialist: 'strategist' }] as const) {
      for (const field of REQUIRED) {
        const content = { ...valid(), author } as Record<string, unknown>;
        delete content[field];
        expect({ field, author: author.kind, ok: parse(content).success }).toEqual({ field, author: author.kind, ok: false });
      }
    }
  });

  it('refuses empty synthesis fields rather than accepting a blank', () => {
    for (const field of ['hypothesis', 'falsificationCheck', 'leadingIndicator', 'rationale'] as const) {
      expect({ field, ok: parse({ ...valid(), [field]: '   ' }).success }).toEqual({ field, ok: false });
    }
    expect(parse({ ...valid(), evidence: [] }).success).toBe(false);
    expect(parse({ ...valid(), verificationPlan: { recheck: '', when: '' } }).success).toBe(false);
  });

  it('refuses a rationale longer than 4,000 characters', () => {
    expect(parse({ ...valid(), rationale: 'x'.repeat(4001) }).success).toBe(false);
  });

  it('takes the traffic at stake as a reach estimate, never as one number', () => {
    expect(parse({ ...valid(), expectedImpact: { ...valid().expectedImpact, trafficAtStake: 120 } }).success).toBe(false);
    expect(
      parse({
        ...valid(),
        expectedImpact: {
          ...valid().expectedImpact,
          trafficAtStake: { kind: 'unknown', reason: 'Search Console is not connected', computedAt: '2026-11-15T09:00:00.000Z' },
        },
      }).success,
    ).toBe(true);
  });

  it('requires the traffic at stake to carry the date it was computed', () => {
    const undated: Record<string, unknown> = { ...reach };
    delete undated.computedAt;
    expect(parse({ ...valid(), expectedImpact: { ...valid().expectedImpact, trafficAtStake: undated } }).success).toBe(false);
    expect(
      parse({
        ...valid(),
        expectedImpact: { ...valid().expectedImpact, trafficAtStake: { kind: 'unknown', reason: 'Not connected' } },
      }).success,
    ).toBe(false);
  });

  it('makes a specialist author name which specialist it is', () => {
    expect(parse({ ...valid(), author: { kind: 'specialist' } }).success).toBe(false);
    expect(parse({ ...valid(), author: { kind: 'specialist', specialist: 'technical' } }).success).toBe(true);
  });

  it('allows exactly the Phase 1 change types in proposed changes', () => {
    for (const type of CHANGE_TYPES)
      expect({
        type,
        ok: parse({ ...valid(), proposedChanges: [{ type, url: 'https://example.com/a/', summary: 'Edit' }] }).success,
      }).toEqual({ type, ok: true });
    expect(
      parse({ ...valid(), proposedChanges: [{ type: 'content.patch', url: 'https://example.com/a/', summary: 'Edit' }] }).success,
    ).toBe(false);
  });

  it('refuses a dependency that is not a recommendation id', () => {
    expect(parse({ ...valid(), dependsOn: ['chg_00000000000000000000000000000000'] }).success).toBe(false);
  });
});
