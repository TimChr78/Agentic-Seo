import { parseDocument } from 'htmlparser2';
import type { ImageAltChange, MetaDescriptionChange, MetaTitleChange, SchemaJsonLdChange } from '../change-types';
import { describeMatch, type JsonLdMatch, jsonLdBlockHash, matchesJsonLd, serialiseJsonLd } from '../jsonld';
import { type Refusal, refuse } from '../refusal';
import { sourceHashRefusal } from '../source';
import { imageSourceUrl, normaliseUrl } from '../urls';

// The HTML editor. Files are edited at source offsets, not re-serialised: a whole-document
// round-trip through a parser rewrites attribute quoting, entity spelling and whitespace, which
// turns a one-line SEO change into an unreviewable diff. htmlparser2 gives the tokenizer's byte
// offsets (`startIndex`/`endIndex`) so the edit replaces exactly the span it names and every byte
// outside it is preserved.
//
// The editor is pure. It checks the change's `before` against the file and refuses as stale rather
// than overwriting an edit that landed after the change was drafted. It never fetches and never
// reads another file.

/** A node from htmlparser2's DOM, as much of it as this editor uses. */
interface DomNode {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
  startIndex: number | null;
  endIndex: number | null;
}

interface AttrSpan {
  name: string;
  nameStart: number;
  nameEnd: number;
  valueStart: number | null;
  valueEnd: number | null;
  quote: '"' | "'" | null;
}

interface TagSpan {
  name: string;
  start: number;
  /** The index of the closing `>` of the start tag. */
  openEnd: number;
  attrs: AttrSpan[];
  selfClosing: boolean;
}

export type HtmlEditOutcome = { ok: true; text: string; changed: boolean; resolvedSrc?: string } | Refusal;

function isElement(node: DomNode): boolean {
  return node.type === 'tag' || node.type === 'script' || node.type === 'style';
}

function elements(root: DomNode): DomNode[] {
  const found: DomNode[] = [];
  const visit = (node: DomNode): void => {
    if (isElement(node)) found.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return found;
}

function nameOf(node: DomNode): string {
  return (node.name ?? '').toLowerCase();
}

function attribute(node: DomNode, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(node.attribs ?? {})) if (key.toLowerCase() === wanted) return value;
  return undefined;
}

/** The exact text inside an element, entity-decoded (htmlparser2 decodes text nodes). */
function innerText(node: DomNode): string {
  return (node.children ?? []).map((child) => (child.type === 'text' ? (child.data ?? '') : '')).join('');
}

/** The byte range of an element's inner content; empty elements have none (insert at the open tag). */
function innerRange(node: DomNode): { start: number; end: number } | null {
  const children = node.children ?? [];
  const first = children[0];
  const last = children[children.length - 1];
  if (first && last && first.startIndex !== null && last.endIndex !== null) return { start: first.startIndex, end: last.endIndex + 1 };
  return null;
}

/**
 * Scans a start tag at `start`, capturing each attribute's name and value offsets. Written by hand
 * because htmlparser2's DOM exposes decoded attributes but not where their bytes are; a quote-aware
 * scan is what lets `content` and `alt` be replaced without touching the attributes around them.
 */
