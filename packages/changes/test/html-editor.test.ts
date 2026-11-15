import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderDiff } from '../src/diff';
import { applyHtmlEdit, findJsonLd } from '../src/editors/html';

const about = readFileSync(new URL('./fixtures/about.html', import.meta.url), 'utf8');

/** 1-based line numbers that differ between two documents. */
function changedLines(before: string, after: string): number[] {
  const left = before.split('\n');
  const right = after.split('\n');
  const changed: number[] = [];
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) if (left[index] !== right[index]) changed.push(index + 1);
  return changed;
}

function titleLine(document: string): string {
  const line = document.split('\n').find((candidate) => candidate.trim().startsWith('<title>'));
  if (!line) throw new Error('the fixture has no title line');
  return line;
}

const titleChange = (before: string, after: string) => ({
  type: 'meta.title' as const,
  url: 'https://martechsignal.com/about/',
  before,
  after,
});

describe('HTML editor: title', () => {
  it('replaces only the title text and leaves every other byte alone', () => {
    const result = applyHtmlEdit(about, titleChange('About | MartechSignal', 'About MartechSignal'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(titleLine(result.text)).toBe('<title>About MartechSignal</title>');
    expect(changedLines(about, result.text)).toEqual([6]);
    expect(result.text.replace('About MartechSignal</title>', 'About | MartechSignal</title>')).toBe(about);
  });

  it('refuses a before value the file no longer holds', () => {
    const result = applyHtmlEdit(about, titleChange('An older title', 'New title'));
    expect(result).toMatchObject({ ok: false, code: 'stale' });
  });

  it('entity-encodes the inserted text', () => {
    const result = applyHtmlEdit(about, titleChange('About | MartechSignal', 'A "quoted" & <tagged> title'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(titleLine(result.text)).toBe('<title>A &quot;quoted&quot; &amp; &lt;tagged&gt; title</title>');
  });

  it('is a no-op when the page already shows the new title', () => {
    const result = applyHtmlEdit(about, titleChange('About | MartechSignal', 'About MartechSignal'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const again = applyHtmlEdit(result.text, titleChange('About | MartechSignal', 'About MartechSignal'));
    expect(again).toMatchObject({ ok: true, changed: false });
  });

  it('refuses a document with two titles rather than guessing', () => {
    const duplicated = about.replace('<title>About | MartechSignal</title>', '<title>About | MartechSignal</title>\n<title>Second</title>');
    const result = applyHtmlEdit(duplicated, titleChange('About | MartechSignal', 'New'));
    expect(result).toMatchObject({ ok: false, code: 'ambiguous' });
  });

  it('refuses a document with no title', () => {
    const result = applyHtmlEdit('<html><head></head><body></body></html>', titleChange('old', 'new'));
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('keeps CRLF line endings', () => {
    const crlf = about.replace(/\n/g, '\r\n');
    const result = applyHtmlEdit(crlf, titleChange('About | MartechSignal', 'About us'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(/(?<!\r)\n/.test(result.text)).toBe(false);
    expect(result.text.split('\r\n').length).toBe(crlf.split('\r\n').length);
  });
});

describe('HTML editor: meta description', () => {
  it('replaces the content value in place', () => {
    const before =
      'Who runs MartechSignal, how tools are evaluated, and the editorial policy behind our AI marketing tool research. Independent, no sponsored rankings.';
    const result = applyHtmlEdit(about, {
      type: 'meta.description',
      url: 'https://martechsignal.com/about/',
      before,
      after: 'How MartechSignal reviews AI marketing tools: the method, the sources and the corrections policy.',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(changedLines(about, result.text)).toEqual([7]);
    expect(result.text).toContain(
      'content="How MartechSignal reviews AI marketing tools: the method, the sources and the corrections policy."',
    );
  });

  it('keeps single-quoted attributes single-quoted', () => {
    const document = "<html><head><title>x</title><meta name='description' content='old'></head></html>";
    const result = applyHtmlEdit(document, { type: 'meta.description', url: 'https://example.com/', before: 'old', after: 'new' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("content='new'");
  });

  it('inserts the tag when the page has none and the change says so with before null', () => {
    const document = '<html><head><title>x</title></head></html>';
    const result = applyHtmlEdit(document, {
      type: 'meta.description',
      url: 'https://example.com/',
      before: null,
      after: 'A new description',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('<html><head><title>x</title>\n<meta name="description" content="A new description"></head></html>');
  });

  it('refuses a non-null before when the file has no description', () => {
    const document = '<html><head><title>x</title></head></html>';
    const result = applyHtmlEdit(document, { type: 'meta.description', url: 'https://example.com/', before: 'old', after: 'new' });
    expect(result).toMatchObject({ ok: false, code: 'stale' });
  });

  it('refuses stale text', () => {
    const result = applyHtmlEdit(about, {
      type: 'meta.description',
      url: 'https://martechsignal.com/about/',
      before: 'something else',
      after: 'new',
    });
    expect(result).toMatchObject({ ok: false, code: 'stale' });
  });
});

describe('HTML editor: image alt', () => {
  it('replaces the alt of the one matching image', () => {
    const result = applyHtmlEdit(about, {
      type: 'image.alt',
      url: 'https://martechsignal.com/about/',
      src: '/assets/tim-christensen.webp',
      before: 'Tim Christensen at a desk',
      after: 'Tim Christensen, founder of MartechSignal, at his desk',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('alt="Tim Christensen, founder of MartechSignal, at his desk"');
    expect(changedLines(about, result.text)).toHaveLength(1);
  });

  it('matches an absolute src from PageFacts against a relative attribute', () => {
    const result = applyHtmlEdit(about, {
      type: 'image.alt',
      url: 'https://martechsignal.com/about/',
      src: 'https://martechsignal.com/assets/tim-christensen.webp',
      before: 'Tim Christensen at a desk',
      after: 'Tim Christensen at work',
    });
    expect(result.ok).toBe(true);
  });

  it('inserts an alt attribute when the image has none', () => {
    const result = applyHtmlEdit(about, {
      type: 'image.alt',
      url: 'https://martechsignal.com/about/',
      src: '/assets/og-default.png',
      before: null,
      after: 'MartechSignal social card',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('<img src="/assets/og-default.png" width="1200" height="630" alt="MartechSignal social card">');
  });

  it('refuses when the alt is not the one the change was drafted against', () => {
    const result = applyHtmlEdit(about, {
      type: 'image.alt',
      url: 'https://martechsignal.com/about/',
      src: '/assets/og-default.png',
      before: 'an alt it never had',
      after: 'new alt',
    });
    expect(result).toMatchObject({ ok: false, code: 'stale' });
  });

  it('refuses a src that matches no image', () => {
    const result = applyHtmlEdit(about, {
      type: 'image.alt',
      url: 'https://martechsignal.com/about/',
      src: '/assets/missing.png',
      before: null,
      after: 'alt',
    });
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('refuses a src that matches more than one image', () => {
    const duplicated = about.replace(
      '<img src="/assets/og-default.png"',
      '<img src="/assets/og-default.png" alt="first"><img src="/assets/og-default.png"',
    );
    const result = applyHtmlEdit(duplicated, {
      type: 'image.alt',
      url: 'https://martechsignal.com/about/',
      src: '/assets/og-default.png',
      before: null,
      after: 'alt',
    });
    expect(result).toMatchObject({ ok: false, code: 'ambiguous' });
  });
});

describe('HTML editor: image matching resolves the page URL', () => {
  const PAGE = 'https://martechsignal.com/blog/post/';
  const alt = (src: string, after = 'A picture') => ({
    type: 'image.alt' as const,
    url: PAGE,
    src,
    before: null,
    after,
  });
  const documentWith = (markup: string) => `<html><head><title>Post</title></head><body>${markup}</body></html>`;

  it('matches a relative src against the absolute URL the crawler records', () => {
    const result = applyHtmlEdit(documentWith('<img src="pic.png">'), alt('https://martechsignal.com/blog/post/pic.png'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('<img src="pic.png" alt="A picture">');
  });

  it('matches a root-relative src', () => {
    const result = applyHtmlEdit(documentWith('<img src="/assets/pic.png">'), alt('https://martechsignal.com/assets/pic.png'));
    expect(result.ok).toBe(true);
  });

  it('resolves against the document base href', () => {
    const document = '<html><head><base href="/assets/"><title>Post</title></head><body><img src="pic.png"></body></html>';
    const result = applyHtmlEdit(document, alt('https://martechsignal.com/assets/pic.png'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('<img src="pic.png" alt="A picture">');
  });

  it('uses the first <base> that has an href, not a <base target>', () => {
    const document =
      '<html><head><base target="_blank"><base href="https://cdn.example/assets/"><title>Post</title></head><body><img src="pic.png"></body></html>';
    const result = applyHtmlEdit(document, alt('https://cdn.example/assets/pic.png'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('<img src="pic.png" alt="A picture">');
    // The absolute URL the editor matched is carried for verification, which never sees <base>.
    expect(result.resolvedSrc).toBe('https://cdn.example/assets/pic.png');
  });

  it('treats an empty <base href=""> as the document URL, not as no base', () => {
    // The HTML spec takes the first <base> element with an href attribute; an empty value resolves
    // to the document URL, so the later <base href="/assets/"> must be ignored.
    const document = '<html><head><base href=""><base href="/assets/"><title>Post</title></head><body><img src="pic.png"></body></html>';
    const result = applyHtmlEdit(document, alt('https://martechsignal.com/blog/post/pic.png'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolvedSrc).toBe('https://martechsignal.com/blog/post/pic.png');
  });

  it('does not use a later <base href> when the first one is empty', () => {
    const document = '<html><head><base href=""><base href="/assets/"><title>Post</title></head><body><img src="pic.png"></body></html>';
    expect(applyHtmlEdit(document, alt('https://martechsignal.com/assets/pic.png'))).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  it('refuses a resolvedSrc that is not the URL it matched', () => {
    // A caller can carry the absolute URL of page B's image on page A's change. Trusting it would
    // match nothing here and verify the wrong page, so the editor refuses the mismatch.
    const result = applyHtmlEdit(documentWith('<img src="pic.png" alt="old">'), {
      ...alt('pic.png', 'new'),
      before: 'old',
      resolvedSrc: 'https://b.test/blog/post/pic.png',
    });
    expect(result).toMatchObject({ ok: false, code: 'stale' });
    if (result.ok) return;
    expect(result.reason).toContain('https://b.test/blog/post/pic.png');
    expect(result.reason).toContain('https://martechsignal.com/blog/post/pic.png');
  });

  it('accepts a resolvedSrc that is the URL it matched', () => {
    const result = applyHtmlEdit(documentWith('<img src="pic.png" alt="old">'), {
      ...alt('pic.png', 'new'),
      before: 'old',
      resolvedSrc: 'https://martechsignal.com/blog/post/pic.png',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('alt="new"');
  });

  it('does not match the same path on another host', () => {
    const result = applyHtmlEdit(
      documentWith('<img src="https://cdn.other.test/assets/pic.png">'),
      alt('https://martechsignal.com/assets/pic.png'),
    );
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
    if (result.ok) return;
    expect(result.details).toMatchObject({ url: 'https://martechsignal.com/assets/pic.png' });
  });

  it('does not match a src on another host that shares only a path', () => {
    const document = '<html><head><title>Post</title></head><body><img src="https://cdn.other.test/assets/pic.png"></body></html>';
    expect(applyHtmlEdit(document, alt('/assets/pic.png'))).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('falls back to the first srcset candidate when src is absent, as the crawler does', () => {
    const document = documentWith('<img srcset="pic-480.webp 480w, pic.webp 1200w" sizes="100vw">');
    const result = applyHtmlEdit(document, alt('https://martechsignal.com/blog/post/pic-480.webp'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('<img srcset="pic-480.webp 480w, pic.webp 1200w" sizes="100vw" alt="A picture">');
  });

  it('refuses a page URL that cannot resolve a relative src', () => {
    const result = applyHtmlEdit(documentWith('<img src="pic.png">'), { ...alt('/pic.png'), url: '/blog/post/' });
    expect(result).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('HTML editor: JSON-LD', () => {
  const aboutBlock = () => findJsonLd(about, { '@type': 'AboutPage' });

  it('adds a block after the last one, with two-space JSON and escaped </', () => {
    const result = applyHtmlEdit(about, {
      type: 'schema.jsonld',
      url: 'https://martechsignal.com/about/',
      operation: 'add',
      match: { '@type': 'FAQPage' },
      before: null,
      after: {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: [{ '@type': 'Question', name: 'Is </script> escaped?', acceptedAnswer: { '@type': 'Answer', text: 'Yes.' } }],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.match(/application\/ld\+json/g)).toHaveLength(2);
    expect(result.text).toContain('<\\/script>');
    const blocks = result.text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) ?? [];
    expect(blocks).toHaveLength(2);
    const added = JSON.parse(blocks[1]!.replace('<script type="application/ld+json">', '').replace(/<\/script>$/, ''));
    expect(added['@type']).toBe('FAQPage');
    expect(added.mainEntity[0].name).toBe('Is </script> escaped?');
    expect(result.text).toContain('\n  "@context"');
  });

  it('replaces the matching block and keeps the rest of the document byte-identical', () => {
    const found = aboutBlock();
    expect(found).not.toBeNull();
    const result = applyHtmlEdit(about, {
      type: 'schema.jsonld',
      url: 'https://martechsignal.com/about/',
      operation: 'replace',
      match: { '@type': 'AboutPage' },
      before: found!.hash,
      after: {
        '@context': 'https://schema.org',
        '@type': 'AboutPage',
        '@id': 'https://martechsignal.com/about/#webpage',
        name: 'About MartechSignal',
        url: 'https://martechsignal.com/about/',
        description: 'How we review AI marketing tools.',
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const replaced = findJsonLd(result.text, { '@type': 'AboutPage' });
    expect(replaced).not.toBeNull();
    expect(JSON.parse(replaced!.body)).toMatchObject({ name: 'About MartechSignal', description: 'How we review AI marketing tools.' });
    expect(result.text.slice(0, result.text.indexOf('<script type="application/ld+json">'))).toBe(
      about.slice(0, about.indexOf('<script type="application/ld+json">')),
    );
    expect(result.text.slice(result.text.indexOf('</script>', result.text.indexOf('application/ld+json')))).toContain('</head>\n<body>');
  });

  it('removes the matching block and the line it sits on', () => {
    const found = aboutBlock();
    const result = applyHtmlEdit(about, {
      type: 'schema.jsonld',
      url: 'https://martechsignal.com/about/',
      operation: 'remove',
      match: { '@type': 'AboutPage' },
      before: found!.hash,
      after: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain('application/ld+json');
    expect(result.text).toContain('</head>\n<body>');
    expect(changedLines(about, result.text).length).toBeGreaterThan(1);
    expect(result.text.split('\n').filter((line) => line.startsWith('<')).length).toBe(
      about.split('\n').filter((line) => line.startsWith('<')).length - 1,
    );
  });

  it('refuses a stale before hash', () => {
    const result = applyHtmlEdit(about, {
      type: 'schema.jsonld',
      url: 'https://martechsignal.com/about/',
      operation: 'replace',
      match: { '@type': 'AboutPage' },
      before: '0'.repeat(64),
      after: { '@type': 'AboutPage' },
    });
    expect(result).toMatchObject({ ok: false, code: 'stale' });
  });

  it('refuses adding a block whose selector already exists', () => {
    const result = applyHtmlEdit(about, {
      type: 'schema.jsonld',
      url: 'https://martechsignal.com/about/',
      operation: 'add',
      match: { '@type': 'AboutPage' },
      before: null,
      after: { '@type': 'AboutPage' },
    });
    expect(result).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('refuses a selector that matches more than one block', () => {
    const duplicated = about.replace(
      '</script>\n</head>',
      '</script>\n<script type="application/ld+json">{"@type":"AboutPage","@id":"https://martechsignal.com/about/#two"}</script>\n</head>',
    );
    const result = applyHtmlEdit(duplicated, {
      type: 'schema.jsonld',
      url: 'https://martechsignal.com/about/',
      operation: 'remove',
      match: { '@type': 'AboutPage' },
      before: '0'.repeat(64),
      after: null,
    });
    expect(result).toMatchObject({ ok: false, code: 'ambiguous' });
  });

  it('adds a block before </head> when the document has none', () => {
    const document = '<html><head><title>x</title></head><body></body></html>';
    const result = applyHtmlEdit(document, {
      type: 'schema.jsonld',
      url: 'https://example.com/',
      operation: 'add',
      match: { '@type': 'WebSite' },
      before: null,
      after: { '@context': 'https://schema.org', '@type': 'WebSite', name: 'x' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(
      '<html><head><title>x</title>\n<script type="application/ld+json">{\n  "@context": "https://schema.org",\n  "@type": "WebSite",\n  "name": "x"\n}</script></head><body></body></html>',
    );
  });

  it('writes a CRLF document with CRLF when adding a block', () => {
    const crlf = about.replace(/\n/g, '\r\n');
    const result = applyHtmlEdit(crlf, {
      type: 'schema.jsonld',
      url: 'https://martechsignal.com/about/',
      operation: 'add',
      match: { '@type': 'FAQPage' },
      before: null,
      after: { '@context': 'https://schema.org', '@type': 'FAQPage', name: 'Question & answer' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(/(?<!\r)\n/.test(result.text)).toBe(false);
    const added = result.text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)?.at(-1) ?? '';
    const body = added.replace('<script type="application/ld+json">', '').replace(/<\/script>$/, '');
    expect(body.includes('\r\n  "@context"')).toBe(true);
    expect(JSON.parse(body)['@type']).toBe('FAQPage');
  });

  it('writes a CRLF document with CRLF when replacing a block', () => {
    const crlf = about.replace(/\n/g, '\r\n');
    const found = findJsonLd(crlf, { '@type': 'AboutPage' });
    expect(found).not.toBeNull();
    const result = applyHtmlEdit(crlf, {
      type: 'schema.jsonld',
      url: 'https://martechsignal.com/about/',
      operation: 'replace',
      match: { '@type': 'AboutPage' },
      before: found!.hash,
      after: { '@context': 'https://schema.org', '@type': 'AboutPage', name: 'About us' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(/(?<!\r)\n/.test(result.text)).toBe(false);
    const replaced = findJsonLd(result.text, { '@type': 'AboutPage' });
    expect(JSON.parse(replaced!.body)).toMatchObject({ name: 'About us' });
  });

  it('refuses a block whose file hash is not the one the change was drafted against', () => {
    const result = applyHtmlEdit(about, {
      type: 'schema.jsonld',
      url: 'https://martechsignal.com/about/',
      operation: 'add',
      match: { '@type': 'FAQPage' },
      before: null,
      after: { '@type': 'FAQPage' },
      sourceHash: 'a'.repeat(64),
    });
    expect(result).toMatchObject({ ok: false, code: 'stale' });
  });
});

describe('HTML editor: review diff', () => {
  it('shows a one-line title edit as one addition and one deletion', () => {
    const result = applyHtmlEdit(about, titleChange('About | MartechSignal', 'About us'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const diff = renderDiff({ files: [{ path: 'about/index.html', before: about, after: result.text }] });
    expect(diff.files[0]).toMatchObject({ status: 'modified', additions: 1, deletions: 1 });
    expect(diff.files[0]!.unified).toContain('-<title>About | MartechSignal</title>');
    expect(diff.files[0]!.unified).toContain('+<title>About us</title>');
  });
});
