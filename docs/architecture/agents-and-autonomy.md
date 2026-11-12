# Agents and autonomy

> Status: design (2026-11-12). The autonomy model is Agentic Marketing's ([agentic-autonomy.md](https://github.com/TimChr78/Agentic-Marketing/blob/main/docs/architecture/agentic-autonomy.md), ADR-0016). This page covers what changes for SEO. Decision record: [ADR-0006](adr/0006-agent-autonomy-for-seo.md).

## 1. Where we stand relative to OpenSEO and claude-seo

| | OpenSEO | claude-seo | Agentic SEO |
|---|---|---|---|
| Agent's role | Uses MCP tools for data; skills guide it | Runs a playbook in Claude Code, with sub-agents fanned out | Runs SEO **loops** inside a mandate, in-platform or over MCP |
| Where the work lives | Tool results plus saved HTML reports | Markdown/PDF report on the user's disk | Findings, recommendations, change sets, outcomes and learnings, all versioned and queryable |
| Changes the site | No | Writes files locally (schema, sitemaps) | Yes, through change sets and connectors, under policy, with verification and rollback |
| Knows if it worked | No | Says what to monitor | Measures against a control group and records a learning |
| Safety | Credit balance | Prompts | Policy engine, mandates, traffic-at-risk limits, guardian, kill switch |

## 2. One command layer

Every capability is a `defineCommand` with zod input/output, a `permission`, an `effect` and an **`actionClass`**. It is exposed over REST, MCP and the UI client from that one definition (ported `commands` package). The MCP server uses SDK v2 with stateless Streamable HTTP at `/mcp`, OAuth 2.1 with consent per scope, scope step-up, and API tokens for scripts.

**Tool groups** (MCP clients can filter by group; names are illustrative):

| Group | Commands |
|---|---|
| `sites.*` | list, get, create, update, verify, markets, competitors, `context.get/update` |
| `audits.*` | run, status, list, pages, issues, issue, findings, lighthouse, compare, baseline, drift, cancel |
| `checks.*` | catalogue, explain, ignore/unignore issue (with reason) |
| `research.*` | keywords (metrics, suggestions, ideas), serp, serpLocations, domain (overview, rankedKeywords, topPages, competitors, gap), backlinks (summary, profile, referringDomains, new/lost, prospects), cluster, lists (save, remove, list) |
| `tracking.*` | ranks (create, estimate, run, history, pin, add/remove keywords), local (grid, serp, business, reviews, updates, questions, categories), aiVisibility (generatePrompts, research, create, estimate, run, results, answer, sources, trend, export, schedule), explorePrompt, brandLookup |
| `search.*` | gsc (sites, connect, performance, inspect, opportunities), ga4 (properties, organicOverview, pagePerformance, landingPages, acquisition, keyEvents, ecommerce, siteSearch, audience, measurementHealth), bing (queries, backlinks), indexNow.submit |
| `content.*` | briefs (create from keyword/cluster/URL), outline, competitorPages, programmaticPlan, schema (generate, validate), sitemap (generate), llmsTxt (generate), hreflang (generate), sendToMarketing |
| `recommendations.*` | list, get, create, update, prioritise, dependencies, outcome |
| `changes.*` | create, updateDraft, diff, preview, requestApply, apply, verify, rollback, status |
| `reports.*` | save, list, get, delete, templates (save, list, delete), share |
| `agents.*`, `learnings.*`, `approvals.*`, `workspace.*` | ported from Agentic Marketing |
| `usage.*` | budgets, spend, estimates |

