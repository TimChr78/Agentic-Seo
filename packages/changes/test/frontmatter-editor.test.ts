import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyFrontmatterEdit, frontmatterValue } from '../src/editors/frontmatter';

const draft = readFileSync(new URL('./fixtures/draft.md', import.meta.url), 'utf8');

function changedLines(before: string, after: string): number[] {
  const left = before.split('\n');
  const right = after.split('\n');
  const changed: number[] = [];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) if (left[index] !== right[index]) changed.push(index + 1);
  return changed;
}

const title = (before: string, after: string) => ({
  type: 'meta.title' as const,
  url: 'https://martechsignal.com/blog/claude-seo-benchmark/',
  before,
  after,
});
const description = (before: string, after: string) => ({
  type: 'meta.description' as const,
  url: 'https://martechsignal.com/blog/claude-seo-benchmark/',
  before,
  after,
});

describe('frontmatter editor: title', () => {
  it('edits seo_title, which the build uses for <title>, and only that line', () => {
    const result = applyFrontmatterEdit(
      draft,
      title('Claude SEO benchmark: the living score tracker', 'Claude SEO benchmark: the scores and what they measured'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(changedLines(draft, result.text)).toEqual([3]);
    expect(frontmatterValue(result.text, 'seo_title')).toBe('Claude SEO benchmark: the scores and what they measured');
    expect(frontmatterValue(result.text, 'title')).toBe('Claude SEO benchmark: every score we have earned, and what each one measured');
  });

  it('falls back to title when seo_title is absent', () => {
    const withoutSeoTitle = draft.replace(/seo_title: .*\n/, '');
    const result = applyFrontmatterEdit(
      withoutSeoTitle,
      title('Claude SEO benchmark: every score we have earned, and what each one measured', 'Claude SEO benchmark: the record'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(frontmatterValue(result.text, 'title')).toBe('Claude SEO benchmark: the record');
    expect(result.text).not.toContain('seo_title');
  });

  it('refuses a before value the file no longer holds', () => {
    const result = applyFrontmatterEdit(draft, title('An old title', 'New title'));
    expect(result).toMatchObject({ ok: false, code: 'stale' });
  });

  it('quotes a value that would otherwise change meaning in YAML', () => {
    const document = '---\ntitle: Old title\n---\nBody\n';
    const result = applyFrontmatterEdit(document, title('Old title', 'New: title # with a comment marker'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('title: "New: title # with a comment marker"');
    expect(frontmatterValue(result.text, 'title')).toBe('New: title # with a comment marker');
  });

  it('is a no-op when the value already matches', () => {
    const result = applyFrontmatterEdit(
      draft,
      title('Claude SEO benchmark: the living score tracker', 'Claude SEO benchmark: the living score tracker'),
    );
    expect(result).toMatchObject({ ok: true, changed: false });
  });

  it('keeps CRLF line endings', () => {
    const crlf = draft.replace(/\n/g, '\r\n');
    const result = applyFrontmatterEdit(crlf, title('Claude SEO benchmark: the living score tracker', 'Claude SEO benchmark: the record'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(/(?<!\r)\n/.test(result.text)).toBe(false);
    expect(result.text.split('\r\n').length).toBe(crlf.split('\r\n').length);
  });
});

describe('frontmatter editor: description', () => {
  it('edits seo_description', () => {
    const result = applyFrontmatterEdit(
      draft,
      description(
        'Five grader generations and what each one measured.',
        'Every Claude SEO score, the grader behind it, and how to read the movement.',
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(changedLines(draft, result.text)).toEqual([9]);
    expect(frontmatterValue(result.text, 'seo_description')).toBe(
      'Every Claude SEO score, the grader behind it, and how to read the movement.',
    );
  });

  it('inserts seo_description when the draft has none, and leaves the rest alone', () => {
    const withoutDescription = draft.replace(/seo_description: .*\n/, '');
    const result = applyFrontmatterEdit(
      withoutDescription,
      description('The body excerpt, which the build uses instead.', 'A hand-written description.'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.startsWith('---\nseo_description: A hand-written description.\ntitle:')).toBe(true);
    expect(frontmatterValue(result.text, 'seo_description')).toBe('A hand-written description.');
    expect(result.text).toContain('Five grader generations have scored martechsignal.com');
  });

  it('refuses stale text', () => {
    const result = applyFrontmatterEdit(draft, description('another description', 'new'));
    expect(result).toMatchObject({ ok: false, code: 'stale' });
  });
});

describe('frontmatter editor: shapes it cannot edit', () => {
  it('refuses a block scalar', () => {
    const document = '---\nseo_title: |\n  a multi-line title\n---\nBody\n';
    const result = applyFrontmatterEdit(document, title('a multi-line title', 'new'));
    expect(result).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('refuses a nested value', () => {
    const document = '---\nseo_title:\n  text: nested\n---\nBody\n';
    const result = applyFrontmatterEdit(document, title('nested', 'new'));
    expect(result).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('refuses a file without frontmatter', () => {
    const result = applyFrontmatterEdit('# Just markdown\n', title('old', 'new'));
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
  });
});
