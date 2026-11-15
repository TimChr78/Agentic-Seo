import { defineCheck } from '../check';
import { isIndexablePage, isOkHtml } from '../indexability';
import { fail, pass } from '../outcome';
import { DESCRIPTION_FONT_PX, DESCRIPTION_MAX_PX, pixelWidth, TITLE_MAX_PX } from '../pixel-width';
import { isHomePage } from '../url';

// On-page: the elements a page uses to describe itself to searchers
// (crawler-and-audits.md §5 "On-page").

const TITLE_LINK = 'https://developers.google.com/search/docs/appearance/title-link';
const SNIPPET = 'https://developers.google.com/search/docs/appearance/snippet';
const HEADINGS = 'https://developers.google.com/search/docs/fundamentals/seo-starter-guide';
const HELPFUL_CONTENT = 'https://developers.google.com/search/docs/fundamentals/creating-helpful-content';
const DUPLICATE_CONTENT = 'https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls';
const LANG = 'https://html.spec.whatwg.org/multipage/dom.html#the-lang-and-xml:lang-attributes';
const VIEWPORT = 'https://developer.mozilla.org/en-US/docs/Web/HTML/Viewport_meta_tag';
const MOBILE_FIRST = 'https://developers.google.com/search/docs/crawling-indexing/mobile/mobile-sites-mobile-first-indexing';

export const titleMissing = defineCheck({
  id: 'title.missing',
  title: 'The page has no title',
  category: 'on_page',
  severity: 'high',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'The page has no title element. Google has to invent a title link from page content, and the result is usually worse than a written one. Add a unique, descriptive title in the head.',
  references: [TITLE_LINK],
  fix: { change: 'meta.title' },
  run: (page) => {
    if (page.html?.title !== null) return pass();
    return fail({ subject: page.finalUrl, selector: 'title', expected: 'a descriptive <title> in the head' });
  },
});

export const titleEmpty = defineCheck({
  id: 'title.empty',
  title: 'The page title is empty',
  category: 'on_page',
  severity: 'high',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'The title element is present but empty. Google treats it as no title and generates one itself. Write a unique, descriptive title.',
  references: [TITLE_LINK],
  fix: { change: 'meta.title' },
  run: (page) => {
    const title = page.html?.title;
    if (title === null || title === undefined || title.trim() !== '') return pass();
    return fail({ subject: page.finalUrl, selector: 'title', value: 'empty', expected: 'a descriptive title' });
  },
});

export const titleTooLong = defineCheck({
  id: 'title.too_long',
  title: 'The title is too wide for Google’s result column',
  category: 'on_page',
  severity: 'low',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: (page) => isOkHtml(page) && (page.html?.title ?? '').trim() !== '',
  explain:
    'The title is wider than the space Google uses for a title link, so it is cut off. The end of the title, often the differentiator, does not appear in results. Shorten it to about 60 characters or 580 pixels.',
  references: [TITLE_LINK],
  fix: { change: 'meta.title' },
  run: (page) => {
    const title = page.html?.title ?? '';
    const width = pixelWidth(title);
    if (width <= TITLE_MAX_PX) return pass();
    return fail({
      subject: page.finalUrl,
      selector: 'title',
      value: title,
      expected: 'no wider than about 580 px (roughly 60 characters)',
      detail: `About ${Math.round(width)} px wide at the title font size.`,
    });
  },
});

export const titleTooShort = defineCheck({
  id: 'title.too_short',
  title: 'The title is very short',
  category: 'on_page',
  severity: 'low',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: (page) => isOkHtml(page) && (page.html?.title ?? '').trim() !== '',
  explain:
    'The title is shorter than 15 characters. A short title gives Google little to work with and rarely describes the page well. Write a more specific title that names the page’s topic.',
  references: [TITLE_LINK],
  fix: { change: 'meta.title' },
  run: (page) => {
    const title = (page.html?.title ?? '').trim();
    if (title.length >= 15) return pass();
    return fail({
      subject: page.finalUrl,
      selector: 'title',
      value: title,
      expected: 'at least 15 characters that describe the page',
    });
  },
});

export const titleMultiple = defineCheck({
  id: 'title.multiple',
  title: 'The page has more than one title element',
  category: 'on_page',
  severity: 'medium',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'The page contains more than one title element. Browsers and crawlers use the first one, so the rest are ignored. Keep a single title in the head.',
  references: [TITLE_LINK],
  fix: { change: 'meta.title' },
  run: (page) => {
    const count = page.html?.titleCount ?? 0;
    if (count <= 1) return pass();
    return fail({
      subject: page.finalUrl,
      selector: 'title',
      value: `${count} title elements`,
      expected: 'one title element',
      detail: 'Crawlers use the first title and ignore the rest.',
    });
  },
});

export const descriptionMissing = defineCheck({
  id: 'description.missing',
  title: 'The page has no meta description',
  category: 'on_page',
  severity: 'medium',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'The page has no meta description. Google then builds a snippet from page text, which may not match the query. Add a description that summarises the page and gives a reason to click.',
  references: [SNIPPET],
  fix: { change: 'meta.description' },
  run: (page) => {
    if (page.html?.metaDescription !== null) return pass();
    return fail({
      subject: page.finalUrl,
      selector: 'meta[name="description"]',
      expected: 'a meta description that summarises the page',
    });
  },
});

