import type { RedirectChange } from '../change-types';
import { redirectTokenProblem } from '../change-types';
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
// A new rule is refused when it would loop (`/a -> /b` while `/b -> /a` exists) or chain, in either
// direction: `/a -> /b` while `/b -> /c` exists adds a hop after `/a`, and adding `/b -> /c` while
// `/a -> /b` exists adds a hop before it. Both checks understand the format's patterns — a `*`
// splat with `:splat` on the target, and `:placeholder` segments — because a literal-only graph
// misses the loop `/old/* -> /new/:splat` plus `/new/item -> /old/item`. When a pattern interaction
// cannot be decided (a target placeholder the source cannot supply), the rule is refused with the
// reason rather than accepted.
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

/** A path for chain comparison: trailing slashes dropped (except the root), absolute URLs kept whole. */
function normalisePath(value: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value.replace(/\/+$/, '').toLowerCase();
  const withoutSlash = value.replace(/\/+$/, '');
  return withoutSlash === '' ? '/' : withoutSlash;
}

// ---------------------------------------------------------------------------------------------
// The format's patterns
// ---------------------------------------------------------------------------------------------

interface CompiledFrom {
  regex: RegExp;
  names: string[];
}

const compiledFrom = new Map<string, CompiledFrom>();

/**
 * A rule's `from` as a matcher: `*` is a splat (rest of the path) and `:name` is one segment. A
 * `:name` sharing its segment with literals is not a placeholder in this format, so it stays
 * literal and the rule simply matches less; that is visible rather than over-broad.
 */
