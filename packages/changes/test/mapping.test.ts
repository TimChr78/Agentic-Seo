import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { globPrefix, parseMapping, pathMatchesGlob, resolveLayout, resolveRedirects, resolveSource, routeMatches } from '../src/mapping';

const mappingJson = readFileSync(new URL('../examples/martechsignal.mapping.json', import.meta.url), 'utf8');
const parsed = parseMapping(JSON.parse(mappingJson));
if (!parsed.ok) throw new Error(`the example mapping does not parse: ${parsed.reason}`);
const mapping = parsed.mapping;

// Real drafts from TimChr78/martechsignal content/drafts/, kept as small excerpts in the fixture
// set: their slugs are what the build turns into routes, and they are not derivable from the names.
const pilotDrafts = [
  'agent-fleet-in-the-wild-2026-10-19.md',
  'agent-delegate-not-user-2026-11-11.md',
  'claude-seo-benchmark-2026-09-27.md',
  'mcp-martech-2026-07-29.md',
];
const draftTexts = new Map(
  pilotDrafts.map((name) => [`content/drafts/${name}`, readFileSync(new URL(`./fixtures/pilot/${name}`, import.meta.url), 'utf8')]),
);

const files = [
  'index.html',
  'about/index.html',
  'authors/tim-christensen/index.html',
  'blog/claude-seo-benchmark/index.html',
  ...[...draftTexts.keys()],
  'sitemap.xml',
  'tools/nocobase/index.html',
];

const listFiles = async (prefix: string) => files.filter((file) => file.startsWith(prefix));
const readFile = async (path: string) => {
  const text = draftTexts.get(path);
  if (text === undefined) throw new Error(`the fixture set has no file ${path}`);
  return text;
};

