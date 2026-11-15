import type { JsonLdBlock } from '@agentic-seo/crawl';
import { defineCheck } from '../check';
import { isOkHtml } from '../indexability';
import { fail, pass } from '../outcome';

// Structured data: what the page declares to search engines, and whether it can be read
// (crawler-and-audits.md §5 "Structured data", ADR-0008 for the deprecation rules).

const SD_INTRO = 'https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data';
const JSON_LD = 'https://json-ld.org/spec/latest/json-ld/';
const ARTICLE = 'https://developers.google.com/search/docs/appearance/structured-data/article';
const PRODUCT = 'https://developers.google.com/search/docs/appearance/structured-data/product-snippet';
const BREADCRUMB = 'https://developers.google.com/search/docs/appearance/structured-data/breadcrumb';
const EVENT = 'https://developers.google.com/search/docs/appearance/structured-data/event';
const LOCAL_BUSINESS = 'https://developers.google.com/search/docs/appearance/structured-data/local-business';
const JOB_POSTING = 'https://developers.google.com/search/docs/appearance/structured-data/job-posting';
const ORGANIZATION = 'https://developers.google.com/search/docs/appearance/structured-data/organization';

interface JsonLdNode {
  /** A stable key for evidence, e.g. `jsonld-1-node-2`. */
  key: string;
  types: string[];
  value: Record<string, unknown>;
}

