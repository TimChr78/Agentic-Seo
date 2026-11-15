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
