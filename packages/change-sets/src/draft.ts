import type { ChangeSetDraftedChange } from '@agentic-seo/artifacts';
import {
  applyChange,
  type Change,
  type EditorName,
  type FieldMap,
  type FrontmatterDialect,
  findJsonLd,
  frontmatterValue,
  type Refusal,
  type RefusalCode,
  redirectRules,
  refuse,
  renderDiff,
  resolveRedirects,
  resolveSource,
  type SiteMapping,
  sameImageSource,
  sourceHashOf,
  urlOf,
} from '@agentic-seo/changes';
import { extractHtml, type HtmlFacts } from '@agentic-seo/crawl';

// Drafting a change set means proving it can be applied before anyone is asked to review it. Each
// change is resolved through the site's mapping to a repository file, the editor applies it in
// memory (so a refusal is caught here, not in a worker after approval), and the result records the
// base commit, the file's sha256 and the rendered diff.
//
// The same code runs when the change set is applied: the worker re-reads every file at the current
// base head, compares `sourceHash`, and re-applies the changes in the same order to build the
// commit. One function, so "what was reviewed" and "what is written" cannot disagree.

/** Everything drafting and applying need from the repository, resolved at one commit. */
export interface DraftDeps {
  mapping: SiteMapping;
  baseSha: string;
  /** Repository paths under a prefix at baseSha (packages/changes' `listFiles`). */
  listFiles: (prefix: string) => Promise<readonly string[]>;
  /** A file's text at baseSha. */
  readFile: (path: string) => Promise<string>;
}

/** One change the library refused, with the change's own place in the set. */
export interface DraftRefusal {
  index: number;
  url: string;
  code: RefusalCode;
  reason: string;
  details?: Record<string, unknown>;
}

export interface DraftedFile {
  path: string;
  editor: EditorName;
  before: string;
  after: string;
}

export interface DraftOutcome {
  drafted: ChangeSetDraftedChange[];
  refusals: DraftRefusal[];
  /** The net edit per file, in the order the changes touched them. */
  files: DraftedFile[];
}

/** The change-set content a draft produces, without the fields the caller supplies. */
export interface DraftResult extends DraftOutcome {
  /** Every route the drafted changes reach, for the reach estimate. */
  affectedUrls: string[];
}

function refusalFrom(index: number, url: string, refusal: Refusal): DraftRefusal {
  return {
    index,
    url,
    code: refusal.code,
    reason: refusal.reason,
    ...(refusal.details ? { details: refusal.details } : {}),
  };
}

interface ResolvedSource {
  path: string;
  editor: EditorName;
  confidence: 'exact' | 'pattern' | 'glob';
  affectedRoutes: string[];
  fields?: FieldMap;
  dialect?: FrontmatterDialect;
}

/**
 * Resolve one change to its source file. A redirect edits the mapping's redirects file; everything
 * else resolves through the route rules. A route that only a shared layout renders is refused: a
 * layout edit reaches every page it renders, so it is a person's deliberate change, not something a
 * single-URL change may do by accident.
 */
async function resolveFor(change: Change, deps: DraftDeps, fileCache: Map<string, Promise<string>>): Promise<ResolvedSource | Refusal> {
  if (change.type === 'redirect') {
    const redirects = resolveRedirects(deps.mapping);
    if (!redirects.ok) return redirects;
    return { path: redirects.path, editor: 'netlify', confidence: 'exact', affectedRoutes: [urlOf(change)] };
  }
  const resolved = await resolveSource(deps.mapping, urlOf(change), {
    listFiles: deps.listFiles,
    readFile: deps.readFile,
    changeType: change.type,
    fileCache,
  });
  if (!resolved.ok) return resolved;
  return {
    path: resolved.path,
    editor: resolved.editor,
    confidence: resolved.confidence,
    affectedRoutes: resolved.affectedRoutes,
    fields: resolved.fields,
    dialect: resolved.dialect,
  };
}

/** Reads a file once per draft. */
function reader(deps: DraftDeps, cache: Map<string, Promise<string>>) {
  return (path: string): Promise<string> => {
    const cached = cache.get(path);
    if (cached) return cached;
    const reading = deps.readFile(path);
    cache.set(path, reading);
    void reading.catch(() => cache.delete(path));
    return reading;
  };
}

