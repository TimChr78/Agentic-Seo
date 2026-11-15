import type { ActionClass } from '@agentic-seo/commands';
import { z } from 'zod';
import { type Refusal, refuse } from './refusal';

// The Phase 1 change types (ADR-0007, domain-model.md §4). A change is one typed edit to one URL,
// written by an agent or a person, stored in a change-set artifact, mapped to a source file, applied
// through a connector and verified by a re-crawl. The schemas are the contract between those steps:
// the mapping and editors accept nothing the catalogue does not define, and the JSON Schema export
// is what `change-types://catalogue` will serve to MCP clients.
//
// The catalogue is deliberately small. Adding a type means adding its schema, its action class, the
// editor support for it and the verification it promises; a type that cannot be verified is not a
// change, it is a wish.

/** The action classes a Phase 1 change can belong to (agents-and-autonomy.md §3). */
const CHANGE_ACTION_CLASSES = ['site.content', 'site.structural'] as const satisfies readonly ActionClass[];
type ChangeActionClass = (typeof CHANGE_ACTION_CLASSES)[number];

/** The longest text a single change may carry; page titles and descriptions are far below this. */
const MAX_TEXT = 2_000;
const MAX_URL = 2_048;

const Url = z.string().min(1).max(MAX_URL).describe('The absolute URL of the page the change is about, e.g. https://example.com/about/');

/**
 * The sha256 of the source file as it was when the change was drafted (`sourceHashOf`). Optional:
 * a change that does not carry one is checked against `before` alone. When it does, every editor
 * refuses a file that hashes to something else, which is what makes an edit safe when the file does
 * not carry the value being replaced: the frontmatter editor requires it to insert a missing key.
 */
const SourceHash = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'Use the sha256 hex of the source file, from sourceHashOf().')
  .optional()
  .describe('The sha256 of the source file when the change was drafted; the editor refuses a file that differs (stale)');

/** `@type` and/or `@id`, the two fields a JSON-LD block can be identified by. */
export const JsonLdMatchSchema = z
  .strictObject({
    '@type': z
      .union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).min(1).max(20)])
      .optional()
      .describe('The schema.org type of the block, e.g. Article or FAQPage; an array means any of them'),
    '@id': z.string().min(1).max(MAX_URL).optional().describe("The block's @id, e.g. https://example.com/about/#webpage"),
  })
  .refine((match) => match['@type'] !== undefined || match['@id'] !== undefined, {
    message: 'Give @type, @id, or both, so the block can be found.',
  });

export const MetaTitleChange = z.strictObject({
  type: z.literal('meta.title'),
  url: Url,
  before: z.string().max(MAX_TEXT).describe('The title the page shows now; the editor refuses if the file disagrees'),
  after: z.string().min(1).max(MAX_TEXT).describe('The title to write, without HTML'),
  sourceHash: SourceHash,
});

export const MetaDescriptionChange = z.strictObject({
  type: z.literal('meta.description'),
  url: Url,
  before: z.string().max(MAX_TEXT).nullable().describe('The description the page shows now; null when it has none, which inserts the tag'),
  after: z.string().min(1).max(MAX_TEXT).describe('The description to write, without HTML'),
  sourceHash: SourceHash,
});

export const SchemaJsonLdChange = z
  .strictObject({
    type: z.literal('schema.jsonld'),
    url: Url,
    operation: z.enum(['add', 'replace', 'remove']).describe('add a new block, replace the matching block, or remove it'),
    match: JsonLdMatchSchema.describe('Which block this change is about'),
    before: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'Use the sha256 hex of the block body from jsonLdBlockHash().')
      .nullable()
      .describe('The hash of the block being replaced or removed; null for add'),
    after: z.unknown().nullable().describe('The JSON-LD object to write (a schema.org node or a @graph); null when removing'),
    sourceHash: SourceHash,
  })
  .superRefine((change, ctx) => {
    if (change.operation === 'add') {
      if (change.before !== null) ctx.addIssue({ code: 'custom', path: ['before'], message: 'An added block has no before hash.' });
      if (typeof change.after !== 'object' || change.after === null || Array.isArray(change.after)) {
        ctx.addIssue({ code: 'custom', path: ['after'], message: 'An added block needs a JSON object.' });
      }
      return;
    }
    if (change.before === null) {
      ctx.addIssue({ code: 'custom', path: ['before'], message: 'Replacing or removing a block needs the hash of the block it names.' });
    }
    if (change.operation === 'replace' && (typeof change.after !== 'object' || change.after === null || Array.isArray(change.after))) {
      ctx.addIssue({ code: 'custom', path: ['after'], message: 'A replacement block needs a JSON object.' });
    }
    if (change.operation === 'remove' && change.after !== null) {
      ctx.addIssue({ code: 'custom', path: ['after'], message: 'A removed block has no after value; use null.' });
    }
  });

