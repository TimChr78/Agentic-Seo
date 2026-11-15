import { describe, expect, it } from 'vitest';
import { actionClassFor, ChangeSchema, changeTypeCatalogue, parseChange, urlOf } from '../src/change-types';
import { jsonLdTypes, matchesJsonLd, serialiseJsonLd, stableJson } from '../src/jsonld';
import { checkPageAgainst, expectedAfter } from '../src/verify';
import { pageFacts } from './support';

const titleChange = {
  type: 'meta.title' as const,
  url: 'https://example.com/about/',
  before: 'Old title',
  after: 'New title',
};

describe('change catalogue', () => {
  it('defines the Phase 1 types with an action class and a verification promise', () => {
    expect(changeTypeCatalogue.map((definition) => definition.type)).toEqual([
      'meta.title',
      'meta.description',
      'schema.jsonld',
      'image.alt',
      'redirect',
    ]);
    for (const definition of changeTypeCatalogue) {
      expect(definition.actionClass, definition.type).toBe(definition.type === 'redirect' ? 'site.structural' : 'site.content');
      expect(definition.verify.length).toBeGreaterThan(20);
      expect(definition.summary.length).toBeGreaterThan(20);
    }
  });

  it('exports a JSON Schema for every type', () => {
    for (const definition of changeTypeCatalogue) {
      expect(definition.jsonSchema.type, definition.type).toBe('object');
      const properties = definition.jsonSchema.properties as Record<string, unknown> | undefined;
      expect(properties?.type, definition.type).toBeDefined();
    }
  });

  it('reports the action class and the URL of a change', () => {
    const parsed = ChangeSchema.parse(titleChange);
    expect(actionClassFor(parsed)).toBe('site.content');
    expect(urlOf(parsed)).toBe('https://example.com/about/');
    const redirect = ChangeSchema.parse({ type: 'redirect', from: '/a/', to: '/b/', status: 301, operation: 'add' });
    expect(actionClassFor(redirect)).toBe('site.structural');
    expect(urlOf(redirect)).toBe('/a/');
  });

  it('accepts the valid shapes the editors consume', () => {
    expect(parseChange(titleChange).ok).toBe(true);
    expect(parseChange({ type: 'meta.description', url: 'https://example.com/', before: null, after: 'A description' }).ok).toBe(true);
    expect(
      parseChange({
        type: 'schema.jsonld',
        url: 'https://example.com/',
        operation: 'add',
        match: { '@type': 'FAQPage' },
        before: null,
        after: { '@type': 'FAQPage' },
      }).ok,
    ).toBe(true);
    expect(
      parseChange({
        type: 'redirect',
        from: '/old/',
        operation: 'remove',
        before: { to: '/new/', status: 301 },
      }).ok,
    ).toBe(true);
  });

  it('rejects a redirect without a status and a schema block with a stale shape', () => {
    expect(parseChange({ type: 'redirect', from: '/a/', to: '/b/', operation: 'add' }).ok).toBe(false);
    expect(
      parseChange({
        type: 'schema.jsonld',
        url: 'https://example.com/',
        operation: 'add',
        match: { '@type': 'FAQPage' },
        before: 'a'.repeat(64),
        after: { '@type': 'FAQPage' },
      }).ok,
    ).toBe(false);
    expect(parseChange({ type: 'meta.title', url: 'https://example.com/', before: 'x' }).ok).toBe(false);
  });

  it('rejects a redirect whose fields would write an extra rule', () => {
    const injection = parseChange({
      type: 'redirect',
      from: '/target/',
      to: '/target 301\n/admin https://evil.test 302\n#',
      status: 301,
      operation: 'add',
    });
    expect(injection).toMatchObject({ ok: false, code: 'invalid' });
    expect(parseChange({ type: 'redirect', from: '/a b/', to: '/c/', status: 301, operation: 'add' }).ok).toBe(false);
    expect(parseChange({ type: 'redirect', from: '/a/', to: 'javascript:alert(1)', status: 301, operation: 'add' }).ok).toBe(false);
    expect(
      parseChange({ type: 'redirect', from: '/a/', to: '/b/', status: 301, operation: 'update', before: { to: '/c d/', status: 301 } }).ok,
    ).toBe(false);
    expect(parseChange({ type: 'redirect', from: '/a/', to: 'https://example.com/b', status: 301, operation: 'add' }).ok).toBe(true);
  });

  it('accepts a fragment on the target but not on the source', () => {
    expect(parseChange({ type: 'redirect', from: '/old/', to: '/new/#section', status: 301, operation: 'add' }).ok).toBe(true);
    expect(parseChange({ type: 'redirect', from: '/old/', to: 'https://example.com/new#section', status: 301, operation: 'add' }).ok).toBe(
      true,
    );
    // A fragment on the source names no path, and ` #` is still a comment because of its whitespace.
    expect(parseChange({ type: 'redirect', from: '/old/#section', to: '/new/', status: 301, operation: 'add' }).ok).toBe(false);
    expect(parseChange({ type: 'redirect', from: '/old/', to: '/new/#section # a note', status: 301, operation: 'add' }).ok).toBe(false);
  });

  it('accepts a source hash on any content change and rejects a malformed one', () => {
    const hash = 'a'.repeat(64);
    expect(parseChange({ ...titleChange, sourceHash: hash }).ok).toBe(true);
    expect(parseChange({ ...titleChange, sourceHash: 'not-a-hash' }).ok).toBe(false);
  });
});

