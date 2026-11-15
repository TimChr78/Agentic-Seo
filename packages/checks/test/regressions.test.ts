import { describe, expect, it } from 'vitest';
import { runPageChecks } from '../src';
import { pageFacts } from './fixtures';

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