export const ImageAltChange = z.strictObject({
  type: z.literal('image.alt'),
  url: Url,
  src: z.string().min(1).max(MAX_URL).describe('The image src as the page shows it; the absolute URL from PageFacts is accepted'),
  /**
   * A relative `src` means what the document's `<base href>` makes it mean, and the crawler records
   * the absolute URL. PageFacts carries no `<base>`, so the editor reports the absolute URL it
   * matched here and verification compares against that. A change drafted from PageFacts already
   * carries an absolute `src` and does not need it. A caller-supplied value is never trusted: the
   * editor refuses one that is not the URL it matched, and `applyChange` returns the matched URL as
   * the change to verify.
   */
  resolvedSrc: z
    .string()
    .min(1)
    .max(MAX_URL)
    .optional()
    .describe(
      'The absolute src the editor matched through the page base href. The editor refuses a value that differs from what it matched and reports the one it used.',
    ),
  before: z.string().max(MAX_TEXT).nullable().describe('The alt the image has now; null when the attribute is missing'),
  after: z.string().max(MAX_TEXT).describe('The alt to write; an empty string marks a decorative image'),
  sourceHash: SourceHash,
});

const RedirectStatus = z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]);

/**
 * The refusal for a pattern rule: Phase 1 writes one URL at a time (ADR-0007, review round 3).
 * Patterns are a person's edit, because deciding what a pattern graph does for every path is not
 * something a change can prove here.
 */
export const REDIRECT_PATTERN_MESSAGE = 'Pattern redirects are written by people in Phase 1; this change can only add a rule for one URL.';

/**
 * Whether a redirect field is a pattern rather than one URL: a `*` splat or a `:name` path segment.
 * The path of an absolute URL is checked too, so `https://example.com/*` is refused as a target.
 */
export function isRedirectPattern(value: string): boolean {
  let path = value;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      path = new URL(value).pathname;
    } catch {
      path = value;
    }
  }
  const query = path.indexOf('?');
  if (query !== -1) path = path.slice(0, query);
  const hash = path.indexOf('#');
  if (hash !== -1) path = path.slice(0, hash);
  if (path.includes('*')) return true;
  return path.split('/').some((segment) => segment.startsWith(':'));
}

/**
 * Why a value cannot be written to a Netlify/Cloudflare Pages redirects file, or null when it can.
 *
 * The format is whitespace-separated with one rule per line. A comment starts with `#` at the start
 * of a line, or after whitespace (an inline comment such as `/a /b 301 # note`), so a `#` inside a
 * token is not a comment. The source is a path, never a URL or a fragment. The target is a path or
 * an absolute http(s) URL, and both Cloudflare Pages and Netlify accept a fragment on it
 * (`/new-page#section`), so `#` is allowed there as long as it is inside the token: whitespace is
 * rejected outright, which is what makes ` #` an inline comment and `/new#section` a target.
 *
 * A Phase 1 change writes one literal rule: a `*` or a `:name` segment is refused with
 * `REDIRECT_PATTERN_MESSAGE`, because patterns are a person's edit.
 *
 * Whitespace or a control character would be read back as extra fields — a target of
 * `/target 301\n/admin https://evil.test 302\n#` writes a second, unreviewed rule — so both are
 * refused. A target of `javascript:` or `data:` is not a redirect either.
 */
