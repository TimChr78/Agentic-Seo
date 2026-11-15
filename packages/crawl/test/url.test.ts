import { describe, expect, it } from 'vitest';
import { isInternalUrl, isUnderSection, normalizeSection, normalizeUrl, pageId, sectionOf, siteHostsOf, snapshotId, urlHash } from '../src';

describe('normalizeUrl', () => {
  it('lower-cases scheme and host, drops the default port and the fragment, and keeps path and query', () => {
    expect(normalizeUrl('HTTPS://Example.COM:443/Path/To?B=2&a=1#frag')).toBe('https://example.com/Path/To?B=2&a=1');
    expect(normalizeUrl('http://example.com:80/')).toBe('http://example.com/');
    // A non-default port is part of the identity.
    expect(normalizeUrl('https://example.com:8443/x')).toBe('https://example.com:8443/x');
  });

  it('resolves relative URLs against a base and converts IDN hosts to punycode', () => {
    expect(normalizeUrl('../b?x=1', 'https://example.com/a/d/')).toBe('https://example.com/a/b?x=1');
    expect(normalizeUrl('https://bücher.example/')).toBe('https://xn--bcher-kva.example/');
  });

  it('refuses what the crawler cannot fetch: other schemes, credentials and malformed input', () => {
    for (const input of ['mailto:x@example.com', 'javascript:void(0)', 'ftp://example.com/', 'https://user:pass@example.com/', 'not a url'])
      expect(normalizeUrl(input)).toBeNull();
  });
});

describe('URL identity helpers', () => {
  it('hashes the normalised URL so two spellings of one page share a frontier row', () => {
    expect(urlHash(normalizeUrl('https://Example.com/a#x') as string)).toBe(urlHash('https://example.com/a'));
  });

  it('derives deterministic snapshot and page ids', () => {
    expect(snapshotId('adt_1', 'abc')).toMatch(/^snp_[0-9a-f]{32}$/);
    expect(snapshotId('adt_1', 'abc')).toBe(snapshotId('adt_1', 'abc'));
    expect(snapshotId('adt_1', 'abc')).not.toBe(snapshotId('adt_2', 'abc'));
    expect(pageId('site-1', 'https://example.com/')).toMatch(/^pag_[0-9a-f]{32}$/);
    expect(pageId('site-1', 'https://example.com/')).toBe(pageId('site-1', 'https://example.com/'));
  });

  it('reads the first path segment as the section and keeps one spelling of a prefix', () => {
    expect(sectionOf('https://example.com/blog/post')).toBe('/blog');
    expect(sectionOf('https://example.com/')).toBe('/');
    expect(sectionOf('https://example.com/robots.txt')).toBe('/robots.txt');
    expect(normalizeSection('blog/')).toBe('/blog');
    expect(normalizeSection('/blog/')).toBe('/blog');
    expect(normalizeSection('/')).toBe('/');
    expect(isUnderSection('https://example.com/blog/post', 'blog')).toBe(true);
    expect(isUnderSection('https://example.com/blog', '/blog')).toBe(true);
    expect(isUnderSection('https://example.com/blogger', '/blog')).toBe(false);
  });

  it('treats every host a site answers on as internal, and nothing else', () => {
    const hosts = siteHostsOf({ primaryDomain: 'example.com', hosts: ['www.example.com'] });
    expect(hosts).toEqual(['example.com', 'www.example.com']);
    expect(isInternalUrl('https://www.example.com/x', hosts)).toBe(true);
    expect(isInternalUrl('https://EXAMPLE.com./x', hosts)).toBe(true);
    expect(isInternalUrl('https://evil.example.com/x', hosts)).toBe(false);
    expect(isInternalUrl('https://example.com.evil.test/x', hosts)).toBe(false);
  });
});
