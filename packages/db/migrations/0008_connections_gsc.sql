-- Phase 1 task B: connections, Google OAuth and the two Search Console datasets reach needs.
--
-- Connections are per site (domain-model.md §1): one connector per site per kind, with the sealed
-- OAuth tokens in `connections.secrets` and the authorization in progress in `oauth_pending`. A
-- revoked connection is kept as history, so `connections` has no DELETE grant for the app role.
--
-- The search facts are two separate datasets, because summing detail rows never reproduces totals
-- (data-providers.md §5, domain-model.md §3): `gsc_property_totals` and `gsc_page_aggregates`.
-- They are plain tables, not monthly partitions. Partitioning would need a partition key in every
-- primary key and a parent-table grant that RLS does not enforce per partition, so the Phase 1
-- tables keep a (workspace_id, site_id, date) index instead; the retention job can move older
-- months out without changing the RLS shape. Each row records whether its day is final:
-- Search Console data is final after about three days and provisional days are re-fetched.

CREATE TABLE connections (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL CHECK (id ~ '^con_[0-9a-f]{32}$'),
  site_id uuid NOT NULL,
  connector text NOT NULL CHECK (length(btrim(connector)) > 0),
  label text NOT NULL DEFAULT '',
  settings jsonb NOT NULL DEFAULT '{}',
  -- Sealed through `secrets.sealJson`: iv + auth tag + ciphertext of one JSON object. Tokens are
  -- never readable through any command; only the refresh worker and the provider credential seam
  -- open them.
  secrets bytea,
  secrets_key_id text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'active', 'error', 'revoked')),
  -- A sentence a person can act on ("Google refused the refresh token; reconnect Search Console").
  last_error text,
  -- The OAuth authorization in progress: state hash, PKCE verifier, redirect URI and start time.
  oauth_pending jsonb,
  token_expires_at timestamptz,
  -- One replica refreshes one connection at a time; the token is released in a finally block.
  refresh_lease_until timestamptz,
  refresh_lease_token text,
  -- `search.gsc.sync` refuses a second request for this site within a minute.
  last_sync_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE RESTRICT
);
-- One live connection per site per connector. A revoked row stays for the audit trail, so it is
-- excluded: connecting again after a disconnect makes a new row.
CREATE UNIQUE INDEX connections_site_connector_live ON connections (workspace_id, site_id, connector) WHERE state <> 'revoked';
CREATE INDEX connections_site ON connections (workspace_id, site_id, connector);
CREATE INDEX connections_refresh_due ON connections (token_expires_at) WHERE state = 'active';
CREATE INDEX connections_oauth_state ON connections ((oauth_pending ->> 'stateHash')) WHERE oauth_pending IS NOT NULL;

CREATE TABLE gsc_property_totals (
  workspace_id uuid NOT NULL,
  site_id uuid NOT NULL,
  -- The Search Console property, e.g. "sc-domain:example.com" or "https://example.com/".
  property text NOT NULL,
  date date NOT NULL,
  search_type text NOT NULL DEFAULT 'web',
  clicks double precision NOT NULL,
  impressions double precision NOT NULL,
  ctr double precision NOT NULL,
  -- Average position, weighted by impressions by Google.
  position double precision NOT NULL,
  -- Search Console data is final after about three days; provisional days are re-fetched.
  is_final boolean NOT NULL DEFAULT false,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, site_id, property, date, search_type),
  FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX gsc_property_totals_range ON gsc_property_totals (workspace_id, site_id, date);

CREATE TABLE gsc_page_aggregates (
  workspace_id uuid NOT NULL,
  site_id uuid NOT NULL,
  property text NOT NULL,
  date date NOT NULL,
  -- The page's URL exactly as Search Console returns it.
  page text NOT NULL,
  -- ISO 3166-1 alpha-3 country and Google's device name; empty when the dimension is not returned.
  country text NOT NULL DEFAULT '',
  device text NOT NULL DEFAULT '',
  clicks double precision NOT NULL,
  impressions double precision NOT NULL,
  ctr double precision NOT NULL,
  position double precision NOT NULL,
  is_final boolean NOT NULL DEFAULT false,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, site_id, property, date, page, country, device),
  FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX gsc_page_aggregates_range ON gsc_page_aggregates (workspace_id, site_id, date);
CREATE INDEX gsc_page_aggregates_page ON gsc_page_aggregates (workspace_id, site_id, page, date);

-- The watermark per site, dataset and search type: what has been fetched, how far the first
-- backfill got, the last final day and why the last run failed.
CREATE TABLE gsc_sync_state (
  workspace_id uuid NOT NULL,
  site_id uuid NOT NULL,
  dataset text NOT NULL CHECK (dataset IN ('property_totals', 'page_aggregates')),
  search_type text NOT NULL DEFAULT 'web',
  -- The newest day known to be final. Reach trusts page aggregates only when this is fresh.
  last_final_date date,
  last_fetched_at timestamptz,
  -- The first sync backfills 16 months backwards in 30-day chunks. `backfill_through` is the newest
  -- day fully fetched; a failed run resumes at the next day. Complete when it reaches today.
  backfill_complete boolean NOT NULL DEFAULT false,
  backfill_through date,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, site_id, dataset, search_type),
  FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE RESTRICT
);

-- Row-level security on every tenant table, in the style of 0001–0006.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['connections', 'gsc_property_totals', 'gsc_page_aggregates', 'gsc_sync_state'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- A revoked connection is kept, so the app role cannot delete one. Search facts are replaced on a
-- re-fetch and removed by retention, so those tables keep DELETE.
GRANT SELECT, INSERT, UPDATE ON connections TO aseo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON gsc_property_totals, gsc_page_aggregates, gsc_sync_state TO aseo_app;
