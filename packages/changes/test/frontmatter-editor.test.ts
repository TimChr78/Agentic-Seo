import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyFrontmatterEdit, frontmatterValue } from '../src/editors/frontmatter';
import { sourceHashOf } from '../src/source';
import { parsePilotFrontmatter } from './pilot-parser';

// The drafts are small excerpts of real files from TimChr78/martechsignal (content/drafts/), kept
// with their own frontmatter so the pilot mapping is tested against the shapes it really meets.
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
    const result = applyFrontmatterEdit(withoutDescription, {
      ...description('The body excerpt, which the build uses instead.', 'A hand-written description.'),
      sourceHash: sourceHashOf(withoutDescription),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.startsWith('---\nseo_description: A hand-written description.\ntitle:')).toBe(true);
    expect(frontmatterValue(result.text, 'seo_description')).toBe('A hand-written description.');
    expect(result.text).toContain('Five grader generations have scored martechsignal.com');
  });

  it('refuses an insertion it cannot check, because the file has no value to compare with before', () => {
    const withoutDescription = draft.replace(/seo_description: .*\n/, '');
    const result = applyFrontmatterEdit(
      withoutDescription,
      description('The body excerpt, which the build uses instead.', 'A hand-written description.'),
    );
    expect(result).toMatchObject({ ok: false, code: 'stale' });
    if (result.ok) return;
    expect(result.reason).toContain('sourceHashOf');
    expect(result.details).toMatchObject({ key: 'seo_description' });
  });

  it('refuses a file whose sha256 is not the one the change was drafted against', () => {
    const result = applyFrontmatterEdit(draft, {
      ...title('Claude SEO benchmark: the living score tracker', 'Claude SEO benchmark: the record'),
      sourceHash: 'a'.repeat(64),
    });
    expect(result).toMatchObject({ ok: false, code: 'stale' });
    if (result.ok) return;
    expect(result.details).toMatchObject({ expected: 'a'.repeat(64), actual: sourceHashOf(draft) });
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

describe('frontmatter editor: the pilot dialect', () => {
  const current = 'Claude SEO benchmark: the living score tracker';
  const write = (after: string) => applyFrontmatterEdit(draft, title(current, after), { dialect: 'strip_quotes' });

  it('writes a value with double quotes inside single quotes, and the pilot parser reads it back', () => {
    const result = write('The "best" tools');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain(`seo_title: 'The "best" tools'`);
    expect(parsePilotFrontmatter(result.text).meta.seo_title).toBe('The "best" tools');
  });

  it('writes a value with single quotes inside double quotes, and the pilot parser reads it back', () => {
    const result = write("It's the best tool");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('seo_title: "It\'s the best tool"');
    expect(parsePilotFrontmatter(result.text).meta.seo_title).toBe("It's the best tool");
  });

  it('round-trips a colon, a hash and a per cent sign', () => {
    const result = write('MCP: a stack #1 at 100%');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(parsePilotFrontmatter(result.text).meta.seo_title).toBe('MCP: a stack #1 at 100%');
  });

  it('refuses a value the pilot parser would change', () => {
    const cases = ['say "hi"', '"quoted"', "'quoted'", 'trailing space ', ' leading space', '# a heading'];
    for (const after of cases) {
      const result = write(after);
      expect(result, after).toMatchObject({ ok: false, code: 'unsupported' });
    }
    const both = write(`It's the "best"`);
    expect(both).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('reads the current value the way the pilot does when checking before', () => {
    const document = `---\nseo_title: "A \\"quoted\\" title"\n---\nBody\n`;
    const result = applyFrontmatterEdit(document, title('A \\"quoted\\" title', 'A plainer title'), { dialect: 'strip_quotes' });
    expect(result.ok).toBe(true);
  });
});
