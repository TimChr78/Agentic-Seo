import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';
import type { Heading, HtmlFacts, PageImage, PageLink } from './facts';
import { isInternalUrl, normalizeUrl } from './url';

// The streaming extractor: one SAX pass over the response body with htmlparser2, producing exactly
// the `HtmlFacts` contract in facts.ts. No DOM is built, so a 10 MB page costs no more than its
// text and the facts collected from it (crawler-and-audits.md §2).

/** What the extractor needs from the response and the site. */
export interface ExtractContext {
  /** The URL that answered after redirects; relative hrefs resolve against it (or `<base href>`). */
  baseUrl: string;
  /** The site's hosts, for `PageLink.internal`. */
  hosts: readonly string[];
  /** Feed size for the parser; the whole body is already decoded, so this only bounds the loop. */
  chunkSize?: number;
}

/** The cap on one JSON-LD block's raw body (facts.ts `JsonLdBlock.raw`). */
export const JSON_LD_MAX_BYTES = 64 * 1024;

/** Anchor text and image alt text are evidence, not content: they are capped like facts.ts says. */
export const ANCHOR_TEXT_MAX = 200;

/** The most links one page's facts keep; a hostile page cannot make a snapshot unbounded. */
export const HTML_FACTS_MAX_LINKS = 5_000;
/** The most images one page's facts keep (the brief's memory bound). */
export const HTML_FACTS_MAX_IMAGES = 1_000;

