import { defineCommand } from '@agentic-seo/commands';
import { AppError } from '@agentic-seo/core';
import { z } from 'zod';
import { checkById, checks } from './catalogue';
import { type Check, checkCategories, checkScopes, evaluators, fixChanges, severities } from './check';
import { ruleById } from './rules';

// The two read commands an agent or the UI uses to browse the catalogue
// (crawler-and-audits.md §5). They are what `checks://catalogue` exposes over MCP later. The issue,
// finding and score commands live in ./audit/commands and are registered by the server beside
// these, so this list stays read-only catalogue browsing.

const CheckSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.enum(checkCategories),
  severity: z.enum(severities),
  scope: z.enum(checkScopes),
  kind: z.enum(['deterministic', 'judged']),
  evaluator: z.enum(evaluators),
  explain: z.string(),
  fix: z.object({ change: z.enum(fixChanges) }).nullable(),
  references: z.array(z.string()),
  requiresCompleteGraph: z.boolean(),
  rules: z.array(z.string()),
});

const RuleSchema = z.object({
  id: z.string(),
  statement: z.string(),
  source: z.string(),
  reviewedAt: z.string(),
});

const CheckDetailSchema = CheckSummarySchema.extend({
  /** The exact condition a finalize check fails on, null for page and site checks. */
  definition: z.string().nullable(),
  /** The full freshness rules this check depends on. */
  rules: z.array(RuleSchema),
});

const summaryOf = (check: Check) => ({
  id: check.id,
  title: check.title,
  category: check.category,
  severity: check.severity,
  scope: check.scope,
  kind: check.kind,
  evaluator: check.evaluator,
  explain: check.explain,
  fix: check.fix ?? null,
  references: [...check.references],
  requiresCompleteGraph: check.requiresCompleteGraph === true,
  rules: [...(check.rules ?? [])],
});

export const checksCatalogue = defineCommand({
  name: 'checks.catalogue',
  title: 'List audit checks',
  description:
    'List the checks in the SEO audit catalogue, optionally filtered by category, severity, scope or evaluator. Each item carries the id, category, severity, scope, evaluator, a plain explanation, the fix type and the official references. Use it to choose a check before reading or explaining a finding. Read-only; it runs no crawl and calls no provider.',
  input: z.object({
    category: z.enum(checkCategories).optional().describe('Only checks in this category'),
    severity: z.enum(severities).optional().describe('Only checks with this default severity'),
    scope: z.enum(checkScopes).optional().describe('Only checks that apply at this scope'),
    evaluator: z.enum(evaluators).optional().describe('Only checks evaluated this way'),
  }),
  output: z.object({ checks: z.array(CheckSummarySchema) }),
  permission: 'sites:read',
  effect: 'read',
  actionClass: 'read',
  handler: async (input) => ({
    checks: checks
      .filter(
        (check) =>
          (input.category === undefined || check.category === input.category) &&
          (input.severity === undefined || check.severity === input.severity) &&
          (input.scope === undefined || check.scope === input.scope) &&
          (input.evaluator === undefined || check.evaluator === input.evaluator),
      )
      .map(summaryOf),
  }),
});

export const checksExplain = defineCommand({
  name: 'checks.explain',
  title: 'Explain an audit check',
  description:
    'Return one check in full: what it detects, why it matters, what to do, its fix type, its official references, the freshness rules it depends on and, for a cross-page check, the exact definition the finalize step evaluates. Use it to explain a finding or plan a fix. Read-only; it runs no crawl and calls no provider.',
  input: z.object({ checkId: z.string().min(1).describe('The dotted check id, e.g. title.too_long') }),
  output: z.object({ check: CheckDetailSchema }),
  permission: 'sites:read',
  effect: 'read',
  actionClass: 'read',
  target: (input) => input.checkId,
  handler: async (input) => {
    const check = checkById(input.checkId);
    if (!check)
      throw new AppError(
        'not_found',
        `No check has the id “${input.checkId}”. Run checks.catalogue to list the available ids, for example title.too_long or canonical.missing.`,
      );
    return {
      check: {
        ...summaryOf(check),
        definition: check.evaluator === 'finalize' ? check.definition : null,
        rules: (check.rules ?? []).flatMap((id) => {
          const rule = ruleById.get(id);
          return rule ? [{ id: rule.id, statement: rule.statement, source: rule.source, reviewedAt: rule.reviewedAt }] : [];
        }),
      },
    };
  },
});

export const checkCommands = [checksCatalogue, checksExplain] as const;
