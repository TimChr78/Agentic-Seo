-- Phase 0 task J: the LLM gateway (Phase 0, packages/ai).
--
-- Ported from Agentic Marketing 9a7a5721 (0.14.23): 0008_ai.sql (providers and the call log),
-- 0015_ai_reservations.sql (budget holds) and the `ai_calls` columns 0018_ai_phase11.sql added.
-- Marketing's journey, participant, profile, classify, copilot, text-cache and answer-review
-- columns are not ported: SEO has no people or profiles, and hosted runs, independent checks and
-- judgement reviews arrive with their phases. Every table carries workspace_id and is protected by
-- row-level security with app-role grants, exactly like 0001_foundations.sql and 0003_providers.sql.

-- LLM providers with the workspace's own API keys. Two wire formats cover most of the market:
-- OpenAI-compatible (OpenAI, Mistral, vLLM, LiteLLM, OpenRouter…) and Anthropic-compatible.
-- `use_for` names the capabilities a provider serves; each use has one provider at a time.
CREATE TABLE ai_providers (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('openai-compatible', 'anthropic-compatible')),
  -- Always an https origin with a public address: packages/fetch's egress guard refuses the rest.
  base_url text NOT NULL,
  models jsonb NOT NULL,
  structured_outputs boolean NOT NULL DEFAULT true,
  use_for text[] NOT NULL DEFAULT '{}' CHECK (use_for <@ ARRAY['agents', 'answer_engines']::text[]),
  monthly_token_budget bigint CHECK (monthly_token_budget IS NULL OR monthly_token_budget >= 0),
  region text NOT NULL DEFAULT '',
  -- The sealed API key (packages/secrets); never returned by a command.
  secrets bytea,
  secrets_key_id text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

-- Every model call is one row: what the model was asked, what it answered or why it did not, the
-- tokens it used and how long it took. It is also the queue of prompt test runs: the AI worker
-- claims pending rows, calls the model outside any transaction and records the outcome.
CREATE TABLE ai_calls (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('decide', 'generate', 'test')),
  status text NOT NULL CHECK (status IN ('pending', 'running', 'done', 'fallback', 'failed')),
  -- Pending rows wait for the worker; a running one whose lease ran out is claimed again.
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  idempotency_key text,
  provider_id text,
  model text,
  prompt_id text,
  prompt_version integer,
  input jsonb NOT NULL DEFAULT '{}',
  output jsonb,
  rationale text,
  error text,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  latency_ms integer,
  principal_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  -- When the call settled: the provider billed it, or the attempt was given up. Its usage is
  -- charged to this month (billed_at), not to the month the row was queued in, so a case queued
  -- before UTC month-end does not escape the new month's budget. Null until the call is settled;
  -- usage falls back to created_at while it is.
  billed_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX ai_calls_queue ON ai_calls (created_at) WHERE status IN ('pending', 'running');
CREATE INDEX ai_calls_recent ON ai_calls (workspace_id, created_at DESC);
-- The budget and ai.usage filter on coalesce(billed_at, created_at), so the index is on that expression.
CREATE INDEX ai_calls_usage ON ai_calls (workspace_id, provider_id, (coalesce(billed_at, created_at)));
CREATE INDEX ai_calls_prompt ON ai_calls (workspace_id, prompt_id, created_at DESC) WHERE prompt_id IS NOT NULL;

-- A call's estimated tokens, held against the provider's monthly budget before the model is asked.
-- A reservation ends with its call, or expires if the call died; usage plus live holds is what the
-- month has spent, so parallel calls cannot together overshoot the budget. A hold lasts through the
-- next billing month by default: a process that dies after the provider billed keeps its coverage
-- instead of releasing tokens the provider has already charged for.
CREATE TABLE ai_token_reservations (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  provider_id text NOT NULL,
  -- The call attempt this hold covers; a stale attempt's hold stays counted when the attempt is
  -- recovered, and the row's own counters say how often it has run.
  call_id text,
  tokens integer NOT NULL CHECK (tokens > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, call_id) REFERENCES ai_calls (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX ai_token_reservations_provider ON ai_token_reservations (workspace_id, provider_id, expires_at);
CREATE INDEX ai_token_reservations_call ON ai_token_reservations (workspace_id, call_id);

ALTER TABLE ai_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_providers
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
ALTER TABLE ai_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_calls
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
ALTER TABLE ai_token_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_token_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_token_reservations
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_providers TO aseo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_calls TO aseo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_token_reservations TO aseo_app;
