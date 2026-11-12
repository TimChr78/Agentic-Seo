# Feature parity

> Status: design (2026-11-12). OpenSEO reference: `v0.1.27` (main, 2026-11-12). claude-seo reference: `v2.5.0`. The phase column refers to [roadmap.md](roadmap.md).

Legend: **P** = parity target, **+** = goes beyond the reference, **–** = deliberately not built.

**"P" is not a name match.** Before a phase starts, each P row in it gets operation-level acceptance criteria, written into its issue: the inputs, the output fields (including nulls shown as "Not available"), the cost behaviour and the error cases, checked against the reference's tool schema or skill. Anything we do not match is listed as an explicit deferral.

## 1. OpenSEO

| OpenSEO capability | MCP tools in OpenSEO | Our module / commands | Target | Phase |
|---|---|---|---|---|
| Projects, website setup, onboarding checklist | `create_project`, `list_projects`, `research_project_website`, `save_project_website_setup` | `sites.*`, Home setup checklist | P | 0 |
| Project memory | `get_project_context`, `update_project_context` | `site-context://`, `sites.context.*`, a versioned artifact | P + (versioned, reviewable) | 0 |
| Keyword research | `research_keywords`, `get_keyword_metrics`, `get_suggested_keywords` | `research.keywords.*` with per-market routing (OpenSEO spec 0004) | P | 3 |
| Saved keywords | `save_keywords`, `list_saved_keywords`, `remove_saved_keywords` | `research.lists.*` | P | 3 |
| Keyword clustering (skill) | — (skill `keyword-clustering`) | `research.cluster` (SERP overlap) | P + (in-platform) | 3 |
| SERP analysis | `get_serp_results`, `show_serp_results`, `search_serp_locations`, `find_serp_competitors` | `research.serp*` | P | 3 |
| Domain overview, ranked keywords, suggestions | `get_domain_overview`, `get_ranked_keywords`, `get_domain_keyword_suggestions` | `research.domain.*` | P | 3 |
| Competitor analysis (skills) | skills `competitor-analysis`, `competitive-landscape` | `research.domain.gap`, Competitor specialist | P + | 3 |
| Backlinks | `get_backlinks_overview`, `get_backlinks_profile` | `research.backlinks.*` (+ Common Crawl domain-level, Bing) | P + (free fallback) | 3 |
| Link prospecting (skill) | skill `link-prospecting` | `research.backlinks.prospects` | P | 3 |
| Rank tracking | `create_rank_tracker`, `estimate_rank_tracker_cost`, `run_rank_tracker`, `get_rank_tracker`, `get_rank_history`, `add/remove/pin_rank_tracking_keywords` | `tracking.ranks.*` | P | 4 |
| Local rank tracking locations | (spec 0008) | `tracking.ranks` with location | P | 4 |
| Local SEO (GBP, reviews, Q&A, grid) | `search_local_businesses`, `get_business_profile`, `get_business_reviews`, `get_business_updates`, `get_google_business_questions`, `get_local_rank_grid`, `get_local_serp_results`, `list_business_categories` | `tracking.local.*` | P | 4 |
| Site audit (crawl, issues, pages) | `run_site_audit`, `get_audit_status`, `get_audit_issues`, `get_audit_pages`, `list_site_audits`, `delete_site_audit` | `audits.*` | P + (≈120 checks, drift, judged checks) | 1 (core) / 2 |
| Lighthouse | `get_audit_lighthouse` | `audits.lighthouse` (PSI lab, CrUX field, local) | P | 2 |
| Crawler access (protected sites, rendering) | (UI) | crawler access settings, renderer port | P | 2 |
| AI visibility trackers | `generate_ai_visibility_prompts`, `research_ai_visibility_prompts`, `complete_ai_research_setup`, `save_ai_visibility_tracker`, `estimate_ai_visibility_cost`, `run_ai_visibility_check`, `get_ai_visibility_*`, `set_ai_visibility_schedule`, `export_ai_visibility_data` | `tracking.aiVisibility.*` | P | 5 |
| Prompt explorer, brand lookup | `explore_prompt` | `tracking.explorePrompt`, `tracking.brandLookup` | P | 5 |
| Google Search Console | `list_search_console_sites`, `set_search_console_site`, `get_search_console_performance`, `show_search_console_performance`, `inspect_urls`, `get_search_opportunities` | `search.gsc.*`, opportunity detectors | P + (detectors) | 1 (totals, pages) / 2 |
| Google Analytics 4 | `list_google_analytics_properties`, `set_google_analytics_property`, 9 report tools (incl. `get_google_analytics_page_performance`) | `search.ga4.*` (incl. `pagePerformance`) | P | 2 |
| IndexNow | `submit_indexnow_urls` | `search.indexNow.submit` | P | 2 |
| Website dashboard | (spec 0015) | Home / Site overview | P | 2 |
| Reports (agent-written HTML) | `save_report`, `list_reports`, `get_report`, `delete_report` | `reports.*` | P | 6 |
| Report templates | `save/list/delete_report_template` | `reports.templates.*` | P | 6 |
| Public share links | `set_report_sharing` | `reports.share` (`report.share` class) | P | 6 |
| In-app agent (SAM) | — | Copilot (in-process MCP client) | P + | 6 |
| MCP server with OAuth and API keys, guest accounts | `whoami` | `/mcp`, OAuth 2.1, API tokens | P (guest accounts –) | 0 |
| Agent skills and plugins (Claude, Codex, Cursor) | `plugins/openseo` | `plugins/agentic-seo` | P | 6 |
| MCP UI widgets | `show_*` tools | optional widget resources | P (later in phase 6) | 6 |
| Multi-user organisations | (spec 0011) | workspaces, roles, invitations (ported) | P + (approver role, SSO later) | 0 |
| Docker self-hosting | (spec 0018) | Compose bundle, `aseo init/doctor` | P | 0 |
| Cloudflare deploy | (Workers) | — | – (Node + Postgres instead) | — |
| Hosted billing (credits, Stripe, auto-reload, plans) | (specs 0002, 0017, 0020) | budgets and metering only | – (self-host first; see open questions) | — |
| Guest accounts for MCP | (spec 0019) | — | – (hosted-SaaS feature) | — |

