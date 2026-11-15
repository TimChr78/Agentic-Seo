-- Phase 1 task G: recommendations produced by the technical specialist and the strategist.
--
-- A recommendation is a versioned artifact (`rcm_…`, packages/artifacts): content, evidence,
-- hypothesis and falsification check all live in JSONB, so the artifact tables already hold it. This
-- migration adds only what an artifact cannot express:
--
--   * `recommendation_runs` — one row per `recommendations.generate` run: which audit it read, how
--     many recommendations were created or dropped and why, what the two model calls cost, and the
--     state (queued → running → completed/failed). The run is the honest record of a synthesis that
--     may have dropped items, so it is separate from the drafts it produced.
--   * `recommendation_priorities` — a person's order over a site's recommendations. Ordering is not
--     part of the content: reordering must not create a version, because a draft version would
--     change what an agent is reviewing and what a published version says. People only, recorded
--     with who last changed it.
--
-- `recommendation_enqueue` is the one narrow door onto Graphile Worker's tables, modelled on 0007's
-- `crawl_enqueue` and 0010's `change_set_enqueue`: the app role has no rights there, and a run that
-- committed without its job would sit in `queued` forever.

CREATE TABLE recommendation_runs (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- `rrun_` + 32 hex characters (newId('rrun')).
  id text NOT NULL CHECK (id ~ '^rrun_[0-9a-f]{32}$'),
  site_id uuid NOT NULL,
  -- The audit whose issues the run read; null when the site has no completed audit.
  audit_id text,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'completed', 'failed')),
  -- Most recommendations one run may create; asked for by the caller, honoured by the validator.
  max_recommendations integer NOT NULL DEFAULT 10 CHECK (max_recommendations BETWEEN 1 AND 20),
  -- Who asked for the run: a person, an agent or the scheduler. The specialists' artifacts record
  -- the same person as their sponsor.
  requested_by_type text NOT NULL CHECK (requested_by_type IN ('user', 'agent', 'system')),
  requested_by_id text NOT NULL,
  -- How many candidates the technical specialist proposed and how many recommendations the
  -- strategist wrote, before validation.
  candidates integer NOT NULL DEFAULT 0 CHECK (candidates >= 0),
  derived integer NOT NULL DEFAULT 0 CHECK (derived >= 0),
  created_count integer NOT NULL DEFAULT 0 CHECK (created_count >= 0),
  dropped_count integer NOT NULL DEFAULT 0 CHECK (dropped_count >= 0),
  -- [{ title, reason }] per item that failed validation after its retry, so a person can see what
  -- the model proposed and why it was not good enough.
  dropped jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The artifacts this run created, in order.
  created_ids text[] NOT NULL DEFAULT '{}',
  -- Tokens the two model calls (and any retry) used, summed; the budget is settled per call.
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  -- A sentence a person can act on ("No AI provider is set up for this use").
  error text,
  -- A lease, so a crashed worker's run is picked up again by the reconciler rather than forever.
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- The fencing token: bumped on every claim, so a worker whose lease expired cannot write a
  -- recommendation or a terminal state after another worker took the run over. `attempts` counts
  -- retries; this names which worker owns the run right now.
  attempt_token bigint NOT NULL DEFAULT 0 CHECK (attempt_token >= 0),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE RESTRICT,
  -- An audit can be deleted with its crawl (findings cascade); the run keeps its counts and loses
  -- only the pointer, so `ON DELETE SET NULL (audit_id)` names the column instead of the workspace.
  FOREIGN KEY (workspace_id, audit_id) REFERENCES audits (workspace_id, id) ON DELETE SET NULL (audit_id)
);
-- The site's runs, newest first: `recommendations.runs` and the reconciler both read this order.
CREATE INDEX recommendation_runs_site ON recommendation_runs (workspace_id, site_id, created_at DESC);
-- The reconciler looks for a run that is queued or whose worker died, across workspaces.
CREATE INDEX recommendation_runs_open ON recommendation_runs (state, created_at)
  WHERE state IN ('queued', 'running');

