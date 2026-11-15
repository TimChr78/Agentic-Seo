import { describe, expect, it } from 'vitest';
import { ChangeSchema } from '../src/change-types';
import { renderDiff } from '../src/diff';

describe('renderDiff: files', () => {
  it('renders one changed line with its context', () => {
    const diff = renderDiff({ files: [{ path: 'about/index.html', before: 'a\nb\nc\n', after: 'a\nB\nc\n' }] });
    expect(diff.files).toEqual([
      {
        path: 'about/index.html',
        status: 'modified',
        unified: '--- a/about/index.html\n+++ b/about/index.html\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n',
        additions: 1,
        deletions: 1,
      },
    ]);
  });

  it('leaves an unchanged file without a diff', () => {
    const diff = renderDiff({ files: [{ path: 'a.txt', before: 'same\n', after: 'same\n' }] });
    expect(diff.files[0]).toMatchObject({ status: 'modified', unified: '', additions: 0, deletions: 0 });
  });

  it('renders an added file from /dev/null', () => {
    const diff = renderDiff({ files: [{ path: 'new.md', before: null, after: 'one\ntwo\n' }] });
    expect(diff.files[0]).toMatchObject({ status: 'added', additions: 2, deletions: 0 });
    expect(diff.files[0]!.unified).toBe('--- /dev/null\n+++ b/new.md\n@@ -0,0 +1,2 @@\n+one\n+two\n');
  });

  it('renders a deleted file to /dev/null', () => {
    const diff = renderDiff({ files: [{ path: 'old.md', before: 'one\n', after: null }] });
    expect(diff.files[0]).toMatchObject({ status: 'deleted', additions: 0, deletions: 1 });
    expect(diff.files[0]!.unified).toBe('--- a/old.md\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-one\n');
  });

  it('marks a missing final newline on both sides', () => {
    const diff = renderDiff({ files: [{ path: 'a.txt', before: 'a', after: 'b' }] });
    expect(diff.files[0]!.unified).toContain('-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file');
  });

  it('groups distant changes into separate hunks with three lines of context', () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n');
    const after = before.replace('line 2', 'line two').replace('line 18', 'line eighteen');
    const diff = renderDiff({ files: [{ path: 'a.txt', before: `${before}\n`, after: `${after}\n` }] });
    expect(diff.files[0]!.unified.match(/^@@/gm)).toHaveLength(2);
    expect(diff.files[0]).toMatchObject({ additions: 2, deletions: 2 });
  });
});

describe('renderDiff: URLs', () => {
  it('groups before/after pairs by URL', () => {
    const changes = [
      ChangeSchema.parse({ type: 'meta.title', url: 'https://example.com/a/', before: 'Old', after: 'New' }),
      ChangeSchema.parse({ type: 'meta.description', url: 'https://example.com/a/', before: 'Old desc', after: 'New desc' }),
      ChangeSchema.parse({ type: 'meta.title', url: 'https://example.com/b/', before: 'B old', after: 'B new' }),
    ];
    expect(renderDiff({ changes })).toEqual({
      files: [],
      urls: [
        {
          url: 'https://example.com/a/',
          changes: [
            { type: 'meta.title', before: 'Old', after: 'New' },
            { type: 'meta.description', before: 'Old desc', after: 'New desc' },
          ],
        },
        { url: 'https://example.com/b/', changes: [{ type: 'meta.title', before: 'B old', after: 'B new' }] },
      ],
    });
  });

  it('groups a redirect under the path it moves', () => {
    const change = ChangeSchema.parse({
      type: 'redirect',
      from: '/old/',
      to: '/new/',
      status: 301,
      operation: 'update',
      before: { to: '/older/', status: 301 },
    });
    expect(renderDiff({ changes: [change] }).urls).toEqual([
      { url: '/old/', changes: [{ type: 'redirect', before: { to: '/older/', status: 301 }, after: { to: '/new/', status: 301 } }] },
    ]);
  });
});
