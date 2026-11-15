import type { ChangeSetContent, ChangeSetDraftedChange } from '@agentic-seo/artifacts';
import { applyChange, renderDiff, type SiteMapping, sourceHashOf } from '@agentic-seo/changes';
import { canonicalJson } from '@agentic-seo/core';
import { resolveChangeSource } from './draft';

// A change set's stored source path, base commit, source hash and diff are server-owned: drafting
// derives them from the repository, and the reviewer approves what that derivation produced. This
// module re-derives every field from the same base commit, so a caller who wrote the artifact with
// its own metadata (the generic artifact commands are refused, but a database write cannot be ruled
// out) is caught at approval and again in the apply worker before anything reaches GitHub.
//
// The check is deliberately exact: the mapping must still resolve the change's URL to the stored
// path and editor, the file at `baseSha` must still hash to `sourceHash`, applying the edit must
// reproduce the stored diff byte for byte, and the stored `change` must be the verify target the
// editor returned (the value verification later compares the deployed page with).

/** The repository reads a re-derivation needs, at the commit each change was drafted from. */
export interface RevalidateReads {
  mapping: SiteMapping;
  listFiles: (prefix: string, ref: string) => Promise<readonly string[]>;
  readFile: (path: string, ref: string) => Promise<string>;
}

/** One stored field that does not match the repository, with the sentence a person can act on. */
export interface RevalidationProblem {
  index: number;
  path: string;
  reason: string;
}

const sameSet = (left: readonly string[], right: readonly string[]): boolean => {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
};

const sameFields = (left: unknown, right: unknown): boolean => canonicalJson(left ?? null) === canonicalJson(right ?? null);

/** Compares two diffs exactly; a forged diff is not the one the reviewer saw. */
function diffProblem(drafted: ChangeSetDraftedChange, actual: ChangeSetDraftedChange['diff']): string | null {
  if (
    drafted.diff.path !== actual.path ||
    drafted.diff.status !== actual.status ||
    drafted.diff.unified !== actual.unified ||
    drafted.diff.additions !== actual.additions ||
    drafted.diff.deletions !== actual.deletions
  ) {
    return `The stored diff for ${drafted.source.path} is not the diff the file at ${drafted.baseSha} produces.`;
  }
  return null;
}

/**
 * Re-derives every stored derived field from the repository at the change's own base commit.
 * Returns one problem per mismatch; an empty array means the content is exactly what drafting
 * would produce now.
 */
export async function revalidateChangeSet(content: ChangeSetContent, reads: RevalidateReads): Promise<RevalidationProblem[]> {
  const problems: RevalidationProblem[] = [];
  const cache = new Map<string, Promise<string>>();
  const originals = new Map<string, string>();
  const current = new Map<string, string>();
  const read = (path: string, ref: string): Promise<string> => {
    const key = `${ref}\u0000${path}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const reading = reads.readFile(path, ref);
    cache.set(key, reading);
    void reading.catch(() => cache.delete(key));
    return reading;
  };

  for (const [index, drafted] of content.changes.entries()) {
    const problem = (reason: string) => problems.push({ index, path: drafted.source.path, reason });
    const change = drafted.change;

    let resolved: Awaited<ReturnType<typeof resolveChangeSource>>;
    try {
      resolved = await resolveChangeSource(
        change,
        {
          mapping: reads.mapping,
          baseSha: drafted.baseSha,
          listFiles: (prefix) => reads.listFiles(prefix, drafted.baseSha),
          readFile: (path) => read(path, drafted.baseSha),
        },
        cache,
      );
    } catch (error) {
      problem(`The change could not be resolved against the mapping: ${error instanceof Error ? error.message : String(error)}.`);
      continue;
    }
    if ('ok' in resolved) {
      problem(`The mapping no longer resolves this change: ${resolved.reason}`);
      continue;
    }
    if (resolved.path !== drafted.source.path) {
      problem(`The mapping resolves this change to ${resolved.path}, not the stored ${drafted.source.path}.`);
      continue;
    }
    if (resolved.editor !== drafted.source.editor) {
      problem(`The mapping resolves this change with the ${resolved.editor} editor, not the stored ${drafted.source.editor}.`);
      continue;
    }
    if (!sameSet(resolved.affectedRoutes, drafted.source.affectedRoutes)) {
      problem('The routes this change reaches are not the ones stored with it.');
      continue;
    }
    if (resolved.editor === 'markdown_frontmatter') {
      if (!sameFields(resolved.fields, drafted.source.fields) || resolved.dialect !== drafted.source.dialect) {
        problem('The frontmatter fields stored with this change are not the ones the mapping resolves.');
        continue;
      }
    }

    let original = originals.get(drafted.source.path);
    if (original === undefined) {
      try {
        original = await read(drafted.source.path, drafted.baseSha);
      } catch (error) {
        problem(`The file at ${drafted.baseSha} could not be read: ${error instanceof Error ? error.message : String(error)}.`);
        continue;
      }
      originals.set(drafted.source.path, original);
    }
    if (sourceHashOf(original) !== drafted.sourceHash) {
      problem(`The file at ${drafted.baseSha} does not hash to the stored source hash.`);
      continue;
    }

    const applied = applyChange({
      editor: resolved.editor,
      text: current.get(drafted.source.path) ?? original,
      change,
      ...(resolved.fields ? { fields: resolved.fields } : {}),
      ...(resolved.dialect ? { dialect: resolved.dialect } : {}),
    });
    if (!applied.ok) {
      problem(`The edit does not apply to the stored file: ${applied.reason}`);
      continue;
    }
    if (!applied.changed) {
      problem('The edit would change nothing in the stored file.');
      continue;
    }
    current.set(drafted.source.path, applied.text);

    const actualDiff = renderDiff({
      files: [{ path: drafted.source.path, before: original, after: applied.text }],
    }).files[0]!;
    const mismatch = diffProblem(drafted, actualDiff);
    if (mismatch) {
      problem(mismatch);
      continue;
    }
    if (canonicalJson(applied.verifyTarget) !== canonicalJson(change)) {
      problem('The stored change is not the verify target the editor produced from this file.');
    }
  }

  return problems;
}

/** One sentence naming the first problem, for a refusal a person can act on. */
export function describeRevalidation(problems: readonly RevalidationProblem[]): string {
  const first = problems[0];
  if (!first) return '';
  const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : '';
  return `${first.reason}${more}`;
}
