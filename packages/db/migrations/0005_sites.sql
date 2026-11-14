-- Phase 0 task I: sites, their markets and their competitors, and the composite foreign keys that
-- tie the rows already carrying a site_id to a site (artifacts, learnings, provider_calls).
--
-- Site ids are uuids like workspace ids. `artifacts.site_id`, `learnings.site_id` and
-- `provider_calls.site_id` were created as plain uuid columns in 0004 and 0003 because sites did
-- not exist yet; 0005 gives them their foreign key. Phase 0 has not shipped, so no stored site_id
-- can point outside `sites` and the constraints can be added without a repair pass.
--
-- A site is archived, never deleted: its artifacts, learnings and provider calls stay meaningful
-- history, so every reference here is ON DELETE RESTRICT. Markets and competitors are rows of a
-- site's configuration, not history, and their commands delete them.

CREATE TABLE sites (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  -- Normalised by the command layer (packages/sites/src/domain.ts): lower-case ASCII (IDNA/punycode),
  -- without scheme, path, port or trailing dot. The database stores the normalised form only.
  primary_domain text NOT NULL CHECK (primary_domain = lower(primary_domain) AND primary_domain !~ '[[:space:]/:?#@]'),
  -- Extra hosts the site answers on, e.g. www.example.com. The primary domain is not repeated.
  hosts text[] NOT NULL DEFAULT '{}',
  -- Confirmed business type; null until a person or agent sets it.
  business_type text CHECK (business_type IN ('saas', 'local', 'ecommerce', 'publisher', 'agency', 'other')),
  is_local_business boolean NOT NULL DEFAULT false,
  -- Published in a DNS TXT record (`aseo-site-verification=<token>`) or a home page meta tag. It is
  -- created with the site and only sites.verification reads it; nothing rotates it silently.
  verification_token text NOT NULL,
  verification_method text CHECK (verification_method IN ('dns', 'meta')),
  verified_at timestamptz,
  verified_by text,
  last_check_at timestamptz,
  -- The actionable reason the last check failed. A verified site keeps its verified_at when a later
  -- check fails (Phase 0 decision): the record disappeared, which is evidence, not disproof.
  last_check_error text,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- (workspace_id, id) is unique through the primary key, which is what the composite foreign keys
  -- below reference. `learnings` and `provider_calls` can point at a site in the same workspace only.
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX sites_workspace ON sites (workspace_id, created_at DESC);
-- One active site per (workspace, primary domain). Archived rows are excluded so a domain can be
-- archived and added again, the same shape as the artifact singleton index.
CREATE UNIQUE INDEX sites_active_domain ON sites (workspace_id, primary_domain) WHERE archived = false;

CREATE TABLE markets (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id uuid NOT NULL,
  site_id uuid NOT NULL,
  -- DataForSEO location code (2840 is the United States) plus a language code (en).
  location_code integer NOT NULL CHECK (location_code > 0),
  language_code text NOT NULL CHECK (length(btrim(language_code)) > 0),
  -- ISO 3166-1 alpha-3 country for Search Console, when it is known.
  gsc_country text CHECK (gsc_country ~ '^[A-Z]{3}$'),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE RESTRICT,
  -- A site has one market per location and language pair.
  CONSTRAINT markets_target UNIQUE (workspace_id, site_id, location_code, language_code)
);
CREATE INDEX markets_site ON markets (workspace_id, site_id);
-- At most one default market per site, expressed as a partial unique index so the commands can move
-- the default in one transaction and a racing writer gets a 23505 rather than two defaults.
CREATE UNIQUE INDEX markets_one_default ON markets (workspace_id, site_id) WHERE is_default;

CREATE TABLE competitors (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id uuid NOT NULL,
  site_id uuid NOT NULL,
  -- Normalised like a site's primary domain.
  domain text NOT NULL CHECK (domain = lower(domain) AND domain !~ '[[:space:]/:?#@]'),
  name text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'detected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT competitors_site_domain UNIQUE (workspace_id, site_id, domain)
);

-- The site references that were waiting for this table. MATCH SIMPLE (the default) skips a row whose
-- site_id is null, so workspace-wide artifacts, learnings and provider calls stay valid.
ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_site_fk FOREIGN KEY (workspace_id, site_id)
  REFERENCES sites (workspace_id, id) ON DELETE RESTRICT;
ALTER TABLE learnings
  ADD CONSTRAINT learnings_site_fk FOREIGN KEY (workspace_id, site_id)
  REFERENCES sites (workspace_id, id) ON DELETE RESTRICT;
ALTER TABLE provider_calls
  ADD CONSTRAINT provider_calls_site_fk FOREIGN KEY (workspace_id, site_id)
  REFERENCES sites (workspace_id, id) ON DELETE RESTRICT;

-- Row-level security on every tenant table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sites', 'markets', 'competitors'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- Privileges of the application role. A site is archived, never deleted, so the app has no DELETE on
-- sites. Markets and competitors are configuration rows the commands remove.
GRANT SELECT, INSERT, UPDATE ON sites TO aseo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON markets, competitors TO aseo_app;
