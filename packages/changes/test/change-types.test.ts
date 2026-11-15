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
