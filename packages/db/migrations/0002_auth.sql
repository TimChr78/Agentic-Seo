-- Phase 0 task C: authentication, members, API tokens, OAuth grants and agents.
--
-- Ported from Agentic Marketing 311460e (migrations 0002_members, 0009_integrations for
-- api_tokens, 0024_token_changes, 0045_agents, 0050_guardian_shadow, 0053_agent_undo,
-- 0062_agent_action_level, 0065_password_reset's audit_log.ip is in 0001, 0077_oauth_workspace).
-- The Better Auth tables are the ones better-auth 1.7.7 generates for the jwt and mcp plugins,
-- written out here so the schema is reviewable and a fresh install needs no auth-time migration.
-- Better Auth owns them on its owner connection; they carry no workspace_id and no RLS, because a
-- person and their session exist across workspaces.

create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "jwks" ("id" text not null primary key, "publicKey" text not null, "privateKey" text not null, "createdAt" timestamptz not null, "expiresAt" timestamptz, "alg" text, "crv" text);

create table "oauthClient" ("id" text not null primary key, "clientId" text not null unique, "clientSecret" text, "clientDiscoveryId" text, "disabled" boolean, "skipConsent" boolean, "enableEndSession" boolean, "subjectType" text, "scopes" jsonb, "clientCredentialsScopes" jsonb, "userId" text references "user" ("id") on delete cascade, "createdAt" timestamptz, "updatedAt" timestamptz, "name" text, "uri" text, "icon" text, "contacts" jsonb, "tos" text, "policy" text, "softwareId" text, "softwareVersion" text, "softwareStatement" text, "redirectUris" jsonb not null, "postLogoutRedirectUris" jsonb, "backchannelLogoutUri" text, "backchannelLogoutSessionRequired" boolean, "tokenEndpointAuthMethod" text, "applicationType" text, "jwks" text, "jwksUri" text, "grantTypes" jsonb, "responseTypes" jsonb, "requirePKCE" boolean, "dpopBoundAccessTokens" boolean, "referenceId" text, "metadata" jsonb);

create table "oauthResource" ("id" text not null primary key, "identifier" text not null unique, "name" text not null, "accessTokenTtl" integer, "refreshTokenTtl" integer, "signingAlgorithm" text, "signingKeyId" text, "allowedScopes" jsonb, "customClaims" jsonb, "dpopBoundAccessTokensRequired" boolean, "disabled" boolean, "createdAt" timestamptz, "updatedAt" timestamptz, "policyVersion" integer, "metadata" jsonb);

create table "oauthClientResource" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "resourceId" text not null references "oauthResource" ("identifier") on delete cascade, "metadata" jsonb, "createdAt" timestamptz);

create table "oauthRefreshToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" text references "session" ("id") on delete set null, "userId" text not null references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "rotatedAt" timestamptz, "rotationReplayResponse" text, "rotationReplayExpiresAt" timestamptz, "authTime" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);

create table "oauthAccessToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" text references "session" ("id") on delete set null, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "refreshId" text references "oauthRefreshToken" ("id") on delete cascade, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);

create table "oauthConsent" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "scopes" jsonb not null, "createdAt" timestamptz not null, "updatedAt" timestamptz not null);

create table "oauthClientAssertion" ("id" text not null primary key, "expiresAt" timestamptz not null);

create index "session_userId_idx" on "session" ("userId");

create index "account_userId_idx" on "account" ("userId");

create index "verification_identifier_idx" on "verification" ("identifier");

create index "oauthClient_userId_idx" on "oauthClient" ("userId");

create index "oauthClientResource_clientId_idx" on "oauthClientResource" ("clientId");

create index "oauthClientResource_resourceId_idx" on "oauthClientResource" ("resourceId");

create index "oauthRefreshToken_clientId_idx" on "oauthRefreshToken" ("clientId");

create index "oauthRefreshToken_sessionId_idx" on "oauthRefreshToken" ("sessionId");

create index "oauthRefreshToken_userId_idx" on "oauthRefreshToken" ("userId");

create index "oauthRefreshToken_authorizationCodeId_idx" on "oauthRefreshToken" ("authorizationCodeId");

create index "oauthAccessToken_clientId_idx" on "oauthAccessToken" ("clientId");

create index "oauthAccessToken_sessionId_idx" on "oauthAccessToken" ("sessionId");

create index "oauthAccessToken_userId_idx" on "oauthAccessToken" ("userId");

create index "oauthAccessToken_authorizationCodeId_idx" on "oauthAccessToken" ("authorizationCodeId");

create index "oauthAccessToken_refreshId_idx" on "oauthAccessToken" ("refreshId");

create index "oauthConsent_clientId_idx" on "oauthConsent" ("clientId");

create index "oauthConsent_userId_idx" on "oauthConsent" ("userId");

