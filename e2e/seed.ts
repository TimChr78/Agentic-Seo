import { createHash } from 'node:crypto';
import { createDb } from '../packages/db/src/pool';

// Fixtures for the thin-loop journey. The e2e server seeds people and a site; an audit, its issues
// and the artifacts that name them come from the crawler and the GitHub connector, neither of which
// the e2e server wires to a local fake. So the journey seeds exactly those rows here, through the
// owner connection, and everything after that is the real command layer: the recommendation is
// created in the browser, the approval is decided by a second person, and every screen reads the
// real rows. Nothing here bypasses a permission: it is the database's owner connection, like the
// harness's own seeding.

/**
 * The e2e database, found by its `_e2e` suffix: the server scopes its name to the run, and the
 * Playwright process cannot derive the same scope (it has its own run id), so it is looked up.
 */
export async function e2eDb() {
  const base = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://aseo:aseo@localhost:5432/aseo_test');
  const maintenance = createDb({ adminUrl: base.toString(), appUrl: base.toString() });
  let name: string;
  try {
    const { rows } = await maintenance.admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE NOT datistemplate AND right(datname, 4) = '_e2e' ORDER BY oid DESC LIMIT 1",
    );
    if (!rows[0]) throw new Error('No e2e database is running: start the server (corepack pnpm e2e) and retry.');
    name = rows[0].datname;
  } finally {
    await maintenance.close();
  }
  const url = new URL(base.toString());
  url.pathname = `/${name}`;
  return createDb({ adminUrl: url.toString(), appUrl: url.toString() });
}

const hex = (seed: string, length = 32) => createHash('sha256').update(seed).digest('hex').slice(0, length);

export interface ThinLoopIds {
  auditId: string;
  issueId: string;
  recommendationId: string;
  approvalId: string;
  changeSetId: string;
}

/**
 * The seeded ids, derived from fixed names rather than timestamps or random values. The axe matrix
 * (`e2e/routes.mjs`) reads the same values, so the populated detail screens it scans are the rows
 * this seed writes.
 */
export const THIN_LOOP_IDS: ThinLoopIds = {
  auditId: `adt_${hex('thin-loop-audit')}`,
  issueId: `iss_${hex('thin-loop-issue')}`,
  recommendationId: `rcm_${hex('thin-loop-recommendation')}`,
  approvalId: `apr_${hex('thin-loop-approval')}`,
  changeSetId: `chg_${hex('thin-loop-change')}`,
};

