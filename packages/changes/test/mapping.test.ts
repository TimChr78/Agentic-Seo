import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { globPrefix, parseMapping, pathMatchesGlob, resolveLayout, resolveRedirects, resolveSource, routeMatches } from '../src/mapping';

const mappingJson = readFileSync(new URL('../examples/martechsignal.mapping.json', import.meta.url), 'utf8');
const parsed = parseMapping(JSON.parse(mappingJson));
if (!parsed.ok) throw new Error(`the example mapping does not parse: ${parsed.reason}`);
const mapping = parsed.mapping;

const files = [
  'index.html',
  'about/index.html',
  'authors/tim-christensen/index.html',
  'blog/claude-seo-benchmark/index.html',
  'content/drafts/claude-seo-benchmark-2026-09-27.md',
  'content/drafts/other-post-2026-01-01.md',
  'sitemap.xml',
  'tools/nocobase/index.html',
];

const listFiles = async (prefix: string) => files.filter((file) => file.startsWith(prefix));

describe('source mapping: the pilot', () => {
  it('resolves the home page to the repository root', async () => {
    const result = await resolveSource(mapping, '/', { listFiles });
    expect(result).toMatchObject({ ok: true, path: 'index.html', editor: 'html', confidence: 'exact', affectedRoutes: ['/'] });
  });

  it('resolves a static page exactly', async () => {
    const result = await resolveSource(mapping, 'https://martechsignal.com/about/', { listFiles });
    expect(result).toMatchObject({ ok: true, path: 'about/index.html', editor: 'html', confidence: 'exact', affectedRoutes: ['/about/'] });
  });

  it('resolves a blog route through the dated draft glob', async () => {
    const result = await resolveSource(mapping, '/blog/claude-seo-benchmark/', { listFiles, changeType: 'meta.title' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe('content/drafts/claude-seo-benchmark-2026-09-27.md');
    expect(result.editor).toBe('markdown_frontmatter');
    expect(result.confidence).toBe('glob');
    expect(result.fields.title).toEqual(['seo_title', 'title']);
    expect(result.fields.description).toEqual(['seo_description']);
    expect(result.affectedRoutes).toEqual(['/blog/claude-seo-benchmark/']);
  });

  it('refuses a generated tool page with the reason and the build script to edit', async () => {
    const result = await resolveSource(mapping, '/tools/nocobase/', { listFiles });
    expect(result).toMatchObject({ ok: false, code: 'unsupported' });
    if (result.ok) return;
    expect(result.reason).toContain('tools/build_tools.py');
    expect(result.details).toMatchObject({ generated: true, path: 'tools/nocobase/index.html' });
  });

  it('refuses a blog route with no matching draft file', async () => {
    const result = await resolveSource(mapping, '/blog/no-such-post/', { listFiles });
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('refuses an ambiguous dated draft', async () => {
    const ambiguous = async (prefix: string) =>
      [...files, 'content/drafts/claude-seo-benchmark-2026-10-01.md'].filter((file) => file.startsWith(prefix));
    const result = await resolveSource(mapping, '/blog/claude-seo-benchmark/', { listFiles: ambiguous });
    expect(result).toMatchObject({ ok: false, code: 'ambiguous' });
    if (result.ok) return;
    expect(result.details).toMatchObject({ candidates: expect.arrayContaining(['content/drafts/claude-seo-benchmark-2026-10-01.md']) });
  });

  it('refuses JSON-LD on a frontmatter source and names the build template', async () => {
    const result = await resolveSource(mapping, '/blog/claude-seo-benchmark/', { listFiles, changeType: 'schema.jsonld' });
    expect(result).toMatchObject({ ok: false, code: 'unsupported' });
    if (result.ok) return;
    expect(result.reason).toContain('build template');
  });

  it('refuses an unmapped route with instructions', async () => {
    const result = await resolveSource(mapping, '/contact/', { listFiles });
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
    if (result.ok) return;
    expect(result.reason).toContain('No source mapping rule matches');
  });

  it('lists every route a layout renders', () => {
    const result = resolveLayout(mapping, '/blog/claude-seo-benchmark/', {
      routes: ['/blog/claude-seo-benchmark/', '/blog/another/', '/about/'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe('tools/build_blog.py');
    expect(result.layout).toBe(true);
    expect(result.affectedRoutes).toEqual(['/blog/claude-seo-benchmark/', '/blog/another/']);
  });

  it('refuses a rule that resolves into a generated path', async () => {
    const custom = parseMapping({
      rules: [{ routes: '/legacy/', source: 'blog/legacy/index.html', editor: 'html' }],
      generated: ['blog/*/index.html'],
    });
    if (!custom.ok) throw new Error(custom.reason);
    const result = await resolveSource(custom.mapping, '/legacy/', { listFiles });
    expect(result).toMatchObject({ ok: false, code: 'unsupported' });
    if (result.ok) return;
    expect(result.reason).toContain('site build writes this path');
  });

  it('reports a parameterised route as pattern confidence', async () => {
    const result = await resolveSource(mapping, '/authors/tim-christensen/', { listFiles });
    expect(result).toMatchObject({ ok: true, path: 'authors/tim-christensen/index.html', confidence: 'pattern' });
  });

  it('finds the redirects file, and refuses a mapping without one', () => {
    expect(resolveRedirects(mapping)).toEqual({ ok: true, path: '_redirects', format: 'netlify' });
    const custom = parseMapping({ rules: [{ routes: '/', source: 'index.html', editor: 'html' }] });
    if (!custom.ok) throw new Error(custom.reason);
    expect(resolveRedirects(custom.mapping)).toMatchObject({ ok: false, code: 'unsupported' });
  });
});

describe('source mapping: patterns and validation', () => {
  it('matches exact, parameter and splat routes', () => {
    expect(routeMatches('/about/', '/about/')).toBe(true);
    expect(routeMatches('/about/', '/about/team/')).toBe(false);
    expect(routeMatches('/blog/:slug/', '/blog/one/')).toBe(true);
    expect(routeMatches('/blog/:slug/', '/blog/one/two/')).toBe(false);
    expect(routeMatches('/tools/*/', '/tools/a/b/')).toBe(true);
    expect(routeMatches('/tools/*/', '/blog/a/')).toBe(false);
  });

  it('takes the literal directory prefix from a source glob', () => {
    expect(globPrefix('content/drafts/*.md')).toBe('content/drafts/');
    expect(globPrefix('*.md')).toBe('');
    expect(globPrefix('about/index.html')).toBe('about/index.html');
    expect(pathMatchesGlob('content/drafts/one-*.md', 'content/drafts/one-2026-01-01.md')).toBe(true);
    expect(pathMatchesGlob('content/drafts/one-*.md', 'content/drafts/two-2026-01-01.md')).toBe(false);
  });

  it('rejects an unknown key and an unknown editor', () => {
    expect(parseMapping({ rules: [{ routes: '/', source: 'index.html', editor: 'html', extra: true }] })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(parseMapping({ rules: [{ routes: '/', source: 'index.html', editor: 'yaml' }] })).toMatchObject({ ok: false, code: 'invalid' });
    expect(parseMapping({ rules: [] })).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('accepts a generated path written plainly and gives it a reason', async () => {
    const custom = parseMapping({
      rules: [{ routes: '/x/', source: 'generated/x.html', editor: 'html' }],
      generated: ['generated/*.html'],
    });
    if (!custom.ok) throw new Error(custom.reason);
    const result = await resolveSource(custom.mapping, '/x/', { listFiles });
    expect(result).toMatchObject({ ok: false, code: 'unsupported' });
    if (result.ok) return;
    expect(result.reason).toContain('overwritten at the next build');
  });
});
