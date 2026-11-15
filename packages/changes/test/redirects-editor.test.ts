import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RedirectChange } from '../src/change-types';
import { applyRedirectEdit, redirectRules } from '../src/editors/redirects';

const redirects = readFileSync(new URL('./fixtures/_redirects', import.meta.url), 'utf8');

function changedLines(before: string, after: string): number[] {
  const left = before.split('\n');
  const right = after.split('\n');
  const changed: number[] = [];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) if (left[index] !== right[index]) changed.push(index + 1);
  return changed;
}

const add = (from: string, to: string, status: 301 | 302 | 307 | 308 = 301): RedirectChange => ({
  type: 'redirect',
  from,
  to,
  status,
  operation: 'add',
});

describe('redirects editor: add', () => {
  it('appends one rule and keeps comments and ordering', () => {
    const result = applyRedirectEdit(redirects, add('/blog/old-post/', '/blog/new-post/', 301));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.startsWith(redirects)).toBe(true);
    expect(result.text).toContain('/blog/old-post/  /blog/new-post/  301');
    expect(redirectRules(result.text)).toHaveLength(redirectRules(redirects).length + 1);
    expect(changedLines(redirects, result.text)).toHaveLength(2);
  });

  it('writes into an empty file', () => {
    const result = applyRedirectEdit('', add('/a/', '/b/'));
    expect(result).toMatchObject({ ok: true, text: '/a/  /b/  301\n' });
  });

  it('refuses a duplicate from', () => {
    const result = applyRedirectEdit(redirects, add('/authors/', '/somewhere-else/'));
    expect(result).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('refuses a loop', () => {
    const document = '/a/  /b/  301\n';
    const result = applyRedirectEdit(document, add('/b/', '/a/'));
    expect(result).toMatchObject({ ok: false, code: 'conflict' });
    if (result.ok) return;
    expect(result.reason).toMatch(/loop/i);
  });

  it('refuses a target that is the same page as the source, a fragment included', () => {
    // The platform matches the request path, so `/a/` and `/a/#section` are the same page: the
    // browser would request `/a` again and loop. A trailing slash is not a difference either.
    for (const to of ['/a/', '/a', '/a/#fragment', '/a#fragment']) {
      const result = applyRedirectEdit('', add('/a/', to));
      expect(result, to).toMatchObject({ ok: false, code: 'conflict' });
      if (result.ok) return;
      expect(result.reason, to).toMatch(/loop/i);
    }
  });

  it('refuses a chain and names the final target', () => {
    const document = '/a/  /b/  301\n/b/  /c/  301\n';
    const result = applyRedirectEdit(document, add('/new/', '/a/'));
    expect(result).toMatchObject({ ok: false, code: 'conflict' });
    if (result.ok) return;
    expect(result.reason).toContain('/c/');
    expect(result.details).toMatchObject({ suggestion: '/c/' });
  });

  it('keeps CRLF line endings', () => {
    const crlf = redirects.replace(/\n/g, '\r\n');
    const result = applyRedirectEdit(crlf, add('/a/', '/b/'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(/(?<!\r)\n/.test(result.text)).toBe(false);
  });

  it('refuses a rule an earlier rule already answers (first match wins)', () => {
    // A `from` without a query answers every query, so `/a?page=2` would never be reached.
    const result = applyRedirectEdit('/a  /b  301\n', add('/a?page=2', '/c/'));
    expect(result).toMatchObject({ ok: false, code: 'conflict' });
    if (result.ok) return;
    expect(result.reason).toContain('line 1');
  });
});

describe('redirects editor: refused input', () => {
  it('refuses a target that would write a second rule, even when the change was never parsed', () => {
    const crafted = {
      type: 'redirect',
      from: '/target/',
      to: '/target 301\n/admin https://evil.test 302\n#',
      status: 301,
      operation: 'add',
    } as RedirectChange;
    const result = applyRedirectEdit(redirects, crafted);
    expect(result).toMatchObject({ ok: false, code: 'invalid' });
    if (result.ok) return;
    expect(result.reason).toContain('whitespace');
  });

  it('refuses a source with whitespace or without a leading slash', () => {
    for (const from of ['/a b/', 'a/', 'https://example.com/a']) {
      expect(applyRedirectEdit(redirects, add(from, '/b/')), from).toMatchObject({ ok: false, code: 'invalid' });
    }
  });

  it('refuses a target that is not a path or an http(s) URL', () => {
    for (const to of ['javascript:alert(1)', 'data:text/html,x', 'example.com/b']) {
      expect(applyRedirectEdit(redirects, add('/a/', to)), to).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(applyRedirectEdit(redirects, add('/a/', 'https://example.com/b'))).toMatchObject({ ok: true });
  });

  it('writes a target that carries a fragment', () => {
    const result = applyRedirectEdit('', add('/old/', '/new/#section'));
    expect(result).toMatchObject({ ok: true, text: '/old/  /new/#section  301\n' });
    if (!result.ok) return;
    // The `#` is inside the token, so it is a fragment and not a comment.
    expect(redirectRules(result.text)).toEqual([{ from: '/old/', to: '/new/#section', status: 301 }]);
  });

  it('refuses a file whose sha256 is not the one the change was drafted against', () => {
    const result = applyRedirectEdit(redirects, { ...add('/a/', '/b/'), sourceHash: 'a'.repeat(64) });
    expect(result).toMatchObject({ ok: false, code: 'stale' });
  });
});

describe('redirects editor: rules that would chain', () => {
  it('refuses adding a rule that makes an existing rule redirect twice', () => {
    const document = '/a  /b  301\n';
    const result = applyRedirectEdit(document, add('/b/', '/c/'));
    expect(result).toMatchObject({ ok: false, code: 'conflict' });
    if (result.ok) return;
    expect(result.reason).toContain('/a');
    expect(result.reason).toContain('/c');
    expect(result.details).toMatchObject({ incoming: ['/a'], suggestion: '/c/' });
  });

  it('refuses adding a rule that closes a loop with an existing rule', () => {
    const document = '/a  /b  301\n';
    const result = applyRedirectEdit(document, add('/b/', '/a/'));
    expect(result).toMatchObject({ ok: false, code: 'conflict' });
    if (result.ok) return;
    expect(result.reason).toMatch(/loop/i);
  });

  it('suggests the end of a longer outgoing chain for the incoming rule', () => {
    const document = '/a  /b  301\n/c/  /d/  301\n';
    const result = applyRedirectEdit(document, add('/b/', '/c/'));
    expect(result).toMatchObject({ ok: false, code: 'conflict' });
    if (result.ok) return;
    expect(result.details).toMatchObject({ incoming: ['/a'], suggestion: '/d/' });
  });

  it('allows a rule whose source nothing points at', () => {
    const document = '/a  /b  301\n';
    expect(applyRedirectEdit(document, add('/c/', '/d/'))).toMatchObject({ ok: true });
  });
});

describe('redirects editor: a change writes one literal rule', () => {
  it('refuses a splat rule that would loop, because it is a pattern a person writes', () => {
    const result = applyRedirectEdit('', add('/a/*', '/a/:splat'));
    expect(result).toMatchObject({ ok: false, code: 'unsupported' });
    if (result.ok) return;
    expect(result.reason).toContain('Pattern redirects are written by people in Phase 1');
  });

  it('refuses a splat rule that would close a loop with an existing rule', () => {
    const document = '/a/item  /b/item  301\n';
    const result = applyRedirectEdit(document, add('/b/*', '/a/:splat'));
    expect(result).toMatchObject({ ok: false, code: 'unsupported' });
    if (result.ok) return;
    expect(result.reason).toContain('Pattern redirects are written by people in Phase 1');
  });

  it('refuses a splat rule that would chain through an existing rule', () => {
    const document = '/target/item  /end  301\n';
    const result = applyRedirectEdit(document, add('/source/*', '/target/:splat'));
    expect(result).toMatchObject({ ok: false, code: 'unsupported' });
    if (result.ok) return;
    expect(result.reason).toContain('Pattern redirects are written by people in Phase 1');
  });

  it('refuses a placeholder on the source or the target', () => {
    for (const [from, to] of [
      ['/news/:year/', '/archive/'],
      ['/a/', '/archive/:slug/'],
      ['/a/', 'https://example.com/:slug/'],
    ] as const) {
      const result = applyRedirectEdit('', add(from, to));
      expect(result, `${from} -> ${to}`).toMatchObject({ ok: false, code: 'unsupported' });
    }
  });

  it('refuses a pattern even when the change was never parsed', () => {
    const crafted = { type: 'redirect', from: '/a/*', to: '/b/:splat', status: 301, operation: 'add' } as RedirectChange;
    expect(applyRedirectEdit('', crafted)).toMatchObject({ ok: false, code: 'unsupported' });
  });
});

describe('redirects editor: existing pattern rules are followed, not judged blind', () => {
  it('refuses a pattern rule the new target runs into, and names the line to edit', () => {
    const document = '/old/*  /new/:splat  301\n';
    const result = applyRedirectEdit(document, add('/new/item/', '/old/item/'));
    expect(result).toMatchObject({ ok: false, code: 'conflict' });
    if (result.ok) return;
    expect(result.reason).toContain('interacts with the pattern rule at line 1');
    expect(result.reason).toContain('Edit the redirects file by hand');
    expect(result.details).toMatchObject({ line: 1 });
  });

  it('refuses an incoming edge a splat target creates, and suggests the final target', () => {
    const document = '/old/*  /new/:splat  301\n';
    const result = applyRedirectEdit(document, add('/new/item/', '/elsewhere/'));
    expect(result).toMatchObject({ ok: false, code: 'conflict' });
    if (result.ok) return;
    expect(result.reason).toContain('/old/item');
    expect(result.details).toMatchObject({ suggestion: '/elsewhere/' });
  });

  it('refuses a placeholder rule the new target asks about rather than guessing', () => {
    const document = '/news/:year/:slug/  /archive/:year/:slug/  301\n';
    const result = applyRedirectEdit(document, add('/archive/2026/post/', '/news/2026/post/'));
    expect(result).toMatchObject({ ok: false, code: 'conflict' });
    if (result.ok) return;
    expect(result.reason).toContain('interacts with the pattern rule at line 1');
  });

  it('refuses a pattern interaction it cannot resolve rather than accepting it', () => {
    // The existing rule's target needs `:year`, which its source never supplies: the real target
    // is unknowable here, so a loop cannot be ruled out.
    const document = '/a/*  /b/:splat/:year  301\n';
    const result = applyRedirectEdit(document, add('/start/', '/a/item/'));
    expect(result).toMatchObject({ ok: false, code: 'conflict' });
    if (result.ok) return;
    expect(result.reason).toContain('interacts with the pattern rule at line 1');
  });

  it('accepts a rule whose incoming pattern is shadowed for that path (first match wins)', () => {
    // `/old/item` answers before `/old/*`, so `/old/*` never sends anything to `/new/item`:
    // the pattern cannot make this rule a chain.
    const document = '/old/item  /safe  301\n/old/*  /new/:splat  301\n';
    expect(applyRedirectEdit(document, add('/new/item/', '/end/'))).toMatchObject({ ok: true });
  });

  it('refuses the same change when the shadowing rule is not there', () => {
    const document = '/old/*  /new/:splat  301\n';
    expect(applyRedirectEdit(document, add('/new/item/', '/end/'))).toMatchObject({ ok: false, code: 'conflict' });
  });
});

describe('redirects editor: update and remove', () => {
  it('replaces one rule line and nothing else', () => {
    const before = { to: '/blog/claude-seo-benchmark/', status: 301 as const };
    const result = applyRedirectEdit(redirects, {
      type: 'redirect',
      from: '/blog/claude-seo-teardown-martechsignal/',
      to: '/blog/claude-seo-benchmark/',
      status: 308,
      operation: 'update',
      before,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(changedLines(redirects, result.text)).toEqual([9]);
    expect(result.text).toContain('/blog/claude-seo-teardown-martechsignal/  /blog/claude-seo-benchmark/  308');
  });

  it('keeps an inline comment and the spacing around the fields it changes', () => {
    const document = '/old/  /new/  301  # keep this note\n';
    const result = applyRedirectEdit(document, {
      type: 'redirect',
      from: '/old/',
      to: '/newer/',
      status: 308,
      operation: 'update',
      before: { to: '/new/', status: 301 },
    });
    expect(result).toMatchObject({ ok: true, text: '/old/  /newer/  308  # keep this note\n' });
  });

  it('changes only the status span when the target stays the same', () => {
    const document = '/old/  /new/  301  # keep\n';
    const result = applyRedirectEdit(document, {
      type: 'redirect',
      from: '/old/',
      to: '/new/',
      status: 308,
      operation: 'update',
      before: { to: '/new/', status: 301 },
    });
    expect(result).toMatchObject({ ok: true, text: '/old/  /new/  308  # keep\n' });
  });

  it('adds a status token before an inline comment when the rule had none', () => {
    const document = '/old/  /new/ # keep\n';
    const result = applyRedirectEdit(document, {
      type: 'redirect',
      from: '/old/',
      to: '/newer/',
      status: 308,
      operation: 'update',
      before: { to: '/new/', status: 301 },
    });
    expect(result).toMatchObject({ ok: true, text: '/old/  /newer/  308 # keep\n' });
  });

  it('refuses when the rule is not what the change was drafted against', () => {
    const result = applyRedirectEdit(redirects, {
      type: 'redirect',
      from: '/authors/',
      to: '/elsewhere/',
      status: 301,
      operation: 'update',
      before: { to: '/someone-else/', status: 301 },
    });
    expect(result).toMatchObject({ ok: false, code: 'stale' });
  });

  it('refuses updating a rule that is not there', () => {
    const result = applyRedirectEdit(redirects, {
      type: 'redirect',
      from: '/missing/',
      to: '/b/',
      status: 301,
      operation: 'update',
      before: { to: '/a/', status: 301 },
    });
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('removes the rule line and keeps the comments', () => {
    const result = applyRedirectEdit(redirects, {
      type: 'redirect',
      from: '/tools.json',
      operation: 'remove',
      before: { to: '/catalog-tools.json', status: 301 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain('/tools.json');
    expect(result.text).toContain('# Double-slash collapse rules removed');
    expect(redirectRules(result.text)).toHaveLength(redirectRules(redirects).length - 1);
  });

  it('refuses a remove whose before no longer matches', () => {
    const result = applyRedirectEdit(redirects, {
      type: 'redirect',
      from: '/tools.json',
      operation: 'remove',
      before: { to: '/something-else/', status: 301 },
    });
    expect(result).toMatchObject({ ok: false, code: 'stale' });
  });
});