create unique index "oauthClientResource_clientId_resourceId_uidx" on "oauthClientResource" ("clientId", "resourceId");

-- Members and invitations. Owners and admins invite people by e-mail; the invitee accepts with a
-- one-time link while signed in with that e-mail. Only a hash of the invitation token is stored.
CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'approver', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user ON workspace_members (user_id);

CREATE TABLE invitations (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'approver', 'viewer')),
  token_hash text NOT NULL UNIQUE,
  invited_by text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  accepted_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  PRIMARY KEY (workspace_id, id)
);
-- At most one open invitation per address and workspace.
CREATE UNIQUE INDEX invitations_open ON invitations (workspace_id, lower(email)) WHERE status = 'pending';

-- workspace_members was read-only for the app until now; it gets row-level security like every
-- other tenant table now that the app can change memberships. Membership lookups at sign-in use
-- the admin connection.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invitations', 'workspace_members'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON invitations TO aseo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_members TO aseo_app;

-- API tokens for scripts. A token acts in one workspace and as an agent for the person who made
-- it; only a hash of the value is stored.
CREATE TABLE api_tokens (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  user_id text NOT NULL,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_hint text NOT NULL,
  scopes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (workspace_id, id)
);

-- Every change to a token's name, scopes or expiry, with creation and revocation, so the token
-- detail can show its history. The token value never changes and is never stored.
CREATE TABLE api_token_changes (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  token_id text NOT NULL,
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changes jsonb NOT NULL,
  stepped_up boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX api_token_changes_token ON api_token_changes (workspace_id, token_id, changed_at DESC);

ALTER TABLE api_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_tokens
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE api_token_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_token_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_token_changes
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON api_tokens TO aseo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON api_token_changes TO aseo_app;

-- One workspace per OAuth connection. An OAuth consent is issued for one workspace: the person
-- picks it on the consent page when they belong to several, and the grant's reference id is that
-- workspace. The consent page writes the pending choice here first; the OAuth provider reads it in
-- `consentReferenceId` and stores it on the grant. The table is a short-lived hand-off keyed by the
-- Better Auth session, not a second membership model: nothing here grants access on its own.
CREATE TABLE oauth_workspace_selections (
  session_id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_workspace_selections_workspace ON oauth_workspace_selections (workspace_id);

ALTER TABLE oauth_workspace_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_workspace_selections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oauth_workspace_selections
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_workspace_selections TO aseo_app;

COMMENT ON TABLE oauth_workspace_selections IS
  'Pending OAuth consent workspace choice for one Better Auth session; the grant itself stores it as its reference id.';

-- Agents as first-class principals (ADR-0006). An agent is a named principal with a sponsor (the
-- member accountable for it), a status and the credentials it acts with (API tokens, OAuth
-- clients). Pausing an agent stops every one of its credentials. Credentials are attached on first
-- use, so existing tokens and OAuth clients become agents without a data migration.
CREATE TABLE agents (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  sponsor_user_id text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
  status_reason text,
  status_changed_by text,
  status_changed_at timestamptz,
  -- Reserved for multi-workspace; a workspace is the tenant, so nothing uses this column.
  brand text,
  -- The guardian's cap on the agent until a person clears it (Phase 7); null when it has not acted.
  guard jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE agent_credentials (
  workspace_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('api_token', 'oauth_client')),
  credential_id text NOT NULL,
  agent_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, kind, credential_id),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX agent_credentials_agent ON agent_credentials (workspace_id, agent_id);

-- Every agent write with the policy decision that allowed, escalated or refused it. Counters for
-- the per-agent limits are read from here. The ledger is append-only for the app, except the
-- columns that mark an action undone.
CREATE TABLE agent_actions (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id bigserial NOT NULL,
  agent_id text NOT NULL,
  command text NOT NULL,
  action_class text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allow', 'hold', 'ask', 'deny')),
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  impact jsonb NOT NULL DEFAULT '{}'::jsonb,
  ok boolean NOT NULL,
  error text,
  target text,
  surface text NOT NULL,
  mandate_id text,
  mandate_version integer,
  intent text,
  level smallint,
  shadow jsonb,
  undo jsonb,
  undone_at timestamptz,
  undone_by text,
  undo_result text,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX agent_actions_agent ON agent_actions (workspace_id, agent_id, at DESC);

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE agent_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_credentials
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE agent_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_actions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON agents TO aseo_app;
GRANT SELECT, INSERT, DELETE ON agent_credentials TO aseo_app;
-- The ledger is append-only for the app, except marking an action undone.
GRANT SELECT, INSERT ON agent_actions TO aseo_app;
GRANT UPDATE (undone_at, undone_by, undo_result) ON agent_actions TO aseo_app;
GRANT USAGE ON SEQUENCE agent_actions_id_seq TO aseo_app;
