import { createHash } from 'node:crypto';

// JSON-LD blocks identify themselves by `@type` and `@id`, sometimes inside an `@graph`. A change
// names the block it means with the same two fields, and both the editor (which must find exactly
// one block) and the verifier (which re-reads the deployed page) use the same matcher, so "what is
// on the page" and "what we edited" cannot drift apart.

/** A block selector: `@type` (one of several) and/or `@id`, as written in JSON-LD. */
export interface JsonLdMatch {
  '@type'?: string | string[];
  '@id'?: string;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every object node in a block, including `@graph` entries and nested values. */
export function jsonLdNodes(value: unknown): JsonObject[] {
  const found: JsonObject[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isObject(node)) return;
    found.push(node);
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return found;
}

/** Every `@type` in a block, flattened and de-duplicated (nested nodes included). */
export function jsonLdTypes(value: unknown): string[] {
  const types = new Set<string>();
  for (const node of jsonLdNodes(value)) {
    const declared = node['@type'];
    if (typeof declared === 'string') types.add(declared);
    else if (Array.isArray(declared)) for (const item of declared) if (typeof item === 'string') types.add(item);
  }
  return [...types];
}

/** Whether one node satisfies the selector; both parts must match the same node. */
function nodeMatches(node: JsonObject, match: JsonLdMatch): boolean {
  if (match['@id'] !== undefined && node['@id'] !== match['@id']) return false;
  if (match['@type'] !== undefined) {
    const wanted = Array.isArray(match['@type']) ? match['@type'] : [match['@type']];
    const declared = node['@type'];
    const actual = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : [];
    if (!wanted.some((type) => actual.includes(type))) return false;
  }
  return true;
}

/** Whether a parsed block contains a node the selector names. */
export function matchesJsonLd(value: unknown, match: JsonLdMatch): boolean {
  return jsonLdNodes(value).some((node) => nodeMatches(node, match));
}

/** A stable, key-sorted serialisation, so two blocks compare equal regardless of key order. */
export function stableJson(value: unknown): string {
  const sort = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sort);
    if (!isObject(node)) return node;
    return Object.fromEntries(
      Object.keys(node)
        .sort()
        .map((key) => [key, sort(node[key])]),
    );
  };
  return JSON.stringify(sort(value));
}

/** Whether two JSON-LD values say the same thing (key order is not a difference). */
export function jsonLdEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

/** The block as a hash of its raw body, which is what a drafted change records as `before`. */
export function jsonLdBlockHash(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * The block body to write: two-space indentation, the document's own line ending, and `</` escaped
 * as `<\/` so the JSON can never close its own `<script>` element. (A JSON string cannot contain a
 * bare `</` in a way that would change the value: `<\/` is the same character to a JSON parser.)
 */
export function serialiseJsonLd(value: unknown, lineEnding: '\n' | '\r\n' = '\n'): string {
  const body = JSON.stringify(value, null, 2);
  return (lineEnding === '\n' ? body : body.replaceAll('\n', lineEnding)).replaceAll('</', '<\\/');
}

/** A short human description of a selector, for refusal messages. */
export function describeMatch(match: JsonLdMatch): string {
  const parts: string[] = [];
  if (match['@type'] !== undefined) parts.push(`@type ${Array.isArray(match['@type']) ? match['@type'].join(' or ') : match['@type']}`);
  if (match['@id'] !== undefined) parts.push(`@id ${match['@id']}`);
  return parts.length ? parts.join(' and ') : 'an empty selector';
}