**Resources:** `site-context://<site>`, `learnings://<site>`, `checks://catalogue`, `change-types://catalogue` (JSON Schema + examples), `skills://<name>`, `docs://…`, `report-starter://html` (the HTML report scaffold, as OpenSEO's `seo-report`).

**Prompts:** "Audit this site and propose the top 10 fixes", "Find striking-distance keywords and draft title changes", "Why did traffic drop last week?", "Plan a content cluster for <topic>", "Check our AI visibility against <competitor>".

**Skills for external agents:** a Claude Code / Codex / Cursor plugin (`plugins/agentic-seo`) ships the MCP connection plus skills mirroring the specialists (§5). It follows OpenSEO's plugin pattern, so external agents get the same playbooks as hosted ones.

**Rich tool output:** tools return compact tables (Markdown) plus structured content. Where the client supports MCP UI widgets, research and SERP results render as widgets (as OpenSEO's `show_*` tools). This is an optional extra, not a dependency.

## 3. SEO action classes

| Class | Examples | Reversible? | Impact estimate |
|---|---|---|---|
| `read` | Research from cache, audits list, GSC reads | – | – |
| `research.spend` | Uncached paid calls; creating or changing a tracker (recurring) | No (money) | Estimated cost, per call and per month |
| `crawl` | `audits.run` on own site; crawl of a competitor | Yes (no lasting effect) | Pages × render mode; load on the target host |
| `draft` | Recommendations, change-set drafts, briefs, report drafts | Yes | – |
| `report.share` | A public share link; sending a report to Agentic Marketing | Yes (revoke the link) | Who can see it |
| `index.submit` | IndexNow, Bing URL submission, sitemap submission through the GSC Sitemaps API (Google retired the sitemap ping endpoint in 2023) | No, but low risk | URL count |
| `site.content` | `meta.*`, `image.alt`, `schema.jsonld`, `internal_link`, `content.patch` on existing pages | Yes, if the connector supports revert | **Traffic at risk** |
| `site.structural` | `redirect`, `canonical`, `robots.meta`, `robots_txt`, `sitemap`, `hreflang`, `content.new_page`, page removal | Partly | **Traffic at risk** × structural multiplier |
| `settings` | Connections, budgets, site settings | Yes, wide blast radius | – |
| `destructive` | Delete site, purge data, revoke connections | No | – |

**Reach**, the SEO equivalent of Agentic Marketing's audience size, is a structured estimate, not one number. Historical clicks alone undervalue new, seasonal and currently broken pages. The estimate records:

| Component | How |
|---|---|
| Affected URLs | The URLs named, **plus** URLs reached through templates/layouts (from the source mapping), the destinations of changed internal links, and all matched URLs for site-wide files |
| Traffic at risk | GSC page-level clicks **and** impressions over 28 days and over the same period last year (seasonality), from the page aggregate dataset ([data-providers.md](data-providers.md) §5) |
| Critical pages | Key pages from site context (home, pricing, top converters from GA4) count as above any threshold |
| Freshness | When GSC data is older than 4 days, or is missing, reach is **unknown** |

**Unknown reach always requires approval.** It never merely drops one level.

**Cumulative limits.** Limits are counted per change set **and** cumulatively per site per rolling 7 days, across all agents and overlapping change sets. This stops a large migration from being split into small batches. Two open change sets that touch the same URL or source file raise a conflict hold (ported from Agentic Marketing).

**Fixed rules (never autonomous, whatever the mandate says).** These are preserved when an action drops a level: a fixed-rule action can only ever be proposed.

- any `robots_txt` change that disallows more than it allowed before;
- any site-wide indexing change (robots, `noindex`/canonical in a template or layout, sitemap removal), **regardless of current traffic**;
- `noindex` or canonical-away on any page with clicks or impressions in the last 28 days, or on a critical page;
- page removal, or redirects of more than 20 URLs in one change set or cumulatively per week;
- `destructive` and `settings` on connections or budgets; creating or changing mandates and credentials (people-only, as in Agentic Marketing);
- anything on a site whose ownership is not verified.

## 4. Mandates and levels

The levels are those of Agentic Marketing: L0 observe, L1 propose (the default), L2 act with veto (a hold window), L3 act within limits, and L4 run the loop. Workspace ceilings cap all mandates.

**L4 is earned differently for SEO.** In Agentic Marketing, L4 needs 28 quiet days. For SEO it also needs **evaluated** results: at least 28 days at L3, **and** at least 10 change sets of the class with a verdict (verified, plus an outcome that is not refuted), with no guardian episode. Quiet days alone do not count, because SEO harm shows up late.

An example mandate for a "Technical fixer" agent:

```yaml
purpose: Keep site.example.com free of high-severity technical issues.
goals: [{ measure: audit.health_score, target: ">= 90" }, { measure: issues.high_open, target: 0 }]
scope:
  sites: [site_01…]
  changeTypes: [meta.title, meta.description, image.alt, schema.jsonld, internal_link, redirect]
  connectors: [github]
levels:
  research.spend: L3         # within limits below
  crawl: L3
  site.content: L2           # 4 h veto window
  site.structural: L1        # always propose
  index.submit: L3
limits:
  researchSpendPerDay: 2.00 USD
  pagesPerChangeSet: 25
  trafficAtRiskPerChangeSet: 500 clicks/28d
  changeSetsPerWeek: 5
tripwires:
  - verification.failed
  - gsc.clicks_on_changed_urls: "-20% vs control over 7d"
  - audit.new_critical_issue
workingHours: Mon–Fri 08:00–17:00 Europe/Copenhagen
expires: 2027-02-12
```

An action outside its limits drops a level, with the reason, exactly as in Agentic Marketing.

## 5. Specialists (the claude-seo team, in-platform)

A **specialist** is a versioned `skill` artifact. It holds a playbook (Markdown), an allowed tool subset, a default model tier (fast or deep), an output schema and a token budget. It is not a separate service. Hosted runs load specialists as sub-runs; external agents get the same playbooks as plugin skills.

| Specialist | Focus | Main tools | Notes |
|---|---|---|---|
| Technical | crawlability, indexability, status, security | `audits.*`, `checks.*` | Mostly reads deterministic findings and prioritises them |
| Content (E-E-A-T) | quality, intent match, thin/duplicate content, freshness | judged checks, GSC | Deep model |
| Schema | detect, validate, generate JSON-LD | `content.schema.*` | Drafts `schema.jsonld` changes |
| Sitemap and index | sitemaps, IndexNow, GSC coverage | `audits.*`, `search.gsc.inspect` | |
| Performance | CWV (CrUX field data, URL or origin), Lighthouse lab opportunities | CrUX, PSI | |
| Visual and mobile | rendering diffs, screenshots | renderer | Needs a renderer |
| GEO | AI crawler access, llms.txt, citability, AI visibility | `tracking.aiVisibility.*` | Deep model |
| Agent readiness | accessibility tree, Markdown alternates, WebMCP | renderer | |
| Local | GBP, NAP, reviews, geo-grid | `tracking.local.*` | Only for local businesses |
| Backlinks | profile, gaps, prospects | `research.backlinks.*` | Proposes prospects only; outreach is out of scope (hand off to Agentic Marketing) |
| Keywords and clusters | research, clustering, content architecture | `research.*` | |
| SXO | page type vs SERP intent, personas | SERP + judged checks | Deep model |
| International | hreflang | `audits.*` | |
| E-commerce | product schema, facets, marketplaces | `audits.*`, `research.serp` | |
| Drift | baselines, regressions | `audits.drift` | Feeds the guardian |
| Search data analyst | GSC and GA4 diagnosis, anomalies | `search.*` | |
| Strategist (orchestrator) | business-type detection, fan-out, synthesis, plan | everything read-only | Writes recommendations |

**Full audit run.** The strategist detects the business type, then fans out the relevant specialists in parallel. Fan-out is bounded per workspace, with each specialist under its own budget. The strategist collects their structured outputs and synthesises them into recommendations. The synthesis follows claude-seo's PERCEIVE → ANALYZE → VALIDATE → ACT method, made structural: a recommendation without evidence ids, a hypothesis, a falsification check and a leading indicator fails output validation and is retried, then dropped with a reason.

## 6. Opportunity detectors (deterministic, before the LLM)

These are scheduled jobs over search facts and research data. They create **opportunities** that agents then turn into recommendations:

| Detector | Signal |
|---|---|
| Striking distance | Queries at average positions 8–20 with impressions above a threshold, per page |
| CTR gap | CTR well below the expected CTR for the position (a site-specific curve fitted from its own GSC data) |
| Decay | Pages whose clicks fell >30% over 8 weeks against their own trend, not seasonal |
| Cannibalisation | Several pages from the site alternating for one query |
| Content gap | Keywords where two or more competitors rank in the top 10 and the site does not (domain intersection) |
| Lost top-10 | Tracker keywords leaving the top 10 |
| AI citation gap | Prompts where competitors are cited and the site is not |
| Index gaps | Valuable pages "crawled, not indexed" (URL inspection) |
| Local gaps | Geo-grid cells where the business is outside the pack |

## 7. Programmes (hosted-agent templates)

A programme is a mandate template, a hosted-agent template and its skills. It ships as data, not as hard-coded features (as Agentic Marketing's programmes):

| Programme | Loop | Default levels |
|---|---|---|
| **Technical guardian** | Daily drift crawl → detect regression → open issue → propose fix → (L2+) apply → verify | crawl L3, site.* L1 |
| **Weekly audit and fix** | Weekly audit → top-N recommendations → change sets for safe types → verify → report | site.content L1→L2 when trusted |
| **Striking-distance optimiser** | Opportunities → title/description/internal-link changes → measure CTR and position against a control | site.content L1 |
| **Content refresher** | Decaying pages → refresh brief → content.patch draft or hand-off to Agentic Marketing | L1 |
| **Rank watch and diagnose** | `rank.lost_top10` → SERP diff, competitor change, own page drift → explanation → recommendation | research.spend L3 |
| **AI visibility monitor** | Scheduled AI visibility runs → citation gaps → GEO recommendations (llms.txt, answer-first passages, schema) | L1 |
| **Local keeper** | Geo-grid, reviews, GBP updates → local recommendations | L1 |
| **Reporter** | Weekly or monthly report from the report template → save → optional share link | report.share L1 |

## 8. Guardian: SEO tripwires

The guardian is ported. It watches its tripwires and **caps, holds, pauses or rolls back**:

- verification of an applied change set failed;
- a `drift.detected` on a changed URL that the change did not intend;
- a new `critical` issue after an apply (for example, a site-wide noindex, robots disallow-all or 5xx spike);
- GSC clicks or impressions on changed URLs fall beyond the threshold against the control group (checked daily, considering GSC data latency);
- tracker positions on targeted keywords fall by more than N positions;
- spend anomaly: a run spends more than 3× its trailing median.

The first three are evaluated within minutes, because they are crawl-based. The traffic-based ones need days, and the UI says so.

**What the guardian does depends on the evidence:**

| Tripwire | Action |
|---|---|
| Directly verified technical failure (verification failed, unintended noindex, robots block, 5xx) | **Automatic rollback** when the mandate allows it and the connector's revert is safe (§10), then pause the agent's class |
| Traffic or rank anomaly | **Pause and ask a person**. It never auto-reverts, because traffic signals are noisy and confounded (algorithm updates, seasonality) |
| Spend anomaly | Cap the agent's `research.spend` and notify the sponsor |

## 10. Outcome measurement (honest causal claims)

A recommendation's outcome is a claim about cause, so the method is fixed before the change is applied:

1. **Cohorts before apply.** Treated URLs and queries are recorded. Where possible, the control cohort is drawn from comparable pages (same template cluster, similar traffic band), and with a pilot's agreement the treated set is randomly split so half is held back. Otherwise the outcome is "observational", and the UI says so.
2. **Pre-trend check.** The treated and control cohorts must have tracked each other over the 8 weeks before. If they did not, the outcome is "inconclusive: no valid control".
3. **The clock starts at deployment plus re-crawl evidence:** the deployed commit is live, and URL inspection or a recrawl shows the new version. It does not start at apply.
4. **Minimum observations.** There is a minimum of impressions per cohort and a fixed window (28 days by default). Below the minimum the verdict is **inconclusive**, which is a first-class result: many small sites will never support a verdict, and the UI says that plainly.
5. **Contamination.** Another change set touching the treated or control URLs, or a confirmed Google update in the window, marks the outcome "confounded" with the reason.
6. **Verdicts:** confirmed, refuted, inconclusive, confounded. Only confirmed and refuted outcomes become learnings.

A rollback is safe only if the connector can check that the source is unchanged since the apply (for GitHub: the files still match the merge commit's version). Otherwise the rollback is itself proposed as a new change set, so it never overwrites later work.

## 9. In-app copilot

As in Agentic Marketing, the copilot is an in-process MCP client. By default it acts **as the signed-in person**, with their permissions. It can also act **as a named agent** under that agent's mandate, as in the sister product, and the UI always shows which. It streams its answers and keeps its conversations. It sees the site context, and it uses the same tools and the same cost estimates as any external agent. OpenSEO's SAM rules carry over:

- never state a metric that did not come from a tool;
- check the research log before paid calls;
- keep the site context current through `sites.context.update`, which creates a draft;
- answer product questions from docs, never invent them.
