import type { RedirectChange } from '../change-types';
import { isRedirectPattern, redirectTokenProblem } from '../change-types';
import { type Refusal, refuse } from '../refusal';
import { sourceHashRefusal } from '../source';

// The redirects editor for a Netlify/Cloudflare Pages `_redirects` file:
//
//   # a comment
//   /old-page/  /new-page/  301
//   /blog/*     /posts/:splat  301
//   /news/:year/:slug/  /archive/:year/:slug/
//
// Comments, ordering and every untouched line are preserved. A rule line is only ever rewritten in
// the spans of the field that changed (`to`, `status`), so an inline comment (`/a /b 301 # note`) and
// the spacing around it survive an update.
//
// A change writes a rule for ONE url (Phase 1 decision, ADR-0007): `from` and `to` carry no `*`
// splat and no `:name` segment. Pattern rules are a person's edit; a change that names one is
// refused rather than analysed, because a pattern graph has holes that are hard to prove closed. The
// file may still contain pattern rules written by people, so the surrounding analysis understands
// them.
//
// A new rule is refused when the resulting file would loop or chain. That is decided the way the
// platform decides: first match wins, on the request path. Match order follows the file, and both
// Cloudflare Pages and Netlify match the path (a fragment is never part of a match, and a `from`
// that carries no query string matches any query), so identity here is the path with trailing
// slashes dropped, plus the query only when the rule itself spells one. Every involved literal path
// is evaluated against the resulting file: the new rule's own target, and every rule whose
// effective target is the new rule's source would gain a hop. A pattern rule that answers one of
// those paths — or that cannot be resolved for it — is refused with the line to edit by hand, unless
// first match wins proves an earlier rule shadows it for that path.
//
// The fields are re-checked here even though the schema already validates them, because a caller
// can build a change object without parsing it and one stray newline would inject a rule.

export type RedirectEditOutcome = { ok: true; text: string; changed: boolean } | Refusal;

const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

interface Line {
  text: string;
  ending: '\r\n' | '\n' | '';
}

interface RuleLine {
  index: number;
  from: string;
  to: string;
  status: number;
}

interface Span {
  start: number;
  end: number;
}

interface RuleSpans {
  from: Span;
  to: Span;
  /** The status token, when the line spells one (a rule may rely on the default 301). */
  status: Span | null;
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let index = 0;
  while (index < text.length) {
    const newline = text.indexOf('\n', index);
    if (newline === -1) {
      lines.push({ text: text.slice(index), ending: '' });
      break;
    }
    if (newline > index && text[newline - 1] === '\r') lines.push({ text: text.slice(index, newline - 1), ending: '\r\n' });
    else lines.push({ text: text.slice(index, newline), ending: '\n' });
    index = newline + 1;
  }
  if (lines.length === 0) lines.push({ text: '', ending: '' });
  return lines;
}

function joinLines(lines: Line[]): string {
  return lines.map((line) => line.text + line.ending).join('');
}

interface Token {
  text: string;
  start: number;
  end: number;
}

/**
 * The tokens of one rule line with their offsets, stopping at a comment. A `#` starts a comment
 * only at the beginning of a line or of a token (after whitespace), which is what makes
 * `/new-page#section` a target and ` # a note` a comment.
 */
function tokensOf(line: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < line.length && /\s/.test(line[index]!)) index += 1;
  while (index < line.length) {
    const start = index;
    while (index < line.length && !/\s/.test(line[index]!)) index += 1;
    const text = line.slice(start, index);
    if (text.startsWith('#')) break;
    tokens.push({ text, start, end: index });
    while (index < line.length && /\s/.test(line[index]!)) index += 1;
  }
  return tokens;
}

/** The field spans of a rule line, or null for a comment, blank line or unsupported rule. */
function ruleSpansOf(line: string): RuleSpans | null {
  const tokens = tokensOf(line);
  if (tokens.length < 2) return null;
  const statusToken = tokens[2];
  const status = statusToken === undefined ? 301 : Number(statusToken.text);
  if (!REDIRECT_STATUSES.has(status)) return null;
  return {
    from: { start: tokens[0]!.start, end: tokens[0]!.end },
    to: { start: tokens[1]!.start, end: tokens[1]!.end },
    status: statusToken === undefined ? null : { start: statusToken.start, end: statusToken.end },
  };
}

function ruleOf(line: string, index: number): RuleLine | null {
  const spans = ruleSpansOf(line);
  if (!spans) return null;
  const status = spans.status === null ? 301 : Number(line.slice(spans.status.start, spans.status.end));
  return {
    index,
    from: line.slice(spans.from.start, spans.from.end),
    to: line.slice(spans.to.start, spans.to.end),
    status,
  };
}

