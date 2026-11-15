import type { MetaDescriptionChange, MetaTitleChange } from '../change-types';
import { DEFAULT_FIELDS, type FieldMap, type FrontmatterDialect } from '../mapping';
import { parsePilotFrontmatter, pilotSlug, pythonIsSpace, pythonStrip } from '../pilot';
import { type Refusal, refuse } from '../refusal';
import { sourceHashRefusal } from '../source';

// The Markdown frontmatter editor. The pilot's blog posts are built by tools/build_blog.py from
// `content/drafts/<slug>-<date>.md`; `<title>` comes from `seo_title or title` and the description
// from `seo_description` (falling back to the body excerpt), so a title change writes `seo_title`
// and never `title`: `title` is the post's H1, and the build derives the route from `slug` or the
// slugified `title` when no `slug` is declared. Any edit whose result would move that route is
// refused, whatever key it used. See the mapping's `fields`.
//
// It is a line editor, not a YAML round-trip: flat `key: value` lines are the pilot's shape, and a
// full parse-and-serialise would reorder keys, drop comments and rewrite quoting. A value that is
// not a flat scalar (a block scalar, a flow collection, an indented nested map) is refused rather
// than guessed at.
//
// Quoting is a mapping-rule choice (`frontmatterDialect`). `yaml` writes standard double-quoted
// scalars with JSON escapes. `strip_quotes` writes for the pilot's own parser, which removes the
// surrounding quotes and nothing else: it must pick a quote character the value does not contain
// and refuse values it cannot carry, because JSON-style escapes would reach the live page as
// backslashes. Every strip_quotes value is read back through the pilot's parser before it is
// written, so a value that would truncate or reshape the frontmatter is refused, not published.

export type FrontmatterEditOutcome = { ok: true; text: string; changed: boolean } | Refusal;

export interface FrontmatterOptions {
  /** The mapping rule's field map; the default is the pilot's. */
  fields?: FieldMap;
  /** How to quote a written value; defaults to `yaml`. */
  dialect?: FrontmatterDialect;
}

interface Line {
  text: string;
  ending: '\r\n' | '\n' | '';
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let index = 0;
  while (index < text.length) {
    const newline = text.indexOf('\n', index);
    if (newline === -1) {
      lines.push({ text: text.slice(index), ending: '' });
      break;
    }
    if (newline > index && text[newline - 1] === '\r') {
      lines.push({ text: text.slice(index, newline - 1), ending: '\r\n' });
    } else {
      lines.push({ text: text.slice(index, newline), ending: '\n' });
    }
    index = newline + 1;
  }
  if (lines.length === 0) lines.push({ text: '', ending: '' });
  return lines;
}

function fileText(lines: Line[]): string {
  return lines.map((line) => line.text + line.ending).join('');
}

interface Frontmatter {
  /** Index of the opening `---`. */
  open: number;
  /** Index of the closing `---`. */
  close: number;
  lines: Line[];
}

function frontmatterOf(text: string): Frontmatter | Refusal {
  const lines = splitLines(text);
  if (lines[0]?.text.trim() !== '---') {
    return refuse('not_found', 'The file has no YAML frontmatter (a `---` block at the top), so a frontmatter field cannot be edited.');
  }
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]!.text.trim() === '---') return { open: 0, close: index, lines };
  }
  return refuse('invalid', 'The frontmatter block is not closed with a `---` line.');
}

interface KeyLine {
  index: number;
  key: string;
  separator: string;
  rawValue: string;
}

function keyLineOf(line: string, index: number): KeyLine | null {
  const match = /^([A-Za-z0-9_.-]+):([ \t]*)(.*)$/.exec(line);
  if (!match) return null;
  return { index, key: match[1]!, separator: match[2]!, rawValue: match[3]! };
}

