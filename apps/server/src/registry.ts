import { agentCommands, memberCommands, tokenCommands } from '@agentic-seo/auth';
import type { AnyCommand } from '@agentic-seo/commands';
import { secretCommands } from '@agentic-seo/secrets';
import { getWorkspace, whoami } from './builtinCommands';

// The secrets package predates the registry's action-class rule. Storing or deleting a credential
// is a `settings` change with a wide blast radius, so the server classifies it here rather than
// leaving the policy engine to guess. Every other write declares its class itself; the registry
// test fails the build if one does not.
const [setSecret, listSecrets, deleteSecret] = secretCommands;

/** Every command the server exposes. REST routes, OpenAPI, MCP tools and the UI client derive from this list. */
export const commands = [
  ...memberCommands,
  ...tokenCommands,
  ...agentCommands,
  { ...setSecret, actionClass: 'settings' as const },
  listSecrets,
  { ...deleteSecret, actionClass: 'settings' as const },
  getWorkspace,
  whoami,
] as const;
export type Commands = typeof commands;

export const commandByName = new Map<string, AnyCommand>(commands.map((c) => [c.name, c]));