describe('source mapping: the pilot', () => {
  it('resolves the home page to the repository root', async () => {
    const result = await resolveSource(mapping, '/', { listFiles });
    expect(result).toMatchObject({ ok: true, path: 'index.html', editor: 'html', confidence: 'exact', affectedRoutes: ['/'] });
  });

  it('resolves a static page exactly', async () => {
    const result = await resolveSource(mapping, 'https://martechsignal.com/about/', { listFiles });
    expect(result).toMatchObject({ ok: true, path: 'about/index.html', editor: 'html', confidence: 'exact', affectedRoutes: ['/about/'] });
  });

  it('resolves a blog route by the draft frontmatter slug, not the file name', async () => {
    const result = await resolveSource(mapping, '/blog/claude-seo-benchmark/', { listFiles, readFile, changeType: 'meta.title' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe('content/drafts/claude-seo-benchmark-2026-09-27.md');
    expect(result.editor).toBe('markdown_frontmatter');
    expect(result.confidence).toBe('glob');
    expect(result.fields.title).toEqual(['seo_title']);
    expect(result.fields.description).toEqual(['seo_description']);
    expect(result.dialect).toBe('strip_quotes');
    expect(result.affectedRoutes).toEqual(['/blog/claude-seo-benchmark/']);
  });

  it('resolves a route whose slug repeats the whole dated file name', async () => {
    const result = await resolveSource(mapping, '/blog/agent-fleet-in-the-wild-2026-10-19/', { listFiles, readFile });
    expect(result).toMatchObject({ ok: true, path: 'content/drafts/agent-fleet-in-the-wild-2026-10-19.md' });
  });

  it('resolves a route from the title when the draft has no slug', async () => {
    const result = await resolveSource(mapping, '/blog/mcp-rewrites-the-integration-economics-of-your-marketing-stack/', {
      listFiles,
      readFile,
    });
    expect(result).toMatchObject({ ok: true, path: 'content/drafts/mcp-martech-2026-07-29.md' });
  });

  it('finds the draft whose slug shares nothing with its file name', async () => {
    const result = await resolveSource(mapping, '/blog/agent-delegate-not-user/', { listFiles, readFile });
    expect(result).toMatchObject({ ok: true, path: 'content/drafts/agent-delegate-not-user-2026-11-11.md' });
  });

  it('refuses a generated tool page with the reason and the build script to edit', async () => {
    const result = await resolveSource(mapping, '/tools/nocobase/', { listFiles, readFile });
    expect(result).toMatchObject({ ok: false, code: 'unsupported' });
    if (result.ok) return;
    expect(result.reason).toContain('tools/build_tools.py');
    expect(result.details).toMatchObject({ generated: true, path: 'tools/nocobase/index.html' });
  });

  it('refuses a blog route with no matching draft file', async () => {
    const result = await resolveSource(mapping, '/blog/no-such-post/', { listFiles, readFile });
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('refuses a slug two drafts claim', async () => {
    const twin = 'content/drafts/claude-seo-benchmark-2026-10-01.md';
    const withTwin = async (prefix: string) => [...files, twin].filter((file) => file.startsWith(prefix));
    const readTwin = async (path: string) =>
      path === twin ? draftTexts.get('content/drafts/claude-seo-benchmark-2026-09-27.md')! : readFile(path);
    const result = await resolveSource(mapping, '/blog/claude-seo-benchmark/', { listFiles: withTwin, readFile: readTwin });
    expect(result).toMatchObject({ ok: false, code: 'ambiguous' });
    if (result.ok) return;
    expect(result.details).toMatchObject({ candidates: expect.arrayContaining([twin]) });
  });

  it('refuses a slug-resolved rule without a way to read the drafts', async () => {
    const result = await resolveSource(mapping, '/blog/claude-seo-benchmark/', { listFiles });
    expect(result).toMatchObject({ ok: false, code: 'unsupported' });
    if (result.ok) return;
    expect(result.reason).toContain('readFile');
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

  it('refuses a layout whose template the build writes', () => {
    const custom = parseMapping({
      rules: [
        { routes: '/blog/:slug/', source: 'tools/build_blog.py', editor: 'html', layout: true },
        { routes: '/blog/:slug/', source: 'content/drafts/*.md', editor: 'markdown_frontmatter', resolveBy: 'frontmatter_slug' },
      ],
      generated: ['tools/*.py'],
    });
    if (!custom.ok) throw new Error(custom.reason);
    const result = resolveLayout(custom.mapping, '/blog/x/', { routes: ['/blog/x/'] });
    expect(result).toMatchObject({ ok: false, code: 'unsupported' });
    if (result.ok) return;
    expect(result.reason).toContain('overwritten at the next build');
    expect(result.details).toMatchObject({ path: 'tools/build_blog.py', generated: true });
  });

  it('refuses a redirects file the build writes', () => {
    const custom = parseMapping({
      rules: [{ routes: '/', source: 'index.html', editor: 'html' }],
      redirects: { file: '_redirects' },
      generated: ['_redirects'],
    });
    if (!custom.ok) throw new Error(custom.reason);
    const result = resolveRedirects(custom.mapping);
    expect(result).toMatchObject({ ok: false, code: 'unsupported' });
    if (result.ok) return;
    expect(result.details).toMatchObject({ path: '_redirects', generated: true });
  });

  it('does not read a "# slug:" comment line as the draft slug', async () => {
    const commented = 'content/drafts/commented-2026-11-15.md';
    const text = '---\ntitle: The real route\n# slug: ignored\n---\nBody\n';
    const listCommented = async (prefix: string) => ['index.html', commented].filter((file) => file.startsWith(prefix));
    const readCommented = async () => text;
    const found = await resolveSource(mapping, '/blog/the-real-route/', { listFiles: listCommented, readFile: readCommented });
    expect(found).toMatchObject({ ok: true, path: commented });
    // Without the anchor the parser reads "slug: ignored" mid-line and resolves the comment's slug.
    expect(await resolveSource(mapping, '/blog/ignored/', { listFiles: listCommented, readFile: readCommented })).toMatchObject({
      ok: false,
      code: 'not_found',
    });
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

  it('refuses the file a glob resolved to when the build writes it', async () => {
    const custom = parseMapping({
      rules: [{ routes: '/posts/:slug/', source: 'content/*/:slug.md', editor: 'markdown_frontmatter' }],
      generated: ['content/archive/*.md'],
    });
    if (!custom.ok) throw new Error(custom.reason);
    const generatedOnly = async (prefix: string) => ['content/archive/old.md'].filter((file) => file.startsWith(prefix));
    const result = await resolveSource(custom.mapping, '/posts/old/', { listFiles: generatedOnly });
    expect(result).toMatchObject({ ok: false, code: 'unsupported' });
    if (result.ok) return;
    expect(result.reason).toContain('overwritten at the next build');
    expect(result.details).toMatchObject({ path: 'content/archive/old.md', generated: true });

    const sourceOnly = async (prefix: string) => ['content/live/old.md'].filter((file) => file.startsWith(prefix));
    expect(await resolveSource(custom.mapping, '/posts/old/', { listFiles: sourceOnly })).toMatchObject({
      ok: true,
      path: 'content/live/old.md',
    });
  });
});