/** A YAML scalar as the frontmatter spells it: the value plus the quote style to keep. */
function scalar(raw: string, dialect: FrontmatterDialect = 'yaml'): { value: string; quote: '"' | "'" | null } | Refusal {
  if (dialect === 'strip_quotes') {
    // The pilot's parse_frontmatter does `val.strip('"').strip("'")`: it removes every surrounding
    // quote and never unescapes, so a value is read back exactly as those two strips leave it.
    const quote = raw.startsWith('"') ? '"' : raw.startsWith("'") ? "'" : null;
    return { value: raw.replace(/^"+/, '').replace(/"+$/, '').replace(/^'+/, '').replace(/'+$/, ''), quote };
  }
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"') || raw.length < 2)
      return refuse('unsupported', 'A quoted frontmatter value is not closed; fix the YAML before changing it.');
    try {
      const value = JSON.parse(raw);
      if (typeof value === 'string') return { value, quote: '"' };
    } catch {
      // Fall through: a double-quoted scalar is YAML's escape set, which is close enough to JSON
      // for the flat strings the pilot uses; if JSON refuses it, take the body literally.
    }
    return { value: raw.slice(1, -1).replaceAll('\\"', '"'), quote: '"' };
  }
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2)
      return refuse('unsupported', 'A single-quoted frontmatter value is not closed; fix the YAML before changing it.');
    return { value: raw.slice(1, -1).replaceAll("''", "'"), quote: "'" };
  }
  return { value: raw, quote: null };
}

const YAML_RESERVED = new Set(['true', 'false', 'null', '~', 'yes', 'no', 'on', 'off']);

/** Whether a plain scalar has to be quoted to round-trip as the same string. */
function needsQuotes(value: string): boolean {
  if (value === '' || value !== value.trim()) return true;
  if (YAML_RESERVED.has(value.toLowerCase())) return true;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) return true;
  if (value.includes(': ') || value.includes(' #') || value.includes('\n') || value.includes('\r') || value.includes('\t')) return true;
  return false;
}

/**
 * Whether a value carries a character Python treats as whitespace or as a line boundary. The build
 * splits lines and strips values with Python's own sets, so a value carrying U+0085, U+001C–U+001F
 * or one of the Unicode spaces is read back as more than one token (or as a different value), and
 * the page would not show what the change names.
 */
function pythonWhitespaceProblem(value: string): boolean {
  for (const char of value) if (char !== ' ' && pythonIsSpace(char)) return true;
  return false;
}