export function redirectTokenProblem(value: string, role: 'from' | 'to'): string | null {
  const what = role === 'from' ? 'source' : 'target';
  if (/[\s\p{Cc}]/u.test(value)) {
    return `The redirect ${what} contains whitespace or a control character, which would split it into extra fields in the redirects file.`;
  }
  if (isRedirectPattern(value)) return REDIRECT_PATTERN_MESSAGE;
  if (role === 'from' && value.includes('#')) {
    return 'The redirect source contains "#": a redirect matches a path, and "#" would start a fragment or a comment in the redirects file.';
  }
  if (value.startsWith('//')) {
    return `The redirect ${what} starts with "//", a protocol-relative URL; give a path ("/...") or an absolute http(s) URL.`;
  }
  if (value.startsWith('/')) return null;
  if (role === 'from') return 'The redirect source must be a path starting with "/".';
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return null;
  } catch {
    // Fall through to the shared message: it is not an absolute URL either.
  }
  return 'The redirect target must be a path starting with "/" or an absolute http(s) URL.';
}

const RedirectFrom = z
  .string()
  .min(1)
  .max(MAX_URL)
  .superRefine((value, ctx) => {
    const problem = redirectTokenProblem(value, 'from');
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  })
  .describe('The path that redirects, e.g. /old-page/');

const RedirectTo = z
  .string()
  .min(1)
  .max(MAX_URL)
  .superRefine((value, ctx) => {
    const problem = redirectTokenProblem(value, 'to');
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  })
  .describe('The new target: a path or an absolute http(s) URL, optionally with a fragment');

export const RedirectChange = z
  .strictObject({
    type: z.literal('redirect'),
    from: RedirectFrom,
    to: RedirectTo.optional().describe('The new target: a path or an absolute URL; not used by remove'),
    status: RedirectStatus.optional().describe('The status to answer with; not used by remove'),
    operation: z.enum(['add', 'update', 'remove']),
    before: z
      .strictObject({ to: RedirectTo, status: RedirectStatus })
      .optional()
      .describe('The rule as it is now, for update and remove; the editor refuses if the file disagrees'),
    sourceHash: SourceHash,
  })
  .superRefine((change, ctx) => {
    if (change.operation !== 'remove') {
      if (change.to === undefined) ctx.addIssue({ code: 'custom', path: ['to'], message: 'An added or updated redirect needs a target.' });
      if (change.status === undefined)
        ctx.addIssue({ code: 'custom', path: ['status'], message: 'An added or updated redirect needs a status.' });
    }
    if (change.operation !== 'add' && change.before === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['before'],
        message: 'An updated or removed redirect needs the rule it replaces (`before`), so a changed file is noticed.',
      });
    }
  });

export const ChangeSchema = z.discriminatedUnion('type', [
  MetaTitleChange,
  MetaDescriptionChange,
  SchemaJsonLdChange,
  ImageAltChange,
  RedirectChange,
]);

export type MetaTitleChange = z.infer<typeof MetaTitleChange>;
export type MetaDescriptionChange = z.infer<typeof MetaDescriptionChange>;
export type SchemaJsonLdChange = z.infer<typeof SchemaJsonLdChange>;
export type ImageAltChange = z.infer<typeof ImageAltChange>;
export type RedirectChange = z.infer<typeof RedirectChange>;
export type Change = z.infer<typeof ChangeSchema>;
export type ChangeTypeName = Change['type'];

/** Which editor can write which change type (a mapping rule adds the file-level half of this). */
export type SourceEditor = 'html' | 'markdown_frontmatter';
export type EditorName = SourceEditor | 'netlify';

export const CHANGE_TYPES: readonly ChangeTypeName[] = ['meta.title', 'meta.description', 'schema.jsonld', 'image.alt', 'redirect'];

export interface ChangeTypeDefinition {
  type: ChangeTypeName;
  title: string;
  /** Written for an LLM choosing a tool: what the change does, when to use it, what it needs. */
  summary: string;
  actionClass: ChangeActionClass;
  /** What a re-fetch must show for the change to count as applied. */
  verify: string;
  schema: z.ZodType;
  /** The machine-readable schema `change-types://catalogue` will serve. */
  jsonSchema: Record<string, unknown>;
}

