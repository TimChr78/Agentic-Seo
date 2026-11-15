import { describe, expect, it } from 'vitest';
import { listTypes } from '../src/commands';
import { ARTIFACT_TYPES, artifactTypes } from '../src/types';

const ctx = {} as never;

describe('artifacts.types', () => {
  it('returns every SEO type without an argument', async () => {
    const out = await listTypes.handler({}, ctx);
    expect(out.types.map((t) => t.type)).toEqual(ARTIFACT_TYPES);
    expect(out.types.map((t) => t.type)).toEqual(
      expect.arrayContaining([
        'note',
        'site_context',
        'agent_mandate',
        'skill',
        'prompt',
        'recommendation',
        'change_set',
        'content_brief',
        'schema_template',
        'report',
        'report_template',
        'rank_tracker',
        'ai_visibility_tracker',
        'audit_profile',
        'hosted_agent',
      ]),
    );
  });

  it('reserves a unique id prefix per type', async () => {
    const prefixes = Object.values(artifactTypes).map((t) => t.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const prefix of prefixes) expect(prefix).toMatch(/^[a-z]{3}$/);
  });

  it('returns one type when given a type', async () => {
    const out = await listTypes.handler({ type: 'site_context' }, ctx);
    expect(out.types).toHaveLength(1);
    expect(out.types[0]?.type).toBe('site_context');
    const schema = out.types[0]?.contentSchema as { properties: Record<string, { description?: string }> };
    expect(schema.properties.businessOverview?.description).toMatch(/business does/);
  });

  it('rejects an unknown type and lists the valid names', () => {
    const parsed = listTypes.input.safeParse({ type: 'journey' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const message = parsed.error.issues[0]?.message ?? '';
    expect(message).toContain('Unknown artifact type');
    for (const type of ARTIFACT_TYPES) expect(message).toContain(type);
  });
});

describe('SEO artifact content', () => {
  it('validates a site context with sensible defaults', () => {
    const parsed = artifactTypes.site_context.content.safeParse({
      businessOverview: 'A SaaS that helps teams plan SEO work.',
      keyPages: [{ url: 'https://example.com/pricing', label: 'Pricing' }],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.currentGoal).toBe('');
    expect(parsed.data.competitors).toEqual([]);
    expect(parsed.data.keyPages[0]?.notes).toBe('');
  });

  it('refuses a placeholder type with the phase it arrives in', () => {
    const parsed = artifactTypes.schema_template.content.safeParse({ any: 'thing' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toBe('This artifact type arrives in Phase 1.');
  });

  it('validates a change set with resolved changes and their diffs', () => {
    const parsed = artifactTypes.change_set.content.safeParse({
      connector: 'github',
      title: 'Rewrite the about page title',
      summary: 'The title does not match the page.',
      changes: [
        {
          change: { type: 'meta.title', url: 'https://example.com/about/', before: 'Old', after: 'New' },
          source: { path: 'about/index.html', editor: 'html', confidence: 'exact', affectedRoutes: ['/about/'] },
          baseSha: 'a'.repeat(40),
          sourceHash: 'b'.repeat(64),
          diff: {
            path: 'about/index.html',
            status: 'modified',
            unified: '--- a/about/index.html\n+++ b/about/index.html\n',
            additions: 1,
            deletions: 1,
          },
        },
      ],
      verificationPlan: 'Re-fetch /about/ and check the title.',
      rollbackPlan: 'Revert the merge commit.',
    });
    expect(parsed.success).toBe(true);
    // A change set applies through one connector; anything else is refused, not stored.
    expect(
      artifactTypes.change_set.content.safeParse({
        connector: 'wordpress',
        title: 'x',
        summary: 'y',
        changes: [],
        verificationPlan: 'z',
        rollbackPlan: 'w',
      }).success,
    ).toBe(false);
  });

  it('keeps the mandate’s SEO action classes and limits', () => {
    const parsed = artifactTypes.agent_mandate.content.safeParse({
      agent: `agt_${'a'.repeat(32)}`,
      purpose: 'Keep the technical audit clean.',
      levels: { 'site.content': 2, 'site.structural': 1 },
      limits: { pagesPerChangeSet: 25, trafficAtRiskPerChangeSet: 500, changeSetsPerWeek: 5 },
      tripwires: ['verification.failed', 'gsc.clicks_on_changed_urls'],
      expires: '2027-02-12T00:00:00Z',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.levels).toEqual({ 'site.content': 2, 'site.structural': 1 });
    expect(parsed.data.limits.pagesPerChangeSet).toBe(25);
    expect(parsed.data.scope.sites).toEqual([]);
  });

  it('marks agent mandates and site context as people-only / singleton', () => {
    expect('peopleOnly' in artifactTypes.agent_mandate && artifactTypes.agent_mandate.peopleOnly).toBe(true);
    expect('singleton' in artifactTypes.site_context && artifactTypes.site_context.singleton).toBe(true);
    expect('singleton' in artifactTypes.note).toBe(false);
  });
});