export function scanTag(html: string, start: number): TagSpan | null {
  if (html[start] !== '<' || html[start + 1] === '/' || html[start + 1] === '!') return null;
  let index = start + 1;
  const nameStart = index;
  while (index < html.length && !/[\s/>]/.test(html[index]!)) index += 1;
  const name = html.slice(nameStart, index);
  if (!name) return null;
  const attrs: AttrSpan[] = [];
  let selfClosing = false;
  while (index < html.length) {
    while (index < html.length && /\s/.test(html[index]!)) index += 1;
    if (index >= html.length) return null;
    if (html[index] === '>') return { name, start, openEnd: index, attrs, selfClosing };
    if (html[index] === '/') {
      selfClosing = true;
      index += 1;
      continue;
    }
    const attrNameStart = index;
    while (index < html.length && !/[\s=/>]/.test(html[index]!)) index += 1;
    const attrNameEnd = index;
    let valueStart: number | null = null;
    let valueEnd: number | null = null;
    let quote: '"' | "'" | null = null;
    while (index < html.length && /\s/.test(html[index]!)) index += 1;
    if (html[index] === '=') {
      index += 1;
      while (index < html.length && /\s/.test(html[index]!)) index += 1;
      const quoteChar = html[index];
      if (quoteChar === '"' || quoteChar === "'") {
        quote = quoteChar;
        index += 1;
        valueStart = index;
        while (index < html.length && html[index] !== quoteChar) index += 1;
        valueEnd = index;
        if (html[index] === quoteChar) index += 1;
      } else {
        valueStart = index;
        while (index < html.length && !/[\s>]/.test(html[index]!)) index += 1;
        valueEnd = index;
      }
    }
    attrs.push({
      name: html.slice(attrNameStart, attrNameEnd),
      nameStart: attrNameStart,
      nameEnd: attrNameEnd,
      valueStart,
      valueEnd,
      quote,
    });
  }
  return null;
}

function attributeSpan(tag: TagSpan, name: string): AttrSpan | undefined {
  const wanted = name.toLowerCase();
  return tag.attrs.find((attr) => attr.name.toLowerCase() === wanted);
}

/** Encode a value for HTML text or an attribute value. `&` first, so nothing is double-encoded. */
export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function lineEndingOf(html: string): '\n' | '\r\n' {
  return html.includes('\r\n') ? '\r\n' : '\n';
}

function lineIndent(html: string, index: number): string {
  const lineStart = html.lastIndexOf('\n', index - 1) + 1;
  return /^[ \t]*/.exec(html.slice(lineStart))?.[0] ?? '';
}

function replaceRange(html: string, start: number, end: number, text: string): string {
  return html.slice(0, start) + text + html.slice(end);
}

/** Insert an element after another, on its own line at the same indentation. */
function insertAfter(html: string, node: DomNode, markup: string): string {
  const index = (node.endIndex ?? html.length - 1) + 1;
  return replaceRange(html, index, index, `${lineEndingOf(html)}${lineIndent(html, node.startIndex ?? index)}${markup}`);
}

function headElement(root: DomNode): DomNode | undefined {
  return elements(root).find((node) => nameOf(node) === 'head');
}

/** Insert before `</head>`; the closing tag's own indentation is reused for the new element. */
function insertBeforeHeadClose(html: string, head: DomNode, markup: string): string | null {
  if (head.endIndex === null) return null;
  const close = html.toLowerCase().lastIndexOf('</head', head.endIndex);
  if (close === -1) return null;
  const lineStart = html.lastIndexOf('\n', close - 1) + 1;
  const indent = /^[ \t]*/.exec(html.slice(lineStart))?.[0] ?? '';
  const whitespaceOnly = /^[ \t]*$/.test(html.slice(lineStart, close));
  return whitespaceOnly
    ? replaceRange(html, close, close, `${markup}${lineEndingOf(html)}`)
    : replaceRange(html, close, close, `${lineEndingOf(html)}${indent}${markup}`);
}

function parse(html: string): DomNode {
  return parseDocument(html, { withStartIndices: true, withEndIndices: true }) as unknown as DomNode;
}

function insertIntoHead(html: string, root: DomNode, title: DomNode | undefined, markup: string): string | Refusal {
  if (title) return insertAfter(html, title, markup);
  const head = headElement(root);
  if (!head) return refuse('not_found', 'The file has no <head> element, so an element cannot be inserted there.');
  const inserted = insertBeforeHeadClose(html, head, markup);
  if (inserted === null) return refuse('invalid', 'The <head> element is not closed, so an element cannot be inserted there.');
  return inserted;
}

/** The `alt`/`content` value replacement, preserving the attribute's quote style. */
function setAttribute(html: string, tag: TagSpan, name: string, value: string): string {
  const attr = attributeSpan(tag, name);
  const encoded = escapeHtml(value);
  if (!attr) {
    const insertAt = tag.selfClosing ? tag.openEnd - 1 : tag.openEnd;
    return replaceRange(html, insertAt, insertAt, ` ${name}="${encoded}"`);
  }
  if (attr.valueStart === null || attr.valueEnd === null) {
    return replaceRange(html, attr.nameEnd, attr.nameEnd, `="${encoded}"`);
  }
  // An unquoted value cannot contain spaces or quotes safely once it is replaced, so it gains quotes.
  return replaceRange(html, attr.valueStart, attr.valueEnd, attr.quote === null ? `"${encoded}"` : encoded);
}

