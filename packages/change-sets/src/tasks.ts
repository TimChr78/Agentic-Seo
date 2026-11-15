// Graphile Worker task identifiers (letters, digits, `_`, `-` and `:` only) shared by the publish
// hook, the poller and the server's worker wiring. A separate module so packages/change-sets can
// name its tasks without importing the worker itself.

/** One approved change set: stale check, one commit, one pull request. */
export const CHANGES_APPLY_TASK = 'changes_apply';

/** Every five minutes: pull request state, stale approvals, merge and deploy detection. */
export const CHANGES_POLL_TASK = 'changes_poll';

/** Re-fetch the affected URLs against the deployed commit and record the verification. */
export const CHANGES_VERIFY_TASK = 'changes_verify';
