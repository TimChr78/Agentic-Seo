// The pilot's own frontmatter reader, ported line for line, so a test can prove a written value
// survives the build that publishes it rather than only round-tripping through our reader.
//
// Source: TimChr78/martechsignal, tools/build_blog.py, functions `slugify` and `parse_frontmatter`,
// at the repository's main commit b1b0bd3295f693944b8d7f783f2ab1712dd3eda0 (re-read on 2026-11-15;
// unchanged since the first port). The Python is:
//
//   def slugify(title: str) -> str:
//       s = title.lower()
//       s = re.sub(r'[^a-z0-9\s-]', '', s)
//       s = re.sub(r'\s+', '-', s)
//       return s.strip('-')
//
//   def parse_frontmatter(text: str):
//       if not text.startswith('---'):
//           return {}, text
//       parts = text.split('---', 2)
//       if len(parts) < 3:
//           return {}, text
//       raw = parts[1].strip()
//       body = parts[2].strip()
//       meta = {}
//       for line in raw.split('\n'):
//           m = re.match(r'(\w+):\s*(.+)', line)
//           if not m:
//               continue
//           key = m.group(1)
//           val = m.group(2).strip().strip('"').strip("'")
//           if val.startswith('[') and val.endswith(']'):
//               val = [v.strip().strip('"').strip("'") for v in val[1:-1].split(',')]
//           meta[key] = val
//       return meta, body
//
// Ported as-is, including the parts that are arguably wrong (quotes are stripped, never unescaped;
// `\w+` keys only; one flat line per key; the block ends at the second literal `---` anywhere in
// the text; `re.match` anchors at the start of the line). The test's job is to catch our writer
// producing something this reader would mangle, so "fixing" the port would defeat it.
//
// The character classes are Python's, not JavaScript's, and are spelled out here so this file does
// not import the production implementation: `str.isspace()`/`\s`/`str.strip()` accept U+0085,
// U+001C–U+001F and the Unicode spaces but not U+FEFF, and `.` stops only at `\n` (JavaScript's also
// stops at `\r`, U+2028 and U+2029). The expected values in
// `fixtures/pilot/python-expectations.json` come from running the Python above, not from this port.

export type PilotValue = string | string[];

/**
 * Python's `str.isspace()` set as a character-class body: what `\s`, `str.strip()` and `str.split()`
 * accept. Spelled here rather than shared with the production implementation, which the tests must
 * not vouch for. Built from a string because a regex literal cannot carry the control characters.
 */
const PYTHON_SPACE_CLASS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PYTHON_SPACE = new RegExp(`[${PYTHON_SPACE_CLASS}]`, 'u');
const PYTHON_SPACE_RUN = new RegExp(`[${PYTHON_SPACE_CLASS}]+`, 'gu');

/** `str.strip()` with no argument. */
function pythonStrip(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && PYTHON_SPACE.test(value[start]!)) start += 1;
  while (end > start && PYTHON_SPACE.test(value[end - 1]!)) end -= 1;
  return value.slice(start, end);
}

/** `str.strip('"')`: remove every leading and trailing `"`. */
function stripDouble(value: string): string {
  return value.replace(/^"+/, '').replace(/"+$/, '');
}

/** `str.strip("'")`: remove every leading and trailing `'`. */
function stripSingle(value: string): string {
  return value.replace(/^'+/, '').replace(/'+$/, '');
}

/** The pilot's quote and whitespace handling of one scalar, in its order. */
function scalar(value: string): string {
  return stripSingle(stripDouble(pythonStrip(value)));
}

/** `slugify`, with Python's `\s` and `str.strip` (which only takes `-`). */
export function pilotSlugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(new RegExp(`[^a-z0-9${PYTHON_SPACE_CLASS}-]`, 'gu'), '')
    .replace(PYTHON_SPACE_RUN, '-');
  return s.replace(/^-+|-+$/g, '');
}

export function parsePilotFrontmatter(text: string): { meta: Record<string, PilotValue>; body: string } {
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const first = text.indexOf('---');
  const second = text.indexOf('---', first + 3);
  if (second === -1) return { meta: {}, body: text };
  const raw = pythonStrip(text.slice(first + 3, second));
  const body = pythonStrip(text.slice(second + 3));
  const meta: Record<string, PilotValue> = {};
  for (const line of raw.split('\n')) {
    // `re.match(r'(\w+):\s*(.+)')`: anchored at the start; `\w` is Python's letters, digits and `_`;
    // `\s*` skips Python's whitespace; `(.+)` runs to the end of the line because Python's `.` only
    // stops at `\n` (and the line has none).
    const matched = /^([\p{L}\p{N}_]+):/u.exec(line);
    if (!matched) continue;
    let index = matched[0].length;
    while (index < line.length && PYTHON_SPACE.test(line[index]!)) index += 1;
    if (index === line.length) continue;
    const key = matched[1]!;
    let value: PilotValue = scalar(line.slice(index));
    if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1).split(',').map(scalar);
    meta[key] = value;
  }
  return { meta, body };
}