function sameText(current: string, expected: string): boolean {
  return current === expected || current.trim() === expected.trim();
}

/** Replace the first <title>; refuses when there is none or more than one. */
function editTitle(html: string, change: MetaTitleChange): HtmlEditOutcome {
  const root = parse(html);
  const titles = elements(root).filter((node) => nameOf(node) === 'title');
  if (titles.length === 0) return refuse('not_found', 'The file has no <title> element to replace.');
  if (titles.length > 1)
    return refuse('ambiguous', `The file has ${titles.length} <title> elements; fix the duplicate before changing the title.`);
  const title = titles[0]!;
  const current = innerText(title);
  if (current.trim() === change.after.trim()) return { ok: true, text: html, changed: false };
  if (!sameText(current, change.before)) {
    return refuse(
      'stale',
      `The file's title is now "${current.trim()}", not "${change.before.trim()}". Re-read the page and draft the change again.`,
      {
        current: current.trim(),
      },
    );
  }
  const range = innerRange(title);
  if (!range || title.startIndex === null) return refuse('invalid', 'The <title> element could not be located in the file.');
  const tag = scanTag(html, title.startIndex);
  if (!tag) return refuse('invalid', 'The <title> element could not be read.');
  const start = range?.start ?? tag.openEnd + 1;
  const end = range?.end ?? tag.openEnd + 1;
  return { ok: true, text: replaceRange(html, start, end, escapeHtml(change.after)), changed: true };
}

/** Replace or insert the first <meta name="description">. */
function editDescription(html: string, change: MetaDescriptionChange): HtmlEditOutcome {
  const root = parse(html);
  const metas = elements(root).filter((node) => nameOf(node) === 'meta' && (attribute(node, 'name') ?? '').toLowerCase() === 'description');
  if (metas.length > 1) {
    return refuse('ambiguous', `The file has ${metas.length} meta descriptions; remove the duplicates before changing it.`);
  }
  const meta = metas[0];
  if (!meta) {
    if (change.before !== null) {
      return refuse(
        'stale',
        'The file has no meta description, but the change expects one. Re-read the page: the description may come from the build template.',
      );
    }
    const markup = `<meta name="description" content="${escapeHtml(change.after)}">`;
    const title = elements(root).find((node) => nameOf(node) === 'title');
    const inserted = insertIntoHead(html, root, title, markup);
    if (typeof inserted !== 'string') return inserted;
    return { ok: true, text: inserted, changed: true };
  }
  const current = attribute(meta, 'content') ?? '';
  if (current === change.after) return { ok: true, text: html, changed: false };
  if (change.before === null || !sameText(current, change.before)) {
    return refuse(
      'stale',
      `The file's meta description is now "${current}", not "${change.before ?? '(missing)'}". Re-read the page and draft the change again.`,
      {
        current,
      },
    );
  }
  if (meta.startIndex === null) return refuse('invalid', 'The meta description could not be located in the file.');
  const tag = scanTag(html, meta.startIndex);
  if (!tag) return refuse('invalid', 'The meta description tag could not be read.');
  return { ok: true, text: setAttribute(html, tag, 'content', change.after), changed: true };
}

interface JsonLdBlock {
  node: DomNode;
  raw: string;
  parsed: unknown;
}

function jsonLdBlocks(root: DomNode): JsonLdBlock[] {
  return elements(root)
    .filter((node) => node.type === 'script' && (attribute(node, 'type') ?? '').toLowerCase() === 'application/ld+json')
    .map((node) => {
      const raw = innerText(node);
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      return { node, raw, parsed };
    });
}

