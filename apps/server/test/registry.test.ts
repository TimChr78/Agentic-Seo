import { missingActionClasses } from '@agentic-seo/commands';
import { describe, expect, it } from 'vitest';
import { commands } from '../src/registry';

// The registry is the one definition REST, MCP and the UI derive from, so these invariants are
// enforced once, here, rather than per surface.

describe('the command registry', () => {
  it('has unique, dotted command names with a title and a description', () => {
    const names = commands.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const command of commands) {
      expect(command.name).toMatch(/^[a-z][A-Za-z]*(\.[a-zA-Z][A-Za-z]*)?$/);
      expect(command.title.length).toBeGreaterThan(0);
      expect(command.description.length).toBeGreaterThan(20);
    }
  });

  it('gives every write an agent may run an action class', () => {
    // A missing class would make the policy engine treat a change in the world as a setting, so it
    // fails the build instead.
    expect(missingActionClasses(commands)).toEqual([]);
  });

  it('marks the commands an agent must never run as humans-only', () => {
    // The commands an agent must never run, whatever its scopes.
    const names = new Set(commands.filter((c) => c.humansOnly).map((c) => c.name));
    for (const name of ['members.invite', 'members.remove', 'apiTokens.update', 'agents.pause', 'agents.revoke'])
      expect(names).toContain(name);
  });

  it('exposes the two commands every principal starts with', () => {
    expect(commands.map((c) => c.name)).toEqual(expect.arrayContaining(['workspace.get', 'whoami']));
  });

  it('declares secrets as settings, never autonomous', () => {
    for (const name of ['secrets.set', 'secrets.delete']) expect(commands.find((c) => c.name === name)?.actionClass).toBe('settings');
  });
});
