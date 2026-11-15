import type { RedirectChange } from '../change-types';
import { redirectTokenProblem } from '../change-types';
import { type Refusal, refuse } from '../refusal';
import { sourceHashRefusal } from '../source';

// The redirects editor for a Netlify/Cloudflare Pages `_redirects` file:
//
//   # a comment
//   /old-page/  /new-page/  301
//
// Comments, ordering and every untouched line are preserved. A new rule is refused when it would
// loop (`/a -> /b` while `/b -> /a` exists) or chain, in either direction: `/a -> /b` while
// `/b -> /c` exists adds a hop after `/a`, and adding `/b -> /c` while `/a -> /b` exists adds a hop
// before it. A chain is legal to a server, but it costs a round trip and hides the real target, so
// the refusal names the final target to point at instead — or the rule to update in the same change
// set. The fields are re-checked here even though the schema already validates them, because a
// caller can build a change object without parsing it and one stray newline would inject a rule.

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

function ruleOf(line: string, index: number): RuleLine | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2) return null;
  const status = tokens[2] === undefined ? 301 : Number(tokens[2]);
  if (!REDIRECT_STATUSES.has(status)) return null;
  return { index, from: tokens[0]!, to: tokens[1]!, status };
}

/** A path for chain comparison: trailing slashes dropped (except the root), absolute URLs kept whole. */
function normalisePath(value: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value.replace(/\/+$/, '').toLowerCase();
  const withoutSlash = value.replace(/\/+$/, '');
  return withoutSlash === '' ? '/' : withoutSlash;
}

interface ChainVerdict {
  kind: 'loop' | 'chain';
  finalTarget: string;
  chain: string[];
}

/** Rules that already point at a path, which a new rule from that path would make chain. */
interface IncomingVerdict {
  kind: 'loop' | 'chain';
  sources: string[];
}

/**
 * Follow the rules from a proposed target. A loop comes back as `loop`; a target that already
 * redirects comes back as `chain` with the final target, which is what the rule should point at.
 * `ignoreFrom` is the rule being replaced: it must not make its own successor look like a chain.
 */
function chainVerdict(lines: Line[], from: string, to: string, ignoreFrom: string | null): ChainVerdict | null {
  const rules = lines.map((line, index) => ruleOf(line.text, index)).filter((rule): rule is RuleLine => rule !== null);
  const byFrom = new Map<string, RuleLine>();
  for (const rule of rules) {
    if (ignoreFrom !== null && normalisePath(rule.from) === normalisePath(ignoreFrom)) continue;
    if (!byFrom.has(normalisePath(rule.from))) byFrom.set(normalisePath(rule.from), rule);
  }
  const origin = normalisePath(from);
  const seen = new Set<string>([origin]);
  let current = normalisePath(to);
  let finalTarget = to;
  const chain: string[] = [];
  if (current === origin) return { kind: 'loop', finalTarget: to, chain: [to] };
  for (let hops = 0; hops < 20; hops += 1) {
    const rule = byFrom.get(current);
    if (!rule) break;
    finalTarget = rule.to;
    chain.push(rule.to);
    const next = normalisePath(rule.to);
    if (next === origin || seen.has(next)) return { kind: 'loop', finalTarget, chain };
    seen.add(next);
    current = next;
  }
  return chain.length > 0 ? { kind: 'chain', finalTarget, chain } : null;
}

/**
 * The rules whose target is the new rule's source: they would gain a hop through it. A rule that
 * also *is* the new target closes a loop (`/a -> /b` plus `/b -> /a`).
 */
function incomingVerdict(lines: Line[], from: string, to: string): IncomingVerdict | null {
  const fromKey = normalisePath(from);
  const toKey = normalisePath(to);
  const sources: string[] = [];
  let loop = false;
  for (const line of lines) {
    const rule = ruleOf(line.text, 0);
    if (!rule || normalisePath(rule.to) !== fromKey) continue;
    if (normalisePath(rule.from) === toKey) loop = true;
    sources.push(rule.from);
  }
  if (loop) return { kind: 'loop', sources };
  return sources.length > 0 ? { kind: 'chain', sources } : null;
}

/** Refuse a new rule when an existing one already points at its source. */
function incomingRefusal(change: RedirectChange, target: string, finalTarget: string, verdict: IncomingVerdict): Refusal {
  if (verdict.kind === 'loop') {
    return refuse('conflict', `Redirecting ${change.from} to ${target} creates a loop with ${verdict.sources.join(', ')}.`, {
      from: change.from,
      chain: verdict.sources,
    });
  }
  const list = verdict.sources.join(', ');
  return refuse(
    'conflict',
    `${list} already ${verdict.sources.length === 1 ? 'redirects' : 'redirect'} to ${change.from}, so ${verdict.sources.length === 1 ? 'it' : 'they'} would redirect twice. Point ${list} at ${finalTarget} in the same change set, or add this rule after updating ${verdict.sources.length === 1 ? 'it' : 'them'}.`,
    { from: change.from, incoming: verdict.sources, suggestion: finalTarget },
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
    if (verdict?.kind === 'loop') {
      return refuse('conflict', `Redirecting ${change.from} to ${target.to} creates a loop. Point it at a page that does not redirect.`, {
        from: change.from,
        chain: verdict.chain,
      });
    }
    const incoming = incomingVerdict(lines, change.from, target.to);
    if (incoming) return incomingRefusal(change, target.to, verdict?.finalTarget ?? target.to, incoming);
    if (verdict) {
      return refuse(
        'conflict',
        `${target.to} already redirects to ${verdict.finalTarget}. Point this rule at ${verdict.finalTarget} directly instead of adding a chain.`,
        { from: change.from, suggestion: verdict.finalTarget, chain: verdict.chain },
      );
    }
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
  if (verdict?.kind === 'loop') {
    return refuse('conflict', `Redirecting ${change.from} to ${target.to} creates a loop. Point it at a page that does not redirect.`, {
      from: change.from,
      chain: verdict.chain,
    });
  }
  if (verdict) {
    return refuse(
      'conflict',
      `${target.to} already redirects to ${verdict.finalTarget}. Point this rule at ${verdict.finalTarget} directly instead of adding a chain.`,
      { from: change.from, suggestion: verdict.finalTarget, chain: verdict.chain },
    );
  }
  if (existing.to === target.to && existing.status === target.status) return { ok: true, text, changed: false };
  lines[existing.index] = { text: `${change.from}  ${target.to}  ${target.status}`, ending: lines[existing.index]!.ending };
  return { ok: true, text: joinLines(lines), changed: true };
}

/** The rules a redirects file holds, for a caller that wants to check what is already there. */
export function redirectRules(text: string): { from: string; to: string; status: number }[] {
  return splitLines(text)
    .map((line, index) => ruleOf(line.text, index))
    .filter((rule): rule is RuleLine => rule !== null)
    .map(({ from, to, status }) => ({ from, to, status }));
}
