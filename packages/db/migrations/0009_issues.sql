-- Phase 1 task E: findings, issues and the health score.
--
-- A finding is evidence: one check failing on one subject in one audit (ADR-0008). Its id is derived
-- from (audit, check, subject), so a retried page or a retried finalize upserts the same row instead
-- of duplicating it. An issue is the long-lived, site-level grouping people triage: one row per
-- (site, check, subject). Resolving, regressing and ignoring happen on the issue, never on the
-- finding, so the evidence of every audit survives.
--
-- The subject key is the identity an issue is grouped by (crawler-and-audits.md §2, domain-model.md
-- §2): the normalised page URL for page and cross-page checks, and the site's origin for site
-- checks. `audit_scores` holds the health score of one audit (§6) with the per-category penalties
-- and the categories that were not evaluated, so the UI never has to recompute or guess.

CREATE TABLE issues (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- `iss_` + the first 32 hex characters of sha256(site_id + check_id + subject_key).
  id text NOT NULL CHECK (id ~ '^iss_[0-9a-f]{32}$'),
  site_id uuid NOT NULL,
  check_id text NOT NULL,
  -- Page URL for page and cross-page checks; the origin for site checks. Never rewritten.
  subject_key text NOT NULL,
  -- The subject as evidence names it, for display; a URL can carry a `#selector` suffix.
  subject text NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved', 'ignored')),
  -- A copy of the check's severity and category, refreshed on every audit that sees the issue: the
  -- catalogue can change its judgement without a backfill of every historical finding.
  severity text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  category text NOT NULL CHECK (
    category IN ('crawlability', 'indexability', 'status_links', 'on_page', 'structured_data', 'images', 'security', 'international')
  ),
  -- How many times the issue came back after an audit resolved it, and when it last did.
  regressed integer NOT NULL DEFAULT 0 CHECK (regressed >= 0),
  last_regressed_at timestamptz,
  -- The audit that opened it; the last one that saw it failing; the last one that evaluated its
  -- subject at all (what "Not re-checked" is read from); the audit that resolved it.
  first_seen_audit_id text NOT NULL,
  last_seen_audit_id text NOT NULL,
  last_checked_audit_id text NOT NULL,
  resolved_audit_id text,
  -- Who ignored it and why. The reason is required by `checks.ignore` (design §4.2).
  ignored_by text,
  ignored_reason text,
  ignored_at timestamptz,
  -- The latest finding's evidence: { items, total, truncated }, capped by the catalogue. Evidence
  -- explains; it never defines how many pages an issue affects.
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The issue's own subject pages, by normalised URL. This is the identity the health score weighs:
  -- a duplicate-title issue for one page affects that page, whatever the group's evidence shows.
  -- Empty for a site-level issue (robots.txt, sitemap, http-to-https), whose subject is the origin.
  affected_urls text[] NOT NULL DEFAULT '{}',
  -- Pages the issue covers and the denominator of the audit that last checked it. Design §4.2 shows
  -- them as "Pages (affected / evaluated)".
  affected_pages integer NOT NULL DEFAULT 1 CHECK (affected_pages >= 0),
  evaluated_pages integer NOT NULL DEFAULT 1 CHECK (evaluated_pages >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, first_seen_audit_id) REFERENCES audits (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, last_seen_audit_id) REFERENCES audits (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, last_checked_audit_id) REFERENCES audits (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, resolved_audit_id) REFERENCES audits (workspace_id, id) ON DELETE RESTRICT,
  -- One long-lived row per (site, check, subject). A plain unique constraint, not the partial index
  -- the brief sketched: every state must stay unique, an ignored issue included, or a later audit
  -- would open a second row beside the ignored one.
  CONSTRAINT issues_subject_unique UNIQUE (workspace_id, site_id, check_id, subject_key),
  CONSTRAINT issues_ignored_fields CHECK (
    state <> 'ignored' OR (ignored_by IS NOT NULL AND ignored_reason IS NOT NULL AND ignored_at IS NOT NULL)
  )
);
-- The site's issues, worst first: the list filters by state, severity and category.
CREATE INDEX issues_site_state ON issues (workspace_id, site_id, state, severity);
CREATE INDEX issues_site_check ON issues (workspace_id, site_id, check_id);