/**
 * Resolve, apply and record every change, in order. Changes that touch one file accumulate, so the
 * commit is the net edit and two changes to one page do not overwrite each other.
 */
export async function draftChanges(changes: readonly Change[], deps: DraftDeps): Promise<DraftResult> {
  const cache = new Map<string, Promise<string>>();
  const read = reader(deps, cache);
  const originals = new Map<string, string>();
  const current = new Map<string, string>();
  const editors = new Map<string, EditorName>();
  const order: string[] = [];
  const drafted: ChangeSetDraftedChange[] = [];
  const refusals: DraftRefusal[] = [];
  const affected = new Set<string>();

  for (const [index, change] of changes.entries()) {
    const url = urlOf(change);
    let resolved: ResolvedSource | Refusal;
    try {
      resolved = await resolveFor(change, deps, cache);
    } catch (error) {
      // Reading a repository file failed (a network error, a missing file): a refusal per change,
      // so the caller sees which change could not be resolved rather than a stack trace.
      refusals.push({
        index,
        url,
        code: 'not_found',
        reason: `The source for ${url} could not be read from the repository: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if ('ok' in resolved) {
      refusals.push(refusalFrom(index, url, resolved));
      continue;
    }

    let original: string;
    try {
      original = originals.get(resolved.path) ?? (await read(resolved.path));
    } catch (error) {
      refusals.push({
        index,
        url,
        code: 'not_found',
        reason: `The file ${resolved.path} could not be read from the repository: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (!originals.has(resolved.path)) {
      originals.set(resolved.path, original);
      current.set(resolved.path, original);
      editors.set(resolved.path, resolved.editor);
      order.push(resolved.path);
    }

    const outcome = applyChange({
      editor: resolved.editor,
      text: current.get(resolved.path) ?? original,
      change,
      ...(resolved.fields ? { fields: resolved.fields } : {}),
      ...(resolved.dialect ? { dialect: resolved.dialect } : {}),
    });
    if (!outcome.ok) {
      refusals.push(refusalFrom(index, url, outcome));
      continue;
    }
    if (!outcome.changed) {
      refusals.push({
        index,
        url,
        code: 'invalid',
        reason: `The source already carries this value, so the change would do nothing. Remove it, or draft a different change.`,
        details: { path: resolved.path },
      });
      continue;
    }

    current.set(resolved.path, outcome.text);
    const diff = renderDiff({ files: [{ path: resolved.path, before: original, after: outcome.text }] }).files[0]!;
    drafted.push({
      change: outcome.verifyTarget,
      source: {
        path: resolved.path,
        editor: resolved.editor,
        confidence: resolved.confidence,
        affectedRoutes: resolved.affectedRoutes,
        ...(resolved.editor === 'markdown_frontmatter' && resolved.fields
          ? { fields: Object.fromEntries(Object.entries(resolved.fields).map(([field, keys]) => [field, [...(keys ?? [])]])) }
          : {}),
        ...(resolved.editor === 'markdown_frontmatter' && resolved.dialect ? { dialect: resolved.dialect } : {}),
      },
      baseSha: deps.baseSha,
      sourceHash: sourceHashOf(original),
      diff,
    });
    for (const route of resolved.affectedRoutes) affected.add(route);
    affected.add(url);
  }

  const files: DraftedFile[] = order.map((path) => ({
    path,
    editor: editors.get(path) ?? 'html',
    before: originals.get(path) ?? '',
    after: current.get(path) ?? '',
  }));
  return { drafted, refusals, files, affectedUrls: [...affected] };
}

/**
 * The inverse of one drafted change, for a rollback, read against the file as it is now.
 *
 * `before` on the inverse is the value the file carries *today*, not the value the original change
 * replaced: a rollback proposed after a later edit would otherwise be refused as stale by the very
 * editor that is supposed to apply it. The original change's `before` is what the inverse restores
 * (`after`). A field the change cannot express — an inserted description, a removed JSON-LD block
 * whose contents were never stored — is refused with the reason, and the caller says which changes
 * it could not reverse instead of writing a revert that silently omits them.
 */
export interface InvertibleDraft {
  change: Change;
  source: { editor: EditorName; fields?: FieldMap };
}

function tryExtract(text: string, change: Change): HtmlFacts | null {
  try {
    return extractHtml(text, { baseUrl: 'url' in change ? change.url : 'https://example.invalid/', hosts: [] });
  } catch {
    return null;
  }
}

function frontmatterCurrent(drafted: InvertibleDraft, text: string | null): string | null {
  if (text === null) return null;
  for (const key of drafted.source.fields?.title ?? []) {
    const value = frontmatterValue(text, key);
    if (value !== null) return value;
  }
  return null;
}

export function inverseOf(drafted: InvertibleDraft, currentText: string | null): { ok: true; change: Change } | Refusal {
  const { change } = drafted;
  const html = currentText !== null && drafted.source.editor === 'html' ? tryExtract(currentText, change) : null;
  switch (change.type) {
    case 'meta.title': {
      // The page title the source carries now: the HTML title tag, or the frontmatter key the build
      // reads its title from.
      const current =
        drafted.source.editor === 'markdown_frontmatter' ? frontmatterCurrent(drafted, currentText) : (html?.title ?? change.before);
      if (current === null) {
        return refuse(
          'not_found',
          `${change.url} has no title in its source any more, so the original title cannot be restored as a change. Edit that page by hand.`,
        );
      }
      return { ok: true, change: { type: 'meta.title', url: change.url, before: current, after: change.before } };
    }
    case 'meta.description': {
      if (change.before === null) {
        return refuse(
          'unsupported',
          `${change.url} had no meta description before this change, and a change cannot remove one. Edit that page by hand.`,
        );
      }
      const current =
        drafted.source.editor === 'markdown_frontmatter' ? frontmatterCurrent(drafted, currentText) : (html?.metaDescription ?? null);
      if (current === null) {
        return refuse('not_found', `${change.url} has no meta description in its source any more, so it cannot be restored as a change.`);
      }
      return { ok: true, change: { type: 'meta.description', url: change.url, before: current, after: change.before } };
    }
    case 'image.alt': {
      const src = change.resolvedSrc ?? change.src;
      if (change.before === null) {
        return refuse('unsupported', `The image ${src} had no alt attribute before this change, and a change cannot remove one.`);
      }
      const image = html?.images.find((candidate) => candidate.src !== null && sameImageSource(candidate.src, src, change.url));
      if (!image || image.alt === null) {
        return refuse(
          'not_found',
          `The image ${src} is not on the page source with an alt attribute any more, so it cannot be restored as a change.`,
        );
      }
      return { ok: true, change: { type: 'image.alt', url: change.url, src, before: image.alt, after: change.before } };
    }
    case 'schema.jsonld':
      if (change.operation !== 'add') {
        return refuse(
          'unsupported',
          `The structured-data change on ${change.url} replaced or removed a block; its previous contents are not stored, so it cannot be restored automatically. Add the block by hand.`,
        );
      }
      if (currentText === null) {
        return refuse('not_found', `The page source for ${change.url} could not be read, so the added JSON-LD block cannot be found.`);
      }
      {
        const found = findJsonLd(currentText, change.match);
        if (!found) {
          return refuse(
            'not_found',
            `No single JSON-LD block on ${change.url} matches ${change.match['@type'] ?? change.match['@id'] ?? 'the change'}, so it cannot be removed.`,
          );
        }
        return {
          ok: true,
          change: { type: 'schema.jsonld', url: change.url, operation: 'remove', match: change.match, before: found.hash, after: null },
        };
      }
    case 'redirect': {
      const current = currentText === null ? null : (redirectRules(currentText).find((rule) => rule.from === change.from) ?? null);
      if (change.operation === 'add') {
        return {
          ok: true,
          change: {
            type: 'redirect',
            from: change.from,
            operation: 'remove',
            before: current
              ? { to: current.to, status: current.status as 301 | 302 | 307 | 308 }
              : { to: change.to!, status: change.status! },
          },
        };
      }
      if (change.operation === 'remove') {
        return {
          ok: true,
          change: { type: 'redirect', from: change.from, to: change.before!.to, status: change.before!.status, operation: 'add' },
        };
      }
      return {
        ok: true,
        change: {
          type: 'redirect',
          from: change.from,
          to: change.before!.to,
          status: change.before!.status,
          operation: 'update',
          before: current
            ? { to: current.to, status: current.status as 301 | 302 | 307 | 308 }
            : { to: change.to!, status: change.status! },
        },
      };
    }
  }
}
