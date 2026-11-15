// hreflang code validation (crawler-and-audits.md §5 "International").
//
// Google accepts either `x-default` or a BCP 47 language tag with an optional script and region:
// `en`, `en-GB`, `zh-Hans`, `zh-Hans-CN`. Region subtags are ISO 3166-1 alpha-2 codes or the
// three-digit UN M.49 codes, and Google matches them case-insensitively, so `en-gb` is accepted
// even though BCP 47 prefers `en-GB`.

const HREFLANG_PATTERN = /^(?:x-default|[a-z]{2,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?)$/i;

/** Whether a value is a usable hreflang code: a BCP 47 language tag, or `x-default`. */
export function isValidHreflang(code: string): boolean {
  return HREFLANG_PATTERN.test(code.trim());
}
