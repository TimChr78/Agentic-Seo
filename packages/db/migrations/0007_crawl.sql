-- Phase 1 task A: the crawl engine. An audit is one crawl of a site (crawler-and-audits.md §2); its
-- frontier, page snapshots and link edges are per-audit working state, while `pages` is the stable
-- per-site list of URLs that survives across audits (domain-model.md §2).
--
-- Every tenant table carries workspace_id and is protected by row-level security, exactly like
-- 0001_foundations.sql. `crawl_host_leases` and `crawl_host_pacing` are deliberately global: they
-- implement the per-host politeness limit that every worker replica shares, so they cannot be
-- scoped to one tenant.
--
-- Link edges are a plain table, not a partition per audit. Partitions would need a policy and grants
-- per audit, whereas the crawler deletes an audit's edges after finalize (the evidence that outlives
-- them is `page_link_stats`), which keeps the table small without dynamic DDL.

CREATE TABLE audits (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- `adt_…`: `aud_…` names the audit_profile artifact (packages/core's id convention).
  id text NOT NULL,
  site_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('site', 'section', 'list', 'page')),
  -- The path prefix for `section` scope, e.g. `/blog`.
  section text,
  -- The exact URLs for `list`/`page` scope.
  urls text[],
  -- { maxPages, maxDepth, maxDurationMs }; the command fills defaults and the hard caps.
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Only `never` is accepted in Phase 1: no renderer is configured until Phase 2.
  render_mode text NOT NULL DEFAULT 'never' CHECK (render_mode IN ('never', 'auto', 'always')),
  state text NOT NULL CHECK (state IN ('queued', 'running', 'finalizing', 'completed', 'partial', 'failed', 'cancelled')),
  -- Why the audit ended `partial` or `failed`, or that it was cancelled.
  state_reason text,
  -- The `Coverage` and `SiteFacts` contracts (packages/crawl/src/facts.ts, hooks.ts).
  coverage jsonb,
  site_facts jsonb,
  pages_crawled integer NOT NULL DEFAULT 0 CHECK (pages_crawled >= 0),
  pages_discovered integer NOT NULL DEFAULT 0 CHECK (pages_discovered >= 0),
  pages_failed integer NOT NULL DEFAULT 0 CHECK (pages_failed >= 0),
  requested_by_type text NOT NULL CHECK (requested_by_type IN ('user', 'agent')),
  requested_by_id text NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  -- Progress for the reconciler: touched by every stored page and by every lease.
  last_progress_at timestamptz NOT NULL DEFAULT now(),
  -- When the reconciler last re-enqueued a chunk for a stalled audit, so it does so once per stall.
  reconciled_at timestamptz,
  -- When the worker's crawl_seed step read robots.txt, sitemaps and the HTTP probe for this audit.
  -- The command itself never touches the network, so this is what tells the first chunk to seed.
  seeded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT audits_scope_section CHECK (scope <> 'section' OR section IS NOT NULL),
  CONSTRAINT audits_scope_urls CHECK (scope NOT IN ('list', 'page') OR (urls IS NOT NULL AND array_length(urls, 1) > 0))
);
CREATE INDEX audits_site ON audits (workspace_id, site_id, created_at DESC, id DESC);
-- At most one live audit per site: two crawls of one site at once would double its load. `cancelled`
-- is excluded because it is terminal for the crawler (finalize still records its coverage).
CREATE UNIQUE INDEX audits_one_live ON audits (workspace_id, site_id) WHERE state IN ('queued', 'running', 'finalizing');

-- The frontier is the crawl queue: one row per known URL of one audit. `url_hash` is the sha256 of
-- the normalised URL, so two spellings of one URL are one row.
CREATE TABLE crawl_frontier (
  workspace_id uuid NOT NULL,
  audit_id text NOT NULL,
  url_hash text NOT NULL,
  url text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'crawled', 'skipped')),
  -- `robots`, `depth_limit`, `page_limit`, `time_limit`, `cancelled`, or a fetch failure.
  skip_reason text,
  -- Click depth from the seed; null for sitemap-only and listed URLs.
  depth integer CHECK (depth IS NULL OR depth >= 0),
  discovered_by text NOT NULL CHECK (discovered_by IN ('seed', 'link', 'sitemap', 'redirect', 'list')),
  discovered_from text,
  in_sitemap boolean NOT NULL DEFAULT false,
  -- The first path segment, for the per-section page quota.
  section text NOT NULL DEFAULT '/',
  -- Which chunk job holds the row; a chunk retry releases its own leftovers first.
  lease_chunk integer,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  PRIMARY KEY (workspace_id, audit_id, url_hash),
  FOREIGN KEY (workspace_id, audit_id) REFERENCES audits (workspace_id, id) ON DELETE CASCADE
);
-- Pages reached by links first, breadth-first by depth; sitemap-only pages after them.
CREATE INDEX crawl_frontier_pending ON crawl_frontier (workspace_id, audit_id, state, depth, in_sitemap);
CREATE INDEX crawl_frontier_lease ON crawl_frontier (workspace_id, audit_id, lease_chunk) WHERE state = 'leased';

