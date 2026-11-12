# Porting from Agentic Marketing

Shared foundations are **copied with provenance**, not shared as a library (open question 1, decided
2026-11-12). Each ported package records the Agentic Marketing commit it came from, so upstream fixes
can be found and carried over. Extraction into a shared library happens only if the same fix has had to
be applied by hand in both repositories three times, or a third product needs the packages.

Source repository: https://github.com/TimChr78/Agentic-Marketing

| Package | Source path | Source commit | Changes on port |
|---|---|---|---|
| `core` | `packages/core` | `311460e` (0.14.8) | Package scope renamed; `personalData.ts` dropped (marketing-specific); brand name and glyph changed |
| `telemetry` | `packages/telemetry` | `311460e` (0.14.8) | Package scope renamed |
| `db` | `packages/db` | `311460e` (0.14.8) | Package scope renamed. One fresh `0001_foundations.sql` replaces the marketing migration history: workspaces (with the settings JSONB), hash-chained audit log, idempotency keys, data keys, secrets and input warnings, with the same RLS style and app-role grants (`aseo_app`). Marketing tables (profiles, events, segments, journeys, messages, consent, ads, broadcasts, erasures, domains, warehouse, backfill) are not ported; auth/members/artifacts/agents tables are left to Phase 0 task C. The marketing release map and `server_versions` helpers are dropped with the table they read. The test harness uses `TEST_DATABASE_URL`, `AS_TEST_RUN` and `aseo_`-scoped database names and creates/drops its own databases. |
| `commands` | `packages/commands` | `311460e` (0.14.8) | Package scope renamed. Roles use `editor` instead of `marketer`; permissions are the SEO set (`sites:*`, `audits:run`, `research:spend`, `changes:apply`) and marketing permissions (profiles, consent, sends) are gone. Action classes are the SEO set from `agents-and-autonomy.md` §3. The policy engine keeps the level 0–4 structure and workspace ceilings, but marketing impact estimators (audience size, message counts) and mandate scope/learning rules are removed; `estimateImpact` is a typed hook that returns unknown reach until GSC page aggregates exist. The agent ledger, ownership/conflict coordination and `agents.undo` database checks are deferred to task C / Phase 7 and wired through `Services` hooks. `brand.ts` is dropped: it was a marketing workspace brand summary; SEO's site name/domain arrives with `sites`. |
| `secrets` | `packages/secrets` | `311460e` (0.14.8) | Package scope renamed; data-key purposes kept as upstream. The real-OpenBao test remains skipped unless `OPENBAO_TEST_ADDR` points at a Transit server (the fake-server tests always run). |
| `client` | `packages/client` | `311460e` (0.14.8) | Package scope renamed |
| `web` | `apps/web` (shell, `src/ui`, `src/index.css`, theme, router) | `311460e` (0.14.8) | Package scope, storage keys and `as-` CSS prefixes renamed; marketing screens, editors, integrations and demo entries dropped; SEO navigation, site switcher, Home and a typed demo API added; brand assets generated as SVG only |

Rules: keep file structure and names where the code is unchanged, so a diff against upstream stays
readable. Remove marketing-only concepts (profiles, consent, journeys, e-mail, segments) instead of
leaving dead code. Record every port in this table in the same pull request.