/** Why the pilot's parser cannot carry a value, or null when it can. */
function stripQuotesProblem(value: string): string | null {
  if (/\p{Cc}/u.test(value)) return 'it contains a control character or a line break, which a single-line frontmatter value cannot carry.';
  if (pythonWhitespaceProblem(value))
    return 'it contains a line separator or a non-breaking or unusual space (Python’s parser treats those as whitespace), which a single-line frontmatter value cannot carry.';
  if (value !== pythonStrip(value)) return 'it begins or ends with whitespace, which the parser strips.';
  if (value.startsWith('#')) return 'it begins with "#", which YAML reads as a comment.';
  // The build closes the frontmatter at the second literal `---` anywhere in the file, so a value
  // carrying one ends the block early and the rest of the draft is published as body text.
  if (value.includes('---'))
    return 'it contains "---", which ends the frontmatter block early and turns the rest of the draft into body text.';
  if (value.startsWith('[') || value.startsWith('{'))
    return 'it begins with "[" or "{", the shape of a YAML collection; the build reads a bracketed value as a list, not as the text you mean.';
  if (/^["']|["']$/.test(value))
    return 'it begins or ends with a quote, which the parser strips, so the page would show a different value.';
  if (value.includes('"') && value.includes("'"))
    return 'it contains both a double and a single quote, so no surrounding quote character survives the parser.';
  return null;
}

/** How the build's parser read a value back, for a refusal message. */
function readBackDescription(value: string | string[] | undefined): string {
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return `a list (${value.length} item${value.length === 1 ? '' : 's'})`;
  return JSON.stringify(value);
}

/**
 * Quote a value for the pilot's parser: a quote character the value does not contain, so the
 * parser's strip leaves exactly the value behind. The result is read back through the ported
 * parser before it is returned: the checks above name the common cases, and this catches anything
 * else that would truncate or reshape the block.
 */
function quoteStripQuotes(value: string, key: string): string | Refusal {
  const problem = stripQuotesProblem(value);
  if (problem)
    return refuse(
      'unsupported',
      `The frontmatter cannot carry this value in the site's strip_quotes dialect: ${problem} Rephrase it, or teach the site's build to unescape quotes.`,
    );
  if (value === '') return '""';
  const quote = value.includes('"') ? "'" : '"';
  const quoted = `${quote}${value}${quote}`;
  const readBack = parsePilotFrontmatter(`---\n${key}: ${quoted}\n---\n`).meta[key];
  if (readBack !== value) {
    return refuse(
      'unsupported',
      `The frontmatter cannot carry this value in the site's strip_quotes dialect: the build's parser reads it back as ${readBackDescription(readBack)}. Rephrase it, or teach the site's build to unescape quotes.`,
    );
  }
  return quoted;
}

function quoteValue(value: string, style: '"' | "'" | null, dialect: FrontmatterDialect, key: string): string | Refusal {
  if (dialect === 'strip_quotes') return quoteStripQuotes(value, key);
  if (style === "'") return `'${value.replaceAll("'", "''")}'`;
  if (style === '"' || needsQuotes(value)) return JSON.stringify(value);
  return value;
}

function keysFor(field: 'title' | 'description', fields: FieldMap): readonly string[] {
  return fields[field] ?? DEFAULT_FIELDS[field] ?? [];
}

function unsupportedShape(lines: Line[], fm: Frontmatter, key: KeyLine): Refusal | null {
  const value = key.rawValue.trim();
  if (value === '' || value === '|' || value === '>' || value.startsWith('|') || value.startsWith('>')) {
    const next = lines[key.index + 1];
    if (
      !next ||
      next.text.startsWith(' ') ||
      next.text.startsWith('\t') ||
      value === '' ||
      value.startsWith('|') ||
      value.startsWith('>')
    ) {
      return refuse(
        'unsupported',
        `The frontmatter key "${key.key}" is not a flat value (it looks like a nested or block value). Edit that YAML by hand or in a different change type.`,
      );
    }
  }
  if (value.startsWith('[') || value.startsWith('{')) {
    return refuse(
      'unsupported',
      `The frontmatter key "${key.key}" holds a YAML collection, not a string. Edit it by hand or use a change type that supports it.`,
    );
  }
  // A key whose value runs onto indented lines is a block; refuse before touching it.
  const nextLine = lines[key.index + 1];
  if (key.index + 1 < fm.close && nextLine && (nextLine.text.startsWith(' ') || nextLine.text.startsWith('\t'))) {
    return refuse('unsupported', `The frontmatter key "${key.key}" continues on indented lines. Edit that nested YAML by hand.`);
  }
  return null;
}

/**
 * The refusal for an edit whose result would move the post's route, or null when it would not.
 * The pilot builds the route from `slug`, else the slugified `title`, so an edit to `title` (or a
 * title insert) can silently rename the page; a change must not do that by accident.
 */
function routeChangeRefusal(beforeText: string, afterText: string): Refusal | null {
  const beforeSlug = pilotSlug(beforeText);
  const afterSlug = pilotSlug(afterText);
  if (beforeSlug === afterSlug) return null;
  const routeOf = (slug: string | null) => (slug === null ? 'no route (the file has neither a slug nor a title)' : `/blog/${slug}/`);
  return refuse(
    'conflict',
    `This edit would change the post's route from ${routeOf(beforeSlug)} to ${routeOf(afterSlug)}, because the build derives it from the frontmatter. Edit a key that does not set the route, or declare an explicit slug first.`,
    { before: beforeSlug, after: afterSlug },
  );
}

/**
 * Edit one frontmatter field in place, preserving every other line byte for byte (line endings
 * included). `options.fields` is the mapping rule's field map; the default is the pilot's.
 */
export function applyFrontmatterEdit(
  text: string,
  change: MetaTitleChange | MetaDescriptionChange,
  options: FrontmatterOptions = {},
): FrontmatterEditOutcome {
  const hashProblem = sourceHashRefusal(change, text);
  if (hashProblem) return hashProblem;
  const fields = options.fields ?? DEFAULT_FIELDS;
  const dialect: FrontmatterDialect = options.dialect ?? 'yaml';
  const fm = frontmatterOf(text);
  if ('ok' in fm) return fm;
  const lines = fm.lines;
  const field = change.type === 'meta.title' ? 'title' : 'description';
  const wanted = keysFor(field, fields);
  const linesByKey = new Map<string, KeyLine[]>();
  for (let index = fm.open + 1; index < fm.close; index += 1) {
    const line = keyLineOf(lines[index]!.text, index);
    if (!line || !wanted.includes(line.key)) continue;
    const existing = linesByKey.get(line.key);
    if (existing) existing.push(line);
    else linesByKey.set(line.key, [line]);
  }

  let found: KeyLine | undefined;
  for (const key of wanted) {
    const matches = linesByKey.get(key);
    if (!matches) continue;
    if (matches.length > 1) {
      return refuse('ambiguous', `The frontmatter has ${matches.length} "${key}" keys. Keep one before changing it.`, { key });
    }
    found = matches[0];
    break;
  }

  if (!found) {
    // The page value is derived by the build (an excerpt for a description, for example), so there
    // is nothing in this file to compare `before` with. Inserting the primary key is how a person
    // takes control of the value, but only the file's hash proves the draft saw a file that still
    // has no such key: without it, a `before` the file cannot contradict would be accepted blindly.
    const key = wanted[0];
    if (!key) return refuse('invalid', 'The mapping has no frontmatter key for this field.');
    if (change.sourceHash === undefined) {
      return refuse(
        'stale',
        `The frontmatter has no "${key}" key, so the value the page shows is derived by the site's build and \`before\` cannot be checked against this file. Re-read the source and draft the change again with its sourceHashOf() so the editor can prove the file has not changed.`,
        { key },
      );
    }
    const quoted = quoteValue(change.after, null, dialect, key);
    if (typeof quoted !== 'string') return quoted;
    const inserted: Line = { text: `${key}: ${quoted}`, ending: lines[fm.open]!.ending || '\n' };
    const next = [...lines.slice(0, fm.open + 1), inserted, ...lines.slice(fm.open + 1)];
    const nextText = fileText(next);
    const routeProblem = routeChangeRefusal(text, nextText);
    if (routeProblem) return routeProblem;
    return { ok: true, text: nextText, changed: true };
  }

  const shape = unsupportedShape(lines, fm, found);
  if (shape) return shape;
  const current = scalar(found.rawValue.trim(), dialect);
  if ('ok' in current) return current;
  if (current.value === change.after) return { ok: true, text, changed: false };
  if (current.value !== change.before) {
    return refuse(
      'stale',
      `The frontmatter key "${found.key}" is now "${current.value}", not "${change.before}". Re-read the page and draft the change again.`,
      {
        key: found.key,
        current: current.value,
      },
    );
  }

  const quoted = quoteValue(change.after, current.quote, dialect, found.key);
  if (typeof quoted !== 'string') return quoted;
  const separator = found.separator === '' ? ' ' : found.separator;
  lines[found.index] = { text: `${found.key}:${separator}${quoted}`, ending: lines[found.index]!.ending };
  const nextText = fileText(lines);
  const routeProblem = routeChangeRefusal(text, nextText);
  if (routeProblem) return routeProblem;
  return { ok: true, text: nextText, changed: true };
}

/** Read a flat frontmatter key, for a caller that wants to check what the file says. */
export function frontmatterValue(text: string, key: string): string | null {
  const fm = frontmatterOf(text);
  if ('ok' in fm) return null;
  for (let index = fm.open + 1; index < fm.close; index += 1) {
    const line = keyLineOf(fm.lines[index]!.text, index);
    if (!line || line.key !== key) continue;
    const value = scalar(line.rawValue.trim());
    return 'ok' in value ? null : value.value;
  }
  return null;
}
