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
  -- The latest rollback proposal for this change set. The original stays where it is until the
  -- rollback change set is verified; a rejected or abandoned proposal leaves this set for another one.
  rollback_change_set_id text,
  -- A rollback's changes that could not be inverted from the change record, with the reason. A
  -- proposal with any uncovered change is never called exact, and it never marks the original
  -- rolled_back: only a rollback that covers every original change can claim that (ADR-0007).
  uncovered_changes jsonb NOT NULL DEFAULT '[]',
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
-- The poller reconciles a job that was lost without its state moving on: an approved change set
-- whose apply job never ran, and a deployed one whose verification never ran.
CREATE INDEX change_set_runs_reconcile ON change_set_runs (state, approved_at, deployed_at)
  WHERE state IN ('approved', 'deployed');
-- One open rollback proposal per original change set. `changes.rollback` locks the original row
-- before it asks whether one exists, so two simultaneous requests serialise; this index is the
-- database's own guarantee, for any path that forgets the lock.
CREATE UNIQUE INDEX change_set_runs_one_open_rollback ON change_set_runs (workspace_id, rollback_of)
  WHERE rollback_of IS NOT NULL
    AND state IN ('draft', 'in_review', 'approved', 'applying', 'pr_open', 'merged', 'deploying', 'deployed');

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

-- Enqueueing a change-set job inside the transaction that makes it due (ADR-0007).
--
-- Two transitions must not be able to commit without their job: the publish that approves a change
-- set (the apply job) and the deploy detection that makes it live (the verification job). Queueing
-- through the server's Graphile helper after the commit leaves a window where a crash loses the job
-- and the change set sits in `approved` or `deployed` forever. The app role cannot insert into
-- Graphile Worker's tables, and should not: this security-definer function is the one narrow door,
-- modelled on 0007's `crawl_enqueue`.
--
-- It accepts only `changes_apply` and `changes_verify`, validates the payload shape, resolves
-- `graphile_worker.add_job` at call time (the worker may not have started yet) and derives the job
-- key from the task and change-set id, never from the caller. Graphile's default `replace` mode
-- would let a caller-chosen key rewrite another task's job; `unsafe_dedupe` only bumps the existing
-- row's revision, so a repeated enqueue of the same change set cannot replace another package's job.
CREATE FUNCTION change_set_enqueue(p_task text, p_payload jsonb, p_run_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $change_set_enqueue$
DECLARE
  v_workspace uuid := nullif(current_setting('app.workspace_id', true), '')::uuid;
  v_payload_workspace uuid;
  v_artifact text;
  v_site uuid;
  v_state text;
  v_job_key text;
  v_has_job_key_mode boolean := false;
  v_payload_type text;
BEGIN
  IF p_task IS NULL OR p_task NOT IN ('changes_apply', 'changes_verify') THEN
    RAISE EXCEPTION 'change_set_enqueue only enqueues changes_apply and changes_verify jobs, not %', p_task
      USING ERRCODE = '22023';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'change_set_enqueue needs a JSON object payload' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_payload)) <> 3
     OR NOT (p_payload ?& ARRAY['workspaceId', 'artifactId', 'siteId']) THEN
    RAISE EXCEPTION 'change_set_enqueue payload must be exactly workspaceId, artifactId and siteId'
      USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_payload_workspace := (p_payload ->> 'workspaceId')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'change_set_enqueue payload workspaceId is not a uuid' USING ERRCODE = '22023';
  END;
  v_artifact := p_payload ->> 'artifactId';
  IF v_artifact IS NULL OR v_artifact !~ '^chg_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'change_set_enqueue payload artifactId is not a change-set id' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_site := (p_payload ->> 'siteId')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'change_set_enqueue payload siteId is not a uuid' USING ERRCODE = '22023';
  END;
  IF v_workspace IS NULL OR v_workspace <> v_payload_workspace THEN
    RAISE EXCEPTION 'change_set_enqueue may only enqueue a change set of the current workspace' USING ERRCODE = '42501';
  END IF;
  SELECT state INTO v_state
    FROM change_set_runs
   WHERE workspace_id = v_payload_workspace AND artifact_id = v_artifact AND site_id = v_site;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'change_set_enqueue: change set % is not on this site and workspace', v_artifact
      USING ERRCODE = '23503';
  END IF;
  IF p_task = 'changes_apply' AND v_state NOT IN ('approved', 'applying') THEN
    RAISE EXCEPTION 'change_set_enqueue: change set % is %, not approved for applying', v_artifact, v_state
      USING ERRCODE = '23514';
  END IF;
  IF p_task = 'changes_verify' AND v_state <> 'deployed' THEN
    RAISE EXCEPTION 'change_set_enqueue: change set % is %, not deployed', v_artifact, v_state
      USING ERRCODE = '23514';
  END IF;

  -- Resolve Graphile Worker's function by its actual argument types (payload was `jsonb` in older
  -- versions and `json` in newer ones), and require `job_key_mode`, or a job key is unsafe to use.
  SELECT format_type(p.proargtypes[1], NULL),
         'job_key_mode' = ANY (p.proargnames)
    INTO v_payload_type, v_has_job_key_mode
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'graphile_worker'
     AND p.proname = 'add_job'
     AND p.proargnames @> ARRAY['identifier', 'payload', 'job_key']
   ORDER BY p.pronargs DESC
   LIMIT 1;

  IF v_payload_type IS NULL OR NOT v_has_job_key_mode THEN
    RETURN false;
  END IF;

  -- The key is ours, never the caller's: `changes_verify:<change set>` (the brief's key) and
  -- `changes_apply:<change set>`. A repeat updates the existing job rather than adding a second.
  v_job_key := format('%s:%s', p_task, v_artifact);

  EXECUTE format(
    'SELECT graphile_worker.add_job(identifier => $1, payload => $2::%s, run_at => $3::timestamptz, job_key => $4::text, job_key_mode => $5::text)',
    v_payload_type
  ) USING p_task, p_payload, coalesce(p_run_at, now()), v_job_key, 'unsafe_dedupe';
  RETURN true;
END
$change_set_enqueue$;

