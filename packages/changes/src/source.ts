import { createHash } from 'node:crypto';
import type { Change } from './change-types';
import { type Refusal, refuse } from './refusal';

// A change is drafted against a file's text; by the time it is applied the file may have moved on.
// `before` catches that for values the file carries, but not for a value the file does not carry
// (an inserted frontmatter key, for example), and a `before` that happens to match can still be
// read from a different revision of the file. A change may therefore record the sha256 of the file
// it was drafted from (`sourceHash`); when it does, every editor refuses a file that does not hash
// to it, and the frontmatter editor requires it before inserting a key.

/** The sha256 hex of a source file's text, which is what a change's `sourceHash` records. */
export function sourceHashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The refusal for a change whose `sourceHash` no longer matches the file, or null when it does. */
export function sourceHashRefusal(change: Change, text: string): Refusal | null {
  if (change.sourceHash === undefined) return null;
  const actual = sourceHashOf(text);
  if (actual === change.sourceHash) return null;
  return refuse(
    'stale',
    'The file changed after this change was drafted (its sha256 no longer matches the change). Re-read the source and draft the change again.',
    { expected: change.sourceHash, actual },
  );
}