export async function seedThinLoop(
  db: Awaited<ReturnType<typeof e2eDb>>,
  input: { workspaceId: string; siteId: string; userId: string; domain: string },
): Promise<ThinLoopIds> {
  const { auditId, issueId, recommendationId, approvalId, changeSetId } = THIN_LOOP_IDS;
  const findingId = `fnd_${hex('thin-loop-finding')}`;
  const at = new Date('2026-11-10T09:00:00.000Z');
  const url = `https://${input.domain}/pricing`;

  // The audit the issue came from, with a score so the overview is not an empty page.
  await db.admin.query(
    `INSERT INTO audits (workspace_id, id, site_id, scope, state, pages_crawled, pages_discovered, pages_failed,
       requested_by_type, requested_by_id, started_at, finished_at, last_progress_at, created_at, coverage)
     VALUES ($1,$2,$3,'site','completed',3,3,0,'user',$4,$5,$5,$5,$5,$6)
     ON CONFLICT DO NOTHING`,
    [
      input.workspaceId,
      auditId,
      input.siteId,
      input.userId,
      at,
      JSON.stringify({ scope: 'site', graph: 'complete', reasons: [], pagesCrawled: 3, pagesDiscovered: 3 }),
    ],
  );
  await db.admin.query(
    `INSERT INTO audit_scores (workspace_id, site_id, audit_id, score, reason, categories, not_evaluated, skipped_checks,
       pages_evaluated, pages_crawled, unchecked_issues, gsc_weighted, computed_at)
     VALUES ($1,$2,$3,78,NULL,$4,$5,'[]'::jsonb,3,3,0,false,$6) ON CONFLICT DO NOTHING`,
    [
      input.workspaceId,
      input.siteId,
      auditId,
      JSON.stringify([{ category: 'on_page', weight: 0.4, penalty: 8.8, contribution: 3.52, issues: 1, affectedPages: 1 }]),
      JSON.stringify([{ category: 'performance', reason: 'No renderer is configured in Phase 1.' }]),
      at,
    ],
  );

  // One issue with one evidence item, as the crawler's finalize step would have written it.
  const evidence = {
    items: [{ subject: url, value: 'A pricing page title that is far too long to be shown in full', expected: 'Within 580 px' }],
    total: 1,
    truncated: false,
  };
  await db.admin.query(
    `INSERT INTO issues (workspace_id, id, site_id, check_id, subject_key, subject, state, severity, category,
       first_seen_audit_id, last_seen_audit_id, last_checked_audit_id, evidence, affected_urls, affected_pages, evaluated_pages,
       created_at, updated_at)
     VALUES ($1,$2,$3,'title.too_long',$4,$4,'open','high','on_page',$5,$5,$5,$6,$7,1,3,$8,$8)
     ON CONFLICT DO NOTHING`,
    [input.workspaceId, issueId, input.siteId, url, auditId, JSON.stringify(evidence), [url], at],
  );
  await db.admin.query(
    `INSERT INTO findings (workspace_id, id, site_id, audit_id, check_id, source_key, subject_key, subject, severity, category,
       evidence, affected_urls, affected_pages, issue_id, created_at)
     VALUES ($1,$2,$3,$4,'title.too_long',$5,$5,$5,'high','on_page',$6,$7,1,$8,$9) ON CONFLICT DO NOTHING`,
    [input.workspaceId, findingId, input.siteId, auditId, url, JSON.stringify(evidence), [url], issueId, at],
  );

  // A recommendation a specialist would have written, published through the real approval flow by
  // the second person in the journey.
  const content = {
    title: 'Rewrite the pricing page title',
    rationale: `The title on ${url} is cut off in the result (issue ${issueId}).`,
    evidence: [{ kind: 'issue', id: issueId, note: 'The pricing page title is too long.' }],
    hypothesis: 'If the title fits the result, the whole message is read and more people click.',
    expectedImpact: {
      summary: 'Expected: CTR +5–10% on the pricing page',
      trafficAtStake: { kind: 'unknown', reason: 'Search Console is not connected for this site.' },
      confidence: 'medium',
    },
    effort: 'small',
    dependsOn: [],
    verificationPlan: { recheck: 'Re-crawl the pricing page and read its title.', when: '28 days after the deploy' },
    falsificationCheck: 'We will know this failed if CTR on the pricing page is unchanged after 28 days.',
    leadingIndicator: 'impressions-weighted CTR, daily',
    proposedChanges: [{ type: 'meta.title', url, summary: 'Shorten the title to fit the result.' }],
    author: { kind: 'specialist', specialist: 'technical' },
  };
  await db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, site_id, latest_version) VALUES ($1,$2,'recommendation',$3,$4,1)
     ON CONFLICT DO NOTHING`,
    [input.workspaceId, recommendationId, content.title, input.siteId],
  );
  await db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id, note)
     VALUES ($1,$2,1,'in_review',$3,$4,'agent','agent_specialist','Drafted by the technical specialist.') ON CONFLICT DO NOTHING`,
    [input.workspaceId, recommendationId, JSON.stringify(content), hex('thin-loop-hash', 64)],
  );
  await db.admin.query(
    `INSERT INTO approval_requests (workspace_id, id, artifact_id, version, status, requested_by_type, requested_by_id, note, created_at)
     VALUES ($1,$2,$3,1,'pending','agent','agent_specialist','Shortens the pricing page title; the evidence is issue ' || $4 || '.',$5)
     ON CONFLICT DO NOTHING`,
    [input.workspaceId, approvalId, recommendationId, issueId, at],
  );

  // A change set already at its pull request, so the pipeline and the connector panel have a real
  // row to read. Its content is the drafted shape: a change with the source it resolves to.
  const changeContent = {
    connector: 'github',
    title: 'Rewrite the pricing page title',
    summary: 'One title change, backed by the issue.',
    recommendationId,
    changes: [
      {
        change: { type: 'meta.title', url, before: 'A pricing page title that is far too long to be shown in full', after: 'Pricing' },
        source: { path: 'pricing/index.html', editor: 'html', confidence: 'exact', affectedRoutes: ['/pricing'] },
        baseSha: 'a'.repeat(40),
        sourceHash: 'b'.repeat(64),
        diff: { path: 'pricing/index.html', status: 'modified', unified: '', additions: 1, deletions: 1 },
      },
    ],
    verificationPlan: 'Re-crawl the pricing page and read its title.',
    rollbackPlan: 'Revert the pull request.',
  };
  await db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, site_id, latest_version) VALUES ($1,$2,'change_set',$3,$4,1)
     ON CONFLICT DO NOTHING`,
    [input.workspaceId, changeSetId, changeContent.title, input.siteId],
  );
  await db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1,$2,1,'published',$3,$4,'user',$5) ON CONFLICT DO NOTHING`,
    [input.workspaceId, changeSetId, JSON.stringify(changeContent), hex('thin-loop-change-hash', 64), input.userId],
  );
  await db.admin.query(
    `INSERT INTO change_set_runs (workspace_id, artifact_id, site_id, state, approved_version, approval_id, branch, pr_number, pr_url,
       head_sha, drafted_at, submitted_at, approved_at, applied_at, state_changed_at)
     VALUES ($1,$2,$3,'pr_open',1,$4,'aseo/change-1',42,$5,$6,$7,$7,$7,$7,$7) ON CONFLICT DO NOTHING`,
    [
      input.workspaceId,
      changeSetId,
      input.siteId,
      `apr_${hex('thin-loop-change-approval')}`,
      `https://github.com/TimChr78/martechsignal/pull/42`,
      'c'.repeat(40),
      at,
    ],
  );

  return { auditId, issueId, recommendationId, approvalId, changeSetId };
}