describe('expectedAfter', () => {
  it('describes each change type', () => {
    expect(expectedAfter(ChangeSchema.parse(titleChange))).toEqual({
      kind: 'meta.title',
      url: 'https://example.com/about/',
      value: 'New title',
    });
    expect(
      expectedAfter(
        ChangeSchema.parse({
          type: 'schema.jsonld',
          url: 'https://example.com/',
          operation: 'remove',
          match: { '@type': 'FAQPage' },
          before: 'a'.repeat(64),
          after: null,
        }),
      ),
    ).toMatchObject({ kind: 'schema.jsonld', present: false, value: null });
    expect(
      expectedAfter(ChangeSchema.parse({ type: 'redirect', from: '/old/', operation: 'remove', before: { to: '/new/', status: 301 } })),
    ).toEqual({ kind: 'redirect', from: '/old/', to: null, status: null });
  });
});

describe('checkPageAgainst', () => {
  it('verifies a title and a description', () => {
    const title = ChangeSchema.parse(titleChange);
    expect(checkPageAgainst(title, pageFacts({ html: { title: 'New title' } })).ok).toBe(true);
    expect(checkPageAgainst(title, pageFacts({ html: { title: 'Something else' } })).ok).toBe(false);
    expect(checkPageAgainst(title, pageFacts({ html: null })).ok).toBe(false);
    expect(checkPageAgainst(title, pageFacts({ status: 404 })).ok).toBe(false);

    const description = ChangeSchema.parse({
      type: 'meta.description',
      url: 'https://example.com/about/',
      before: 'old',
      after: 'new',
    });
    expect(checkPageAgainst(description, pageFacts({ html: { metaDescription: 'new' } })).ok).toBe(true);
    expect(checkPageAgainst(description, pageFacts({ html: { metaDescription: 'old' } })).ok).toBe(false);
  });

  it('verifies JSON-LD by parsed equality, not key order', () => {
    const change = ChangeSchema.parse({
      type: 'schema.jsonld',
      url: 'https://example.com/about/',
      operation: 'replace',
      match: { '@type': 'AboutPage' },
      before: 'a'.repeat(64),
      after: { '@context': 'https://schema.org', '@type': 'AboutPage', name: 'About' },
    });
    const parsed = { name: 'About', '@type': 'AboutPage', '@context': 'https://schema.org' };
    expect(checkPageAgainst(change, pageFacts({ html: { jsonLd: [{ raw: '{}', parsed, error: null, types: ['AboutPage'] }] } })).ok).toBe(
      true,
    );
    expect(checkPageAgainst(change, pageFacts({ html: { jsonLd: [] } })).ok).toBe(false);
  });

  it('verifies a removed JSON-LD block', () => {
    const change = ChangeSchema.parse({
      type: 'schema.jsonld',
      url: 'https://example.com/about/',
      operation: 'remove',
      match: { '@type': 'FAQPage' },
      before: 'a'.repeat(64),
      after: null,
    });
    expect(checkPageAgainst(change, pageFacts({ html: { jsonLd: [] } })).ok).toBe(true);
    expect(
      checkPageAgainst(
        change,
        pageFacts({ html: { jsonLd: [{ raw: '{}', parsed: { '@type': 'FAQPage' }, error: null, types: ['FAQPage'] }] } }),
      ).ok,
    ).toBe(false);
  });

  it('verifies an image alt against a relative or absolute src', () => {
    const change = ChangeSchema.parse({
      type: 'image.alt',
      url: 'https://example.com/about/',
      src: 'https://example.com/assets/a.png',
      before: null,
      after: 'A photo',
    });
    const image = { src: 'https://example.com/assets/a.png', alt: 'A photo', width: null, height: null, loading: null, inLink: false };
    expect(checkPageAgainst(change, pageFacts({ html: { images: [image] } })).ok).toBe(true);
    expect(checkPageAgainst(change, pageFacts({ html: { images: [{ ...image, alt: null }] } })).ok).toBe(false);
    expect(checkPageAgainst(change, pageFacts({ html: { images: [] } })).ok).toBe(false);
  });

  it('verifies a base-relative image src through the absolute src the editor resolved', () => {
    // The page's <base href="https://cdn.example/assets/"> makes `src="pic.png"` load
    // `https://cdn.example/assets/pic.png`, and the crawler records that. A change drafted with the
    // relative src carries the editor's absolute URL, so verification compares complete URLs
    // instead of resolving "pic.png" against the page and finding https://example.com/about/pic.png.
    const change = ChangeSchema.parse({
      type: 'image.alt',
      url: 'https://example.com/about/',
      src: 'pic.png',
      resolvedSrc: 'https://cdn.example/assets/pic.png',
      before: null,
      after: 'A photo',
    });
    expect(
      checkPageAgainst(
        change,
        pageFacts({
          html: {
            images: [
              { src: 'https://cdn.example/assets/pic.png', alt: 'A photo', width: null, height: null, loading: null, inLink: false },
            ],
          },
        }),
      ).ok,
    ).toBe(true);
  });

  it('verifies a redirect by status and Location', () => {
    const change = ChangeSchema.parse({ type: 'redirect', from: '/old/', to: '/new/', status: 301, operation: 'add' });
    const page = pageFacts({
      url: 'https://example.com/old/',
      finalUrl: 'https://example.com/new/',
      redirects: [{ url: 'https://example.com/old/', status: 301, location: 'https://example.com/new/' }],
    });
    expect(checkPageAgainst(change, page).ok).toBe(true);
    expect(checkPageAgainst(change, pageFacts({ redirects: [] })).ok).toBe(false);
    const wrongStatus = pageFacts({
      redirects: [{ url: 'https://example.com/old/', status: 302, location: 'https://example.com/new/' }],
    });
    expect(checkPageAgainst(change, wrongStatus).ok).toBe(false);
  });

  it('verifies that a removed redirect no longer redirects', () => {
    const change = ChangeSchema.parse({ type: 'redirect', from: '/old/', operation: 'remove', before: { to: '/new/', status: 301 } });
    expect(checkPageAgainst(change, pageFacts({ redirects: [] })).ok).toBe(true);
    const still = pageFacts({ redirects: [{ url: 'https://example.com/old/', status: 301, location: 'https://example.com/new/' }] });
    expect(checkPageAgainst(change, still).ok).toBe(false);
  });

  it('does not verify a removed redirect when the fetch did not complete', () => {
    const change = ChangeSchema.parse({ type: 'redirect', from: '/old/', operation: 'remove', before: { to: '/new/', status: 301 } });
    const failed = pageFacts({ status: 0, redirects: [], fetchError: 'connect ECONNREFUSED' });
    const check = checkPageAgainst(change, failed);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('unknown');
    expect(checkPageAgainst(change, pageFacts({ status: 0, redirects: [] })).ok).toBe(false);
  });
});