CREATE TABLE findings (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- `fnd_` + the first 32 hex characters of sha256(audit_id + check_id + source_key).
  id text NOT NULL CHECK (id ~ '^fnd_[0-9a-f]{32}$'),
  site_id uuid NOT NULL,
  audit_id text NOT NULL,
  check_id text NOT NULL,
  -- The snapshot that produced the finding: the requested URL a page hook judged. Two snapshots can
  -- end at the same final URL, so this — not the subject — is what a retried hook replaces.
  source_key text NOT NULL,
  -- The issue identity: the page URL for a content check (its final URL), the requested URL for a
  -- redirect or status check, or `url#selector`. Grouped across audits; never the replacement key.
  subject_key text NOT NULL,
  -- The URL, or `url#selector` when the check points at a fragment of a page.
  subject text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  category text NOT NULL CHECK (
    category IN ('crawlability', 'indexability', 'status_links', 'on_page', 'structured_data', 'images', 'security', 'international')
  ),
  -- { items, total, truncated }: the catalogue's capped evidence plus the true count.
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The issue's own subject pages (normalised URLs); the score's page identity, never the evidence.
  affected_urls text[] NOT NULL DEFAULT '{}',
  affected_pages integer NOT NULL DEFAULT 1 CHECK (affected_pages >= 0),
  -- The issue the finding belongs to; set once the issues of an audit are upserted.
  issue_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, audit_id) REFERENCES audits (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, issue_id) REFERENCES issues (workspace_id, id) ON DELETE SET NULL
);
CREATE INDEX findings_audit_check ON findings (workspace_id, audit_id, check_id);
CREATE INDEX findings_subject ON findings (workspace_id, site_id, check_id, subject_key);
-- A retried page hook replaces its snapshot's findings by source key.
CREATE INDEX findings_source ON findings (workspace_id, audit_id, source_key);
CREATE INDEX findings_issue ON findings (workspace_id, issue_id) WHERE issue_id IS NOT NULL;

CREATE TABLE audit_scores (
  workspace_id uuid NOT NULL,
  site_id uuid NOT NULL,
  audit_id text NOT NULL,
  -- 0–100; null when nothing could be evaluated, with `reason` saying why (design rule: no data is
  -- never healthy).
  score integer CHECK (score BETWEEN 0 AND 100),
  reason text,
  -- [{ category, weight, penalty, contribution, issues, affectedPages }] for the evaluated categories.
  categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{ category, reason }] for the categories this audit did not evaluate at all (performance,
  -- rendering, GEO…). The UI shows them beside the score.
  not_evaluated jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{ checkId, reason }] for checks suppressed on this audit, e.g. graph checks on a truncated graph.
  skipped_checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  pages_evaluated integer NOT NULL DEFAULT 0 CHECK (pages_evaluated >= 0),
  pages_crawled integer NOT NULL DEFAULT 0 CHECK (pages_crawled >= 0),
  -- Open issues the audit could not judge (their subject pages were not evaluated by it). They are
  -- excluded from the score and reported as unchecked coverage, so a scoped audit never scores an
  -- issue it did not look at.
  unchecked_issues integer NOT NULL DEFAULT 0 CHECK (unchecked_issues >= 0),
  -- Whether GSC clicks weighted the page shares (false: every page weighed the same).
  gsc_weighted boolean NOT NULL DEFAULT false,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, audit_id),
  FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, audit_id) REFERENCES audits (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT audit_scores_null_reason CHECK (score IS NOT NULL OR reason IS NOT NULL)
);
CREATE INDEX audit_scores_site ON audit_scores (workspace_id, site_id, computed_at DESC);

-- Row-level security on every tenant table, in the style of 0001–0008.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['issues', 'findings', 'audit_scores'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- A retried chunk replaces its page's findings before writing them again, so findings keep DELETE;
-- they are still never exposed as a way to erase an audit. Issues are history: a check that stops
-- failing is resolved, never deleted, and an ignored issue keeps its reason, so that table has no
-- DELETE grant. Scores are replaced when an audit is recomputed.
GRANT SELECT, INSERT, UPDATE, DELETE ON findings TO aseo_app;
GRANT SELECT, INSERT, UPDATE ON issues TO aseo_app;
GRANT SELECT, INSERT, UPDATE ON audit_scores TO aseo_app;
