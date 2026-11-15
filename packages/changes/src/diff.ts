import type { Change, ChangeTypeName } from './change-types';
import { urlOf } from './change-types';

// The review surface's data (a later task renders it): per-file unified diffs and per-URL
// before/after pairs. The diff is produced here rather than by the editor because the connector may
// batch several changes into one file, and a reviewer wants to see the net edit. A small LCS line
// diff keeps the dependency list short; it never needs to be faster than a source file.

export interface DiffFileInput {
  path: string;
  /** `null` when the file is created by this change set. */
  before: string | null;
  /** `null` when the file is deleted. */
  after: string | null;
}

export interface RenderedFileDiff {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  /** A unified diff with `a/` and `b/` headers; empty for an unchanged file. */
  unified: string;
  additions: number;
  deletions: number;
}

export interface UrlChangePair {
  type: ChangeTypeName;
  before: unknown;
  after: unknown;
}

export interface RenderedUrlDiff {
  url: string;
  changes: UrlChangePair[];
}

export interface DiffInput {
  files?: readonly DiffFileInput[];
  changes?: readonly Change[];
}

export interface RenderedDiff {
  files: RenderedFileDiff[];
  urls: RenderedUrlDiff[];
}

interface Op {
  kind: 'equal' | 'delete' | 'insert';
  line: string;
}

/** Above this many cells the LCS table is not worth its memory; the file is shown replaced. */
const MAX_LCS_CELLS = 4_000_000;
const CONTEXT_LINES = 3;

function toLines(text: string): { lines: string[]; finalNewline: boolean } {
  if (text === '') return { lines: [], finalNewline: true };
  const finalNewline = text.endsWith('\n');
  const body = finalNewline ? text.slice(0, -1) : text;
  return { lines: body.split('\n'), finalNewline };
}

function lineOps(before: readonly string[], after: readonly string[]): Op[] {
  const n = before.length;
  const m = after.length;
  if (n * m > MAX_LCS_CELLS) {
    return [...before.map((line): Op => ({ kind: 'delete', line })), ...after.map((line): Op => ({ kind: 'insert', line }))];
  }
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = table[i]!;
    const next = table[i + 1]!;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = before[i] === after[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: 'equal', line: before[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ kind: 'delete', line: before[i]! });
      i += 1;
    } else {
      ops.push({ kind: 'insert', line: after[j]! });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: 'delete', line: before[i]! });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: 'insert', line: after[j]! });
    j += 1;
  }
  return ops;
}

function hunkRanges(ops: readonly Op[]): [number, number][] {
  const ranges: [number, number][] = [];
  ops.forEach((op, index) => {
    if (op.kind === 'equal') return;
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(ops.length, index + CONTEXT_LINES + 1);
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else ranges.push([start, end]);
  });
  return ranges;
}

function unifiedFor(path: string, before: DiffFileInput['before'], after: DiffFileInput['after']): RenderedFileDiff {
  const left = before === null ? { lines: [] as string[], finalNewline: true } : toLines(before);
  const right = after === null ? { lines: [] as string[], finalNewline: true } : toLines(after);
  const ops = lineOps(left.lines, right.lines);
  const status: RenderedFileDiff['status'] = before === null ? 'added' : after === null ? 'deleted' : 'modified';
  // A final newline that only one side has is a change of bytes even when every line matches. Git
  // renders it as the last line being replaced, with the marker on the side that lacks it, so the
  // same shape is produced here instead of reporting an empty diff for a non-empty change.
  const newlineOnlyDifference = left.finalNewline !== right.finalNewline && left.lines.length > 0 && right.lines.length > 0;
  if (newlineOnlyDifference && ops[ops.length - 1]?.kind === 'equal') {
    const last = ops[ops.length - 1]!;
    ops.splice(ops.length - 1, 1, { kind: 'delete', line: last.line }, { kind: 'insert', line: last.line });
  }
  if (ops.every((op) => op.kind === 'equal')) return { path, status, unified: '', additions: 0, deletions: 0 };

  const oldLast = ops.findLastIndex((op) => op.kind !== 'insert');
  const newLast = ops.findLastIndex((op) => op.kind !== 'delete');
  const lines: string[] = [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ ${after === null ? '/dev/null' : `b/${path}`}`];
  let additions = 0;
  let deletions = 0;

  for (const [start, end] of hunkRanges(ops)) {
    let oldBefore = 0;
    let newBefore = 0;
    for (let index = 0; index < start; index += 1) {
      if (ops[index]!.kind !== 'insert') oldBefore += 1;
      if (ops[index]!.kind !== 'delete') newBefore += 1;
    }
    let oldLength = 0;
    let newLength = 0;
    for (let index = start; index < end; index += 1) {
      if (ops[index]!.kind !== 'insert') oldLength += 1;
      if (ops[index]!.kind !== 'delete') newLength += 1;
    }
    const oldStart = oldLength === 0 ? oldBefore : oldBefore + 1;
    const newStart = newLength === 0 ? newBefore : newBefore + 1;
    lines.push(`@@ -${oldStart},${oldLength} +${newStart},${newLength} @@`);
    for (let index = start; index < end; index += 1) {
      const op = ops[index]!;
      const prefix = op.kind === 'equal' ? ' ' : op.kind === 'delete' ? '-' : '+';
      if (op.kind === 'delete') deletions += 1;
      if (op.kind === 'insert') additions += 1;
      lines.push(`${prefix}${op.line}`);
      const missesOldNewline = index === oldLast && !left.finalNewline && op.kind !== 'insert';
      const missesNewNewline = index === newLast && !right.finalNewline && op.kind !== 'delete';
      if (missesOldNewline || missesNewNewline) lines.push('\\ No newline at end of file');
    }
  }

  return { path, status, unified: `${lines.join('\n')}\n`, additions, deletions };
}

function pairOf(change: Change): UrlChangePair {
  switch (change.type) {
    case 'meta.title':
    case 'meta.description':
    case 'image.alt':
      return { type: change.type, before: change.before, after: change.after };
    case 'schema.jsonld':
      return { type: change.type, before: change.before, after: change.operation === 'remove' ? null : change.after };
    case 'redirect':
      return {
        type: change.type,
        before: change.before ?? null,
        after: change.operation === 'remove' ? null : { to: change.to ?? null, status: change.status ?? null },
      };
  }
}

/** Per-file unified diffs and per-URL before/after pairs for a change set under review. */
export function renderDiff(input: DiffInput): RenderedDiff {
  const files = (input.files ?? []).map((file) => unifiedFor(file.path, file.before, file.after));
  const byUrl = new Map<string, UrlChangePair[]>();
  for (const change of input.changes ?? []) {
    const url = urlOf(change);
    const pairs = byUrl.get(url);
    if (pairs) pairs.push(pairOf(change));
    else byUrl.set(url, [pairOf(change)]);
  }
  return { files, urls: [...byUrl].map(([url, changes]) => ({ url, changes })) };
}
