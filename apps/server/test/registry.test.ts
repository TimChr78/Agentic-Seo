import { missingActionClasses, PERMISSIONS } from '@agentic-seo/commands';
import { describe, expect, it } from 'vitest';
import { commands } from '../src/registry';

// The registry is the one definition REST, MCP and the UI derive from, so these invariants are
// enforced once, here, rather than per surface.

/**
 * The Phase 1 command groups (roadmap Phase 1: audits, checks, Search Console data, recommendations
 * and change sets with the GitHub connector). A command outside these groups is not part of the thin
 * loop, so its description is not held to this bar.
 */
const PHASE_1 = /^(audits|checks|changes|recommendations)\.|^search\.|^connectors\.github\./;

/**
 * What a call costs, in the harness's own words. Every Phase 1 description states one of these so an
 * agent can weigh a call before making it: a free read, a crawl that loads the site's host, or a
 * model call billed in tokens. The heuristic is deliberately a word check, not a sentence match, so
 * a description can phrase the cost naturally (“Free.”, “Costs nothing.”, “costs the site's
 * bandwidth”, “runs cost tokens”) without a brittle copy contract.
 */
const COST_CLAUSE = /\b(free|costs?|billed)\b/i;

/** Short enough that it cannot say what a tool does, when to use it and what it needs. */
const MIN_DESCRIPTION = 180;

describe('the command registry', () => {
  it('has unique, dotted command names with a title and a description', () => {
    const names = commands.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const command of commands) {
      expect(command.name).toMatch(/^[a-z][A-Za-z]*(\.[a-zA-Z][A-Za-z]*)*$/);
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

  it('exposes the provider usage commands, with budgets as a person’s settings decision', () => {
    const names = commands.map((c) => c.name);
    for (const name of ['usage.budgets', 'usage.setBudget', 'usage.spend', 'usage.unresolved', 'usage.estimate'])
      expect(names).toContain(name);
    expect(commands.find((c) => c.name === 'usage.setBudget')).toMatchObject({
      permission: 'workspace:admin',
      effect: 'write',
      humansOnly: true,
      actionClass: 'settings',
    });
    // The read models serve whoever may spend; none of them is a draft an agent could slip through.
    for (const name of ['usage.budgets', 'usage.spend', 'usage.unresolved', 'usage.estimate'])
      expect(commands.find((c) => c.name === name)).toMatchObject({ permission: 'research:spend', effect: 'read' });
  });

  it('describes every Phase 1 command an agent can run for an LLM, including what it costs', () => {
    // A description is the only thing an agent sees before choosing a tool, so it must say what the
    // command does, when to use it against its neighbours, what it needs first and what it costs.
    // Length is a proxy for the first three; the cost clause is checked literally.
    const exposed = commands.filter((command) => PHASE_1.test(command.name) && !command.humansOnly);
    expect(exposed.length).toBeGreaterThan(30);
    for (const command of exposed) {
      expect(command.description.length, `${command.name} is too short to choose between tools`).toBeGreaterThanOrEqual(MIN_DESCRIPTION);
      expect(command.description, `${command.name} does not say what the call costs`).toMatch(COST_CLAUSE);
    }
  });

  it('maps every Phase 1 permission to a scope an MCP client can be granted', () => {
    // Permission strings double as OAuth scopes, and the consent screen offers exactly PERMISSIONS.
    // A command with a null permission never appears as a tool, so it would fail this too.
    for (const command of commands.filter((c) => PHASE_1.test(c.name))) {
      expect(command.permission, `${command.name} has no permission to grant`).not.toBeNull();
      expect(PERMISSIONS, `${command.name} needs a scope a connection cannot be granted`).toContain(command.permission);
    }
  });
});
