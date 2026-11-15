import type { MetaDescriptionChange, MetaTitleChange } from '../change-types';
import { DEFAULT_FIELDS, type FieldMap } from '../mapping';
import { type Refusal, refuse } from '../refusal';

// The Markdown frontmatter editor. The pilot's blog posts are built by tools/build_blog.py from
// `content/drafts/<slug>-<date>.md`; `<title>` comes from `seo_title or title` and the description
// from `seo_description` (falling back to the body excerpt), so a title change edits `seo_title`
// when it exists and `title` otherwise. See the mapping's `fields`.
//
// It is a line editor, not a YAML round-trip: flat `key: value` lines are the pilot's shape, and a
// full parse-and-serialise would reorder keys, drop comments and rewrite quoting. A value that is
// not a flat scalar (a block scalar, a flow collection, an indented nested map) is refused rather
// than guessed at.

export type FrontmatterEditOutcome = { ok: true; text: string; changed: boolean } | Refusal;

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
function scalar(raw: string): { value: string; quote: '"' | "'" | null } | Refusal {
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

function quoteValue(value: string, style: '"' | "'" | null): string {
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
 * Edit one frontmatter field in place, preserving every other line byte for byte (line endings
 * included). `fields` is the mapping rule's field map; the default is the pilot's.
 */
export function applyFrontmatterEdit(
  text: string,
  change: MetaTitleChange | MetaDescriptionChange,
  fields: FieldMap = DEFAULT_FIELDS,
): FrontmatterEditOutcome {
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
    // is nothing in this file to compare `before` with. Insert the primary key, which is how a
    // person takes control of the value.
    const key = wanted[0];
    if (!key) return refuse('invalid', 'The mapping has no frontmatter key for this field.');
    const inserted: Line = { text: `${key}: ${quoteValue(change.after, null)}`, ending: lines[fm.open]!.ending || '\n' };
    const next = [...lines.slice(0, fm.open + 1), inserted, ...lines.slice(fm.open + 1)];
    return { ok: true, text: fileText(next), changed: true };
  }

  const shape = unsupportedShape(lines, fm, found);
  if (shape) return shape;
  const current = scalar(found.rawValue.trim());
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

  const separator = found.separator === '' ? ' ' : found.separator;
  lines[found.index] = { text: `${found.key}:${separator}${quoteValue(change.after, current.quote)}`, ending: lines[found.index]!.ending };
  return { ok: true, text: fileText(lines), changed: true };
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