-- What the crawler saw for one URL in one audit. The id is derived from (audit_id, url_hash), so a
-- retried chunk upserts the same row instead of duplicating it.
CREATE TABLE page_snapshots (
  workspace_id uuid NOT NULL,
  -- `snp_` + the first 32 hex characters of sha256(audit_id + url_hash).
  id text NOT NULL,
  site_id uuid NOT NULL,
  audit_id text NOT NULL,
  url text NOT NULL,
  final_url text NOT NULL,
  status integer NOT NULL CHECK (status >= 0),
  -- The full `PageFacts` (packages/crawl/src/facts.ts).
  facts jsonb NOT NULL,
  -- Copy of the HTML content hash, for duplicate-content queries without parsing jsonb.
  content_hash text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, audit_id) REFERENCES audits (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX page_snapshots_audit ON page_snapshots (workspace_id, audit_id, url);
CREATE INDEX page_snapshots_content ON page_snapshots (workspace_id, audit_id, content_hash) WHERE content_hash IS NOT NULL;

-- The stable per-site page: one row per URL, updated by every audit that sees it (domain-model.md
-- §2). Snapshots are what an audit saw; a page is what the site has.
CREATE TABLE pages (
  workspace_id uuid NOT NULL,
  -- `pag_` + the first 32 hex characters of sha256(site_id + url), so a retried upsert keeps it.
  id text NOT NULL,
  site_id uuid NOT NULL,
  url text NOT NULL,
  last_audit_id text,
  last_status integer,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT pages_site_url UNIQUE (workspace_id, site_id, url)
);

-- Internal and external links found on a page, for the link graph. Finalize reads them for
-- site-level checks and then deletes the audit's rows; `page_link_stats` keeps the summary.
CREATE TABLE link_edges (
  workspace_id uuid NOT NULL,
  audit_id text NOT NULL,
  from_url_hash text NOT NULL,
  to_url_hash text NOT NULL,
  to_url text NOT NULL,
  rel text[] NOT NULL DEFAULT '{}',
  -- Capped at 200 characters by the extractor.
  anchor text NOT NULL DEFAULT '',
  internal boolean NOT NULL,
  PRIMARY KEY (workspace_id, audit_id, from_url_hash, to_url_hash),
  FOREIGN KEY (workspace_id, audit_id) REFERENCES audits (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX link_edges_inlinks ON link_edges (workspace_id, audit_id, to_url_hash);

-- The link-graph summary finalize keeps before dropping an audit's edges: inlink and outlink counts,
-- and up to five sample anchors for evidence.
CREATE TABLE page_link_stats (
  workspace_id uuid NOT NULL,
  audit_id text NOT NULL,
  url_hash text NOT NULL,
  inlinks integer NOT NULL DEFAULT 0,
  outlinks integer NOT NULL DEFAULT 0,
  internal_inlinks integer NOT NULL DEFAULT 0,
  sample_anchors text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (workspace_id, audit_id, url_hash),
  FOREIGN KEY (workspace_id, audit_id) REFERENCES audits (workspace_id, id) ON DELETE CASCADE
);

-- One lease generation per chunk job: a database sequence, so two chunks of one audit (or two
-- replicas) can never hold the same generation, and a retried job can recognise its own leftovers.
CREATE SEQUENCE crawl_chunk_seq;
GRANT USAGE, SELECT ON SEQUENCE crawl_chunk_seq TO aseo_app;

-- Global per-host concurrency (crawler-and-audits.md §2): one row per leased slot, shared by every
-- worker replica. A lease expires, so a killed worker cannot hold a host forever. `owner` names the
-- process and job for diagnostics.
CREATE TABLE crawl_host_leases (
  id bigserial PRIMARY KEY,
  host text NOT NULL,
  owner text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX crawl_host_leases_host ON crawl_host_leases (host);
CREATE INDEX crawl_host_leases_expiry ON crawl_host_leases (expires_at);

-- Per-host spacing and pauses, also global: `next_start_at` is the earliest next request start
-- (crawl-delay or the limiter's minimum), `paused_until` a 429/503 backoff.
CREATE TABLE crawl_host_pacing (
  host text PRIMARY KEY,
  next_start_at timestamptz NOT NULL DEFAULT now(),
  paused_until timestamptz
);

-- Row-level security on every tenant table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audits', 'crawl_frontier', 'page_snapshots', 'pages', 'link_edges', 'page_link_stats'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- The app role owns the crawl's working state. An audit is kept as history, so it is never deleted.
GRANT SELECT, INSERT, UPDATE ON audits TO aseo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON crawl_frontier, page_snapshots, pages, link_edges, page_link_stats TO aseo_app;
-- Host limits are installation-level, not tenant data: the app role needs them from every workspace.
GRANT SELECT, INSERT, UPDATE, DELETE ON crawl_host_leases TO aseo_app;
GRANT USAGE, SELECT ON SEQUENCE crawl_host_leases_id_seq TO aseo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON crawl_host_pacing TO aseo_app;

-- Enqueueing from `audits.run`. A command's transaction can enqueue its first chunk atomically, so
-- a new audit starts at once instead of waiting up to a minute for the reconciler. The app role
-- cannot insert into Graphile Worker's tables, and should not: this security-definer function is
-- the one narrow door. It accepts only a `crawl_chunk` job for an audit of the caller's workspace,
-- validates the payload shape, and resolves `graphile_worker.add_job` at call time — Graphile's
-- schema is created by the worker on first start, so it may not exist when this migration runs. If
-- it is absent the function returns false and the caller falls back to the reconciler, which
-- dispatches the audit on its next tick.
--
-- The job key is derived here, from the validated audit id and chunk generation; the caller cannot
-- pass one. Graphile Worker's job key is global across tasks, and its default `replace` mode rewrites
-- an existing job of *any* task that holds the key — a caller-chosen key could therefore replace
-- another package's job. `unsafe_dedupe` only bumps the existing row's revision and never changes
-- its task, so a collision can at worst delay our chunk to the reconciler. Two calls for the same
-- audit chunk do dedupe (the key is the same), which is what a retried command wants.
CREATE FUNCTION crawl_enqueue(p_task text, p_payload jsonb, p_run_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $crawl_enqueue$
DECLARE
  v_workspace uuid := nullif(current_setting('app.workspace_id', true), '')::uuid;
  v_payload_workspace uuid;
  v_audit text;
  v_chunk numeric;
  v_job_key text;
  v_has_job_key_mode boolean := false;
  v_payload_type text;
BEGIN
  IF p_task IS DISTINCT FROM 'crawl_chunk' THEN
    RAISE EXCEPTION 'crawl_enqueue only enqueues crawl_chunk jobs, not %', p_task USING ERRCODE = '22023';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'crawl_enqueue needs a JSON object payload' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_payload)) <> 3
     OR NOT (p_payload ?& ARRAY['workspaceId', 'auditId', 'chunk']) THEN
    RAISE EXCEPTION 'crawl_enqueue payload must be exactly workspaceId, auditId and chunk' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_payload_workspace := (p_payload ->> 'workspaceId')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'crawl_enqueue payload workspaceId is not a uuid' USING ERRCODE = '22023';
  END;
  v_audit := p_payload ->> 'auditId';
  IF v_audit IS NULL OR v_audit !~ '^adt_[A-Za-z0-9_-]{1,60}$' THEN
    RAISE EXCEPTION 'crawl_enqueue payload auditId is not an audit id' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_payload -> 'chunk') <> 'number' THEN
    RAISE EXCEPTION 'crawl_enqueue payload chunk is not a number' USING ERRCODE = '22023';
  END IF;
  v_chunk := (p_payload ->> 'chunk')::numeric;
  IF v_chunk <> trunc(v_chunk) OR v_chunk < 1 THEN
    RAISE EXCEPTION 'crawl_enqueue payload chunk is not a positive integer' USING ERRCODE = '22023';
  END IF;
  IF v_workspace IS NULL OR v_workspace <> v_payload_workspace THEN
    RAISE EXCEPTION 'crawl_enqueue may only enqueue an audit of the current workspace' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM audits
    WHERE workspace_id = v_payload_workspace AND id = v_audit AND state IN ('queued', 'running', 'finalizing')
  ) THEN
    RAISE EXCEPTION 'crawl_enqueue: audit % is not live in this workspace', v_audit USING ERRCODE = '23503';
  END IF;

  -- Resolve Graphile Worker's function by its actual argument types: payload was `jsonb` in older
  -- versions and `json` in newer ones, so the cast is built from the catalogue, not assumed. The
  -- function must also accept `job_key_mode`, or `unsafe_dedupe` is unavailable and a job key is
  -- unsafe to use at all.
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

  -- The key is ours, never the caller's: a `replace` of another task's job is then impossible.
  v_job_key := format('crawl_chunk:%s:%s', v_audit, trunc(v_chunk)::bigint);

  EXECUTE format(
    'SELECT graphile_worker.add_job(identifier => $1, payload => $2::%s, run_at => $3::timestamptz, job_key => $4::text, job_key_mode => $5::text)',
    v_payload_type
  ) USING p_task, p_payload, coalesce(p_run_at, now()), v_job_key, 'unsafe_dedupe';
  RETURN true;
END
$crawl_enqueue$;

REVOKE ALL ON FUNCTION crawl_enqueue(text, jsonb, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crawl_enqueue(text, jsonb, timestamptz) TO aseo_app;
