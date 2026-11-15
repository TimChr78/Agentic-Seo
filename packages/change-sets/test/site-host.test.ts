import type { Change } from '@agentic-seo/changes';
import { describe, expect, it } from 'vitest';
import { changeHostProblem } from '../src/site-host';

// Review of PR #27: the site-host rule at its entry point (drafting and revalidation both call it).

const site = { name: 'Example', primaryDomain: 'example.com', hosts: [] as string[] };
const title = (url: string): Change => ({ type: 'meta.title', url, before: 'Old', after: 'New' }) as Change;

describe('changeHostProblem', () => {
  it('treats a trailing-dot host as the site’s own, like the crawler', () => {
    expect(changeHostProblem(title('https://example.com./about/'), site)).toBeNull();
    expect(changeHostProblem(title('https://EXAMPLE.com/about/'), site)).toBeNull();
    expect(changeHostProblem(title('https://other.example/about/'), site)).toMatch(/not on site/);
    expect(changeHostProblem(title('http://example.com/about/'), site)).toMatch(/not on site/);
  });

  it('lets a change repair or remove an old http:// redirect target on the site', () => {
    const repair = {
      type: 'redirect',
      operation: 'update',
      from: '/old/',
      to: 'https://example.com./about/',
      status: 301,
      before: { to: 'http://example.com/about/', status: 301 },
    } as unknown as Change;
    expect(changeHostProblem(repair, site)).toBeNull();
    const remove = {
      type: 'redirect',
      operation: 'remove',
      from: '/old/',
      before: { to: 'http://example.com/about/', status: 301 },
    } as unknown as Change;
    expect(changeHostProblem(remove, site)).toBeNull();
    // The resulting target is still held to the rule.
    const stillHttp = { ...(repair as object), to: 'http://example.com/about/' } as unknown as Change;
    expect(changeHostProblem(stillHttp, site)).toMatch(/must use the site’s own origin/);
  });
});