export const descriptionTooLong = defineCheck({
  id: 'description.too_long',
  title: 'The meta description is too long for a snippet',
  category: 'on_page',
  severity: 'low',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  // A present-but-empty description (`''`) is too short too; only an absent one (`null`) is `description.missing`.
  appliesTo: (page) => isOkHtml(page) && page.html?.metaDescription != null,
  explain:
    'The meta description is longer than the space Google shows, so it is truncated. The end of the description, often the call to action, is cut off. Shorten it to about 155 characters or 990 pixels.',
  references: [SNIPPET],
  fix: { change: 'meta.description' },
  run: (page) => {
    const description = page.html?.metaDescription ?? '';
    const width = pixelWidth(description, DESCRIPTION_FONT_PX);
    if (width <= DESCRIPTION_MAX_PX) return pass();
    return fail({
      subject: page.finalUrl,
      selector: 'meta[name="description"]',
      value: description,
      expected: 'no wider than about 990 px at snippet size (roughly 155 characters)',
      detail: `About ${Math.round(width)} px wide at the snippet font size.`,
    });
  },
});

export const descriptionTooShort = defineCheck({
  id: 'description.too_short',
  title: 'The meta description is very short',
  category: 'on_page',
  severity: 'low',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  // A present-but-empty description (`''`) is too short too; only an absent one (`null`) is `description.missing`.
  appliesTo: (page) => isOkHtml(page) && page.html?.metaDescription != null,
  explain:
    'The meta description is shorter than 50 characters. A very short description gives Google little to show and wastes the snippet. Write a fuller summary of the page.',
  references: [SNIPPET],
  fix: { change: 'meta.description' },
  run: (page) => {
    const description = (page.html?.metaDescription ?? '').trim();
    if (description.length >= 50) return pass();
    return fail({
      subject: page.finalUrl,
      selector: 'meta[name="description"]',
      value: description,
      expected: 'at least 50 characters that summarise the page',
    });
  },
});

export const descriptionMultiple = defineCheck({
  id: 'description.multiple',
  title: 'The page has more than one meta description',
  category: 'on_page',
  severity: 'medium',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'The page contains more than one meta description. Crawlers use one of them and ignore the rest, so the visible snippet is unpredictable. Keep a single description.',
  references: [SNIPPET],
  fix: { change: 'meta.description' },
  run: (page) => {
    const count = page.html?.metaDescriptionCount ?? 0;
    if (count <= 1) return pass();
    return fail({
      subject: page.finalUrl,
      selector: 'meta[name="description"]',
      value: `${count} meta descriptions`,
      expected: 'one meta description',
    });
  },
});

export const h1Missing = defineCheck({
  id: 'h1.missing',
  title: 'The page has no h1',
  category: 'on_page',
  severity: 'medium',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'The page has no h1 heading. The h1 states the page’s main topic for readers and for parsers that rely on headings. Add one h1 that matches the page.',
  references: [HEADINGS],
  run: (page) => {
    if ((page.html?.headings ?? []).some((heading) => heading.level === 1)) return pass();
    return fail({ subject: page.finalUrl, selector: 'h1', expected: 'one h1 that states the page’s topic' });
  },
});

export const h1Multiple = defineCheck({
  id: 'h1.multiple',
  title: 'The page has more than one h1',
  category: 'on_page',
  severity: 'low',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'The page has more than one h1. Competing top-level headings blur what the page is about. Keep one h1 and use h2 for the sections.',
  references: [HEADINGS],
  run: (page) => {
    const h1s = (page.html?.headings ?? []).filter((heading) => heading.level === 1);
    if (h1s.length <= 1) return pass();
    return fail(
      h1s.map((heading) => ({
        subject: page.finalUrl,
        selector: 'h1',
        value: heading.text,
        expected: 'one h1 on the page',
      })),
    );
  },
});

export const headingsSkippedLevel = defineCheck({
  id: 'headings.skipped_level',
  title: 'A heading skips a level',
  category: 'on_page',
  severity: 'info',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'A heading jumps down by more than one level, such as h2 followed by h4. The outline becomes ambiguous for screen readers and for parsers. Use the next level down, or restructure the section.',
  references: [HEADINGS],
  run: (page) => {
    const headings = page.html?.headings ?? [];
    const skips: { from: number; to: number; text: string }[] = [];
    for (let index = 1; index < headings.length; index++) {
      const previous = headings[index - 1]!;
      const current = headings[index]!;
      if (current.level - previous.level > 1) skips.push({ from: previous.level, to: current.level, text: current.text });
    }
    if (!skips.length) return pass();
    return fail(
      skips.map((skip) => ({
        subject: page.finalUrl,
        selector: `h${skip.to}`,
        value: `h${skip.from} → h${skip.to}`,
        expected: `h${skip.from + 1} as the next level`,
        detail: skip.text ? `The heading reads “${skip.text}”.` : undefined,
      })),
    );
  },
});