describe('JSON-LD helpers', () => {
  const block = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Person', '@id': 'https://example.com/#person' },
      { '@type': ['AboutPage', 'WebPage'], '@id': 'https://example.com/about/#page' },
      { nested: { '@type': 'Organization' } },
    ],
  };

  it('finds every type, including inside @graph and nested nodes', () => {
    expect(jsonLdTypes(block).sort()).toEqual(['AboutPage', 'Organization', 'Person', 'WebPage']);
  });

  it('matches by type, by id, and by both on the same node', () => {
    expect(matchesJsonLd(block, { '@type': 'WebPage' })).toBe(true);
    expect(matchesJsonLd(block, { '@id': 'https://example.com/about/#page' })).toBe(true);
    expect(matchesJsonLd(block, { '@type': 'Person', '@id': 'https://example.com/about/#page' })).toBe(false);
    expect(matchesJsonLd(block, { '@type': 'FAQPage' })).toBe(false);
  });

  it('serialises with two-space indentation and escapes </', () => {
    const text = serialiseJsonLd({ '@type': 'Thing', value: '</script>' });
    expect(text).toContain('\n  "@type"');
    expect(text).toContain('<\\/script>');
    expect(JSON.parse(text).value).toBe('</script>');
  });

  it('compares key order-insensitively', () => {
    expect(stableJson({ b: 1, a: 2 })).toBe(stableJson({ a: 2, b: 1 }));
  });
});
