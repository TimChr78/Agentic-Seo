-- Phase 1 integration review: the two security-definer enqueue functions added in 0010 and 0011 were
-- created without the privileges 0007's `crawl_enqueue` carries. A function is executable by PUBLIC by
-- default, so any role that can reach the public schema could enqueue a `changes_apply`,
-- `changes_verify` or `recommendations_generate` job. Each function already checks
-- `app.workspace_id` and the row it names, but the permission was never narrowed, and a
-- security-definer function is exactly where that matters.
--
-- This migration closes both with 0007's pattern: revoke the default PUBLIC grant, then grant EXECUTE
-- to the application role only. `aseo_app` is the role name the migrator rewrites to the configured
-- app role (packages/db/src/migrate.ts), so a test's `aseo_test_app` is granted in its place.

REVOKE ALL ON FUNCTION change_set_enqueue(text, jsonb, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION change_set_enqueue(text, jsonb, timestamptz) TO aseo_app;

REVOKE ALL ON FUNCTION recommendation_enqueue(text, jsonb, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recommendation_enqueue(text, jsonb, timestamptz) TO aseo_app;
