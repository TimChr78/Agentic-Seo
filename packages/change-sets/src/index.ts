export * from './apply';
export * from './commands-changes';
export * from './commands-connector';
export * from './connector';
export * from './draft';
export * from './enqueue';
export * from './impact';
export * from './poll';
export * from './publish-hook';
export * from './revalidate';
export * from './state';
export * from './tasks';
export * from './verify';
export * from './verify-fetch';
export * from './worker';

import { registerChangeSetClosedHook, registerChangeSetPublishHook } from './publish-hook';

// The hooks are registered when the package loads, so the artifact approval flow and the change-set
// apply job cannot be wired separately and drift apart.
registerChangeSetPublishHook();
registerChangeSetClosedHook();
