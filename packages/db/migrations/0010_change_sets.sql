-- Phase 1 task F: change sets through the GitHub pull-request connector (ADR-0007).
--
-- A change set's content is a versioned artifact (`chg_…`, packages/artifacts); this migration adds
-- the lifecycle the artifact tables cannot express: one run row per change set with the state and
-- the commit, pull request and deployment SHAs the state refers to, an append-only transition log
-- with evidence, and one verification row per change per attempt.
--
-- The run row is deliberately separate from the artifact: an artifact version is immutable once
-- published, while a run walks through applying, pr_open, merged, deploying and verified. Keeping
-- the two apart is what lets `changes.status` say where the change actually is in the world.
--
-- `deploy_not_detected` is a real outcome (ADR-0007 review update: a merge is not a deployment),
-- and `stale` records that a source changed after drafting, so the change set has to be redrafted.

CREATE TABLE change_set_runs (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- The `chg_…` artifact this run belongs to; one run per change set.
  artifact_id text NOT NULL,
  site_id uuid NOT NULL,
  state text NOT NULL CHECK (
    state IN (
      'draft',
      'in_review',
      'approved',
      'applying',
      'pr_open',
      'merged',
      'deploying',
      'deployed',
      'verified',
      'verification_failed',
      'deploy_not_detected',
      'closed',
      'stale',
      'rolled_back',
      'superseded',
      'failed'
    )
  ),
  -- The artifact version a person (or a mandate) approved; the apply job refuses a different one.
  approved_version integer,
  -- The pull request head SHA that approval covers. A later push makes it differ, which sends the
  -- change set back to review (ADR-0007: stale approvals).
  approved_head_sha text,
  approval_id text,
  branch text,
  pr_number integer,
  pr_url text,
  head_sha text,
  merge_commit_sha text,
  deployed_sha text,
  -- A rollback change set names the change set it rolls back.
  rollback_of text,
  -- Verification attempts that ended in a fetch failure; the third one gives up with evidence.
  verification_attempts integer NOT NULL DEFAULT 0,
  -- A sentence a person can act on ("The file changed since this change set was drafted").
  last_error text,
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  drafted_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  approved_at timestamptz,
  applied_at timestamptz,
  merged_at timestamptz,
  deployed_at timestamptz,
  verified_at timestamptz,
  closed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, artifact_id),
  FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifacts (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX change_set_runs_site ON change_set_runs (workspace_id, site_id, state);
-- The conflict hold and the poller both ask for the site's open change sets: a partial index keeps
-- the terminal history out of the way.
CREATE INDEX change_set_runs_open ON change_set_runs (workspace_id, site_id)
  WHERE state IN ('draft', 'in_review', 'approved', 'applying', 'pr_open', 'merged', 'deploying', 'deployed');
-- The poller discovers work across workspaces; this one finds a repository's open pull requests.
CREATE INDEX change_set_runs_pr ON change_set_runs (workspace_id, artifact_id) WHERE pr_number IS NOT NULL;

-- Append-only: one row per transition, with who caused it and the evidence a reviewer needs. There
-- is no audit outbox yet (the brief is explicit), so this log is what the change-set screen reads.
CREATE TABLE change_set_events (
  seq bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  artifact_id text NOT NULL,
  from_state text,
  to_state text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('person', 'agent', 'system')),
  actor_id text,
  -- Written for a person: "The pull request head changed after approval; approve it again."
  reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES change_set_runs (workspace_id, artifact_id) ON DELETE CASCADE
);
CREATE INDEX change_set_events_one ON change_set_events (workspace_id, artifact_id, seq);

-- One row per change per verification attempt. An attempt is kept whole, so a re-verification
-- after a fix shows both the failure and the pass rather than overwriting the evidence.
CREATE TABLE change_set_verifications (
  workspace_id uuid NOT NULL,
  artifact_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  change_index integer NOT NULL CHECK (change_index >= 0),
  url text NOT NULL,
  change_type text NOT NULL,
  result text NOT NULL CHECK (result IN ('pass', 'fail', 'unknown')),
  detail text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}',
  -- Verifications run against the deployed commit, never the merge (ADR-0007).
  deployed_sha text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, artifact_id, attempt, change_index),
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES change_set_runs (workspace_id, artifact_id) ON DELETE CASCADE
);

-- Row-level security on every tenant table, in the style of 0001–0008.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['change_set_runs', 'change_set_events', 'change_set_verifications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- The run row moves through its states; the log and the verification evidence are append-only. A
-- change set is closed, never deleted, so the app role has no DELETE on any of the three.
GRANT SELECT, INSERT, UPDATE ON change_set_runs TO aseo_app;
GRANT SELECT, INSERT ON change_set_events, change_set_verifications TO aseo_app;
-- `bigserial` does not grant its sequence to the app role on its own.
GRANT USAGE ON SEQUENCE change_set_events_seq_seq TO aseo_app;
