// Pixel-width estimation for titles and meta descriptions.
//
// Google does not truncate titles and snippets by character count: it renders them and cuts at the
// width of the result column. Title links render at about 20 px and truncate near 580 px; meta
// descriptions render at about 14 px and truncate near 990 px. The widths below are Arial advance
// widths (units per 1000 em, from the Arial metrics) scaled to the font size, so the estimate is
// close for Latin text and deliberately cautious elsewhere. It is an approximation: the font a
// result actually uses, and Google's own layout, decide the exact cut. No network or font library is
// involved, which keeps checks pure and deterministic.

/** Arial advance widths in units per 1000 em, for printable ASCII. */
const ARIAL_UNITS: Record<string, number> = {
  ' ': 278,
  '!': 278,
  '"': 355,
  '#': 556,
  $: 556,
  '%': 889,
  '&': 667,
  "'": 191,
  '(': 333,
  ')': 333,
  '*': 389,
  '+': 584,
  ',': 278,
  '-': 333,
  '.': 278,
  '/': 278,
  '0': 556,
  '1': 556,
  '2': 556,
  '3': 556,
  '4': 556,
  '5': 556,
  '6': 556,
  '7': 556,
  '8': 556,
  '9': 556,
  ':': 278,
  ';': 278,
  '<': 584,
  '=': 584,
  '>': 584,
  '?': 556,
  '@': 1015,
  A: 667,
  B: 667,
  C: 722,
  D: 722,
  E: 667,
  F: 611,
  G: 778,
  H: 722,
  I: 278,
  J: 500,
  K: 667,
  L: 556,
  M: 833,
  N: 722,
  O: 778,
  P: 667,
  Q: 778,
  R: 722,
  S: 667,
  T: 611,
  U: 722,
  V: 667,
  W: 944,
  X: 667,
  Y: 667,
  Z: 611,
  '[': 278,
  '\\': 278,
  ']': 278,
  '^': 469,
  _: 556,
  '`': 333,
  a: 556,
  b: 556,
  c: 500,
  d: 556,
  e: 556,
  f: 278,
  g: 556,
  h: 556,
  i: 222,
  j: 222,
  k: 500,
  l: 222,
  m: 833,
  n: 556,
  o: 556,
  p: 556,
  q: 556,
  r: 333,
  s: 500,
  t: 278,
  u: 556,
  v: 500,
  w: 722,
  x: 500,
  y: 500,
  z: 500,
  '{': 334,
  '|': 260,
  '}': 334,
  '~': 584,
};

/** The width of one character in units per 1000 em. Latin default; CJK and emoji are full-width. */
function unitsOf(char: string): number {
  const known = ARIAL_UNITS[char];
  if (known !== undefined) return known;
  const code = char.codePointAt(0) ?? 0;
  // CJK, Hangul, kana, full-width forms and emoji render at roughly one em.
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0x1f300 && code <= 0x1faff))
  )
    return 1000;
  // Accented Latin and other proportional scripts: a little wider than the average Latin glyph.
  return 580;
}

/**
 * The rendered width of `text` in CSS pixels at `fontSizePx` (default 20, Google's title size).
 * Use 14 for meta descriptions, which Google renders at snippet size.
 */
export function pixelWidth(text: string, fontSizePx = 20): number {
  let units = 0;
  for (const char of text) units += unitsOf(char);
  return Math.round(((units / 1000) * fontSizePx + Number.EPSILON) * 10) / 10;
}

/** Google truncates title links near this width at the title font size. */
export const TITLE_MAX_PX = 580;
/** Google truncates meta descriptions near this width at the snippet font size. */
export const DESCRIPTION_MAX_PX = 990;
/** The font size used for the description limit. */
export const DESCRIPTION_FONT_PX = 14;
