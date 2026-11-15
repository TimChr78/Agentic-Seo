import type { AuditHooks } from './hooks';

// The audit hooks registry (hooks.ts). The registrar is module-level rather than a `Services` entry
// because the packages that plug in (the check catalogue, change sets, the guardian) are imported
// for their side effect by the server: `registerAuditHooks(...)` runs at import time, before any
// command or job exists, and the crawler needs no dependency on those packages. Tests register a
// hook the same way and dispose of it.
//
// Hooks are called once per stored page and once per finalized audit, inside the crawler's tenant
// transaction. A hook that throws rolls that transaction back (the chunk or finalize is retried),
// so every hook must be idempotent.

const hooks: AuditHooks[] = [];

/** Registers a hook set. The returned function unregisters it (tests use it; production does not). */
export function registerAuditHooks(hook: AuditHooks): () => void {
  hooks.push(hook);
  return () => {
    const index = hooks.indexOf(hook);
    if (index !== -1) hooks.splice(index, 1);
  };
}

/** Every registered hook, in registration order. */
export function auditHooks(): readonly AuditHooks[] {
  return hooks;
}

/** Removes every hook; tests call it so one file's hook cannot see another file's pages. */
export function clearAuditHooks(): void {
  hooks.length = 0;
}