// ---------------------------------------------------------------------------------------------
// Matching: what the platform compares
// ---------------------------------------------------------------------------------------------

/**
 * The request path a rule field is about: an absolute URL's path, or the field itself, with the
 * fragment and query removed and trailing slashes dropped (except the root). A rule's `to` keeps
 * its fragment when written; it just never takes part in matching.
 */
function pathOnly(value: string): string {
  let path = value;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      path = new URL(value).pathname;
    } catch {
      path = value;
    }
  }
  const hash = path.indexOf('#');
  if (hash !== -1) path = path.slice(0, hash);
  const query = path.indexOf('?');
  if (query !== -1) path = path.slice(0, query);
  const withoutSlash = path.replace(/\/+$/, '');
  return withoutSlash === '' ? '/' : withoutSlash;
}

/** The query string a field spells (without `?`), or null when it spells none. */
function queryOnly(value: string): string | null {
  let rest = value;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      return new URL(value).search === '' ? null : new URL(value).search.slice(1);
    } catch {
      rest = value;
    }
  }
  const hash = rest.indexOf('#');
  if (hash !== -1) rest = rest.slice(0, hash);
  const query = rest.indexOf('?');
  return query === -1 ? null : rest.slice(query + 1);
}

/**
 * A rule or target as the graph compares it: the request path, with the query only when the value
 * spells one. An absolute target keeps its origin, because another host is another page.
 */
function identityOf(value: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const query = url.search === '' ? '' : url.search;
      return `${url.protocol}//${url.host}${pathOnly(value)}${query}`;
    } catch {
      return value;
    }
  }
  const query = queryOnly(value);
  return query === null ? pathOnly(value) : `${pathOnly(value)}?${query}`;
}

interface CompiledFrom {
  regex: RegExp;
  names: string[];
}

const compiledFrom = new Map<string, CompiledFrom>();

/**
 * A rule's path as a matcher: `*` is a splat (rest of the path) and `:name` is one segment. A
 * `:name` sharing its segment with literals is not a placeholder in this format, so it stays
 * literal and the rule simply matches less; that is visible rather than over-broad.
 */
function compileFrom(from: string): CompiledFrom {
  const cached = compiledFrom.get(from);
  if (cached) return cached;
  const pattern = pathOnly(from);
  let source = '^';
  const names: string[] = [];
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index]!;
    if (char === '*') {
      names.push('*');
      source += '(.*)';
      index += 1;
      continue;
    }
    if (char === ':') {
      const matched = /^:([A-Za-z0-9_]+)/.exec(pattern.slice(index));
      if (matched) {
        const rest = pattern.slice(index + matched[0].length);
        if (rest === '' || rest.startsWith('/')) {
          names.push(matched[1]!);
          source += '([^/]+)';
          index += matched[0].length;
          continue;
        }
      }
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    index += 1;
  }
  const compiled = { regex: new RegExp(`${source}$`), names };
  compiledFrom.set(from, compiled);
  return compiled;
}

/** Whether a rule's `from` is a pattern rather than one path. */
function isPattern(from: string): boolean {
  return isRedirectPattern(from);
}

/**
 * The parameters a rule's `from` gives a request value, or null when the rule does not answer it.
 * A `from` without a query matches any query — the platform matches the path — while one that
 * spells a query only matches that one.
 */
function fromMatches(from: string, requestValue: string): Record<string, string> | null {
  const ruleQuery = queryOnly(from);
  if (ruleQuery !== null && ruleQuery !== queryOnly(requestValue)) return null;
  const matched = compileFrom(from).regex.exec(pathOnly(requestValue));
  if (!matched) return null;
  const values: Record<string, string> = {};
  compileFrom(from).names.forEach((name, index) => {
    values[name] = matched[index + 1] ?? '';
  });
  return values;
}

/**
 * Fill a `to` template from the parameters a `from` pattern captured. Null when the template needs
 * a parameter the rule cannot supply: the real target is then unknowable here, so the caller must
 * refuse rather than guess.
 */
function resolveTarget(to: string, params: Record<string, string>): string | null {
  let unresolved = false;
  // Only a whole segment is a placeholder (as in `compileFrom`): `/time/12:30/` stays literal.
  const resolved = to.replace(/(?<=\/):[A-Za-z0-9_]+(?=\/|$|\?|#)/g, (token) => {
    const name = token.slice(1);
    const value = name === 'splat' && params['*'] !== undefined ? params['*'] : params[name];
    if (value === undefined) {
      unresolved = true;
      return token;
    }
    return value;
  });
  return unresolved ? null : resolved;
}

