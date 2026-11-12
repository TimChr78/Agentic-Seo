# Technology selection

The baseline is **Agentic Marketing's [tech stack](https://github.com/TimChr78/Agentic-Marketing/blob/main/docs/architecture/tech-stack.md)**, with the same criteria in the same order: (1) maintainable by one person, (2) permissive licence, (3) few moving parts for self-hosting, (4) a proven path to scale, (5) good for agents. This page lists only what we keep, drop and add.

> Licences are as understood at the time of writing. Re-verify each one when the dependency is adopted.

## Kept from Agentic Marketing (same versions where possible)

| Area | Choice |
|---|---|
| Language and runtime | TypeScript (strict), Node.js 24 LTS |
| Monorepo | pnpm workspaces |
| HTTP | Hono + `@hono/zod-openapi` |
| Schemas | Zod 4 (one source for validation, OpenAPI, MCP JSON Schema, forms) |
| Database access | Drizzle ORM + Drizzle Kit migrations |
| Jobs | Graphile Worker (cron, jobs in the same transaction as state) |
| Auth | Better Auth (organizations, passkeys, 2FA, MCP OAuth 2.1 provider, SSO later), all packages pinned to one version |
| MCP | Official MCP TypeScript SDK v2, stateless Streamable HTTP |
| LLM | Vercel AI SDK (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`), BYOK |
| UI | React 19 + Vite, the in-house router, TanStack Query, the `apps/web/src/ui` component set, design tokens |
| Charts | Apache ECharts (SVG renderer, lazy) |
| Code view | Monaco (JSON-LD, robots.txt, diffs) |
| Lint, format and tests | Biome, Vitest, Playwright (+ axe), Testcontainers |
| Packaging | One OCI image, Docker Compose, Helm chart, GitHub Actions, Renovate, SBOM, cosign |
| Observability | OpenTelemetry + pino, Prometheus `/metrics` |
| Secrets | Envelope encryption; env/file KEK, AWS KMS, OpenBao |

## Dropped (not needed for SEO)

| Component | Why |
|---|---|
| ClickHouse | No high-rate event stream. Partitioned Postgres tables carry rank, GSC and AI-answer facts at the target scale. It stays the upgrade path behind the `facts` repository interface ([ADR-0003](adr/0003-storage.md)) |
| NATS JetStream | No ingest hot path. An outbox plus Graphile Worker is enough |
| Valkey | No sub-millisecond session state. Rate limits and token buckets live in Postgres |
| MJML, GrapesJS, LiquidJS, React Flow | No e-mail or journey editors |

## Added

| Area | Choice | Licence | Alternatives considered | Why |
|---|---|---|---|---|
| HTTP client | **undici** (Node's fetch engine) with a custom dispatcher | MIT | got, axios | Connection pooling, a pinned-address `connect` hook for the SSRF guard, streaming bodies |
| HTML extraction | **htmlparser2** (streaming SAX) | MIT | cheerio, jsdom, parse5 | Bounded memory per page (OpenSEO's lesson with cheerio); fast |
| DOM where needed | **parse5** + small selectors, only for judged-check snippets | MIT | jsdom | Light; spec-compliant |
| robots.txt | **robots-parser** | MIT | own | Google-compatible precedence; well tested |
| XML (sitemaps) | **fast-xml-parser** (streaming for large sitemaps via **sax**) | MIT / ISC | xml2js | Already pinned in Agentic Marketing |
| URL normalisation | WHATWG `URL` + own canonicaliser | — | normalize-url | Exact control over SEO-significant differences (trailing slash, case, params) |
| Structured data | **JSON-LD** parsing (`jsonld`, remote context loading off), Schema.org vocabulary JSON, own Google rich-result rules | BSD-3 / Schema.org data CC BY-SA 3.0 (a documented **third-party data exception**: shipped as data files with attribution, separate from the MIT code) | Schema Markup Validator (no API) | Offline validation with Google's requirements encoded as data |
| Text metrics | Own tokeniser + **franc-min** (language detection) | MIT | — | Word counts, language mismatch for hreflang |
| Pixel width of titles | Precomputed glyph-width tables for Arial | — | canvas | No native dependency |
| Rendering (sidecar) | **Playwright** + Chromium in the `renderer` image | Apache-2.0 | Puppeteer | Maintained, multi-device emulation; screenshots |
| Local Lighthouse (sidecar) | **lighthouse** | Apache-2.0 | Unlighthouse | Only when PSI is unavailable |
| External renderers | Crawl4AI, Browserless adapters (HTTP) | — | — | Reuse existing infrastructure |
| Google APIs | Direct REST with our OAuth client (no `googleapis` mega-package) | — | googleapis (Apache-2.0, very large) | Small surface: GSC, GA4 Data/Admin, PSI, CrUX |
| Git connector | **Octokit** (REST) | MIT | isomorphic-git | Pull requests, not local clones |
| Diff | **diff** (jsdiff) | BSD-3 | — | Text diffs in change sets |
| Clustering | Own SERP-overlap clustering (Jaccard on top-10 URLs) + optional embeddings via the LLM gateway | — | — | claude-seo's SERP-based method; no vector DB needed |
| Report HTML | Agent-written HTML in a sandboxed iframe; **DOMPurify** for any HTML we re-serve | Apache-2.0 / MPL-2.0 | — | As OpenSEO reports, but sanitised |

## Explicitly not used

| Tool | Reason |
|---|---|
| Forking OpenSEO | Cloudflare Workers-first (D1, Durable Objects, Workflows), TanStack Start, different conventions; we match its features, not its code ([ADR-0001](adr/0001-sister-product-reuse.md)) |
| claude-seo's Python scripts | Different runtime; we re-implement the checks in TypeScript and credit the project |
| Screaming Frog, Sitebulb | Proprietary |
| A vector database | Not needed for clustering or memory at this scale |
| Temporal | As in Agentic Marketing: an extra cluster for a one-person, self-hostable core |
