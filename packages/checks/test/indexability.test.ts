import { describe, expect, it } from 'vitest';
import { indexability, isSameUrl, isValidHreflang, metaRobotsNoindex, pixelWidth, xRobotsDirectives, xRobotsNoindex } from '../src';
import { pageFacts } from './fixtures';

describe('indexability', () => {
  it('accepts a 200 HTML page with a self canonical and no noindex', () => {
    expect(indexability(pageFacts())).toEqual({ indexable: true, reasons: [] });
  });

  it('names every signal that keeps the page out of the index', () => {
    const page = pageFacts({
      status: 404,
      html: { metaRobots: ['noindex'], canonical: 'https://example.com/other' },
      headers: { xRobotsTag: 'noindex' },
    });
    const result = indexability(page);
    expect(result.indexable).toBe(false);
    expect(result.reasons).toHaveLength(4);
    expect(result.reasons.join(' ')).toMatch(/404/);
    expect(result.reasons.join(' ')).toMatch(/meta robots/);
    expect(result.reasons.join(' ')).toMatch(/X-Robots-Tag/);
    expect(result.reasons.join(' ')).toMatch(/canonical points at https:\/\/example.com\/other/);
  });

  it('treats a non-HTML response and a robots.txt disallow as not indexable', () => {
    expect(indexability(pageFacts({ html: null })).reasons.join(' ')).toMatch(/not an HTML document/);
    expect(indexability(pageFacts({ robotsAllowed: false })).reasons.join(' ')).toMatch(/robots.txt/);
  });

  it('accepts a canonical that differs only by normalisation', () => {
    expect(indexability(pageFacts({ html: { canonical: 'https://EXAMPLE.com:443/#top' } })).indexable).toBe(true);
  });
});

describe('X-Robots-Tag parsing', () => {
  it('parses unscoped and user-agent-scoped directives', () => {
    expect(xRobotsDirectives('noindex, nofollow')).toEqual([
      { userAgent: null, directive: 'noindex' },
      { userAgent: null, directive: 'nofollow' },
    ]);
    expect(xRobotsDirectives('googlebot: noindex, nofollow')).toEqual([
      { userAgent: 'googlebot', directive: 'noindex' },
      { userAgent: 'googlebot', directive: 'nofollow' },
    ]);
    expect(xRobotsDirectives('bingbot: noarchive')).toEqual([{ userAgent: 'bingbot', directive: 'noarchive' }]);
  });

  it('applies noindex to Googlebot and to every crawler, not to another bot', () => {
    expect(xRobotsNoindex('noindex')).toBe(true);
    expect(xRobotsNoindex('googlebot: noindex')).toBe(true);
    expect(xRobotsNoindex('none')).toBe(true);
    expect(xRobotsNoindex('bingbot: noindex')).toBe(false);
    expect(xRobotsNoindex(null)).toBe(false);
  });

  it('reads noindex and none from the meta robots tokens', () => {
    expect(metaRobotsNoindex(['noindex', 'follow'])).toBe(true);
    expect(metaRobotsNoindex(['none'])).toBe(true);
    expect(metaRobotsNoindex(['index', 'follow'])).toBe(false);
  });
});

describe('pixelWidth', () => {
  it('separates titles around Google’s 580 px limit', () => {
    expect(pixelWidth('a'.repeat(52))).toBeLessThan(580);
    expect(pixelWidth('a'.repeat(53))).toBeGreaterThan(580);
  });

  it('treats CJK characters as full width', () => {
    expect(pixelWidth('中'.repeat(30))).toBe(600);
  });

  it('uses the supplied font size, which descriptions need', () => {
    expect(pixelWidth('a'.repeat(100), 14)).toBeLessThan(pixelWidth('a'.repeat(100), 20));
  });
});

describe('isValidHreflang', () => {
  it('accepts BCP 47 language tags and x-default', () => {
    for (const code of ['en', 'en-GB', 'en-gb', 'zh-Hans', 'zh-Hans-CN', 'es-419', 'x-default'])
      expect(isValidHreflang(code), code).toBe(true);
  });

  it('refuses malformed codes and bare words', () => {
    for (const code of ['', 'e', 'english', 'en_US', 'en-', '-en', 'en-GB-extra', 'EN_gb']) expect(isValidHreflang(code), code).toBe(false);
  });
});

describe('isSameUrl', () => {
  it('ignores case in the host, the default port and the fragment', () => {
    expect(isSameUrl('https://Example.com:443/a#x', 'https://example.com/a')).toBe(true);
    expect(isSameUrl('https://example.com/a', 'https://example.com/a/')).toBe(false);
    expect(isSameUrl(null, 'https://example.com/')).toBe(false);
  });
});
