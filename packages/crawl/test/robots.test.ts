import { describe, expect, it } from 'vitest';
import { parseRobotsTxt, robotsTxtFacts } from '../src';

describe('parseRobotsTxt', () => {
  it('groups rules by user agent and keeps sitemaps', () => {
    const parsed = parseRobotsTxt(
      [
        '# a comment',
        'User-agent: *',
        'Disallow: /private',
        'Allow: /private/public',
        'Sitemap: https://example.com/sitemap.xml',
        '',
        'User-agent: Googlebot',
        'User-agent: Bingbot',
        'Disallow: /no',
      ].join('\n'),
    );
    expect(parsed.groups).toHaveLength(2);
    expect(parsed.groups[0]).toMatchObject({
      agents: ['*'],
      rules: [
        { allow: false, value: '/private' },
        { allow: true, value: '/private/public' },
      ],
    });
    expect(parsed.groups[1]?.agents).toEqual(['googlebot', 'bingbot']);
    expect(parsed.sitemaps).toEqual(['https://example.com/sitemap.xml']);
    expect(parsed.parseErrors).toEqual([]);
  });

  it('records the lines it cannot use, with their line numbers', () => {
    const parsed = parseRobotsTxt(['User-agent: *', 'Nonsense: yes', 'Disallow: /x'].join('\n'));
    expect(parsed.parseErrors).toEqual([{ line: 2, text: 'Nonsense: yes' }]);
    expect(parsed.groups[0]?.rules).toEqual([{ allow: false, value: '/x' }]);
  });

  it('names every user agent for which the whole site is disallowed', () => {
    const facts = robotsTxtFacts({
      url: 'https://example.com/robots.txt',
      status: 200,
      fetchError: null,
      body: [
        'User-agent: *',
        'Disallow: /',
        '',
        'User-agent: gptbot',
        'Disallow: /',
        'Allow: /',
        '',
        'User-agent: claudebot',
        'Disallow: /',
      ].join('\n'),
    });
    expect(facts.disallowAllFor).toEqual(['*', 'claudebot']);
    expect(facts.body).toContain('User-agent: *');
  });

  it('makes relative sitemap locations absolute and caps the evidence body', () => {
    const facts = robotsTxtFacts({
      url: 'https://example.com/robots.txt',
      status: 200,
      fetchError: null,
      body: `User-agent: *\nSitemap: /sitemap.xml\nSitemap: https://cdn.example/x.xml\n${'#'.repeat(600 * 1024)}`,
    });
    expect(facts.sitemaps).toEqual(['https://example.com/sitemap.xml', 'https://cdn.example/x.xml']);
    expect((facts.body ?? '').length).toBe(512 * 1024);
  });
});
