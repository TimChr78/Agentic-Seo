import { defineCommand } from '@agentic-seo/commands';
import { AppError } from '@agentic-seo/core';
import { z } from 'zod';
import type { ProviderGateway } from './gateway';
import { PORT_NAMES } from './ports';

declare module '@agentic-seo/commands' {
  interface Services {
    /** The provider gateway; the server registers it once and every data command goes through it. */
    providers?: ProviderGateway;
  }
}

// The usage surface: budgets, spend and estimates. The registry binds these when the server starts;
// they are read-only except `usage.setBudget`, which is a workspace-admin settings change and is
// never available to agents.

const period = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'a month, YYYY-MM')
  .describe('The budget month in UTC, e.g. "2026-11"');

const budget = z.object({
  providerId: z.string(),
  period: z.string(),
  currency: z.string(),
  budgetMicros: z.number().int(),
  spentMicros: z.number().int(),
  heldMicros: z.number().int(),
  remainingMicros: z.number().int(),
});

const spendRow = z.object({
  providerId: z.string(),
  period: z.string(),
  callerType: z.enum(['person', 'agent', 'hosted_run', 'schedule', 'system']),
  siteId: z.string().nullable(),
  calls: z.number().int(),
  costMicros: z.number().int(),
  currency: z.string(),
});

const unresolvedCall = z.object({
  callId: z.string(),
  workspaceId: z.string(),
  providerId: z.string(),
  port: z.string(),
  operation: z.string(),
  purpose: z.string(),
  state: z.enum(['dispatching', 'submitted', 'unknown']),
  currency: z.string(),
  heldMicros: z.number().int(),
  maxCostMicros: z.number().int(),
  providerTaskId: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function gateway(ctx: { services: { providers?: ProviderGateway } }): ProviderGateway {
  const providers = ctx.services.providers;
  if (!providers) throw new AppError('precondition_failed', 'The provider gateway is not configured on this server.');
  return providers;
}

export const usageBudgets = defineCommand({
  name: 'usage.budgets',
  title: 'Provider budgets',
  description: 'Monthly budgets, spend and held reservations per provider for the workspace.',
  input: z.object({ period: period.optional() }),
  output: z.object({ period: z.string(), budgets: z.array(budget) }),
  permission: 'research:spend',
  effect: 'read',
  handler: async (input, ctx) => {
    const providers = gateway(ctx);
    const at = input.period ?? providers.currentPeriod();
    return { period: at, budgets: await providers.budgets({ workspaceId: ctx.principal.workspaceId, period: at, tx: ctx.tx }) };
  },
});

export const usageSetBudget = defineCommand({
  name: 'usage.setBudget',
  title: 'Set a provider budget',
  description: 'Set or change the monthly budget for one provider. Workspace admins only; agents can never run this.',
  input: z.object({
    providerId: z.string().min(1).max(64),
    period: period.optional(),
    currency: z.string().regex(/^[A-Z]{3}$/, 'a three-letter currency code, e.g. USD'),
    budgetMicros: z.number().int().nonnegative().describe('The monthly ceiling in millionths of the currency unit'),
  }),
  output: budget,
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  actionClass: 'settings',
  target: (input) => input.providerId,
  handler: async (input, ctx) => {
    const providers = gateway(ctx);
    return providers.setBudget({
      workspaceId: ctx.principal.workspaceId,
      providerId: input.providerId,
      period: input.period,
      currency: input.currency,
      budgetMicros: input.budgetMicros,
      tx: ctx.tx,
    });
  },
});

export const usageSpend = defineCommand({
  name: 'usage.spend',
  title: 'Provider spend',
  description: 'Settled provider spend for a month, grouped by provider, caller and site.',
  input: z.object({
    period: period.optional(),
    providerId: z.string().min(1).optional(),
    callerType: z.enum(['person', 'agent', 'hosted_run', 'schedule', 'system']).optional(),
    siteId: z.string().uuid().optional(),
  }),
  output: z.object({ period: z.string(), rows: z.array(spendRow) }),
  permission: 'research:spend',
  effect: 'read',
  handler: async (input, ctx) => {
    const providers = gateway(ctx);
    const at = input.period ?? providers.currentPeriod();
    const rows = await providers.spend({
      workspaceId: ctx.principal.workspaceId,
      period: at,
      providerId: input.providerId,
      callerType: input.callerType,
      siteId: input.siteId,
      tx: ctx.tx,
    });
    return { period: at, rows };
  },
});

export const usageUnresolved = defineCommand({
  name: 'usage.unresolved',
  title: 'Unresolved provider calls',
  description: 'Calls whose outcome is unknown and whose budget hold is still kept. Reconcile them; a blind retry could charge twice.',
  input: z.object({}),
  output: z.object({ calls: z.array(unresolvedCall) }),
  permission: 'research:spend',
  effect: 'read',
  handler: async (_input, ctx) => ({
    calls: await gateway(ctx).unresolved({ workspaceId: ctx.principal.workspaceId, tx: ctx.tx }),
  }),
});

export const usageEstimate = defineCommand({
  name: 'usage.estimate',
  title: 'Estimate a provider call',
  description: 'The maximum authorised cost of one provider operation, without spending or reserving anything.',
  input: z.object({
    port: z.enum(PORT_NAMES),
    operation: z.string().min(1),
    request: z.unknown(),
    providerId: z.string().min(1).optional(),
    credentialKey: z.string().optional(),
    propertyKey: z.string().optional(),
    market: z.string().optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  }),
  output: z.object({
    providerId: z.string(),
    maxCostMicros: z.number().int(),
    currency: z.string(),
    basis: z.string(),
    cached: z.boolean(),
  }),
  permission: 'research:spend',
  effect: 'read',
  handler: async (input, ctx) =>
    gateway(ctx).estimate({
      workspaceId: ctx.principal.workspaceId,
      port: input.port,
      operation: input.operation,
      request: input.request,
      caller: { type: 'person', id: ctx.principal.userId },
      purpose: 'estimate',
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
      ...(input.credentialKey === undefined ? {} : { credentialKey: input.credentialKey }),
      ...(input.propertyKey === undefined ? {} : { propertyKey: input.propertyKey }),
      ...(input.market === undefined ? {} : { market: input.market }),
      ...(input.options === undefined ? {} : { options: input.options }),
    }),
});

export const providerCommands = [usageBudgets, usageSetBudget, usageSpend, usageUnresolved, usageEstimate] as const;