export const contentThin = defineCheck({
  id: 'content.thin',
  title: 'An indexable page has little text',
  category: 'on_page',
  severity: 'low',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: (page) => isIndexablePage(page) && !isHomePage(page.finalUrl),
  explain:
    'An indexable page has fewer than 200 words of visible text. Thin pages rarely satisfy a search intent on their own and can dilute the site’s quality signals. Add the substance a visitor came for, or merge the page into a fuller one.',
  references: [HELPFUL_CONTENT],
  run: (page) => {
    const words = page.html?.wordCount ?? 0;
    if (words >= 200) return pass();
    return fail({
      subject: page.finalUrl,
      value: `${words} words`,
      expected: 'at least 200 words of visible text',
    });
  },
});

export const htmlLangMissing = defineCheck({
  id: 'html.lang_missing',
  title: 'The html element has no lang attribute',
  category: 'on_page',
  severity: 'low',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'The html element has no lang attribute. Browsers and assistive technology cannot tell the page’s language, and Google relies on other signals to infer it. Add lang with the page’s language code.',
  references: [LANG],
  run: (page) => {
    const lang = page.html?.lang;
    if (lang !== null && lang !== undefined && lang.trim() !== '') return pass();
    return fail({ subject: page.finalUrl, selector: 'html', expected: 'a lang attribute such as lang="en"' });
  },
});

export const viewportMissing = defineCheck({
  id: 'viewport.missing',
  title: 'The page has no viewport meta tag',
  category: 'on_page',
  severity: 'medium',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'The page has no viewport meta tag. Mobile browsers assume a desktop-width layout, so text is tiny and the page fails mobile usability. Add width=device-width, initial-scale=1.',
  references: [MOBILE_FIRST, VIEWPORT],
  run: (page) => {
    const viewport = page.html?.viewport;
    if (viewport !== null && viewport !== undefined && viewport.trim() !== '') return pass();
    return fail({
      subject: page.finalUrl,
      selector: 'meta[name="viewport"]',
      expected: 'width=device-width, initial-scale=1',
    });
  },
});

export const titleDuplicate = defineCheck({
  id: 'title.duplicate',
  title: 'Several pages share a title',
  category: 'on_page',
  severity: 'medium',
  scope: 'cross_page',
  kind: 'deterministic',
  evaluator: 'finalize',
  explain:
    'Several indexable pages share the same title. Duplicate titles make pages compete with each other and give searchers no way to tell them apart. Give each page a title that describes its own content.',
  references: [TITLE_LINK, DUPLICATE_CONTENT],
  fix: { change: 'meta.title' },
  definition:
    'Fails for each group of two or more indexable 200 HTML pages in the audit whose title text is identical after trimming and collapsing whitespace (case-sensitive). Pages with no title or an empty title are excluded (title.missing and title.empty cover them). Evidence: one item per URL in the group, each carrying the shared title, capped at 50 URLs per group.',
});

export const descriptionDuplicate = defineCheck({
  id: 'description.duplicate',
  title: 'Several pages share a meta description',
  category: 'on_page',
  severity: 'medium',
  scope: 'cross_page',
  kind: 'deterministic',
  evaluator: 'finalize',
  explain:
    'Several indexable pages share the same meta description. Duplicate descriptions make snippets repetitive and do not reflect each page. Write a description for each page.',
  references: [SNIPPET, DUPLICATE_CONTENT],
  fix: { change: 'meta.description' },
  definition:
    'Fails for each group of two or more indexable 200 HTML pages in the audit whose meta description is identical after trimming and collapsing whitespace (case-sensitive). Pages with no meta description are excluded (description.missing covers them). Evidence: one item per URL in the group, each carrying the shared description, capped at 50 URLs per group.',
});

export const contentDuplicate = defineCheck({
  id: 'content.duplicate',
  title: 'Several pages have identical content',
  category: 'on_page',
  severity: 'medium',
  scope: 'cross_page',
  kind: 'deterministic',
  evaluator: 'finalize',
  explain:
    'Several indexable pages have identical main content. Google picks one and treats the rest as duplicates, so the others rarely rank. Differentiate the pages or consolidate them with a canonical.',
  references: [DUPLICATE_CONTENT],
  definition:
    'Fails for each group of two or more indexable 200 HTML pages in the audit whose main-content hash (sha256 of the normalised visible text) is identical and is not the hash of an empty body. Evidence: one item per URL in the group, each carrying the shared hash and the page’s word count, capped at 50 URLs per group.',
});

export const onPageChecks = [
  titleMissing,
  titleEmpty,
  titleTooLong,
  titleTooShort,
  titleMultiple,
  descriptionMissing,
  descriptionTooLong,
  descriptionTooShort,
  descriptionMultiple,
  h1Missing,
  h1Multiple,
  headingsSkippedLevel,
  contentThin,
  htmlLangMissing,
  viewportMissing,
  titleDuplicate,
  descriptionDuplicate,
  contentDuplicate,
] as const;
