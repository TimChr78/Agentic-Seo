-- Provider gateway (Phase 0 task E): durable provider calls, monthly budgets and holds, the response
-- cache and token buckets. Every table carries workspace_id and is protected by row-level security,
-- exactly like 0001_foundations.sql. Amounts are bigint micros (millionths of the currency unit), so
-- arithmetic stays exact; currency is an ISO 4217 code.

CREATE TABLE provider_budgets (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  -- The UTC month a budget applies to, e.g. 2026-11. A call settles against the month it started.
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  -- Immutable once the period has held or spent anything: spent_micros and held_micros are only
  -- meaningful in the currency they were reserved in, so the gateway refuses to change it then.
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  budget_micros bigint NOT NULL CHECK (budget_micros >= 0),
  spent_micros bigint NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
  held_micros bigint NOT NULL DEFAULT 0 CHECK (held_micros >= 0),
  -- Thresholds (50, 80, 100) already announced for this budget period.
  notified_thresholds integer[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, provider_id, period)
);

-- One row per uncached call, from reservation to settlement. A call that timed out after the
-- provider accepted it stays `unknown` with its hold kept until reconciliation, never retried blind.
-- `dispatching` is committed before any network I/O, so cleanup can never mistake a live call for an
-- abandoned reservation: it moves `dispatching`/`submitted` calls to `unknown` and keeps the hold.
CREATE TABLE provider_calls (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  caller_type text NOT NULL CHECK (caller_type IN ('person', 'agent', 'hosted_run', 'schedule', 'system')),
  caller_id text NOT NULL,
  purpose text NOT NULL,
  site_id uuid,
  provider_id text NOT NULL,
  port text NOT NULL,
  operation text NOT NULL,
  request_hash text NOT NULL,
  credential_key text NOT NULL DEFAULT '',
  property_key text NOT NULL DEFAULT '',
  market text NOT NULL DEFAULT '',
  options_hash text NOT NULL DEFAULT '',
  -- The full cache identity, kept so a reconciled call can fill the cache without the request body.
  cache_key text NOT NULL,
  max_cost_micros bigint NOT NULL CHECK (max_cost_micros >= 0),
  reserved_micros bigint NOT NULL CHECK (reserved_micros >= 0),
  actual_cost_micros bigint CHECK (actual_cost_micros IS NULL OR actual_cost_micros >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider_task_id text,
  state text NOT NULL CHECK (state IN ('pending', 'dispatching', 'submitted', 'settled', 'failed', 'unknown', 'released')),
  -- Set when a provider charged more than its hold; the actual cost is recorded in full and the
  -- call is reported to the overrun alert hook.
  overrun boolean NOT NULL DEFAULT false,
  -- The raw vendor response, kept for seven days for debugging; purgeRawResponses() empties it.
  raw_response jsonb,
  raw_expires_at timestamptz,
  error text,
  budget_period text NOT NULL CHECK (budget_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- When the dispatch intent was committed, before any call to the provider.
  dispatched_at timestamptz,
  submitted_at timestamptz,
  settled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_calls_workspace_idempotency UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX provider_calls_workspace_created ON provider_calls (workspace_id, created_at DESC);
CREATE INDEX provider_calls_state ON provider_calls (workspace_id, state, updated_at);
CREATE INDEX provider_calls_task ON provider_calls (provider_id, provider_task_id) WHERE provider_task_id IS NOT NULL;
-- The reconciliation sweeps: in-flight calls and calls whose outcome is unknown, across workspaces.
CREATE INDEX provider_calls_in_flight ON provider_calls (updated_at) WHERE state IN ('dispatching', 'submitted');
CREATE INDEX provider_calls_unresolved ON provider_calls (workspace_id, updated_at) WHERE state = 'unknown';

-- Normalised responses keyed by workspace, provider, credential or property, normalised request,
-- market and options. A hit is free; the row also carries when it was fetched for "From cache".
CREATE TABLE provider_cache (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  cache_key text NOT NULL,
  provider_id text NOT NULL,
  port text NOT NULL,
  operation text NOT NULL,
  credential_key text NOT NULL DEFAULT '',
  property_key text NOT NULL DEFAULT '',
  request_hash text NOT NULL,
  market text NOT NULL DEFAULT '',
  options_hash text NOT NULL DEFAULT '',
  response jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, cache_key)
);
CREATE INDEX provider_cache_expiry ON provider_cache (workspace_id, expires_at);

-- A token bucket per workspace, provider and credential. Refilling is computed from updated_at, so
-- no scheduler is needed; the bucket is shared by every server process.
CREATE TABLE provider_rate_buckets (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  credential_key text NOT NULL DEFAULT '',
  tokens double precision NOT NULL CHECK (tokens >= 0),
  capacity double precision NOT NULL CHECK (capacity > 0),
  refill_per_second double precision NOT NULL CHECK (refill_per_second >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, provider_id, credential_key)
);

-- Row-level security on every tenant table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['provider_budgets', 'provider_calls', 'provider_cache', 'provider_rate_buckets'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- Privileges of the application role. Calls and budgets are updated in place (settlement, holds);
-- cache entries and buckets may be deleted when expired.
GRANT SELECT, INSERT, UPDATE ON provider_budgets, provider_calls TO aseo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON provider_cache, provider_rate_buckets TO aseo_app;