/**
 * The parameters that make a `to` template land on a concrete path, or null when it cannot. Used to
 * turn "which rule sends something to the new rule's source" into a concrete source path.
 */
function matchTarget(to: string, path: string): Record<string, string> | null {
  // In this direction `:splat` may span segments and `:name` is one; the template is matched
  // against one concrete path, so addressing `:splat` as a splat is enough.
  const matched = compileFrom(to.replace(/:splat\b/g, '*')).regex.exec(pathOnly(path));
  if (!matched) return null;
  const values: Record<string, string> = {};
  compileFrom(to.replace(/:splat\b/g, '*')).names.forEach((name, index) => {
    values[name] = matched[index + 1] ?? '';
  });
  return values;
}

/** The rule that answers a request, with the target it writes; `target` is null when unresolvable. */
interface EffectiveTarget {
  rule: RuleLine;
  target: string | null;
}

/** An absolute URL: a request that leaves this file's rules (another host, or an explicit origin). */
function isAbsolute(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith('//');
}

/**
 * The first rule that answers a request value, as the platform applies them (first match wins). An
 * absolute target is a request to an origin this file does not govern (the rules match the site's
 * own paths), so no rule answers it: `https://other.test/done` never follows the local `/done`.
 */
function effectiveTarget(rules: readonly RuleLine[], requestValue: string): EffectiveTarget | null {
  if (isAbsolute(requestValue)) return null;
  for (const rule of rules) {
    const params = fromMatches(rule.from, requestValue);
    if (!params) continue;
    return { rule, target: resolveTarget(rule.to, params) };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------

function loopRefusal(change: RedirectChange, target: string, chain: string[]): Refusal {
  return refuse('conflict', `Redirecting ${change.from} to ${target} creates a loop. Point it at a page that does not redirect.`, {
    from: change.from,
    chain,
  });
}

function chainRefusal(change: RedirectChange, target: string, finalTarget: string, chain: string[]): Refusal {
  return refuse(
    'conflict',
    `${target} already redirects to ${finalTarget}. Point this rule at ${finalTarget} directly instead of adding a chain.`,
    { from: change.from, suggestion: finalTarget, chain },
  );
}

function incomingRefusal(change: RedirectChange, finalTarget: string, sources: string[]): Refusal {
  const list = sources.join(', ');
  return refuse(
    'conflict',
    `${list} already ${sources.length === 1 ? 'redirects' : 'redirect'} to ${change.from}, so ${sources.length === 1 ? 'it' : 'they'} would redirect twice. Point ${list} at ${finalTarget} in the same change set, or add this rule after updating ${sources.length === 1 ? 'it' : 'them'}.`,
    { from: change.from, incoming: sources, suggestion: finalTarget },
  );
}

/**
 * A pattern rule the change's own source or target runs into. Phase 1 changes write one literal
 * rule and never edit a pattern, so the fix is a person's edit of the redirects file.
 */
function patternInteractionRefusal(change: RedirectChange, rule: RuleLine, path: string): Refusal {
  const line = rule.index + 1;
  return refuse(
    'conflict',
    `${path} interacts with the pattern rule at line ${line} (${rule.from} -> ${rule.to}); this change can only add a rule for one URL. Edit the redirects file by hand if that pattern needs to change.`,
    { from: change.from, line, rule: { from: rule.from, to: rule.to } },
  );
}

/** A pattern rule whose target cannot be resolved for a path, so a loop cannot be ruled out. */
function undecidableRefusal(change: RedirectChange, rule: RuleLine, path: string): Refusal {
  const line = rule.index + 1;
  return refuse(
    'conflict',
    `${path} matches the rule at line ${line} (${rule.from} -> ${rule.to}), but its target needs a placeholder that rule cannot supply, so whether this change loops cannot be decided. It interacts with the pattern rule at line ${line}; edit the redirects file by hand.`,
    { from: change.from, line, rule: { from: rule.from, to: rule.to } },
  );
}

function detailOf(change: RedirectChange): { to: string; status: number } | Refusal {
  if (change.operation === 'remove') {
    if (!change.before) return refuse('invalid', 'A removed redirect needs the rule it removes (`before`).');
    return { to: change.before.to, status: change.before.status };
  }
  if (change.to === undefined || change.status === undefined) {
    return refuse('invalid', `An ${change.operation === 'add' ? 'added' : 'updated'} redirect needs a target and a status.`);
  }
  return { to: change.to, status: change.status };
}

function stale(rule: RuleLine, before: { to: string; status: number }, from: string): Refusal {
  return refuse(
    'stale',
    `The redirect from ${from} now goes to ${rule.to} with status ${rule.status}, not ${before.to} with status ${before.status}. Re-read the file and draft the change again.`,
    { from, current: { to: rule.to, status: rule.status } },
  );
}

/** Rewrite only the `to` and/or `status` spans of a rule line, keeping spacing and inline comments. */
function updatedRuleLine(line: string, spans: RuleSpans, to: string, status: number, changeTo: boolean, changeStatus: boolean): string {
  if (changeTo && changeStatus) {
    const between = spans.status ? line.slice(spans.to.end, spans.status.start) : '  ';
    const afterStatus = spans.status ? line.slice(spans.status.end) : line.slice(spans.to.end);
    return line.slice(0, spans.to.start) + to + between + status + afterStatus;
  }
  if (changeTo) return line.slice(0, spans.to.start) + to + line.slice(spans.to.end);
  if (spans.status) return line.slice(0, spans.status.start) + String(status) + line.slice(spans.status.end);
  return `${line.slice(0, spans.to.end)}  ${status}${line.slice(spans.to.end)}`;
}

// ---------------------------------------------------------------------------------------------
// Loop and chain analysis
// ---------------------------------------------------------------------------------------------

/** The rules of the file after the change, plus the rule the change writes. */
interface ProposedFile {
  rules: RuleLine[];
  newRule: RuleLine;
}

/** The rules whose effective target is the new rule's source, so they would redirect twice. */
interface Incoming {
  sources: string[];
  /** A pattern rule that sends some path to the source but cannot be resolved to one path. */
  undecidable: RuleLine | null;
}

function incomingOf(rules: readonly RuleLine[], newRule: RuleLine): Incoming {
  const sources: string[] = [];
  let undecidable: RuleLine | null = null;
  for (const rule of rules) {
    if (rule === newRule) continue;
    let source = rule.from;
    if (isPattern(rule.from)) {
      const params = matchTarget(rule.to, newRule.from);
      if (!params) continue;
      const concrete = resolveTarget(rule.from.replaceAll('*', ':splat'), params);
      if (concrete === null) {
        undecidable = rule;
        continue;
      }
      source = concrete;
    } else if (isAbsolute(rule.to) || !fromMatches(newRule.from, rule.to)) {
      // Request matching, not identity: `/old -> /new?x=1` reaches `/new` when `/new` spells no query.
      continue;
    }
    // First match wins: the rule only sends `source` to the new rule's source when no earlier rule
    // answers `source` instead. That is what makes a shadowed pattern not a chain.
    const found = effectiveTarget(rules, source);
    if (!found || found.rule !== rule || found.target === null) continue;
    // The target must be answered by the new rule itself, first match included.
    if (effectiveTarget(rules, found.target)?.rule !== newRule) continue;
    sources.push(source);
  }
  return { sources, undecidable };
}

/**
 * Refuse a proposed file whose new rule loops, chains, or runs into a pattern rule that only a
 * person should change. Returns null when the rule is safe.
 */
function graphRefusal(change: RedirectChange, proposed: ProposedFile): Refusal | null {
  const { rules, newRule } = proposed;
  const origin = identityOf(newRule.from);
  if (identityOf(newRule.to) === origin) return loopRefusal(change, newRule.to, [newRule.to]);

  // The rule's own source and target must be settled by the first match: a pattern that answers
  // either path is an interaction this change does not make, and an earlier rule that answers the
  // new source leaves the new rule with nothing to do.
  for (const path of [newRule.from, newRule.to]) {
    const found = effectiveTarget(rules, path);
    if (!found || found.rule === newRule) continue;
    if (isPattern(found.rule.from)) return patternInteractionRefusal(change, found.rule, path);
    if (path !== newRule.from) continue;
    return refuse(
      'conflict',
      `The rule at line ${found.rule.index + 1} (${found.rule.from} -> ${found.rule.to}) already answers ${path} first, so this rule would never apply. Update that rule instead, or remove it first.`,
      { from: change.from, line: found.rule.index + 1 },
    );
  }

  // Follow the resulting file from the new target: a hop is a chain, a return to the start is a
  // loop. Pattern rules are followed too, with their placeholders filled from the path they see.
  const seen = new Set<string>([origin]);
  const chain: string[] = [];
  let finalTarget = newRule.to;
  let current = newRule.to;
  for (let hops = 0; hops < 20; hops += 1) {
    const found = effectiveTarget(rules, current);
    if (!found) break;
    // Re-entering the new rule is a loop, whatever the identities: `/a -> /a?x=1` is answered by
    // `/a` again, because a rule without a query matches any query.
    if (found.rule === newRule) return loopRefusal(change, newRule.to, [...chain, current]);
    if (found.target === null) return undecidableRefusal(change, found.rule, pathOnly(current));
    finalTarget = found.target;
    chain.push(finalTarget);
    const next = identityOf(finalTarget);
    if (next === origin || seen.has(next)) return loopRefusal(change, newRule.to, chain);
    seen.add(next);
    current = finalTarget;
  }

  const incoming = incomingOf(rules, newRule);
  if (incoming.undecidable) return undecidableRefusal(change, incoming.undecidable, newRule.from);
  if (incoming.sources.length > 0) return incomingRefusal(change, finalTarget, incoming.sources);
  if (chain.length > 0) return chainRefusal(change, newRule.to, finalTarget, chain);
  return null;
}

// ---------------------------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------------------------

/** Add, update or remove one literal rule in a Netlify-format redirects file. */
export function applyRedirectEdit(text: string, change: RedirectChange): RedirectEditOutcome {
  const hashProblem = sourceHashRefusal(change, text);
  if (hashProblem) return hashProblem;
  const lines = splitLines(text);
  const rules = lines.map((line, index) => ruleOf(line.text, index)).filter((rule): rule is RuleLine => rule !== null);
  const existing = rules.find((rule) => identityOf(rule.from) === identityOf(change.from));
  const target = detailOf(change);
  if ('ok' in target) return target;

  const fromProblem = redirectTokenProblem(change.from, 'from');
  if (fromProblem) return refuse(isRedirectPattern(change.from) ? 'unsupported' : 'invalid', fromProblem, { from: change.from });
  const toProblem = redirectTokenProblem(target.to, 'to');
  if (toProblem) return refuse(isRedirectPattern(target.to) ? 'unsupported' : 'invalid', toProblem, { to: target.to });

  if (change.operation === 'add') {
    if (existing) {
      return refuse('conflict', `A redirect from ${change.from} already exists (to ${existing.to}). Use update, or remove it first.`, {
        from: change.from,
      });
    }
    const newRule: RuleLine = { index: -1, from: change.from, to: target.to, status: target.status };
    const refusal = graphRefusal(change, { rules: [...rules, newRule], newRule });
    if (refusal) return refusal;
    const eol = lines.find((line) => line.ending !== '')?.ending ?? '\n';
    const rule = `${change.from}  ${target.to}  ${target.status}`;
    if (lines.length === 1 && lines[0]!.text === '') return { ok: true, text: `${rule}${eol}`, changed: true };
    const last = lines[lines.length - 1]!;
    if (last.ending === '') lines[lines.length - 1] = { text: last.text, ending: eol };
    lines.push({ text: rule, ending: eol });
    return { ok: true, text: joinLines(lines), changed: true };
  }

  if (!existing) {
    return refuse('not_found', `No redirect from ${change.from} is in the file. Re-read the source and draft the change again.`, {
      from: change.from,
    });
  }
  if (!change.before) return refuse('invalid', 'An updated or removed redirect needs the rule it replaces (`before`).');
  if (existing.to !== change.before.to || existing.status !== change.before.status) return stale(existing, change.before, change.from);

  if (change.operation === 'remove') {
    lines.splice(existing.index, 1);
    return { ok: true, text: joinLines(lines), changed: true };
  }

  if (existing.to === target.to && existing.status === target.status) return { ok: true, text, changed: false };

  const newRule: RuleLine = { index: existing.index, from: change.from, to: target.to, status: target.status };
  const resulting = rules.map((rule) => (rule.index === existing.index ? newRule : rule));
  const refusal = graphRefusal(change, { rules: resulting, newRule });
  if (refusal) return refusal;

  const spans = ruleSpansOf(lines[existing.index]!.text);
  if (!spans) return refuse('invalid', `The redirect from ${change.from} could not be located precisely enough to update it.`);
  lines[existing.index] = {
    text: updatedRuleLine(
      lines[existing.index]!.text,
      spans,
      target.to,
      target.status,
      existing.to !== target.to,
      existing.status !== target.status,
    ),
    ending: lines[existing.index]!.ending,
  };
  return { ok: true, text: joinLines(lines), changed: true };
}

/** The rules a redirects file holds, for a caller that wants to check what is already there. */
export function redirectRules(text: string): { from: string; to: string; status: number }[] {
  return splitLines(text)
    .map((line, index) => ruleOf(line.text, index))
    .filter((rule): rule is RuleLine => rule !== null)
    .map(({ from, to, status }) => ({ from, to, status }));
}
