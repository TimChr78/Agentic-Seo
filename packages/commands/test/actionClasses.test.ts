import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ACTION_CLASSES, ROLE_PERMISSIONS } from '../src';
import { type AnyCommand, actionClassOf, defineCommand, missingActionClasses } from '../src/registry';

// ADR-0006: the policy engine judges agent writes by what they change in the world, so every
// write an agent may run must declare its action class. People-only commands default from `effect`.
// The server's registry test calls `missingActionClasses(commands)`; these checks pin the rule.

const base = {
  title: 'Test',
  description: 'Test',
  input: z.object({}),
  output: z.object({}),
};

const read = defineCommand({ ...base, name: 'sites.list', permission: 'sites:read', effect: 'read', handler: async () => ({}) });
const crawl = defineCommand({
  ...base,
  name: 'audits.run',
  permission: 'audits:run',
  effect: 'write',
  actionClass: 'crawl',
  handler: async () => ({}),
});
const unclassifiedAgentWrite = defineCommand({
  ...base,
  name: 'sites.update',
  permission: 'sites:write',
  effect: 'write',
  handler: async () => ({}),
});
const peopleOnlyWrite = defineCommand({
  ...base,
  name: 'workspace.update',
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  handler: async () => ({}),
});

describe('action classes', () => {
  it('every write an agent may run declares one', () => {
    expect(missingActionClasses([read as AnyCommand, crawl as AnyCommand, peopleOnlyWrite as AnyCommand])).toEqual([]);
    expect(missingActionClasses([read as AnyCommand, crawl as AnyCommand, unclassifiedAgentWrite as AnyCommand])).toEqual(['sites.update']);
  });

  it('derives a class from the effect when a command does not declare one', () => {
    expect(actionClassOf({ effect: 'read' })).toBe('read');
    expect(actionClassOf({ effect: 'destructive' })).toBe('destructive');
    expect(actionClassOf({ effect: 'write' })).toBe('settings');
    expect(actionClassOf({ effect: 'write', actionClass: 'site.content' })).toBe('site.content');
  });

  it('accepts only the SEO classes from the architecture page', () => {
    expect(ACTION_CLASSES).toEqual([
      'read',
      'research.spend',
      'crawl',
      'draft',
      'report.share',
      'index.submit',
      'site.content',
      'site.structural',
      'settings',
      'destructive',
    ]);
    for (const name of ACTION_CLASSES) expect(typeof name).toBe('string');
  });
});

describe('the role matrix', () => {
  it('gives editors the daily SEO work but not secrets or workspace administration', () => {
    expect(new Set(ROLE_PERMISSIONS.editor)).toEqual(
      new Set([
        'artifacts:read',
        'artifacts:write',
        'artifacts:publish',
        'sites:read',
        'sites:write',
        'audits:run',
        'research:spend',
        'changes:apply',
        'audit:read',
      ]),
    );
  });

  it('gives approvers review rights and viewers read-only access', () => {
    expect(ROLE_PERMISSIONS.approver).toContain('artifacts:approve');
    expect(ROLE_PERMISSIONS.approver).not.toContain('changes:apply');
    expect(new Set(ROLE_PERMISSIONS.viewer)).toEqual(new Set(['artifacts:read', 'sites:read']));
  });

  it('keeps secrets and workspace administration for owners and admins', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(ROLE_PERMISSIONS[role]).toEqual(expect.arrayContaining(['secrets:read', 'secrets:write', 'workspace:admin']));
    }
    for (const role of ['editor', 'approver', 'viewer'] as const) {
      expect(ROLE_PERMISSIONS[role]).not.toContain('secrets:write');
    }
  });
});
