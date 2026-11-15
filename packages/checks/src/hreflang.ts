// hreflang code validation (crawler-and-audits.md §5 "International").
//
// Google accepts `x-default` or a language code in ISO 639-1 format, optionally followed by a
// script (ISO 15924) and a region in ISO 3166-1 alpha-2 format: `en`, `en-GB`, `zh-Hans`,
// `zh-Hant-TW`. It matches case-insensitively, so `en-gb` is accepted even though BCP 47 prefers
// `en-GB`. Google does not support UN M.49 numeric regions (`es-419`), and a code that is not an
// assigned ISO 3166-1 country is ignored, including the reserved `UK` (use `GB`), `EU` and the
// user-assigned ranges (`AA`, `QM`–`QZ`, `XA`–`XZ`, `ZZ`).
// https://developers.google.com/search/docs/specialty/international/localized-versions
//
// The registries come from the runtime's ICU data (`Intl.DisplayNames`, `Intl.getCanonicalLocales`),
// so no code list is maintained here. A region alias that ICU rewrites (`UK` → `GB`, `BU` → `MM`)
// is not an assigned code and is refused.

const SHAPE = /^([a-z]{2})(?:-([a-z]{4}))?(?:-([a-z]{2}))?$/i;
/** Exceptionally reserved ISO 3166-1 codes and the user-assigned ranges; not countries. */
const NOT_A_COUNTRY = /^(?:AC|CP|CQ|DG|EA|EU|EZ|FX|IC|SU|TA|UK|UN|AA|Q[M-Z]|X[A-Z]|ZZ)$/;

const languages = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
const scripts = new Intl.DisplayNames(['en'], { type: 'script', fallback: 'none' });
const regions = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });

function isAssignedRegion(region: string): boolean {
  const code = region.toUpperCase();
  if (NOT_A_COUNTRY.test(code) || regions.of(code) === undefined) return false;
  return Intl.getCanonicalLocales(`und-${code}`)[0] === `und-${code}`;
}

/** Whether a value is a usable hreflang code for Google: `x-default`, or language[-script][-region]. */
export function isValidHreflang(code: string): boolean {
  const value = code.trim();
  if (value.toLowerCase() === 'x-default') return true;
  const match = SHAPE.exec(value);
  if (!match) return false;
  const [, language, script, region] = match;
  if (!language || languages.of(language.toLowerCase()) === undefined) return false;
  if (script) {
    const name = `${script[0]?.toUpperCase()}${script.slice(1).toLowerCase()}`;
    if (name === 'Zzzz' || scripts.of(name) === undefined) return false;
  }
  return !region || isAssignedRegion(region);
}
