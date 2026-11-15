import { describe, expect, it } from 'vitest';
import { checkById, runPageChecks, runSiteChecks } from '../src';
import { pageFacts, siteFacts } from './fixtures';

// Review findings on PR #17, one test each.

describe('structured data from the page cannot reach Object.prototype', () => {
  it('runs every page check on a JSON-LD @type named after an inherited property', () => {
    for (const type of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      const page = pageFacts({
        html: { jsonLd: [{ raw: `{"@type":"${type}"}`, parsed: { '@type': type }, error: null, types: [type] }] },
      });
      expect(() => runPageChecks(page), type).not.toThrow();
    }
  });
});

describe('an empty meta description', () => {
  it('fails description.too_short, while description.missing stays for an absent one', () => {
    const page = pageFacts({ html: { metaDescription: '', metaDescriptionCount: 1 } });
    const results = runPageChecks(page);
    expect(results.find((r) => r.checkId === 'description.too_short')?.outcome).toBe('fail');
    expect(results.find((r) => r.checkId === 'description.missing')?.outcome).toBe('pass');
  });
});

describe('image evidence', () => {
  it('carries no attribute selector built from the resolved src', () => {
    const page = pageFacts({
      html: { images: [{ src: 'https://example.com/photo.png', alt: null, width: null, height: null, loading: null, inLink: false }] },
    });
    const results = runPageChecks(page);
    for (const id of ['image.missing_alt', 'image.no_dimensions']) {
      const result = results.find((r) => r.checkId === id);
      expect(result?.outcome, id).toBe('fail');
      expect(result?.evidence.length, id).toBeGreaterThan(0);
      for (const item of result?.evidence ?? []) expect(item.selector, id).toBeUndefined();
    }
  });
});

describe('deeply nested JSON-LD (review round 2)', () => {
  it('does not overflow the stack and still finds the nested node', () => {
    let parsed: unknown = { '@type': 'Product' };
    for (let i = 0; i < 6000; i++) parsed = [parsed];
    const page = pageFacts({ html: { jsonLd: [{ raw: '[…]', parsed, error: null, types: ['Product'] }] } });
    const results = runPageChecks(page);
    expect(results.find((r) => r.checkId === 'schema.missing_required')?.outcome).toBe('fail');
  });
});

describe('robots_txt.blocks_all (review round 2)', () => {
  it('counts every crawler and Googlebot, not specialised or unrelated crawlers', () => {
    const outcome = (agents: string[]) =>
      runSiteChecks(siteFacts({ robotsTxt: { disallowAllFor: agents } })).find((r) => r.checkId === 'robots_txt.blocks_all')?.outcome;
    expect(outcome(['*'])).toBe('fail');
    expect(outcome(['googlebot'])).toBe('fail');
    for (const agent of ['googlebot-news', 'googlebot-image', 'notgooglebot', 'bingbot']) expect(outcome([agent]), agent).toBe('pass');
  });
});

describe('finalize definitions pin the corrected contracts (review round 2)', () => {
  const definitionOf = (id: string) => {
    const check = checkById(id);
    return check && 'definition' in check ? String(check.definition) : '';
  };
  it('finds redirecting targets by the requested URL’s redirect chain, not the final status', () => {
    for (const id of ['canonical.to_redirect', 'links.to_redirect']) {
      expect(definitionOf(id), id).toMatch(/requested URL/);
      expect(definitionOf(id), id).toMatch(/non-empty `redirects` chain/);
      expect(definitionOf(id), id).toMatch(/whatever the final status is/);
    }
  });
  it('ends a canonical walk at a self-canonical page and counts only non-self edges as cycles', () => {
    const definition = definitionOf('canonical.chain_or_cycle');
    expect(definition).toMatch(/declares itself canonical[^.]*ends the walk/);
    expect(definition).toMatch(/non-self edge/);
    expect(definition).toMatch(/\/a → \/b where \/b is self-canonical passes/);
  });
});
