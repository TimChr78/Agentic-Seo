import { checkCommands, checksCatalogue, checksExplain } from '@agentic-seo/checks';
import { describe, expect, it } from 'vitest';

// The catalogue over the command layer: read-only, filtered, and precise enough for an agent to
// choose a check and explain a finding.

const ctx = {} as never;

describe('checks.catalogue', () => {
  it('lists the whole catalogue', async () => {
    const out = await checksCatalogue.handler({}, ctx);
    expect(out.checks.length).toBeGreaterThanOrEqual(40);
    expect(out.checks.find((check) => check.id === 'title.missing')).toMatchObject({
      category: 'on_page',
      severity: 'high',
      scope: 'page',
      evaluator: 'page',
      fix: { change: 'meta.title' },
    });
    for (const check of out.checks) {
      expect(check.explain.length).toBeGreaterThan(40);
      expect(check.references.length).toBeGreaterThan(0);
    }
  });

  it('filters by category, severity and evaluator', async () => {
    const onPage = await checksCatalogue.handler({ category: 'on_page' }, ctx);
    expect(onPage.checks.length).toBeGreaterThan(10);
    expect(onPage.checks.every((check) => check.category === 'on_page')).toBe(true);

    const critical = await checksCatalogue.handler({ severity: 'critical' }, ctx);
    expect(critical.checks.map((check) => check.id)).toEqual(['robots_txt.blocks_all']);

    const finalize = await checksCatalogue.handler({ evaluator: 'finalize' }, ctx);
    expect(finalize.checks.length).toBeGreaterThan(0);
    expect(finalize.checks.every((check) => check.evaluator === 'finalize')).toBe(true);
  });
});

describe('checks.explain', () => {
  it('returns one check with its freshness rules', async () => {
    const { check } = await checksExplain.handler({ checkId: 'schema.deprecated_type' }, ctx);
    expect(check).toMatchObject({ id: 'schema.deprecated_type', category: 'structured_data', definition: null });
    expect(check.rules.map((rule) => rule.id)).toContain('howto_rich_results_deprecated');
    expect(check.rules[0]?.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns the exact definition for a cross-page check', async () => {
    const { check } = await checksExplain.handler({ checkId: 'canonical.to_non_200' }, ctx);
    expect(check.evaluator).toBe('finalize');
    expect(check.definition).toMatch(/canonical/);
    expect(check.rules).toEqual([]);
  });

  it('refuses an unknown id and points at the catalogue', async () => {
    await expect(checksExplain.handler({ checkId: 'title.nope' }, ctx)).rejects.toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('checks.catalogue'),
    });
  });

  it('requires a check id', () => {
    expect(checksExplain.input.safeParse({}).success).toBe(false);
  });
});

describe('the check commands', () => {
  it('are read-only and need only the site read permission', () => {
    for (const command of checkCommands)
      expect(command, command.name).toMatchObject({ permission: 'sites:read', effect: 'read', actionClass: 'read' });
  });
});
