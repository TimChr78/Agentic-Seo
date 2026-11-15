import { createHash } from 'node:crypto';

// The identity of a finding and an issue (migration 0009). Both are derived from the data they
// describe, so a retried page or a retried finalize upserts the same row: a chunk that runs twice
// must not double the evidence, and an issue must stay one row across audits.

const short = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 32);

/**
 * A finding's id: one audit, one check, one source snapshot. `sourceKey` is the requested URL of
 * the snapshot that produced the finding, so a retried page hook upserts the same rows and a second
 * snapshot that ends at the same final URL keeps its own findings (the issue they group may still
 * be one — that is `subjectKey`).
 */
export function findingId(auditId: string, checkId: string, sourceKey: string): string {
  return `fnd_${short(`${auditId}:${checkId}:${sourceKey}`)}`;
}

/** An issue's id: one site, one check, one subject, for as long as the site exists. */
export function issueId(siteId: string, checkId: string, subjectKey: string): string {
  return `iss_${short(`${siteId}:${checkId}:${subjectKey}`)}`;
}

/**
 * sha256 of the empty string, the content hash of a page whose visible text is empty. The duplicate
 * content check ignores it: every empty page would otherwise be a duplicate of every other.
 */
export const EMPTY_CONTENT_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
