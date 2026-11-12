# Open questions

## Decided (2026-11-12)

| # | Question | Decision | Recorded in |
|---|---|---|---|
| 1 | **Shared code with Agentic Marketing** | **Copy with provenance now.** Each ported package records the Agentic Marketing commit it came from. Shared packages are extracted only when one of these triggers fires: the same fix had to be applied by hand in both repositories three times, or a third product needs the packages. A shared library would add versioning, publishing and cross-repo CI, which costs more than occasional manual syncing for a team of one. A small `scripts/port-diff` lists upstream changes to ported packages since their recorded commit, so drift stays visible | [ADR-0001](adr/0001-sister-product-reuse.md) |
| 3 | **Hosted SaaS** | **Self-host only.** Hosted is possible in the far future; `workspace_id` everywhere keeps the door open, but nothing is built for billing, plans or guest accounts | [data-providers.md](data-providers.md) |
| 5 | **CMS connector** | **WordPress only** for now (Phase 7). Shopify and others later, on demand | [ADR-0007](adr/0007-change-sets-and-site-connectors.md) |
| 6 | **Pilot sites** | **MartechSignal.com and oresund.live** (both non-CMS: GitHub connector, Phase 1 onwards). A CMS pilot for Phase 7 is still open; see #11 | [roadmap.md](roadmap.md) |

## Still open

| # | Question | Default assumed | Affects |
|---|---|---|---|
| 2 | **Product name and CLI:** keep `agentic-seo` / `aseo`, image `ghcr.io/timchr78/agentic-seo`? | Yes | Phase 0 |
| 4 | **Shared SSO and a product switcher** between Agentic Marketing and Agentic SEO | Separate sign-ins in wave 1; the bridge uses MCP/API tokens | Phase 8 |
| 7 | **AI visibility source:** DataForSEO LLM endpoints, direct engine APIs, or both | Both, with the default chosen by spike 5 | [data-providers.md](data-providers.md) |
| 8 | **Default renderer in Compose:** ship the `renderer` sidecar enabled, or `none` with a profile to enable it? | `none` by default, `--profile renderer` to add it; Crawl4AI adapter for existing installs | [ADR-0005](adr/0005-rendering.md) |
| 9 | **claude-seo FLOW framework (CC BY 4.0):** include its prompts with attribution, or leave out? | Leave out in wave 1 | [feature-parity.md](feature-parity.md) |
| 10 | **Agency features** (client viewer role, white-label reports, many sites per workspace) | Many sites per workspace yes; white-label later | [domain-model.md](domain-model.md) |
| 11 | **The CMS pilot for Phase 7.** Constraint (owner, 2026-11-12): no public website is served from the home network; public sites stay on Cloudflare. Options: (a) WordPress running only on the LAN, exported as a static site to Cloudflare Pages (Simply Static); (b) Payload CMS on Cloudflare Workers (official D1 template), which would replace WordPress as the first CMS connector; (c) a git-based CMS (Decap or Sveltia) on Pages, which needs no new connector | **Deferred** (owner, 2026-11-12) until before Phase 7; (a) and (b) are both viable. The owner already has the paid Workers plan, so (b) adds no cost. For (a), the connector reaches the LAN WordPress through the per-site private-target allow-list, and verification waits for the export and the Pages deploy | [roadmap.md](roadmap.md), [ADR-0007](adr/0007-change-sets-and-site-connectors.md) |
