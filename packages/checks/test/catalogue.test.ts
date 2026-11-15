import { describe, expect, it } from 'vitest';
import {
  checkById,
  checkCategories,
  checkScopes,
  checks,
  evaluators,
  failedResults,
  finalizeChecks,
  fixChanges,
  ruleById,
  runPageChecks,
  runSiteChecks,
  severities,
} from '../src';
import { finalizeFixtures, pageFacts, pageFixtures, siteFacts, siteFixtures } from './fixtures';

// The catalogue's invariants: every check is identifiable, explained, referenced and fitted with a
// pass and a fail case, and the good default fixtures pass every check. A new check that skips any
// of this fails here rather than in production.

describe('the check catalogue', () => {
  it('has at least 40 checks, with unique dotted ids', () => {
    expect(checks.length).toBeGreaterThanOrEqual(40);
    const ids = checks.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/);
  });

  it('covers every category', () => {
    for (const category of checkCategories)
      expect(
        checks.some((check) => check.category === category),
        category,
      ).toBe(true);
  });

  it('gives every check a 2–4 sentence explanation, references and valid metadata', () => {
    for (const check of checks) {
      expect(checkCategories, check.id).toContain(check.category);
      expect(severities, check.id).toContain(check.severity);
      expect(checkScopes, check.id).toContain(check.scope);
      expect(evaluators, check.id).toContain(check.evaluator);
      expect(check.kind, check.id).toBe('deterministic');
      expect(check.references.length, check.id).toBeGreaterThan(0);
      for (const reference of check.references) expect(reference, check.id).toMatch(/^https:\/\//);
      const sentences = check.explain.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim() !== '');
      expect(sentences.length, check.id).toBeGreaterThanOrEqual(2);
      expect(sentences.length, check.id).toBeLessThanOrEqual(4);
      expect(check.explain, check.id).not.toMatch(/\b(oops|successfully)\b/i);
      if (check.fix) expect(fixChanges, check.id).toContain(check.fix.change);
      for (const rule of check.rules ?? []) expect(ruleById.has(rule), `${check.id} → ${rule}`).toBe(true);
    }
  });

  it('keeps scope, evaluator and the finalize definition consistent', () => {
    for (const check of checks) {
      if (check.evaluator === 'page') {
        expect(check.scope, check.id).toBe('page');
        expect(typeof check.run, check.id).toBe('function');
      } else if (check.evaluator === 'site') {
        expect(check.scope, check.id).toBe('site');
        expect(typeof check.run, check.id).toBe('function');
      } else {
        expect(check.scope, check.id).toBe('cross_page');
        expect('run' in check, check.id).toBe(false);
        expect(check.definition.length, check.id).toBeGreaterThan(80);
      }
      if (check.requiresCompleteGraph) expect(check.evaluator, check.id).toBe('finalize');
    }
    expect(finalizeChecks.length).toBeGreaterThan(0);
    expect(finalizeChecks).toHaveLength(checks.filter((check) => check.evaluator === 'finalize').length);
  });

  it('suppresses the graph checks when coverage is truncated', () => {
    for (const id of ['crawl.deep_page', 'crawl.orphan_page'])
      expect(checkById(id), id).toMatchObject({ evaluator: 'finalize', requiresCompleteGraph: true });
  });

  it('has a pass and a fail fixture for every check', () => {
    for (const check of checks) {
      if (check.evaluator === 'page') {
        const fixture = pageFixtures[check.id];
        expect(fixture, `${check.id} has no page fixtures`).toBeDefined();
        if (!fixture) continue;
        const passed = runPageChecks(fixture.pass).find((result) => result.checkId === check.id);
        expect(passed?.outcome, `${check.id} pass fixture`).toBe('pass');
        const failed = runPageChecks(fixture.fail).find((result) => result.checkId === check.id);
        expect(failed?.outcome, `${check.id} fail fixture`).toBe('fail');
        if (failed?.outcome !== 'fail') continue;
        expect(failed.evidence.length, `${check.id} fail fixture evidence`).toBeGreaterThan(0);
        expect(failed.total, `${check.id} fail fixture total`).toBeGreaterThanOrEqual(failed.evidence.length);
      } else if (check.evaluator === 'site') {
        const fixture = siteFixtures[check.id];
        expect(fixture, `${check.id} has no site fixtures`).toBeDefined();
        if (!fixture) continue;
        const passed = runSiteChecks(fixture.pass).find((result) => result.checkId === check.id);
        expect(passed?.outcome, `${check.id} pass fixture`).toBe('pass');
        const failed = runSiteChecks(fixture.fail).find((result) => result.checkId === check.id);
        expect(failed?.outcome, `${check.id} fail fixture`).toBe('fail');
        if (failed?.outcome !== 'fail') continue;
        expect(failed.evidence.length, `${check.id} fail fixture evidence`).toBeGreaterThan(0);
        expect(failed.total, `${check.id} fail fixture total`).toBeGreaterThanOrEqual(failed.evidence.length);
      } else {
        const fixture = finalizeFixtures[check.id];
        expect(fixture, `${check.id} has no finalize fixtures`).toBeDefined();
        expect(fixture?.pass.length, check.id).toBeGreaterThan(20);
        expect(fixture?.fail.length, check.id).toBeGreaterThan(20);
      }
    }
  });

  it('has no fixture for a check that does not exist', () => {
    const evaluatorOf = new Map(checks.map((check) => [check.id, check.evaluator]));
    for (const id of Object.keys(pageFixtures)) expect(evaluatorOf.get(id), id).toBe('page');
    for (const id of Object.keys(siteFixtures)) expect(evaluatorOf.get(id), id).toBe('site');
    for (const id of Object.keys(finalizeFixtures)) expect(evaluatorOf.get(id), id).toBe('finalize');
  });

  it('passes every check on the good default fixtures', () => {
    expect(failedResults(runPageChecks(pageFacts()))).toEqual([]);
    expect(failedResults(runSiteChecks(siteFacts()))).toEqual([]);
  });

  it('returns not-applicable results with a reason instead of dropping them', () => {
    const home = runPageChecks(pageFacts());
    expect(home.map((result) => result.checkId)).toEqual(
      expect.arrayContaining(checks.filter((check) => check.evaluator === 'page').map((check) => check.id)),
    );
    const thin = home.find((result) => result.checkId === 'content.thin');
    expect(thin).toMatchObject({ outcome: 'not_applicable' });
    expect(thin?.reason).toMatch(/does not apply/);

    const notHtml = runPageChecks(pageFacts({ status: 404, html: null }));
    expect(notHtml.find((result) => result.checkId === 'title.missing')).toMatchObject({ outcome: 'not_applicable' });
  });

  it('runs only page checks for pages and only site checks for sites', () => {
    expect(runPageChecks(pageFacts()).every((result) => result.evaluator === 'page')).toBe(true);
    expect(runSiteChecks(siteFacts()).every((result) => result.evaluator === 'site')).toBe(true);
  });

  it('caps evidence and reports the true total', () => {
    const images = Array.from({ length: 60 }, (_, index) => ({
      src: `https://example.com/${index}.png`,
      alt: null,
      width: '10',
      height: '10',
      loading: null,
      inLink: false,
    }));
    const check = checkById('image.missing_alt');
    if (!check) throw new Error('image.missing_alt is missing from the catalogue');
    expect(check.evaluator).toBe('page');
    if (check.evaluator !== 'page') return;
    const outcome = check.run(pageFacts({ html: { images } }));
    expect(outcome.outcome).toBe('fail');
    if (outcome.outcome !== 'fail') return;
    expect(outcome.evidence).toHaveLength(50);
    expect(outcome.total).toBe(60);
    expect(outcome.truncated).toBe(true);
  });

  it('looks a check up by id', () => {
    expect(checkById('title.missing')?.category).toBe('on_page');
    expect(checkById('does.not_exist')).toBeUndefined();
  });
});