const definitions: readonly Omit<ChangeTypeDefinition, 'jsonSchema'>[] = [
  {
    type: 'meta.title',
    title: 'Page title',
    summary:
      'Replace the <title> text of one page. Use it on a page whose title is too long, duplicated or does not match search intent. The change names the title the page shows now; if the source file disagrees, it is refused as stale rather than overwriting a newer edit.',
    actionClass: 'site.content',
    verify:
      'Fetch the URL again: the first <title> in the head must equal `after`, and the change is not applied until the deployed page shows it.',
    schema: MetaTitleChange,
  },
  {
    type: 'meta.description',
    title: 'Meta description',
    summary:
      'Replace or add the <meta name="description"> of one page. Use it when the search snippet is missing, truncated or generic. The change names the current description, or null when the page has none; a file that disagrees is refused as stale.',
    actionClass: 'site.content',
    verify: 'Fetch the URL again: the first meta description must equal `after`.',
    schema: MetaDescriptionChange,
  },
  {
    type: 'schema.jsonld',
    title: 'Structured data block',
    summary:
      'Add, replace or remove one JSON-LD block, identified by @type and/or @id. Use it to add or correct structured data on a page that already has HTML source. Not available on Markdown-frontmatter sources: their schema comes from the site build template.',
    actionClass: 'site.content',
    verify:
      'Fetch the URL again: exactly one block matches, its parsed JSON equals `after` (key order is ignored), and for remove no block matches any more.',
    schema: SchemaJsonLdChange,
  },
  {
    type: 'image.alt',
    title: 'Image alt text',
    summary:
      'Set the alt attribute of one <img>, identified by its src. Use it on a meaningful image with a missing, empty or unhelpful alt. The editor refuses when no image or more than one image matches the src. An empty `after` marks a decorative image.',
    actionClass: 'site.content',
    verify:
      'Fetch the URL again: exactly one image with the same src has alt equal to `after` (an empty string is present and empty, not missing).',
    schema: ImageAltChange,
  },
  {
    type: 'redirect',
    title: 'Redirect rule',
    summary:
      "Add, update or remove one rule in the site's redirects file, for one URL. Use it to send an old URL to its replacement. `from` and `to` are literal paths or an absolute URL: a `*` splat or a `:name` segment is a pattern rule, which a person writes by hand in Phase 1. The editor refuses loops and chains (following the file's first-match-wins order) and suggests the final target instead. Redirecting more than 20 URLs is a fixed rule: it always needs a person.",
    actionClass: 'site.structural',
    verify:
      'Fetch the `from` URL again: it must answer with the configured status and a Location header resolving to `to`; for remove it must not redirect.',
    schema: RedirectChange,
  },
];

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  // zod's exporter does not need the refinements: they repeat constraints the object fields carry,
  // and a refinement it cannot express would otherwise throw at module load.
  return z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }) as Record<string, unknown>;
}

/** The Phase 1 catalogue, in the order the UI and the docs show it. */
export const changeTypeCatalogue: readonly ChangeTypeDefinition[] = definitions.map((definition) => ({
  ...definition,
  jsonSchema: jsonSchema(definition.schema),
}));

export function changeTypeDefinition(type: ChangeTypeName): ChangeTypeDefinition {
  const found = changeTypeCatalogue.find((definition) => definition.type === type);
  if (!found) throw new Error(`${type} is not in the change catalogue`);
  return found;
}

/** The action class of a change, which the policy engine decides autonomy against. */
export function actionClassFor(change: Change): ActionClass {
  return changeTypeDefinition(change.type).actionClass;
}

/** The URL a change is about; a redirect is about the path it moves. */
export function urlOf(change: Change): string {
  return change.type === 'redirect' ? change.from : change.url;
}

/** Parse an untrusted value into a change, with zod's message as the refusal reason. */
export function parseChange(value: unknown): { ok: true; change: Change } | Refusal {
  const parsed = ChangeSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return refuse('invalid', first ? `${first.path.join('.') || 'change'}: ${first.message}` : 'The change is not valid.');
  }
  return { ok: true, change: parsed.data };
}
