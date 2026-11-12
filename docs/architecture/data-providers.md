# Data providers and the provider gateway

> Status: design (2026-11-12). Pricing figures change often; verify them when each adapter is built.

## 1. Principle

Only the `providers` package talks to paid or rate-limited external APIs. Features ask for data through **typed ports**, never through a vendor SDK. The gateway owns:

1. **Estimate.** A cost estimate before the call, from the request shape (rows, tasks, depth). Paid MCP tools return the estimate in their description and in a dry-run mode (`estimate: true`), so an agent can see the price before it spends.
2. **Budget and hold.** An atomic credit hold against the workspace's monthly budget for that provider, and against the agent's mandate limit for `research.spend` when an agent is the caller. This follows OpenSEO's metering lesson: hold first, then settle to the actual cost the provider returned.
3. **Cache.** Responses are keyed by workspace, provider, credential or property (for Google data), normalised request, market and request options, with a TTL per endpoint. Public market data can optionally be shared across a workspace's sites; Google data never crosses its property. A cache hit is free, and the UI shows "From cache, fetched 3 days ago · Refresh (≈ $0.02)".
4. **Rate limits and retries.** A token bucket per provider and per credential, stored in Postgres. Retries use backoff and only for idempotent reads.
5. **Metering.** Every call is recorded with cost, caller (person, agent, hosted run, schedule), purpose, site and cache status. This feeds Settings → Usage and the agent reports.
6. **Durable call lifecycle.** A provider call can be charged even when our side times out, so every call is a persisted record: request identity (an idempotency key), reservation, the provider task id, and the state `pending → submitted → settled | failed | unknown`. An `unknown` call is reconciled (DataForSEO task status, the provider's usage API) **before** any retry. Abandoned holds expire through a reconciler. Batched calls (a tracker run sharing one task) split their actual cost by a recorded rule.
7. **A maximum authorised cost.** Each call carries a ceiling: the estimate plus a margin, set by the caller or the mandate. A call whose cost cannot be bounded is refused. Estimates are a guide; the ceiling is the control.
8. **Normalisation.** Vendor responses are mapped to our own types, and the raw response is kept for 7 days for debugging.

Self-hosters pay the providers directly. There is no billing system and no mark-up, only budgets. A hosted SaaS is out of scope for wave 1 (see [open-questions.md](open-questions.md)).

## 2. Ports

| Port | Operations |
|---|---|
| `KeywordData` | metrics (volume, CPC, difficulty, intent, 12-month trend), suggestions, ideas/related, keywords for a domain or URL |
| `SerpData` | organic SERP (with features, AI Overview and its citations), locations search, SERP competitors |
| `DomainData` | overview (traffic, keyword counts), ranked keywords, top pages, competitors, domain intersection (gap) |
| `BacklinkData` | summary, referring domains, backlinks, anchors, new and lost, intersections for link prospecting |
| `LocalData` | business search, business profile, reviews, updates/posts, Q&A, categories, local SERP, geo-grid |
| `AnswerEngines` | ask a prompt of an LLM answer engine and return the answer, cited sources and model id |
| `SearchConsole` | sites, search analytics (query, page, country, device, date), URL inspection, sitemaps |
| `Analytics` | GA4 properties and the organic reports (page performance, landing pages, acquisition, key events, e-commerce, site search, audience, measurement health); Matomo as an alternative |
| `PageExperience` | PSI (Lighthouse + field data), CrUX, CrUX History |
| `IndexSubmit` | IndexNow, Bing URL submission, GSC sitemap submission (the Sitemaps API, not the retired ping). The Google Indexing API is supported only for eligible page types (job postings and livestream videos) |
| `WebmasterData` | Bing Webmaster (queries, backlinks, crawl issues) |

## 3. Adapters

| Adapter | Ports | Cost | Wave 1 |
|---|---|---|---|
| **DataForSEO** (Labs, SERP, Keywords Data, Backlinks, Business Data, AI Optimization) | Keyword, Serp, Domain, Backlink, Local, AnswerEngines (LLM responses / AI mentions) | Pay as you go; the user's own key | Yes, the primary market-data source (as in OpenSEO) |
| **Google Search Console** | SearchConsole | Free, OAuth | Yes |
| **Google Analytics 4** (Data API, Admin API) | Analytics | Free, OAuth | Yes |
| **PageSpeed Insights, CrUX, CrUX History** | PageExperience | Free, API key | Yes |
| **IndexNow** | IndexSubmit | Free | Yes |
| **Bing Webmaster Tools** | WebmasterData, IndexSubmit | Free, API key | Yes |
| **Common Crawl web graph** | BacklinkData (**domain-level** linking hosts and ranks only: no individual backlinks, anchors or new/lost links) | Free; a periodic import of the host-graph ranks | Yes, the free fallback (as claude-seo); the UI labels its limits |
| **LLM answer engines, direct** (OpenAI, Anthropic, Google Gemini, Perplexity, all with web search) | AnswerEngines | The user's LLM keys, through the LLM gateway | Yes |
| **Moz Links API** | BacklinkData | Free tier, then paid | Yes (Phase 5, free tier) |
| **DataForSEO Merchant / Google Shopping, Amazon** | MarketplaceData (e-commerce keyword and listing gaps, as claude-seo e-commerce) | Pay as you go | Later |
| **Google Places / Business Profile API** | LocalData (own listing) | Free with quota, OAuth | Later |
| **Keywords Everywhere, Google Ads Keyword Planner** | KeywordData | Cheap / free with an Ads account | Later |
| **Matomo** | Analytics | Self-hosted | Later |

**Routing.** Each port has an ordered list of adapters per workspace, with a "cheapest that can answer" default and an explicit override, as in OpenSEO's keyword data-source routing. When no adapter is configured, the UI and tools say which key unlocks the feature and link to setup. They never fake data.

**One accounting owner.** Direct answer-engine calls run through the LLM gateway (which owns tokens and model budgets), but the provider gateway owns the AI visibility *run*: it reserves the run's total ceiling and settles from the LLM gateway's metered token cost. Each cost is counted once.

**Keyword routing** follows OpenSEO's spec 0004. DataForSEO Labs and Keywords Data (Google Ads volumes) differ by country coverage and cost, and difficulty and intent can be null. Routing is per market, the clickstream-based option is an explicit, priced choice, and nulls are shown as "Not available", never as zero.

**AI visibility has two sources.** DataForSEO's LLM endpoints are cheap and need no LLM keys. Direct engine APIs with web search let you choose the engine and keep the raw answer. Neither equals what a signed-in consumer sees in ChatGPT or Gemini. The UI states this on every AI visibility view. (This is an open question to validate in spike 5.)

## 4. Cost controls in the product

- **Budgets** per provider per workspace per month, with alerts at 50%, 80% and 100%. At 100%, paid calls are refused with a clear error naming the budget and who can raise it.
- **Estimates in the UI:** every paid action shows its estimate on the button or in a confirm step ("Run research · ≈ $0.04").
- **Recurring spend:** trackers show their monthly cost before they are saved (OpenSEO's `estimate_rank_tracker_cost`). Saving one is a `research.spend` commitment under the policy engine.
- **Agent limits:** a mandate's `research.spend` limit per day and per run; hosted runs also have token and tool-call budgets.
- **Research log:** before spending, agents check `site-context://<site>` for the same question answered in the last 30 days. This is OpenSEO SAM's rule, enforced as a soft check: the tool returns `recentlyAnswered` with a link.

## 5. Google connections

There is one OAuth client per installation (the self-hoster creates it, guided by `aseo doctor` and the setup docs), with scopes for `webmasters.readonly`, `analytics.readonly` and, later, `indexing` where allowed. Tokens are encrypted, refreshed by the worker and revocable per site. The worker syncs GSC daily into **three datasets**: property totals, page aggregates and query detail (see [domain-model.md](domain-model.md) §3). Summed detail rows never equal totals, because Google anonymises rare queries and does not guarantee all rows. Each dataset keeps a finality watermark: data newer than about 3 days is provisional and is re-fetched until final, and a first sync backfills 16 months. The UI shows a coverage indicator on query-level views ("Query rows cover 71% of clicks"). Traffic at risk uses page aggregates. Opportunity detectors run on these datasets ([agents-and-autonomy.md](agents-and-autonomy.md) §6).
