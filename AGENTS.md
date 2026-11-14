# Agent guidance (Agentic SEO)

Agentic SEO is the sister product of [Agentic Marketing](https://github.com/TimChr78/Agentic-Marketing).
Read [docs/architecture/README.md](docs/architecture/README.md) first; the plan is
[docs/architecture/roadmap.md](docs/architecture/roadmap.md) and the UI contract is
[docs/design/DESIGN.md](docs/design/DESIGN.md).

## Engineering rules

- **Same conventions as Agentic Marketing.** When in doubt, do what its code does. Ported packages keep
  their structure; [docs/process/porting.md](docs/process/porting.md) records the source commit.
- **Every capability is a command** (`defineCommand`): zod input and output, a permission, an `effect`
  and an `actionClass`. No REST route, MCP tool or UI call outside the registry.
- **Tenancy:** every table has `workspace_id` and row-level security. Never query with the owner pool
  from a request path.
- **Only `fetch` touches arbitrary URLs** (SSRF guard). **Only `providers` calls paid or rate-limited
  external APIs.**
- TypeScript strict, ESM, Node 24. Biome for lint and format (`corepack pnpm lint`).
- Tests: Vitest. Integration tests use the shared test Postgres: `scripts/test-services.sh up`, then
  `eval "$(scripts/test-services.sh env)"`. Never start other containers. A test exists to enforce
  behaviour; prefer one test per invariant at the public entry point (the command or service).
- No `CHANGELOG.md` edits in tasks; add `changelog.d/<slug>.md` instead.
- Dependencies: pin exact versions (`.npmrc` has `save-exact`); permissive licences only (MIT, Apache-2.0,
  BSD, ISC, MPL-2.0). Prefer the versions Agentic Marketing already uses.
- Copy: sentence case, specific, no "Oops"/"successfully" (see DESIGN.md and the sister product's
  microcopy contract).

## Process

Work flows through phase branches and task pull requests: [docs/process/delegates.md](docs/process/delegates.md).
Commits end with the co-author line given in the session. Never commit secrets, tokens or `.env`.