CREATE TABLE recommendation_priorities (
  workspace_id uuid NOT NULL,
  -- The `rcm_…` artifact this order is about; one row per recommendation.
  artifact_id text NOT NULL,
  site_id uuid NOT NULL,
  -- Lower sorts first. Sparse values are allowed; `recommendations.prioritise` writes 0..n-1.
  priority integer NOT NULL CHECK (priority >= 0),
  -- Who last set the order; people only.
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, artifact_id),
  FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifacts (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX recommendation_priorities_site ON recommendation_priorities (workspace_id, site_id, priority);

-- Row-level security on every tenant table, in the style of 0001–0010.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['recommendation_runs', 'recommendation_priorities'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- A run row moves through its states; it is history, so the app role has no DELETE. Priorities are
-- a person's current order: they are set and replaced, and deleting one is how a recommendation
-- leaves the order (archiving a recommendation keeps its name on the order until someone clears it,
-- which the command does in the same transaction).
GRANT SELECT, INSERT, UPDATE ON recommendation_runs TO aseo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON recommendation_priorities TO aseo_app;

-- Enqueueing a generation run inside the transaction that creates it.
--
-- `recommendations.generate` inserts the run row and must not commit without its job: a crash
-- between the commit and the server's `addJob` would leave a run nobody runs, with no reconciler
-- signal of its own. The app role cannot insert into Graphile Worker's tables, so this
-- security-definer function is the one narrow door (as `crawl_enqueue` in 0007).
--
-- It accepts one task and one payload shape, resolves `graphile_worker.add_job` at call time (the
-- worker may not have started yet) and derives the job key itself, so an app-role caller can never
-- rewrite another task's job. A false return means Graphile's schema is absent: the run stays
-- `queued` and the server's reconciler queues it on a later tick.
CREATE FUNCTION recommendation_enqueue(p_task text, p_payload jsonb, p_run_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $recommendation_enqueue$
DECLARE
  v_workspace uuid := nullif(current_setting('app.workspace_id', true), '')::uuid;
  v_payload_workspace uuid;
  v_run text;
  v_site uuid;
  v_state text;
  v_job_key text;
  v_has_job_key_mode boolean := false;
  v_payload_type text;
BEGIN
  IF p_task IS NULL OR p_task NOT IN ('recommendations_generate') THEN
    RAISE EXCEPTION 'recommendation_enqueue only enqueues recommendations_generate jobs, not %', p_task
      USING ERRCODE = '22023';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'recommendation_enqueue needs a JSON object payload' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_payload)) <> 3
     OR NOT (p_payload ?& ARRAY['workspaceId', 'runId', 'siteId']) THEN
    RAISE EXCEPTION 'recommendation_enqueue payload must be exactly workspaceId, runId and siteId'
      USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_payload_workspace := (p_payload ->> 'workspaceId')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'recommendation_enqueue payload workspaceId is not a uuid' USING ERRCODE = '22023';
  END;
  v_run := p_payload ->> 'runId';
  IF v_run IS NULL OR v_run !~ '^rrun_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'recommendation_enqueue payload runId is not a recommendation run id' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_site := (p_payload ->> 'siteId')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'recommendation_enqueue payload siteId is not a uuid' USING ERRCODE = '22023';
  END;
  IF v_workspace IS NULL OR v_workspace <> v_payload_workspace THEN
    RAISE EXCEPTION 'recommendation_enqueue may only enqueue a run of the current workspace' USING ERRCODE = '42501';
  END IF;
  SELECT state INTO v_state
    FROM recommendation_runs
   WHERE workspace_id = v_payload_workspace AND id = v_run AND site_id = v_site;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'recommendation_enqueue: run % is not on this site and workspace', v_run
      USING ERRCODE = '23503';
  END IF;
  IF v_state NOT IN ('queued', 'running') THEN
    RAISE EXCEPTION 'recommendation_enqueue: run % is %, not waiting to run', v_run, v_state
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

  -- The key is ours, never the caller's: `recommendations_generate:<run>`. `unsafe_dedupe` only
  -- bumps the existing row's revision, so a repeated enqueue cannot replace another job.
  v_job_key := format('%s:%s', p_task, v_run);

  EXECUTE format(
    'SELECT graphile_worker.add_job(identifier => $1, payload => $2::%s, run_at => $3::timestamptz, job_key => $4::text, job_key_mode => $5::text)',
    v_payload_type
  ) USING p_task, p_payload, coalesce(p_run_at, now()), v_job_key, 'unsafe_dedupe';
  RETURN true;
END
$recommendation_enqueue$;