const SKIP_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template']);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** Trimmed, whitespace-collapsed, entity-decoded text (the conventions in facts.ts). */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The `rel` attribute as lower-cased tokens. */
function relTokens(value: string | undefined): string[] {
  return (value ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/** The first candidate of a `srcset`, without its width/density descriptor. */
function firstSrcsetCandidate(value: string): string | null {
  const first = value.split(',')[0]?.trim().split(/\s+/)[0];
  return first ? first : null;
}

function textAttribute(attributes: Record<string, string>, name: string): string | null {
  const value = attributes[name];
  return value === undefined ? null : collapse(value);
}

/** Every `@type` in a parsed JSON-LD value, including inside `@graph` and nested nodes. */
function collectJsonLdTypes(value: unknown, types: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdTypes(item, types);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const type = record['@type'];
  if (typeof type === 'string') types.add(type);
  if (Array.isArray(type)) for (const entry of type) if (typeof entry === 'string') types.add(entry);
  for (const nested of Object.values(record)) collectJsonLdTypes(nested, types);
}

interface AnchorCapture {
  rawHref: string;
  href: string | null;
  rel: string[];
  text: string[];
  imageAlt: string | null;
}

interface HeadingCapture {
  level: Heading['level'];
  text: string[];
}

interface JsonLdCapture {
  parts: string[];
  size: number;
}

/**
 * Parses one HTML document into `HtmlFacts`. Non-HTML and non-2xx responses never reach here: the
 * crawler stores `html: null` for them.
 */
export function extractHtml(html: string, context: ExtractContext): HtmlFacts {
  const { baseUrl, hosts } = context;
  const pageProtocol = new URL(baseUrl).protocol;
  const pageIsHttps = pageProtocol === 'https:';
  const pageIsHttp = pageProtocol === 'http:';

  let baseHref: string | null = null;
  const resolve = (raw: string): string | null => normalizeUrl(raw, baseHref ?? baseUrl);

  let lang: string | null = null;
  let inHead = false;
  let skipDepth = 0;
  const bodyText: string[] = [];

  let titleCount = 0;
  let title: string | null = null;
  let capturingTitle = false;
  const titleParts: string[] = [];

  let metaDescription: string | null = null;
  let metaDescriptionCount = 0;
  const metaRobots: string[] = [];

  const canonicals: string[] = [];
  let canonicalOutsideHead = false;

  let viewport: string | null = null;
  let charset: string | null = null;
  const hreflang: HtmlFacts['hreflang'] = [];

  const headings: Heading[] = [];
  const headingStack: HeadingCapture[] = [];

  const links: PageLink[] = [];
  const anchors: AnchorCapture[] = [];
  let linksTruncated = false;

  const images: PageImage[] = [];
  let imagesTruncated = false;
  const jsonLd: HtmlFacts['jsonLd'] = [];
  let jsonLdCapture: JsonLdCapture | null = null;
  const microdataTypes: string[] = [];
  const openGraph: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  const mixedContent = new Set<string>();
  const insecureForms = new Set<string>();

  function captureText(text: string): void {
    if (skipDepth > 0) return;
    if (capturingTitle) {
      titleParts.push(text);
      return;
    }
    if (inHead) return;
    bodyText.push(text);
    const anchor = anchors.at(-1);
    if (anchor) anchor.text.push(text);
    const heading = headingStack.at(-1);
    if (heading) heading.text.push(text);
  }

  /**
   * Marks an element boundary in the visible text. htmlparser2 reports text in callbacks that do
   * not line up with words (and split differently by chunk size), so contiguous callbacks are
   * concatenated and a space is inserted only where an element opens or closes; the text is
   * collapsed at the end. `<p>AT&amp;T</p>` stays one word whatever the feed size.
   */
  function textBoundary(): void {
    if (skipDepth > 0 || inHead || capturingTitle) return;
    bodyText.push(' ');
    const anchor = anchors.at(-1);
    if (anchor) anchor.text.push(' ');
    const heading = headingStack.at(-1);
    if (heading) heading.text.push(' ');
  }

  function finishAnchor(anchor: AnchorCapture): void {
    const text = collapse(anchor.text.join('')) || anchor.imageAlt || '';
    if (links.length >= HTML_FACTS_MAX_LINKS) {
      linksTruncated = true;
      return;
    }
    links.push({
      href: anchor.href,
      rawHref: anchor.rawHref,
      rel: anchor.rel,
      text: text.slice(0, ANCHOR_TEXT_MAX),
      internal: anchor.href !== null && isInternalUrl(anchor.href, hosts),
    });
  }

  function subresource(raw: string | undefined): void {
    if (!raw || !pageIsHttps) return;
    const resolved = resolve(raw);
    if (resolved && new URL(resolved).protocol === 'http:') mixedContent.add(resolved);
  }

  function handleMeta(attributes: Record<string, string>): void {
    const name = attributes.name?.trim().toLowerCase();
    const property = attributes.property?.trim().toLowerCase();
    const content = attributes.content;
    if (name === 'description') {
      metaDescriptionCount += 1;
      if (metaDescription === null && content !== undefined) metaDescription = collapse(content);
      return;
    }
    if (name === 'robots' || name === 'googlebot') {
      for (const directive of (content ?? '').toLowerCase().split(',')) {
        const value = directive.trim();
        if (value) metaRobots.push(value);
      }
      return;
    }
    if (name === 'viewport' && viewport === null && content !== undefined) viewport = collapse(content);
    if (attributes.charset !== undefined && charset === null) charset = attributes.charset.trim().toLowerCase();
    if (attributes['http-equiv']?.trim().toLowerCase() === 'content-type') {
      const match = /charset\s*=\s*["']?([^"';\s]+)/i.exec(content ?? '');
      if (match?.[1] && charset === null) charset = match[1].toLowerCase();
    }
    if (property?.startsWith('og:') && openGraph[property] === undefined && content !== undefined) openGraph[property] = collapse(content);
    if (name?.startsWith('twitter:') && twitter[name] === undefined && content !== undefined) twitter[name] = collapse(content);
  }

  function handleLink(attributes: Record<string, string>): void {
    const rel = relTokens(attributes.rel);
    const href = attributes.href;
    if (href === undefined) return;
    if (rel.includes('canonical')) {
      const resolved = resolve(href);
      if (resolved) {
        canonicals.push(resolved);
        if (!inHead) canonicalOutsideHead = true;
      }
    }
    if (rel.includes('alternate') && attributes.hreflang !== undefined) {
      const resolved = resolve(href);
      if (resolved) hreflang.push({ lang: attributes.hreflang.trim().toLowerCase(), href: resolved });
    }
    if (rel.includes('stylesheet')) subresource(href);
  }

  function handleImage(attributes: Record<string, string>): void {
    const raw = attributes.src ?? (attributes.srcset ? firstSrcsetCandidate(attributes.srcset) : null);
    const alt = attributes.alt === undefined ? null : collapse(attributes.alt);
    const anchor = anchors.at(-1);
    // A linked image with no alt supplies the anchor's text.
    if (anchor && anchor.imageAlt === null && alt) anchor.imageAlt = alt;
    if (images.length >= HTML_FACTS_MAX_IMAGES) imagesTruncated = true;
    else
      images.push({
        src: raw ? resolve(raw) : null,
        // null and '' mean different things (facts.ts): missing versus explicitly decorative.
        alt,
        width: textAttribute(attributes, 'width'),
        height: textAttribute(attributes, 'height'),
        loading: attributes.loading === undefined ? null : attributes.loading.trim().toLowerCase(),
        inLink: anchor !== undefined,
      });
    if (raw) subresource(raw);
  }

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        textBoundary();
        // Generic attributes are collected before any tag-specific early return: microdata on an
        // <img>, <form> or <a> is still microdata.
        if (attributes.itemtype !== undefined) microdataTypes.push(attributes.itemtype.trim());
        if (name === 'html' && attributes.lang !== undefined) lang = attributes.lang.trim().toLowerCase();
        if (name === 'head') {
          inHead = true;
          return;
        }
        if (name === 'base') {
          const href = attributes.href;
          if (href && baseHref === null) baseHref = resolve(href) ?? baseHref;
          return;
        }
        if (name === 'title') {
          capturingTitle = true;
          titleParts.length = 0;
          return;
        }
        if (name === 'meta') {
          handleMeta(attributes);
          return;
        }
        if (name === 'link') {
          handleLink(attributes);
          return;
        }
        if (name === 'img') {
          handleImage(attributes);
          return;
        }
        if (SKIP_TEXT_TAGS.has(name)) {
          if (name === 'script') {
            subresource(attributes.src);
            if (attributes.type?.trim().toLowerCase() === 'application/ld+json') jsonLdCapture = { parts: [], size: 0 };
          }
          skipDepth += 1;
          return;
        }
        if (name === 'a') {
          anchors.push({
            rawHref: attributes.href ?? '',
            href: attributes.href === undefined ? null : resolve(attributes.href),
            rel: relTokens(attributes.rel),
            text: [],
            imageAlt: null,
          });
          return;
        }
        if (HEADINGS.has(name)) {
          headingStack.push({ level: Number(name.slice(1)) as Heading['level'], text: [] });
          return;
        }
        if (name === 'iframe' || name === 'source') {
          subresource(attributes.src);
          return;
        }
        if (name === 'form') {
          const action = (attributes.action ?? '').trim();
          const method = (attributes.method ?? 'get').trim().toLowerCase();
          // An empty action posts to the page itself.
          const resolved = action === '' ? baseUrl : resolve(action);
          if (resolved === null) return;
          const secure = new URL(resolved).protocol === 'https:';
          if (!secure || (pageIsHttp && method === 'post')) insecureForms.add(resolved);
          return;
        }
      },
      ontext(text) {
        if (jsonLdCapture) {
          const room = JSON_LD_MAX_BYTES - jsonLdCapture.size;
          if (room > 0) {
            const kept = text.length > room ? text.slice(0, room) : text;
            jsonLdCapture.parts.push(kept);
            jsonLdCapture.size += kept.length;
          }
        }
        captureText(text);
      },
      onclosetag(name) {
        textBoundary();
        if (name === 'head') {
          inHead = false;
          return;
        }
        if (name === 'title') {
          titleCount += 1;
          // Contiguous text callbacks belong to one word: a separator here would split "AT&T"
          // whenever the parser received it in two pieces (chunk-size dependent facts).
          if (capturingTitle && title === null) title = collapse(titleParts.join(''));
          capturingTitle = false;
          return;
        }
        if (SKIP_TEXT_TAGS.has(name)) {
          if (name === 'script' && jsonLdCapture) {
            const raw = jsonLdCapture.parts.join('');
            let parsed: unknown = null;
            let error: string | null = null;
            try {
              parsed = JSON.parse(raw);
            } catch (caught) {
              error = caught instanceof Error ? caught.message : String(caught);
            }
            const types = new Set<string>();
            if (parsed !== null) collectJsonLdTypes(parsed, types);
            jsonLd.push({ raw, parsed, error, types: [...types] });
            jsonLdCapture = null;
          }
          if (skipDepth > 0) skipDepth -= 1;
          return;
        }
        if (name === 'a') {
          const anchor = anchors.pop();
          if (anchor) finishAnchor(anchor);
          return;
        }
        if (HEADINGS.has(name)) {
          const heading = headingStack.pop();
          if (heading) headings.push({ level: heading.level, text: collapse(heading.text.join('')) });
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );

  // Feed in chunks so the parser's own buffers stay small even for a very large document. Text
  // callbacks may fall anywhere; boundaries are tracked from tags, so the facts do not depend on
  // where a chunk boundary falls.
  const chunkSize = Math.max(1, context.chunkSize ?? 64 * 1024);
  for (let index = 0; index < html.length; index += chunkSize) parser.write(html.slice(index, index + chunkSize));
  parser.end();

  const normalisedText = collapse(bodyText.join(''));
  return {
    lang,
    title,
    titleCount,
    metaDescription,
    metaDescriptionCount,
    metaRobots,
    canonical: canonicals[0] ?? null,
    canonicals,
    canonicalOutsideHead,
    viewport,
    charset,
    hreflang,
    headings,
    links,
    images,
    ...(linksTruncated ? { linksTruncated: true } : {}),
    ...(imagesTruncated ? { imagesTruncated: true } : {}),
    jsonLd,
    microdataTypes,
    openGraph,
    twitter,
    wordCount: normalisedText ? normalisedText.split(' ').length : 0,
    contentHash: createHash('sha256').update(normalisedText).digest('hex'),
    mixedContent: [...mixedContent],
    insecureForms: [...insecureForms],
  } satisfies HtmlFacts;
}
