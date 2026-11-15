import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extractHtml } from '../src';
import { richPage } from './fixture';

const base = 'https://fixture.test:8443/rich';
const facts = extractHtml(richPage(), { baseUrl: base, hosts: ['fixture.test'] });

describe('extractHtml', () => {
  it('reads language, title and description with their counts', () => {
    expect(facts.lang).toBe('en-gb');
    expect(facts.title).toBe('Rich page');
    expect(facts.titleCount).toBe(2);
    expect(facts.metaDescription).toBe('First description');
    expect(facts.metaDescriptionCount).toBe(2);
  });

  it('splits robots directives from every robot meta tag', () => {
    expect(facts.metaRobots).toEqual(['index', 'follow', 'noindex']);
  });

  it('resolves canonicals against <base href> and marks one outside the head', () => {
    expect(facts.canonical).toBe('https://fixture.test:8443/deep/child');
    expect(facts.canonicals).toEqual(['https://fixture.test:8443/deep/child', 'https://fixture.test:8443/outside']);
    expect(facts.canonicalOutsideHead).toBe(true);
  });

  it('reads the document basics: viewport, charset, hreflang and headings', () => {
    expect(facts.viewport).toBe('width=device-width, initial-scale=1');
    expect(facts.charset).toBe('utf-8');
    expect(facts.hreflang).toEqual([{ lang: 'fr-fr', href: 'https://fixture.test:8443/fr' }]);
    expect(facts.headings).toEqual([
      { level: 1, text: 'Rich page' },
      { level: 2, text: 'Second' },
    ]);
  });

  it('keeps links with their rel, anchor text and internal flag; a non-http href is null', () => {
    expect(facts.links).toHaveLength(4);
    expect(facts.links[0]).toMatchObject({
      href: 'https://fixture.test:8443/deep/child',
      rel: [],
      text: 'Child link',
      internal: true,
    });
    expect(facts.links[1]).toMatchObject({
      href: 'https://fixture.test:8443/missing',
      rel: ['nofollow', 'sponsored'],
      text: 'Missing',
      internal: true,
    });
    expect(facts.links[2]).toMatchObject({ href: null, rawHref: 'mailto:x@example.com', text: 'Mail', internal: false });
    // An image-only anchor takes the image's alt as its text.
    expect(facts.links[3]).toMatchObject({ href: 'https://fixture.test:8443/deep/child', text: 'Alt text' });
  });

  it('distinguishes a missing alt from an empty one, and keeps dimensions, loading and srcset', () => {
    const [linked, onlyAlt, empty, missing, srcset, insecure] = facts.images;
    expect(linked).toMatchObject({ src: 'https://fixture.test:8443/deep/pic.png', alt: 'Picture', inLink: true });
    expect(onlyAlt).toMatchObject({ src: 'https://fixture.test:8443/deep/only-alt.png', alt: 'Alt text', inLink: true });
    expect(empty).toMatchObject({ alt: '' });
    expect(missing).toMatchObject({ alt: null });
    expect(srcset).toMatchObject({
      src: 'https://fixture.test:8443/deep/three-1.png',
      alt: 'Three',
      width: '10',
      height: '20',
      loading: 'lazy',
      inLink: false,
    });
    expect(insecure).toMatchObject({ src: 'http://plain.example/pic.png' });
  });

  it('parses JSON-LD, collecting types from @graph and nested nodes, and records a parse error', () => {
    expect(facts.jsonLd).toHaveLength(2);
    const [good, broken] = facts.jsonLd;
    expect(good?.error).toBeNull();
    expect(good?.raw).toContain('"@context"');
    expect(good?.types.sort()).toEqual(['Organization', 'SearchAction', 'WebSite']);
    expect(broken?.parsed).toBeNull();
    expect(broken?.error).toMatch(/JSON/i);
    expect(broken?.types).toEqual([]);
  });

  it('reads microdata types, Open Graph and Twitter cards, first value winning', () => {
    expect(facts.microdataTypes).toEqual(['https://schema.org/Article']);
    expect(facts.openGraph).toEqual({ 'og:title': 'Rich OG' });
    expect(facts.twitter).toEqual({ 'twitter:card': 'summary' });
  });

  it('counts only visible words and hashes the same normalised text', () => {
    expect(facts.wordCount).toBe(14);
    expect(facts.contentHash).toBe(
      createHash('sha256').update('Rich page Second Some visible words here for the counter. Child link Missing Mail').digest('hex'),
    );
  });

  it('records mixed content and insecure forms on an HTTPS page', () => {
    expect(facts.mixedContent).toEqual(['http://plain.example/pic.png', 'http://plain.example/app.js', 'http://plain.example/app.css']);
    expect(facts.insecureForms).toEqual(['http://plain.example/submit']);
  });

  it('does not feed script, style, noscript or template bodies into the text', () => {
    const plain = extractHtml(
      '<html><head><title>T</title></head><body><p>one two</p><script>three four</script><style>five six</style><noscript>seven</noscript><template>eight</template></body></html>',
      { baseUrl: 'https://example.com/', hosts: ['example.com'] },
    );
    expect(plain.wordCount).toBe(2);
  });

  it('keeps entity-decoded contiguous text as one word', () => {
    const plain = extractHtml('<html><body><p>AT&amp;T</p></body></html>', {
      baseUrl: 'https://example.com/',
      hosts: ['example.com'],
    });
    expect(plain.wordCount).toBe(1);
    expect(plain.contentHash).toBe(createHash('sha256').update('AT&T').digest('hex'));
  });

  it('produces the same text facts whatever chunk size the parser is fed', () => {
    // Every text fact — title, description, headings, anchor text, visible words and the hash — and
    // everything derived from them must not depend on where the parser's callbacks fall. A separator
    // inserted at a callback boundary shows up here.
    const context = { baseUrl: base, hosts: ['fixture.test'] };
    const whole = extractHtml(richPage(), { ...context, chunkSize: 64 * 1024 });
    for (const chunkSize of [1, 7]) {
      expect(extractHtml(richPage(), { ...context, chunkSize })).toEqual(whole);
    }
  });

  it('keeps a title split across text callbacks as one word', () => {
    const html = '<html><head><title>AT&amp;T</title></head><body><h2>AT&amp;T</h2><a href="/x">AT&amp;T</a></body></html>';
    const context = { baseUrl: 'https://example.com/', hosts: ['example.com'] };
    const whole = extractHtml(html, { ...context, chunkSize: 64 * 1024 });
    expect(whole.title).toBe('AT&T');
    expect(whole.headings).toEqual([{ level: 2, text: 'AT&T' }]);
    expect(whole.links[0]?.text).toBe('AT&T');
    expect(extractHtml(html, { ...context, chunkSize: 1 })).toEqual(whole);
    expect(extractHtml(html, { ...context, chunkSize: 7 })).toEqual(whole);
  });

  it('collects microdata from elements the extractor handles specially', () => {
    const factsWithMicrodata = extractHtml(
      '<html><body><img src="/x.png" itemtype="https://schema.org/ImageObject"><form action="/y" itemtype="https://schema.org/ContactPoint"></form><a href="/z" itemtype="https://schema.org/Person">Z</a><meta itemprop="name" content="n" itemtype="https://schema.org/Thing"></body></html>',
      { baseUrl: 'https://example.com/', hosts: ['example.com'] },
    );
    expect(factsWithMicrodata.microdataTypes).toEqual([
      'https://schema.org/ImageObject',
      'https://schema.org/ContactPoint',
      'https://schema.org/Person',
      'https://schema.org/Thing',
    ]);
  });

  it('caps links and images and flags the truncation', () => {
    const links = Array.from({ length: 5_001 }, (_, index) => `<a href="/l/${index}">x</a>`).join('');
    const images = Array.from({ length: 1_001 }, (_, index) => `<img src="/i/${index}.png">`).join('');
    const capped = extractHtml(`<html><body>${links}${images}</body></html>`, {
      baseUrl: 'https://example.com/',
      hosts: ['example.com'],
    });
    expect(capped.links).toHaveLength(5_000);
    expect(capped.linksTruncated).toBe(true);
    expect(capped.images).toHaveLength(1_000);
    expect(capped.imagesTruncated).toBe(true);

    const small = extractHtml('<html><body><a href="/one">one</a><img src="/one.png"></body></html>', {
      baseUrl: 'https://example.com/',
      hosts: ['example.com'],
    });
    expect(small.linksTruncated).toBeUndefined();
    expect(small.imagesTruncated).toBeUndefined();
  });
});
