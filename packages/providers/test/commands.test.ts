import { describe, expect, it } from 'vitest';
import { providerCommands, usageBudgets, usageEstimate, usageSetBudget, usageSpend, usageUnresolved } from '../src';

// The server registers this list later. The guards are part of the contract: budgets are a
// workspace-admin settings change people make, while the read models serve anyone who may spend.

describe('provider usage commands', () => {
  it('exports the five usage commands in registry order', () => {
    expect(providerCommands.map((command) => command.name)).toEqual([
      'usage.budgets',
      'usage.setBudget',
      'usage.spend',
      'usage.unresolved',
      'usage.estimate',
    ]);
  });

  it('keeps budget changes for workspace admins and people only', () => {
    expect(usageSetBudget.permission).toBe('workspace:admin');
    expect(usageSetBudget.effect).toBe('write');
    expect(usageSetBudget.humansOnly).toBe(true);
    expect(usageSetBudget.actionClass).toBe('settings');
  });

  it('makes the read models available to anyone who may spend', () => {
    for (const command of [usageBudgets, usageSpend, usageUnresolved, usageEstimate]) {
      expect(command.permission).toBe('research:spend');
      expect(command.effect).toBe('read');
    }
  });
});