function compileFrom(from: string): CompiledFrom {
  const cached = compiledFrom.get(from);
  if (cached) return cached;
  // Patterns are compared the way rules are compared elsewhere: a trailing slash is not a
  // difference (`/b/` and `/b` are the same page), so it is dropped before compiling.
  const pattern = normalisePath(from);
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

/** The parameters a `from` pattern gives a path, or null when it does not match. */
function matchFrom(from: string, path: string): Record<string, string> | null {
  const compiled = compileFrom(from);
  const matched = compiled.regex.exec(normalisePath(path));
  if (!matched) return null;
  const values: Record<string, string> = {};
  compiled.names.forEach((name, index) => {
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
  const resolved = to.replace(/:[A-Za-z0-9_]+/g, (token) => {
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

/** A `to` template as a matcher, to see whether a rule could target a concrete path. */
function matchTarget(to: string, path: string): Record<string, string> | null {
  // For this direction `:splat` may span segments and `:name` is one, but the template is checked
  // against a concrete path, so the same compiler is enough once `:splat` is named `*`.
  const asFrom = to.replace(/:splat\b/g, '*');
  return matchFrom(asFrom, path);
}

// ---------------------------------------------------------------------------------------------
// Chain and loop analysis
// ---------------------------------------------------------------------------------------------

interface ChainVerdict {
  kind: 'loop' | 'chain';
  finalTarget: string;
  chain: string[];
}

/** A rule that already targets the new rule's source, so it would redirect twice. */
interface IncomingVerdict {
  kind: 'chain';
  sources: string[];
}

type Walk =
  | { kind: 'loop'; finalTarget: string; chain: string[] }
  | { kind: 'chain'; finalTarget: string; chain: string[] }
  | { kind: 'undecidable'; reason: string };

/** The refusal for a walk that cannot be decided: the rules it followed are named. */
function undecidableWalk(rule: RuleLine, path: string): Walk {
  return {
    kind: 'undecidable',
    reason: `The existing rule ${rule.from} -> ${rule.to} matches ${path}, but its target needs a placeholder its source cannot supply, so whether this change loops cannot be decided here. Fix that rule first.`,
  };
}

/**
 * Follow the rules from a proposed target. A loop comes back as `loop`; a target that already
 * redirects comes back as `chain` with the final target, which is what the rule should point at.
 * `ignoreFrom` is the rule being replaced: it must not make its own successor look like a chain.
 */
function chainVerdict(lines: Line[], from: string, to: string, ignoreFrom: string | null): Walk | null {
  const rules = lines.map((line, index) => ruleOf(line.text, index)).filter((rule): rule is RuleLine => rule !== null);
  const usable = ignoreFrom === null ? rules : rules.filter((rule) => normalisePath(rule.from) !== normalisePath(ignoreFrom));
  const origin = normalisePath(from);
  const seen = new Set<string>([origin]);
  let current = normalisePath(to);
  let finalTarget = to;
  const chain: string[] = [];
  if (current === origin) return { kind: 'loop', finalTarget: to, chain: [to] };
  for (let hops = 0; hops < 20; hops += 1) {
    // Netlify and Cloudflare answer with the first rule that matches, so the first match wins here.
    let matched: RuleLine | undefined;
    let params: Record<string, string> | null = null;
    for (const rule of usable) {
      const values = matchFrom(rule.from, current);
      if (values) {
        matched = rule;
        params = values;
        break;
      }
    }
    if (!matched || params === null) break;
    const resolved = resolveTarget(matched.to, params);
    if (resolved === null) return undecidableWalk(matched, current);
    finalTarget = resolved;
    chain.push(resolved);
    const next = normalisePath(resolved);
    if (next === origin || seen.has(next)) return { kind: 'loop', finalTarget, chain };
    seen.add(next);
    current = next;
  }
  return chain.length > 0 ? { kind: 'chain', finalTarget, chain } : null;
}

/**
 * The rules whose target is the new rule's source, patterns included: `/old/* -> /new/:splat`
 * already sends `/old/item` to `/new/item`, so adding `/new/item` would make it redirect twice.
 * A source the pattern cannot pin down is reported by the pattern itself.
 */
function incomingVerdict(lines: Line[], from: string): IncomingVerdict | null {
  const fromPath = normalisePath(from);
  const sources: string[] = [];
  for (const line of lines) {
    const rule = ruleOf(line.text, 0);
    if (!rule) continue;
    const params = matchTarget(rule.to, fromPath);
    if (!params) continue;
    const concrete = resolveTarget(rule.from.replaceAll('*', ':splat'), params);
    sources.push(concrete === null ? rule.from : concrete);
  }
  return sources.length > 0 ? { kind: 'chain', sources } : null;
}

/** Refuse a new rule when an existing one already points at its source. */
function incomingRefusal(change: RedirectChange, finalTarget: string, verdict: IncomingVerdict): Refusal {
  const list = verdict.sources.join(', ');
  return refuse(
    'conflict',
    `${list} already ${verdict.sources.length === 1 ? 'redirects' : 'redirect'} to ${change.from}, so ${verdict.sources.length === 1 ? 'it' : 'they'} would redirect twice. Point ${list} at ${finalTarget} in the same change set, or add this rule after updating ${verdict.sources.length === 1 ? 'it' : 'them'}.`,
    { from: change.from, incoming: verdict.sources, suggestion: finalTarget },
  );
}

function chainRefusal(change: RedirectChange, target: string, verdict: ChainVerdict): Refusal {
  return refuse(
    'conflict',
    `${target} already redirects to ${verdict.finalTarget}. Point this rule at ${verdict.finalTarget} directly instead of adding a chain.`,
    { from: change.from, suggestion: verdict.finalTarget, chain: verdict.chain },
  );
}

function loopRefusal(change: RedirectChange, target: string, chain: string[]): Refusal {
  return refuse('conflict', `Redirecting ${change.from} to ${target} creates a loop. Point it at a page that does not redirect.`, {
    from: change.from,
    chain,
  });
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

/** Add, update or remove one rule in a Netlify-format redirects file. */
export function applyRedirectEdit(text: string, change: RedirectChange): RedirectEditOutcome {
  const hashProblem = sourceHashRefusal(change, text);
  if (hashProblem) return hashProblem;
  const lines = splitLines(text);
  const rules = lines.map((line, index) => ruleOf(line.text, index)).filter((rule): rule is RuleLine => rule !== null);
  const from = normalisePath(change.from);
  const existing = rules.find((rule) => normalisePath(rule.from) === from);
  const target = detailOf(change);
  if ('ok' in target) return target;

  const fromProblem = redirectTokenProblem(change.from, 'from');
  if (fromProblem) return refuse('invalid', fromProblem, { from: change.from });
  if (change.operation !== 'remove') {
    const toProblem = redirectTokenProblem(target.to, 'to');
    if (toProblem) return refuse('invalid', toProblem, { to: target.to });
  }

  if (change.operation === 'add') {
    if (existing) {
      return refuse('conflict', `A redirect from ${change.from} already exists (to ${existing.to}). Use update, or remove it first.`, {
        from: change.from,
      });
    }
    const verdict = chainVerdict(lines, change.from, target.to, null);
    if (verdict?.kind === 'undecidable') return refuse('conflict', verdict.reason, { from: change.from });
    if (verdict?.kind === 'loop') return loopRefusal(change, target.to, verdict.chain);
    const incoming = incomingVerdict(lines, change.from);
    if (incoming) return incomingRefusal(change, verdict?.finalTarget ?? target.to, incoming);
    if (verdict) return chainRefusal(change, target.to, verdict);
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

  const verdict = chainVerdict(lines, change.from, target.to, change.from);
  if (verdict?.kind === 'undecidable') return refuse('conflict', verdict.reason, { from: change.from });
  if (verdict?.kind === 'loop') return loopRefusal(change, target.to, verdict.chain);
  if (verdict) return chainRefusal(change, target.to, verdict);
  if (existing.to === target.to && existing.status === target.status) return { ok: true, text, changed: false };

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