## 2. claude-seo

| claude-seo command / agent | Our equivalent | Target | Phase |
|---|---|---|---|
| `/seo audit` (parallel agents, health score, action plan) | Full audit run: crawl + strategist fan-out + recommendations | P + (persistent, measured) | 1 (thin) / 6 (all specialists) |
| `/seo page` | `audits.run` with scope `page` + all specialists | P | 1 / 6 |
| `/seo technical` (9 categories) | technical checks | P | 1 |
| `/seo content` (E-E-A-T) | judged content checks, Content specialist | P | 6 |
| `/seo content-brief` | `content.briefs.create`, hand-off to Agentic Marketing | P + | 6 |
| `/seo schema` (detect, validate, generate) | schema checks + `content.schema.*` + `schema.jsonld` change | P + (applied via change sets) | 1 / 7 |
| `/seo sitemap` (analyse, generate) | sitemap checks + `content.sitemap.generate` | P | 1 / 7 |
| `/seo images` | image checks | P | 1 |
| `/seo hreflang` | hreflang checks + generator | P | 1 / 7 |
| `/seo geo` (AI crawlers, citability, llms.txt) | GEO checks + AI visibility + `llms_txt` change | P + | 1 / 5 |
| `/seo agentic` (agent readiness: Lighthouse agentic X/N, access policies, discovery files, WebMCP) | agent-readiness checks (renderer), with Lighthouse fraction handling and access-policy distinctions | P | 5 |
| `/seo plan <type>` | Strategist plan by business type → recommendations roadmap | P | 6 |
| `/seo programmatic` | programmatic checks + `content.programmaticPlan` | P | 6 |
| `/seo competitor-pages` | `content.competitorPages` (draft only) | P | 6 |
| `/seo local`, `/seo maps` | local checks + `tracking.local.*` | P | 4 |
| `/seo google` (GSC, PSI, CrUX, Indexing, GA4, PDF) | `search.*`, CrUX/PSI, Indexing API for eligible pages only, reports (PDF via print) | P | 2 |
| `/seo backlinks` (Moz, Bing, Common Crawl, DataForSEO, known-link verification) | `research.backlinks.*` with DataForSEO, Bing and Common Crawl in 3; Moz in 5; `research.backlinks.verify` (re-fetch known linking pages) in 3 | P | 3 / 5 |
| `/seo cluster` | `research.cluster` | P | 3 |
| `/seo sxo` | SXO specialist (SERP + judged) | P | 6 |
| `/seo drift` | baselines, drift crawls, guardian | P + | 1 / 7 |
| `/seo ecommerce` (product schema, Google Shopping/Merchant, Amazon, marketplace keyword gaps) | e-commerce checks + specialist; marketplace data via a later `MarketplaceData` port | P (on-site) / later (marketplace gaps) | 2 / 6 / later |
| `/seo flow` (FLOW framework, CC BY 4.0) | — | – (licence and scope; revisit) | — |
| `/seo image-gen` | — | – (out of scope) | — |
| `/seo dataforseo`, `/seo firecrawl` | provider gateway adapters; Crawl4AI as renderer | P | 3 / 1 |
| Synthesis methodology (falsifiability, leading indicators) | Recommendation schema (required fields) | P + (enforced) | 6 |
| Quality gates (location pages, deprecated schema) | freshness rules as data | P | 1 |
| Google update ledger (`seo_updates`) | `docs://google-updates`, annotations on GSC charts | P | 2 |

## 3. Beyond both (the agentic core)

| Capability | Phase |
|---|---|
| Change sets with typed changes, diffs and previews | 1 |
| Site connectors: GitHub PR (1), manual/export (2), WordPress (7); Shopify later | 1 / 2 / 7 |
| Deployment-aware re-crawl verification and safe rollback | 1 |
| Outcome measurement (pre-registered cohorts, verdicts incl. inconclusive) → learnings | 2 / 6 |
| Mandates, levels L0–L4, the policy engine with structured reach | 0 (L0/L1) / 7 (L2–L4) |
| Guardian with SEO tripwires | 7 |
| Hosted agents and programmes | 6 (L1) / 7 |
| Agentic Marketing bridge (briefs → editorial topics, events) | 8 |
