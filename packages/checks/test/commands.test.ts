import { type AnyCommand, agentPrincipal, createExecutor, type Services, userPrincipal } from '@agentic-seo/commands';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { hasTestDatabase } from '../../db/test/disposable';
import { auditFindings, auditIssue, auditIssues, auditScore, checksIgnore, checksUnignore } from '../src';
import { type AuditTestContext, addSite, createAuditTestContext, goodPage, seedAudit, services } from './support';

// The issue, finding and score commands at their public entry point (the command), including the
// ignore pair: a viewer cannot write, a person with sites:write can, and an agent's call is judged
// by the policy engine and recorded in the action ledger.

const url = (path: string): string => `https://example.com${path}`;

describe.skipIf(!hasTestDatabase())('audit issue commands', () => {
  let ctx: AuditTestContext;
  let ws = '';
  let siteId = '';
  let auditId = '';
  let missingTitleIssueId = '';

  const owner = () => userPrincipal('user_owner', ws, 'owner');
  const viewer = () => userPrincipal('user_viewer', ws, 'viewer');
  const call = <C extends AnyCommand>(command: C, input: unknown, principal = owner()): Promise<z.output<C['output']>> =>
    ctx.executor.execute(command, input, principal, { surface: 'rest' });

  beforeAll(async () => {
    ctx = await createAuditTestContext('checks_commands');
    ws = ctx.disposable.workspace;
    siteId = await addSite(ctx.db, ws);
    auditId = await seedAudit(ctx.db, ws, siteId, {
      pages: [goodPage(url('/a'), { html: { title: null } }), goodPage(url('/b'))],
    });
    const listed = await call(auditIssues, { siteId });
    missingTitleIssueId = listed.issues.find((issue) => issue.checkId === 'title.missing' && issue.subject === url('/a'))?.id ?? '';
  }, 120_000);

  afterAll(async () => {
    ctx?.dispose();
    await ctx?.disposable.close();
  });

  it('lists a site’s issues worst first, with counts, the check title and no GSC', async () => {
    const result = await call(auditIssues, { siteId });
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.hasGsc).toBe(false);
    expect(result.summary.open).toBe(result.issues.filter((issue) => issue.state === 'open').length);
    const issue = result.issues.find((entry) => entry.id === missingTitleIssueId);
    expect(issue).toMatchObject({
      checkId: 'title.missing',
      title: 'The page has no title',
      category: 'on_page',
      severity: 'high',
      subject: url('/a'),
      state: 'open',
      affectedPages: 1,
      evaluatedPages: 2,
      evidenceTotal: 1,
      clicks28d: null,
    });
    expect(result.issues.every((entry) => entry.title !== entry.checkId)).toBe(true);
    // Severity ordering: nothing medium-or-lower can precede a high issue.
    const ranks = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
    for (let index = 1; index < result.issues.length; index += 1)
      expect(ranks[result.issues[index]!.severity]).toBeGreaterThanOrEqual(ranks[result.issues[index - 1]!.severity]);
  });

  it('filters and pages the issue list', async () => {
    const filtered = await call(auditIssues, { siteId, checkId: 'title.missing', severity: 'high' });
    expect(filtered.issues.length).toBe(1);
    expect(filtered.summary.total).toBeGreaterThanOrEqual(1);
    const page = await call(auditIssues, { siteId, limit: 1 });
    expect(page.issues).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const next = await call(auditIssues, { siteId, limit: 1, cursor: page.nextCursor ?? undefined });
    expect(next.issues[0]?.id).not.toBe(page.issues[0]?.id);
  });

  it('returns one issue with its check definition, evidence pages and finding history', async () => {
    const result = await call(auditIssue, { issueId: missingTitleIssueId });
    expect(result.issue.checkId).toBe('title.missing');
    expect(result.check.explain.length).toBeGreaterThan(20);
    expect(result.check.definition).toBeNull();
    expect(result.issue.evidence.length).toBe(1);
    expect(result.pages[0]?.url).toBe(url('/a'));
    expect(result.history).toEqual([expect.objectContaining({ auditId, evidenceTotal: 1 })]);
  });

  it('lists the findings of one audit with their evidence and issue link', async () => {
    const result = await call(auditFindings, { auditId, checkId: 'title.missing' });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      checkId: 'title.missing',
      subject: url('/a'),
      issueId: missingTitleIssueId,
      severity: 'high',
      category: 'on_page',
    });
    expect(result.findings[0]?.evidence[0]?.subject).toBeTruthy();
    const first = await call(auditFindings, { auditId, limit: 1 });
    expect(first.findings).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const next = await call(auditFindings, { auditId, limit: 1, cursor: first.nextCursor ?? undefined });
    expect(next.findings[0]?.id).not.toBe(first.findings[0]?.id);
  });

  it('returns the score with its categories and what it did not evaluate', async () => {
    const result = await call(auditScore, { siteId, auditId });
    expect(result.score).not.toBeNull();
    expect(result.score as number).toBeGreaterThanOrEqual(0);
    expect(result.categories).toHaveLength(8);
    expect(result.categories.find((entry) => entry.category === 'on_page')?.issues).toBeGreaterThanOrEqual(1);
    expect(result.notEvaluated).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: 'performance', reason: expect.stringContaining('Phase 2') })]),
    );
    expect(result.pagesEvaluated).toBe(2);
    expect(result.state).toBe('completed');
  });

  it('answers audits.score for the latest scored audit when no audit id is given', async () => {
    const latest = await call(auditScore, { siteId });
    expect(latest.auditId).toBe(auditId);
  });

  it('refuses a score for an audit that has not finalized', async () => {
    const queued = 'adt_p1e_queued';
    await ctx.db.admin.query(
      `INSERT INTO audits (workspace_id, id, site_id, scope, state, requested_by_type, requested_by_id)
       VALUES ($1, $2, $3, 'site', 'queued', 'user', 'seed-user')`,
      [ws, queued, siteId],
    );
    await expect(call(auditScore, { siteId, auditId: queued })).rejects.toMatchObject({ code: 'precondition_failed' });
  });

  it('refuses ignoring as a viewer, because sites:write is required', async () => {
    await expect(
      call(checksIgnore, { issueId: missingTitleIssueId, reason: 'Accepted for the staging host.' }, viewer()),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('pages same-severity issues by affected pages descending (cursor directions agree)', async () => {
    const cursorSite = await addSite(ctx.db, ws, 'cursor.example');
    const subjects = ['https://cursor.example/two-pages', 'https://cursor.example/one-page'];
    const rows = [
      { id: 'iss_000000000000000000000000000000c1', subject: subjects[0] as string, pages: 2 },
      { id: 'iss_000000000000000000000000000000c2', subject: subjects[1] as string, pages: 1 },
    ];
    for (const row of rows) {
      await ctx.db.admin.query(
        `INSERT INTO issues (workspace_id, id, site_id, check_id, subject_key, subject, state, severity, category,
                             first_seen_audit_id, last_seen_audit_id, last_checked_audit_id, affected_pages, affected_urls)
         VALUES ($1, $2, $3, 'title.duplicate', $4, $4, 'open', 'medium', 'on_page', $5, $5, $5, $6, ARRAY[$4]::text[])`,
        [ws, row.id, cursorSite, row.subject, auditId, row.pages],
      );
    }
    const first = await call(auditIssues, { siteId: cursorSite, checkId: 'title.duplicate', limit: 1 });
    expect(first.issues.map((issue) => issue.affectedPages)).toEqual([2]);
    expect(first.nextCursor).not.toBeNull();
    const second = await call(auditIssues, {
      siteId: cursorSite,
      checkId: 'title.duplicate',
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.issues.map((issue) => issue.affectedPages)).toEqual([1]);
  });

  it('ignores and unignores an issue for a person with sites:write', async () => {
    const ignored = await call(checksIgnore, { issueId: missingTitleIssueId, reason: 'The staging host is noindex on purpose.' });
    expect(ignored.issue.state).toBe('ignored');
    expect(ignored.issue.ignored).toMatchObject({ by: 'user_owner', reason: 'The staging host is noindex on purpose.' });
    await expect(call(checksIgnore, { issueId: missingTitleIssueId, reason: 'too short' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    const reopened = await call(checksUnignore, { issueId: missingTitleIssueId });
    expect(reopened.issue.state).toBe('open');
    expect(reopened.issue.ignored).toBeNull();
    await expect(call(checksUnignore, { issueId: missingTitleIssueId })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('sends an agent’s ignore through the policy engine and records it in the ledger', async () => {
    const ledger: Parameters<NonNullable<Services['onAgentAction']>>[1][] = [];
    const ledgerServices: Services = {
      ...services,
      onAgentAction: async (_tx, entry) => {
        ledger.push(entry);
      },
    };
    const executor = createExecutor(ctx.db, ledgerServices);
    const agent = agentPrincipal(
      { id: 'agt_p1e', name: 'Audit triager', status: 'active', statusReason: null },
      'user_owner',
      'client_p1e',
      ws,
      'owner',
      ['sites:read', 'sites:write'],
    );
    await expect(
      executor.execute(checksIgnore, { issueId: missingTitleIssueId, reason: 'The staging host is noindex on purpose.' }, agent, {
        surface: 'mcp',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ command: 'checks.ignore', actionClass: 'settings', decision: 'deny', ok: false });
    // A settings change always needs a person, so nothing was written.
    const result = await call(auditIssue, { issueId: missingTitleIssueId });
    expect(result.issue.state).toBe('open');
  });
});