/** Add, replace or remove one JSON-LD block identified by `@type`/`@id`. */
function editJsonLd(html: string, change: SchemaJsonLdChange): HtmlEditOutcome {
  const root = parse(html);
  const blocks = jsonLdBlocks(root);
  const matching = blocks.filter((block) => block.parsed !== null && matchesJsonLd(block.parsed, change.match));
  const label = describeMatch(change.match);

  if (change.operation === 'add') {
    if (matching.length > 0) {
      return refuse('conflict', `A JSON-LD block matching ${label} is already on the page. Use replace, or choose a different @type/@id.`);
    }
    const markup = `<script type="application/ld+json">${serialiseJsonLd(change.after, lineEndingOf(html))}</script>`;
    const last = blocks[blocks.length - 1];
    const title = elements(root).find((node) => nameOf(node) === 'title');
    const inserted = last ? insertAfter(html, last.node, markup) : insertIntoHead(html, root, title, markup);
    if (typeof inserted !== 'string') return inserted;
    return { ok: true, text: inserted, changed: true };
  }

  if (matching.length === 0) {
    return refuse('not_found', `No JSON-LD block matching ${label} is in the file. Re-read the page and draft the change again.`, {
      match: change.match,
    });
  }
  if (matching.length > 1) {
    return refuse(
      'ambiguous',
      `${matching.length} JSON-LD blocks match ${label}. Choose one with @type and @id, or fix the duplicate blocks.`,
      {
        match: change.match,
      },
    );
  }
  const block = matching[0]!;
  if (change.before === null || jsonLdBlockHash(block.raw) !== change.before) {
    return refuse(
      'stale',
      `The JSON-LD block matching ${label} changed after this change was drafted. Re-read the page and draft the change again.`,
      {
        match: change.match,
        current: jsonLdBlockHash(block.raw),
      },
    );
  }

  if (change.operation === 'remove') {
    const start = block.node.startIndex;
    const end = block.node.endIndex;
    if (start === null || end === null) return refuse('invalid', 'The JSON-LD block could not be located in the file.');
    return { ok: true, text: removeElement(html, start, end), changed: true };
  }

  const range = innerRange(block.node);
  const tag = block.node.startIndex === null ? null : scanTag(html, block.node.startIndex);
  if (!range || !tag) return refuse('invalid', 'The JSON-LD block could not be located in the file.');
  return { ok: true, text: replaceRange(html, range.start, range.end, serialiseJsonLd(change.after, lineEndingOf(html))), changed: true };
}

/** Remove an element and the line it sits on, so the surrounding markup keeps its shape. */
function removeElement(html: string, startIndex: number, endIndex: number): string {
  let start = startIndex;
  let end = endIndex + 1;
  const lineStart = html.lastIndexOf('\n', start - 1) + 1;
  const indentation = html.slice(lineStart, start);
  if (/^[ \t]*$/.test(indentation)) start = lineStart;
  if (html.startsWith('\r\n', end)) end += 2;
  else if (html[end] === '\n') end += 1;
  else if (html[start - 1] === '\n') {
    start -= 1;
    if (html[start - 1] === '\r') start -= 1;
  }
  return replaceRange(html, start, end, '');
}

/**
 * The base a relative `<img src>` is resolved against: the document's first `<base>` that has an
 * `href` (even an empty one, which resolves to the document URL), else the page URL. The HTML spec
 * takes the first `<base>` with an `href` attribute, so a `<base target>` without one does not hide
 * a later `<base href>`, and `<base href="">` does not either.
 */
function documentBase(root: DomNode, pageUrl: string): string | null {
  const href = elements(root)
    .filter((node) => nameOf(node) === 'base')
    .map((node) => attribute(node, 'href'))
    .find((value) => value !== undefined);
  const candidate = href !== undefined ? normaliseUrl(href, pageUrl) : normaliseUrl(pageUrl);
  if (candidate === null || !/^https?:/i.test(candidate)) return null;
  return candidate;
}

