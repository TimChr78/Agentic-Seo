// How the pilot (TimChr78/martechsignal) names a blog post, ported from its build so the mapping
// resolves the same route the build writes.
//
// tools/build_blog.py, at commit b1b0bd3295f693944b8d7f783f2ab1712dd3eda0:
//   slug = meta.get('slug') or slugify(title)          (main, and build_post)
//   def slugify(title):
//       s = title.lower()
//       s = re.sub(r'[^a-z0-9\s-]', '', s)
//       s = re.sub(r'\s+', '-', s)
//       return s.strip('-')
// and parse_frontmatter reads a flat `key: value` line as `val.strip().strip('"').strip("'")`
// with `re.match(r'(\w+):\s*(.+)', line)`: anchored at the start of the line, so an indented line
// or a comment (`# slug: old`) is not a key. Both are ported faithfully, because a reader that
// matched mid-line would resolve a route the build never writes.
//
// The draft's file name is not the route: `content/drafts/<title-slug>-<YYYY-MM-DD>.md` is a
// convention, and real drafts either carry a `slug` unrelated to the file name or carry none at
// all. A mapping that guessed from the file name would point a change at the wrong post, so it
// reads the drafts and compares their slugs instead.

export interface PilotFrontmatter {
  /** Flat keys, as the pilot's parser reads them (a `[a, b]` value becomes a list). */
  meta: Record<string, string | string[]>;
  body: string;
}

/** The pilot's slugify: lowercase, drop everything but `[a-z0-9 -]`, spaces to `-`, trim `-`. */
export function pilotSlugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Parse the frontmatter the way the pilot's `parse_frontmatter` does. */
export function parsePilotFrontmatter(text: string): PilotFrontmatter {
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const open = text.indexOf('---');
  const close = text.indexOf('---', open + 3);
  if (close === -1) return { meta: {}, body: text };
  const raw = text.slice(open + 3, close).trim();
  const body = text.slice(close + 3).trim();
  const meta: Record<string, string | string[]> = {};
  for (const line of raw.split('\n')) {
    // `re.match` anchors at the start; Python's `\w` is Unicode-aware, so letters and digits are
    // key characters here too. Without the anchor a `# slug: ignored` comment reads as a slug.
    const matched = /^([\p{L}\p{N}_]+):\s*(.+)/u.exec(line);
    if (!matched) continue;
    const key = matched[1]!;
    const value = matched[2]!.trim().replace(/^"+/, '').replace(/"+$/, '').replace(/^'+/, '').replace(/'+$/, '');
    if (value.startsWith('[') && value.endsWith(']')) {
      meta[key] = value
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim().replace(/^"+/, '').replace(/"+$/, '').replace(/^'+/, '').replace(/'+$/, ''));
    } else {
      meta[key] = value;
    }
  }
  return { meta, body };
}

/** The `slug` the pilot's build gives a draft, or null when it has neither a slug nor a title. */
export function pilotSlug(text: string): string | null {
  const { meta } = parsePilotFrontmatter(text);
  const declared = meta.slug;
  if (typeof declared === 'string' && declared !== '') return declared;
  const title = meta.title;
  if (typeof title !== 'string' || title === '') return null;
  return pilotSlugify(title);
}
