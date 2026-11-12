-- Phase 0 task C2: versioned artifacts, approval requests and learnings.
--
-- Ported from Agentic Marketing 311460e: 0001_foundations.sql (artifacts, artifact_versions,
-- approval_requests), 0031_artifact_layout.sql (only the discard function; SEO artifacts have no
-- canvas positions), 0032_approval_bundles.sql (bundle_id), 0047_mandates.sql (hold_until),
-- 0056_learnings.sql and 0076_agent_coordination.sql (owner_agent_id).
--
-- Marketing's artifact content lives in JSONB and needs no table changes, so the marketing columns
-- that shaped e-mail, journeys and segments are gone. `site_id` is new: SEO scopes site memory and
-- learnings to a site. It is a plain uuid without a foreign key because the `sites` table arrives
-- in a later task; a nullable column keeps every existing artifact workspace-scoped until then.

CREATE TABLE artifacts (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  type text NOT NULL,
  name text NOT NULL,
  -- The site this artifact belongs to, when it is site-scoped (site context, trackers, change sets).
  site_id uuid,
  latest_version integer NOT NULL,
  published_version integer,
  archived boolean NOT NULL DEFAULT false,
  -- The agent that owns this artifact (#426). A missing agent counts as retired, never as active.
  owner_agent_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX artifacts_type ON artifacts (workspace_id, type, updated_at DESC);
CREATE INDEX artifacts_owner_agent ON artifacts (workspace_id, owner_agent_id) WHERE owner_agent_id IS NOT NULL;
CREATE INDEX artifacts_site ON artifacts (workspace_id, site_id) WHERE site_id IS NOT NULL;

CREATE TABLE artifact_versions (
  workspace_id uuid NOT NULL,
  artifact_id text NOT NULL,
  number integer NOT NULL,
  state text NOT NULL CHECK (state IN ('draft', 'in_review', 'published', 'superseded', 'rejected')),
  content jsonb NOT NULL,
  content_hash text NOT NULL,
  based_on integer,
  author_type text NOT NULL CHECK (author_type IN ('user', 'agent')),
  author_id text NOT NULL,
  author_client text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, artifact_id, number),
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifacts (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE approval_requests (
  workspace_id uuid NOT NULL,
  id text NOT NULL,
  artifact_id text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  requested_by_type text NOT NULL,
  requested_by_id text NOT NULL,
  requested_by_client text,
  note text NOT NULL,
  decided_by text,
  decided_at timestamptz,
  decision_note text,
  -- A bundle is reviewed together: one row per artifact, sharing a bundle id (#107).
  bundle_id text,
  -- A held agent change (level 2) would run at hold_until unless a person vetoes it. Holds arrive
  -- in Phase 7; the column is here so the artifact and approval shape is complete.
  hold_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, artifact_id, version) REFERENCES artifact_versions (workspace_id, artifact_id, number) ON DELETE CASCADE
);
CREATE INDEX approval_requests_pending ON approval_requests (workspace_id, created_at) WHERE status = 'pending';
CREATE INDEX approval_requests_bundle ON approval_requests (workspace_id, bundle_id) WHERE bundle_id IS NOT NULL;
CREATE INDEX approval_requests_holds ON approval_requests (hold_until) WHERE status = 'pending' AND hold_until IS NOT NULL;

-- Discarding a draft (artifacts.discardDraft) deletes the unpublished versions after the live one.
-- The app role gets no DELETE on versions or approval requests: this function is the only way, and
-- it only acts on the caller's workspace, only on draft or rejected versions after a live one,
-- never while a request is pending, and removes only those versions' decided requests.
CREATE FUNCTION discard_artifact_drafts(p_artifact text) RETURNS integer[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  ws uuid := nullif(current_setting('app.workspace_id', true), '')::uuid;
  live integer;
  numbers integer[];
BEGIN
  IF ws IS NULL THEN RAISE EXCEPTION 'no workspace'; END IF;
  SELECT published_version INTO live FROM artifacts WHERE workspace_id = ws AND id = p_artifact FOR UPDATE;
  IF live IS NULL THEN RAISE EXCEPTION 'artifact % has no live version', p_artifact; END IF;
  IF EXISTS (SELECT 1 FROM approval_requests WHERE workspace_id = ws AND artifact_id = p_artifact AND version > live AND status = 'pending') THEN
    RAISE EXCEPTION 'a version of % is waiting for approval', p_artifact;
  END IF;
  IF EXISTS (SELECT 1 FROM artifact_versions WHERE workspace_id = ws AND artifact_id = p_artifact AND number > live AND state NOT IN ('draft', 'rejected')) THEN
    RAISE EXCEPTION 'a version of % after the live one is neither a draft nor rejected', p_artifact;
  END IF;
  SELECT coalesce(array_agg(number ORDER BY number), '{}') INTO numbers
    FROM artifact_versions WHERE workspace_id = ws AND artifact_id = p_artifact AND number > live;
  DELETE FROM approval_requests WHERE workspace_id = ws AND artifact_id = p_artifact AND version > live;
  DELETE FROM artifact_versions WHERE workspace_id = ws AND artifact_id = p_artifact AND number > live;
  UPDATE artifacts SET latest_version = live, updated_at = now() WHERE workspace_id = ws AND id = p_artifact;
  RETURN numbers;
END $$;
REVOKE ALL ON FUNCTION discard_artifact_drafts(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION discard_artifact_drafts(text) TO aseo_app;

-- Learnings (agentic-autonomy §6): a conclusion with the evidence behind it. `site_id` scopes a
-- learning to one site; null means the whole workspace. People retract one with a reason and the
-- row stays for the record. `evidence` points at real artifacts (change sets, recommendations,
-- reports, trackers) so a conclusion cannot come from a remembered id.
CREATE TABLE learnings (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  site_id uuid,
  statement text NOT NULL,
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  author_type text NOT NULL CHECK (author_type IN ('user', 'agent')),
  author_id text NOT NULL,
  agent_id text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retracted')),
  retracted_by text,
  retracted_at timestamptz,
  retract_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX learnings_active ON learnings (workspace_id, created_at DESC) WHERE status = 'active';
CREATE INDEX learnings_site ON learnings (workspace_id, site_id, created_at DESC) WHERE site_id IS NOT NULL;

ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON artifacts
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE artifact_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON artifact_versions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON approval_requests
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE learnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE learnings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON learnings
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- The app role may read and write artifacts. Versions and approvals are append-only except the
-- state and decision columns; only discard_artifact_drafts deletes them, under its own checks.
GRANT SELECT, INSERT, UPDATE ON artifacts TO aseo_app;
GRANT SELECT, INSERT, UPDATE ON artifact_versions TO aseo_app;
GRANT SELECT, INSERT, UPDATE ON approval_requests TO aseo_app;
GRANT SELECT, INSERT, UPDATE ON learnings TO aseo_app;
