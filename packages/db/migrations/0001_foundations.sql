-- Phase 0 foundations: tenancy, the audit log, idempotency, envelope-encryption key material and
-- input warnings. Every tenant table carries workspace_id and is protected by row-level security.
-- The application connects as aseo_app (no BYPASSRLS) and sets app.workspace_id per transaction.
--
-- Ported from Agentic Marketing 311460e (0001_foundations.sql, 0004_profiles.sql for the data-key
-- purpose, 0023_workspace_settings.sql, 0029_input_warnings.sql, 0066_password_reset.sql for
-- audit_log.ip and 0079_workspace_create.sql for the workspaces INSERT grant). Auth, members,
-- artifacts and agents tables are deliberately left to task C.

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  approval_policy text NOT NULL DEFAULT 'agent_changes'
    CHECK (approval_policy IN ('none', 'agent_changes', 'all_publishes')),
  time_zone text NOT NULL DEFAULT 'UTC',
  -- Autonomy ceilings and the agents switch (ADR-0006); empty means the defaults.
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only, hash-chained: each row's hash covers the previous row's hash, so tampering with
-- history is detectable. The app role may insert and read, never update or delete.
CREATE TABLE audit_log (
  seq bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  principal_type text NOT NULL,
  principal_id text NOT NULL,
  client_id text,
  surface text NOT NULL,
  command text NOT NULL,
  effect text NOT NULL,
  target text,
  input_hash text NOT NULL,
  ok boolean NOT NULL,
  error text,
  prev_hash text,
  hash text NOT NULL,
  -- The client IP when the entry did not come from a command (a password reset).
  ip text
);
CREATE INDEX audit_log_workspace ON audit_log (workspace_id, seq DESC);

CREATE TABLE idempotency_keys (
  workspace_id uuid NOT NULL,
  key text NOT NULL,
  command text NOT NULL,
  input_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);

-- Envelope encryption: each workspace has data keys wrapped by a key-encryption key (KEK) that
-- never touches the database. Secrets are encrypted with the active data key.
CREATE TABLE data_keys (
  workspace_id uuid NOT NULL,
  id text NOT NULL,
  kek_id text NOT NULL,
  wrapped_key bytea NOT NULL,
  active boolean NOT NULL DEFAULT true,
  -- A key is for secrets, or for identity matching data (kept from upstream's shape).
  purpose text NOT NULL DEFAULT 'secrets' CHECK (purpose IN ('secrets', 'identity', 'matching')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE UNIQUE INDEX data_keys_one_active ON data_keys (workspace_id) WHERE active;

CREATE TABLE secrets (
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  data_key_id text NOT NULL,
  iv bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, name),
  FOREIGN KEY (workspace_id, data_key_id) REFERENCES data_keys (workspace_id, id)
);

-- Evidence for turning strict input mode on: every key a client sent that the command schema
-- ignored, with first/last seen and a count. Key paths only: values are never stored, because they
-- may contain personal data or secrets. The client is an API token, a person or an OAuth client.
CREATE TABLE input_warnings (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'token', 'oauth_client')),
  principal_id text NOT NULL,
  client_label text NOT NULL,
  command text NOT NULL,
  key_path text NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, principal_type, principal_id, command, key_path)
);
CREATE INDEX input_warnings_last_seen ON input_warnings (workspace_id, last_seen);

-- Row-level security on every tenant table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_log', 'idempotency_keys', 'data_keys', 'secrets', 'input_warnings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspaces
  USING (id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- Privileges of the application role. The audit log is append-only for the app.
GRANT SELECT, INSERT, UPDATE ON workspaces TO aseo_app;
GRANT SELECT, INSERT, UPDATE ON idempotency_keys, data_keys TO aseo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON secrets TO aseo_app;
GRANT SELECT, INSERT ON audit_log TO aseo_app;
GRANT USAGE ON SEQUENCE audit_log_seq_seq TO aseo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON input_warnings TO aseo_app;
