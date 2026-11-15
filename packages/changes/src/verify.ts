import type { PageFacts } from '@agentic-seo/crawl';
import type { Change } from './change-types';
import { type JsonLdMatch, jsonLdEqual, matchesJsonLd } from './jsonld';
import { sameImageSource, sameUrl } from './urls';

// What "applied" means, said once. The apply step writes the source; the verification task runs
// after deployment and re-fetches the URL, so it must judge the page, not the file. `expectedAfter`
// turns a change into the expectation, and `checkPageAgainst` compares a PageFacts record with it.
// Both are pure and take the crawler's contract types, so the verifier never sees raw HTML.

/** The expectation a change puts on the deployed page. */
export type ExpectedAfter =
  | { kind: 'meta.title'; url: string; value: string }
  | { kind: 'meta.description'; url: string; value: string }
  | { kind: 'schema.jsonld'; url: string; match: JsonLdMatch; present: boolean; value: unknown }
  | { kind: 'image.alt'; url: string; src: string; value: string }
  | { kind: 'redirect'; from: string; to: string | null; status: number | null };

export function expectedAfter(change: Change): ExpectedAfter {
  switch (change.type) {
    case 'meta.title':
      return { kind: 'meta.title', url: change.url, value: change.after };
    case 'meta.description':
      return { kind: 'meta.description', url: change.url, value: change.after };
    case 'schema.jsonld':
      return {
        kind: 'schema.jsonld',
        url: change.url,
        match: change.match,
        present: change.operation !== 'remove',
        value: change.operation === 'remove' ? null : change.after,
      };
    case 'image.alt':
      return { kind: 'image.alt', url: change.url, src: change.src, value: change.after };
    case 'redirect':
      return {
        kind: 'redirect',
        from: change.from,
        to: change.operation === 'remove' ? null : (change.to ?? null),
        status: change.operation === 'remove' ? null : (change.status ?? null),
      };
  }
}

export interface PageCheck {
  ok: boolean;
  /** One sentence, written for the change-set UI and the agent's ledger. */
  detail: string;
}

function fetched(page: PageFacts): string | null {
  if (page.fetchError) return `The page could not be fetched (${page.fetchError}).`;
  if (page.status < 200 || page.status >= 300) return `The page answered ${page.status}, so its content could not be verified.`;
  return null;
}

/** Compare one page's facts with the change's expectation. */
export function checkPageAgainst(change: Change, page: PageFacts): PageCheck {
  const expectation = expectedAfter(change);
  switch (expectation.kind) {
    case 'meta.title': {
      const problem = fetched(page);
      if (problem) return { ok: false, detail: problem };
      const title = page.html?.title ?? null;
      return title === expectation.value
        ? { ok: true, detail: `The page title is now "${expectation.value}".` }
        : { ok: false, detail: `The page title is ${title === null ? 'missing' : `"${title}"`}, not "${expectation.value}".` };
    }
    case 'meta.description': {
      const problem = fetched(page);
      if (problem) return { ok: false, detail: problem };
      const description = page.html?.metaDescription ?? null;
      return description === expectation.value
        ? { ok: true, detail: 'The meta description matches the change.' }
        : {
            ok: false,
            detail: `The meta description is ${description === null ? 'missing' : `"${description}"`}, not "${expectation.value}".`,
          };
    }
    case 'schema.jsonld': {
      const problem = fetched(page);
      if (problem) return { ok: false, detail: problem };
      const blocks = (page.html?.jsonLd ?? []).filter((block) => block.parsed !== null && matchesJsonLd(block.parsed, expectation.match));
      if (!expectation.present) {
        return blocks.length === 0
          ? { ok: true, detail: 'No JSON-LD block matches the removed selector.' }
          : { ok: false, detail: `${blocks.length} JSON-LD block(s) still match the removed selector.` };
      }
      if (blocks.length === 0) return { ok: false, detail: 'No JSON-LD block matches the change.' };
      if (blocks.length > 1)
        return { ok: false, detail: `${blocks.length} JSON-LD blocks match the change; it must identify exactly one.` };
      return jsonLdEqual(blocks[0]!.parsed, expectation.value)
        ? { ok: true, detail: 'The JSON-LD block matches the change.' }
        : { ok: false, detail: 'The JSON-LD block is present but its contents differ from the change.' };
    }
    case 'image.alt': {
      const problem = fetched(page);
      if (problem) return { ok: false, detail: problem };
      // The crawler resolves a relative src against the page it ended on, so the comparison uses
      // the same base: the path alone is not enough when the image could be on another host.
      const base = page.finalUrl || page.url;
      const images = (page.html?.images ?? []).filter((image) => image.src !== null && sameImageSource(image.src, expectation.src, base));
      if (images.length === 0) return { ok: false, detail: `No image with src ${expectation.src} is on the page.` };
      if (images.length > 1)
        return { ok: false, detail: `${images.length} images with src ${expectation.src} are on the page; the change must identify one.` };
      const alt = images[0]!.alt;
      return alt === expectation.value
        ? { ok: true, detail: 'The image alt matches the change.' }
        : { ok: false, detail: `The image alt is ${alt === null ? 'missing' : `"${alt}"`}, not "${expectation.value}".` };
    }
    case 'redirect': {
      const hops = page.redirects ?? [];
      const first = hops.find((hop) => sameUrl(hop.url, expectation.from, page.url));
      if (expectation.to === null || expectation.status === null) {
        return first
          ? { ok: false, detail: `${expectation.from} still redirects with status ${first.status}.` }
          : { ok: true, detail: `${expectation.from} no longer redirects.` };
      }
      if (!first)
        return { ok: false, detail: `${expectation.from} does not redirect; expected status ${expectation.status} to ${expectation.to}.` };
      if (first.status !== expectation.status) {
        return { ok: false, detail: `${expectation.from} answers ${first.status}, not ${expectation.status}.` };
      }
      return sameUrl(first.location, expectation.to, first.url)
        ? { ok: true, detail: `${expectation.from} answers ${expectation.status} to ${expectation.to}.` }
        : { ok: false, detail: `${expectation.from} redirects to ${first.location}, not ${expectation.to}.` };
    }
  }
}