/** Every object with an `@type` in a block, including nodes inside `@graph` and nested values. */
function nodesOf(block: JsonLdBlock, blockIndex: number): JsonLdNode[] {
  const nodes: JsonLdNode[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    const rawType = object['@type'];
    if (rawType !== undefined) {
      const types = (Array.isArray(rawType) ? rawType : [rawType])
        .filter((type): type is string => typeof type === 'string')
        .map((type) => type.replace(/^https?:\/\/schema\.org\//, ''));
      if (types.length) nodes.push({ key: `jsonld-${blockIndex + 1}-node-${nodes.length + 1}`, types, value: object });
    }
    for (const [key, child] of Object.entries(object)) {
      if (key === '@type') continue;
      if (child !== null && typeof child === 'object') visit(child);
    }
  };
  visit(block.parsed);
  return nodes;
}

function hasProperty(node: Record<string, unknown>, property: string): boolean {
  const value = node[property];
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** Google’s required properties, as published for each rich-result type (checked 2026-11-15). */
const REQUIRED: Record<string, { required: string[]; anyOf?: string[][] }> = {
  Product: { required: ['name'], anyOf: [['offers', 'review', 'aggregateRating']] },
  BreadcrumbList: { required: ['itemListElement'] },
  Event: { required: ['name', 'startDate', 'location'] },
  LocalBusiness: { required: ['name', 'address'] },
  JobPosting: { required: ['title', 'datePosted', 'description', 'hiringOrganization'] },
};

/** Properties Google recommends but does not require (Article and Organization require none). */
const RECOMMENDED: Record<string, string[]> = {
  Article: ['headline', 'image', 'datePublished', 'author'],
  BlogPosting: ['headline', 'image', 'datePublished', 'author'],
  NewsArticle: ['headline', 'image', 'datePublished', 'author'],
  Organization: ['name', 'url'],
  Product: ['image', 'description'],
  Event: ['endDate', 'image'],
};

export const schemaParseError = defineCheck({
  id: 'schema.parse_error',
  title: 'A JSON-LD block is not valid JSON',
  category: 'structured_data',
  severity: 'high',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'A JSON-LD block is not valid JSON. Google ignores the whole block, so none of the markup in it is read. Fix the JSON and validate the page with the Rich Results Test.',
  references: [SD_INTRO, JSON_LD],
  fix: { change: 'schema.jsonld' },
  run: (page) => {
    const blocks = page.html?.jsonLd ?? [];
    const broken = blocks.map((block, index) => ({ block, index })).filter(({ block }) => block.error !== null);
    if (!broken.length) return pass();
    return fail(
      broken.map(({ block, index }) => ({
        subject: `${page.finalUrl}#jsonld-${index + 1}`,
        selector: 'script[type="application/ld+json"]',
        value: block.error ?? 'invalid JSON',
        expected: 'a JSON-LD block that parses',
        detail: block.raw.length > 200 ? `${block.raw.slice(0, 200)}…` : block.raw,
      })),
    );
  },
});

export const schemaMissingType = defineCheck({
  id: 'schema.missing_type',
  title: 'A JSON-LD block has no @type',
  category: 'structured_data',
  severity: 'medium',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'A JSON-LD block has no @type. Without a type Google cannot tell what the block describes and ignores it. Add the schema.org type that matches the content.',
  references: [SD_INTRO, JSON_LD],
  fix: { change: 'schema.jsonld' },
  run: (page) => {
    const blocks = page.html?.jsonLd ?? [];
    const typedless = blocks
      .map((block, index) => ({ block, index }))
      .filter(({ block }) => block.parsed !== null && block.types.length === 0);
    if (!typedless.length) return pass();
    return fail(
      typedless.map(({ index }) => ({
        subject: `${page.finalUrl}#jsonld-${index + 1}`,
        selector: 'script[type="application/ld+json"]',
        value: 'no @type',
        expected: 'an @type such as WebPage, Article or Product',
      })),
    );
  },
});

export const schemaDeprecatedType = defineCheck({
  id: 'schema.deprecated_type',
  title: 'The page uses a deprecated structured data type',
  category: 'structured_data',
  severity: 'low',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'The page uses HowTo structured data. Google deprecated the HowTo rich result in 2023 and no longer shows it. Remove the markup, or keep it only for other consumers that read it.',
  references: ['https://schema.org/HowTo', 'https://developers.google.com/search/updates#how-to-deprecation'],
  rules: ['howto_rich_results_deprecated'],
  fix: { change: 'schema.jsonld' },
  run: (page) => {
    const blocks = page.html?.jsonLd ?? [];
    const hits: { index: number; type: string }[] = [];
    for (const [index, block] of blocks.entries())
      for (const type of block.types) if (type.toLowerCase() === 'howto') hits.push({ index, type });
    if (!hits.length) return pass();
    return fail(
      hits.map(({ index, type }) => ({
        subject: `${page.finalUrl}#jsonld-${index + 1}`,
        value: type,
        expected: 'markup for a type Google still shows in results',
      })),
    );
  },
});

export const schemaRichResultRestricted = defineCheck({
  id: 'schema.rich_result_restricted',
  title: 'The page uses FAQPage, whose rich result Google retired',
  category: 'structured_data',
  severity: 'info',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'The page uses FAQPage structured data. Google retired the FAQ rich result in May 2026 and no longer shows it in results. The markup is harmless but earns nothing in Search, so remove it if nothing else reads it.',
  references: ['https://schema.org/FAQPage', 'https://developers.google.com/search/updates#faq-deprecation'],
  rules: ['faq_rich_results_retired'],
  run: (page) => {
    const blocks = page.html?.jsonLd ?? [];
    const hits: { index: number; type: string }[] = [];
    for (const [index, block] of blocks.entries())
      for (const type of block.types) if (type.toLowerCase() === 'faqpage') hits.push({ index, type });
    if (!hits.length) return pass();
    return fail(
      hits.map(({ index, type }) => ({
        subject: `${page.finalUrl}#jsonld-${index + 1}`,
        value: type,
        expected: 'markup that earns a result, if the page needs one',
      })),
    );
  },
});

export const schemaMissingRequired = defineCheck({
  id: 'schema.missing_required',
  title: 'Structured data is missing a required property',
  category: 'structured_data',
  severity: 'medium',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'A structured data block is missing a property Google requires for that type. The page stays ineligible for the rich result until the property is present. Add the properties named in the evidence.',
  references: [SD_INTRO, PRODUCT, BREADCRUMB, EVENT, LOCAL_BUSINESS, JOB_POSTING],
  fix: { change: 'schema.jsonld' },
  run: (page) => {
    const blocks = page.html?.jsonLd ?? [];
    const items: { subject: string; value: string; expected: string }[] = [];
    const seen = new Set<string>();
    for (const [index, block] of blocks.entries()) {
      for (const node of nodesOf(block, index)) {
        for (const type of node.types) {
          // Own properties only: `@type` is page input, and "constructor" or "__proto__" must not reach Object.prototype.
          const rules = Object.hasOwn(REQUIRED, type) ? REQUIRED[type] : undefined;
          if (!rules) continue;
          const missing = rules.required.filter((property) => !hasProperty(node.value, property));
          if (
            type === 'JobPosting' &&
            !hasProperty(node.value, 'jobLocation') &&
            !hasProperty(node.value, 'jobLocationType') &&
            !hasProperty(node.value, 'applicantLocationRequirements')
          )
            missing.push('jobLocation');
          for (const property of missing) {
            const key = `${node.key}:${type}:${property}`;
            if (seen.has(key)) continue;
            seen.add(key);
            items.push({
              subject: `${page.finalUrl}#${node.key}`,
              value: `${type} is missing ${property}`,
              expected: `the required ${property} property`,
            });
          }
          for (const alternatives of rules.anyOf ?? []) {
            if (alternatives.some((property) => hasProperty(node.value, property))) continue;
            const key = `${node.key}:${type}:anyOf`;
            if (seen.has(key)) continue;
            seen.add(key);
            items.push({
              subject: `${page.finalUrl}#${node.key}`,
              value: `${type} has none of ${alternatives.join(', ')}`,
              expected: `at least one of ${alternatives.join(', ')}`,
            });
          }
        }
      }
    }
    if (!items.length) return pass();
    return fail(
      items.map((item) => ({
        subject: item.subject,
        selector: 'script[type="application/ld+json"]',
        value: item.value,
        expected: item.expected,
      })),
    );
  },
});

export const schemaMissingRecommended = defineCheck({
  id: 'schema.missing_recommended',
  title: 'Structured data omits a recommended property',
  category: 'structured_data',
  severity: 'info',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'A structured data block omits properties Google recommends. The markup is still valid, but the missing values limit the details Google can show. Add the recommended properties that apply.',
  references: [ARTICLE, ORGANIZATION, PRODUCT, EVENT],
  rules: ['article_no_required_properties', 'organization_no_required_properties'],
  fix: { change: 'schema.jsonld' },
  run: (page) => {
    const blocks = page.html?.jsonLd ?? [];
    const items: { subject: string; value: string; expected: string }[] = [];
    const seen = new Set<string>();
    for (const [index, block] of blocks.entries()) {
      for (const node of nodesOf(block, index)) {
        for (const type of node.types) {
          for (const property of (Object.hasOwn(RECOMMENDED, type) ? RECOMMENDED[type] : undefined) ?? []) {
            if (hasProperty(node.value, property)) continue;
            const key = `${node.key}:${type}:${property}`;
            if (seen.has(key)) continue;
            seen.add(key);
            items.push({
              subject: `${page.finalUrl}#${node.key}`,
              value: `${type} omits ${property}`,
              expected: `the recommended ${property} property`,
            });
          }
        }
      }
    }
    if (!items.length) return pass();
    return fail(
      items.map((item) => ({
        subject: item.subject,
        selector: 'script[type="application/ld+json"]',
        value: item.value,
        expected: item.expected,
      })),
    );
  },
});

export const structuredDataChecks = [
  schemaParseError,
  schemaMissingType,
  schemaDeprecatedType,
  schemaRichResultRestricted,
  schemaMissingRequired,
  schemaMissingRecommended,
] as const;
