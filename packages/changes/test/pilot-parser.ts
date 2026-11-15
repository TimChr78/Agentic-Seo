// The pilot's own frontmatter reader, ported line for line, so a test can prove a written value
// survives the build that publishes it rather than only round-tripping through our reader.
//
// Source: TimChr78/martechsignal, tools/build_blog.py, function `parse_frontmatter`, at commit
// b1b0bd3295f693944b8d7f783f2ab1712dd3eda0 (read on 2026-11-15). The Python is:
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
// `\w+` keys only; one flat line per key). The test's job is to catch our writer producing something
// this reader would mangle, so "fixing" the port would defeat it.

export type PilotValue = string | string[];

/** `str.strip('"')`: remove every leading and trailing `"`. */
function stripDouble(value: string): string {
  return value.replace(/^"+/, '').replace(/"+$/, '');
}

/** `str.strip("'")`: remove every leading and trailing `'`. */
function stripSingle(value: string): string {
  return value.replace(/^'+/, '').replace(/'+$/, '');
}

/** The pilot's quote and whitespace handling of one scalar. */
function scalar(value: string): string {
  return stripSingle(stripDouble(value.trim()));
}

export function parsePilotFrontmatter(text: string): { meta: Record<string, PilotValue>; body: string } {
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const first = text.indexOf('---');
  const second = text.indexOf('---', first + 3);
  if (second === -1) return { meta: {}, body: text };
  const raw = text.slice(first + 3, second).trim();
  const body = text.slice(second + 3).trim();
  const meta: Record<string, PilotValue> = {};
  for (const line of raw.split('\n')) {
    const matched = /^(\w+):\s*(.+)/.exec(line);
    if (!matched) continue;
    const key = matched[1]!;
    let value: PilotValue = scalar(matched[2]!);
    if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1).split(',').map(scalar);
    meta[key] = value;
  }
  return { meta, body };
}
