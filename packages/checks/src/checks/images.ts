import { defineCheck } from '../check';
import { isOkHtml } from '../indexability';
import { fail, pass } from '../outcome';

// Images: what an image tells a crawler and a screen reader when the image itself is not available
// (crawler-and-audits.md §5 "Images").

const IMAGES = 'https://developers.google.com/search/docs/appearance/google-images';
const IMG_ELEMENT = 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/img';
const CLS = 'https://web.dev/articles/optimize-cls';

export const imageMissingAlt = defineCheck({
  id: 'image.missing_alt',
  title: 'An image has no alt attribute',
  category: 'images',
  severity: 'low',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'An image has no alt attribute. When the image fails to load, or a screen reader reads the page, there is no description. Add alt text that describes the image’s content; use alt="" only for decoration.',
  references: [IMAGES, IMG_ELEMENT],
  fix: { change: 'image.alt' },
  run: (page) => {
    const images = (page.html?.images ?? [])
      .map((image, index) => ({ image, index }))
      .filter(({ image }) => image.alt === null && !image.inLink);
    if (!images.length) return pass();
    return fail(
      images.map(({ image, index }) => ({
        subject: `${page.finalUrl}#image-${index + 1}`,
        selector: image.src ? `img[src="${image.src}"]` : 'img',
        value: image.src ?? 'no src',
        expected: 'alt text that describes the image',
      })),
    );
  },
});

export const imageLinkMissingAlt = defineCheck({
  id: 'image.link_missing_alt',
  title: 'A linked image has no alt text',
  category: 'images',
  severity: 'medium',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'An image inside a link has no alt attribute. The link then has no anchor text at all, so crawlers and screen readers cannot tell where it goes. Add alt text that describes the destination.',
  references: [IMAGES, IMG_ELEMENT],
  fix: { change: 'image.alt' },
  run: (page) => {
    const images = (page.html?.images ?? [])
      .map((image, index) => ({ image, index }))
      .filter(({ image }) => image.alt === null && image.inLink);
    if (!images.length) return pass();
    return fail(
      images.map(({ image, index }) => ({
        subject: `${page.finalUrl}#image-${index + 1}`,
        selector: image.src ? `a img[src="${image.src}"]` : 'a img',
        value: image.src ?? 'no src',
        expected: 'alt text that describes the link destination',
      })),
    );
  },
});

export const imageNoDimensions = defineCheck({
  id: 'image.no_dimensions',
  title: 'An image has no width or height attribute',
  category: 'images',
  severity: 'info',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'An image has no width or height attribute. The browser cannot reserve space for it, so the page shifts as images load. Add the intrinsic width and height so the layout stays stable.',
  references: [IMG_ELEMENT, CLS],
  run: (page) => {
    const images = (page.html?.images ?? [])
      .map((image, index) => ({ image, index }))
      .filter(({ image }) => image.width === null || image.height === null);
    if (!images.length) return pass();
    return fail(
      images.map(({ image, index }) => ({
        subject: `${page.finalUrl}#image-${index + 1}`,
        selector: image.src ? `img[src="${image.src}"]` : 'img',
        value: `width=${image.width ?? 'missing'}, height=${image.height ?? 'missing'}`,
        expected: 'width and height attributes with the intrinsic size',
      })),
    );
  },
});

export const imageChecks = [imageMissingAlt, imageLinkMissingAlt, imageNoDimensions] as const;