/** Set the alt of the one <img> whose src matches; refuse when none or several do. */
function editImageAlt(html: string, change: ImageAltChange): HtmlEditOutcome {
  const root = parse(html);
  // The page's own URL is what makes a relative src mean anything. Comparing paths alone would
  // match an image on another host with the same path, and would miss `src="pic.png"` on
  // `/blog/post/` that the crawler records as `/blog/post/pic.png`.
  const base = documentBase(root, change.url);
  if (base === null) {
    return refuse(
      'invalid',
      `The change's page URL ${change.url} is not an absolute http(s) URL (or its <base href> is not one), so a relative image src cannot be resolved. Use the absolute URL from the crawl.`,
      { url: change.url },
    );
  }
  const wanted = normaliseUrl(change.src, base);
  if (wanted === null) return refuse('invalid', `The change's image src "${change.src}" is not a URL.`, { src: change.src });
  // A caller-supplied absolute src is what verification would use, so it has to be the URL this
  // editor actually matched. Trusting it would verify a different image (page B's src carried on
  // page A's change) and report a change as applied that never landed.
  if (change.resolvedSrc !== undefined) {
    const recorded = normaliseUrl(change.resolvedSrc);
    if (recorded === null || recorded !== wanted) {
      return refuse(
        'stale',
        `The change records ${change.resolvedSrc} as this image's absolute src, but "${change.src}" resolves to ${wanted} on this page. Re-read the page and draft the change again.`,
        { src: change.src, recorded: change.resolvedSrc, resolved: wanted },
      );
    }
  }
  const images = elements(root).filter(
    (node) => nameOf(node) === 'img' && imageSourceUrl(attribute(node, 'src'), attribute(node, 'srcset'), base) === wanted,
  );
  if (images.length === 0)
    return refuse('not_found', `No <img> in the file resolves to ${wanted}. Re-read the page: the image may be set by CSS or the build.`, {
      src: change.src,
      url: wanted,
    });
  if (images.length > 1) {
    return refuse(
      'ambiguous',
      `${images.length} <img> elements resolve to ${wanted}. Give the image a unique src or fix the duplicate before setting its alt.`,
      {
        src: change.src,
        url: wanted,
      },
    );
  }
  const image = images[0]!;
  const current = attribute(image, 'alt');
  if (current === change.after) return { ok: true, text: html, changed: false, resolvedSrc: wanted };
  if (current === undefined ? change.before !== null : current !== change.before) {
    return refuse(
      'stale',
      current === undefined
        ? 'The image now has no alt attribute, but the change expects one. Re-read the page and draft the change again.'
        : `The image's alt is now "${current}", not "${change.before ?? '(missing)'}". Re-read the page and draft the change again.`,
      current === undefined ? { current: null } : { current },
    );
  }
  if (image.startIndex === null) return refuse('invalid', 'The image could not be located in the file.');
  const tag = scanTag(html, image.startIndex);
  if (!tag) return refuse('invalid', 'The image tag could not be read.');
  return { ok: true, text: setAttribute(html, tag, 'alt', change.after), changed: true, resolvedSrc: wanted };
}

export function applyHtmlEdit(
  html: string,
  change: MetaTitleChange | MetaDescriptionChange | SchemaJsonLdChange | ImageAltChange,
): HtmlEditOutcome {
  const hashProblem = sourceHashRefusal(change, html);
  if (hashProblem) return hashProblem;
  switch (change.type) {
    case 'meta.title':
      return editTitle(html, change);
    case 'meta.description':
      return editDescription(html, change);
    case 'schema.jsonld':
      return editJsonLd(html, change);
    case 'image.alt':
      return editImageAlt(html, change);
  }
}

/** The `<img>` sources in a document, for a caller that needs to pick one. */
export function imageSources(html: string): string[] {
  const root = parse(html);
  return elements(root)
    .filter((node) => nameOf(node) === 'img')
    .map((node) => attribute(node, 'src') ?? '')
    .filter((src) => src !== '');
}

/** Whether a document has a JSON-LD block matching a selector, with its current body hash. */
export function findJsonLd(html: string, match: JsonLdMatch): { body: string; hash: string } | null {
  const blocks = jsonLdBlocks(parse(html)).filter((block) => block.parsed !== null && matchesJsonLd(block.parsed, match));
  if (blocks.length !== 1) return null;
  return { body: blocks[0]!.raw, hash: jsonLdBlockHash(blocks[0]!.raw) };
}
