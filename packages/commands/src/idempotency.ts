/**
 * The idempotency key rule for every surface that takes one — the REST header, an MCP write tool
 * and the typed client: 1 to 200 printable ASCII characters, no spaces. A key that fails it is
 * refused rather than silently treated as "no key", so a retry cannot run the write twice (#906).
 *
 * Upstream keeps the REST header lenient for compatibility with callers that predate the rule
 * (`isValidIdempotencyKey` is only enforced on the new surfaces). Phase 0 has not shipped, so there
 * are no such callers here: the executor enforces the strict rule for every surface.
 */
export const IDEMPOTENCY_KEY_MAX = 200;

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]+$/;

export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && key.length >= 1 && key.length <= IDEMPOTENCY_KEY_MAX && IDEMPOTENCY_KEY_PATTERN.test(key);
}
