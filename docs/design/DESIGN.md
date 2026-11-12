# Admin UI design

> Status: design (2026-11-12). **Agentic SEO inherits Agentic Marketing's design system as a binding contract:** [DESIGN.md v2 (final)](https://github.com/TimChr78/Agentic-Marketing/blob/main/docs/design/DESIGN.md) and its microcopy, motion, skeletons-and-budgets contracts and the showcase `tokens.json`. Colour tokens, typography, spacing, radii, elevation, the data-visualisation palette and chart contract, the KPI tile, page templates, components, themes and accessibility rules all apply **as written there**. This page adds only what is specific to SEO: navigation, screens and new components. Any deviation needs a decision record here.

## 1. Direction

Calm, precise **search operations**, informed by Linear, Stripe Dashboard and Google Search Console's clarity rather than the dense, feature-packed suites of Semrush or Ahrefs. The style is the same as the sister product:

- warm stone neutrals, teal data marks, blue as the only interaction accent;
- system fonts and Lucide icons;
- no gradients, glass, mascots or AI sparkles;
- agent identity shown as a bot icon plus "Agent", never as a colour or a status.

**State and consequence first**, applied to SEO:

- what is broken or at risk, and how much traffic it touches;
- what the agent proposes and what it would change;
- the next step;
- then the data.

Every metric names its period, its denominator, its source (GSC, DataForSEO, crawl) and its freshness. "No data" never means healthy. A health score names what was not evaluated.

## 2. Product mark

There is a sister mark in the same construction as Agentic Marketing's (`packages/core/src/brand.ts`). It shares the grid and stroke, with a distinct glyph: a magnifier formed by the same arc. The wordmark is "Agentic SEO". The mark is generated, never redrawn per surface. *(The asset is to be designed in Phase 0.)*

## 3. Navigation

Shell geometry as Agentic Marketing: sidebar 232/64, top bar 56, and one menu trigger below 1024. The **site switcher** takes the place of the brand switcher: logo/favicon, site name and primary domain, with a "New site" action.

| Group | Entries | Notes |
|---|---|---|
| **Work** | Home, Inbox, Agents | Inbox = approvals, holds with veto windows, recommendations awaiting a decision |
| **Site health** | Audits, Issues, Performance, Changes | Changes = change sets and their verification and outcomes |
| **Search** | Search performance, Opportunities, Rankings, AI visibility, Local | Local hidden unless the site is a local business |
| **Research** | Keywords, Competitors, SERP explorer, Backlinks | Research works for any domain, not only the current site |
| **Content** | Briefs, Clusters, Reports | |
| **Settings** | One entry; secondary nav: Site, Connections, Providers and budgets, Crawler access, Users and roles, API tokens, Approval policy and agent autonomy, Usage | |

Role gates follow the sister product. Paid actions are hidden for roles without `research:spend` and shown disabled with the reason when helpful ("Only editors can run paid research").

## 4. Key screens

Wireframes show structure only. The geometry comes from the inherited page templates (List, Detail, Settings, Editor).

### 4.1 Home (site overview)

```
┌ Home · example.com ─────────────────────────────────────────────── [Run audit] ┐
│ Consequence summary (surface-2):                                                │
│  3 high issues touch 1,240 clicks/28d · 2 changes in review · 1 agent held      │
│  Next: review "Fix canonical on /pricing" (Inbox)                               │
├──────────────┬──────────────┬──────────────┬──────────────┐                     │
│ Health score │ Clicks       │ Avg position │ AI citations │  KPI tiles          │
│ 82 /100      │ 18,402       │ 14.2         │ 31 of 120    │  (period, delta,    │
│ ↑ 4 pts      │ ↑ 6.1% more  │ ↑ 0.8 better │ prompts      │   source, freshness)│
│ 9,812 pages  │ GSC · 28 d   │ GSC · 28 d   │ 3 engines    │                     │
│ Perf. not    │ Updated 2 d  │              │ Updated 1 d  │                     │
│ evaluated    │ ago          │              │ ago          │                     │
├──────────────┴──────────────┴──────────────┴──────────────┘                     │
│ "How many clicks did organic search bring?"   line chart, previous period dashed│
│   annotations: change sets applied ▲, Google updates ◆                          │
├─────────────────────────────────────────┬───────────────────────────────────────┤
│ Top recommendations (impact × confidence)│ What agents did this week            │
│  1 Rewrite titles on 12 striking-distance│  Technical guardian · 2 issues fixed │
│    pages · ≈ +300 clicks/28d · Proposed  │  Striking-distance optimiser · held  │
│  2 Add Product schema to 48 pages · …    │  [Open Agents]                       │
├─────────────────────────────────────────┴───────────────────────────────────────┤
│ Setup checklist (until done): Verify site · Connect GSC · Add competitors ·     │
│ Run first audit · Add DataForSEO key (optional) · Connect a site connector      │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Issues (list) and issue detail

List template: search, a category select, severity and state filters, and an honest count. The columns are:

- **Issue** (plain-language name, with the check id in technical details);
- **Severity** (pill);
- **Pages** (affected / evaluated);
- **Traffic touched** (clicks over 28 days, or "No GSC");
- **First seen**;
- **State** (Open / Regressed / Resolved / Ignored).

Issue detail (Detail template):

- **Consequence summary:** "Canonical points to a redirect on 37 pages · 1,240 clicks/28d · since audit 14 Oct".
- **Tabs:** Pages (affected URLs, with evidence: value vs expected), Explanation (why it matters, references, freshness date), History (score over audits), Activity.
- **Primary action:** **Create recommendation**, or **Open recommendation** if one exists. A secondary action, Ignore (with a required reason), is available too.

### 4.3 Recommendation detail (the heart of the product)

```
┌ Rewrite titles on 12 striking-distance pages        In review · Agent ┐
│ Recommendation · v2 · Technical fixer (Agent, sponsor: Tim) · 2 h ago  │
├ Consequence summary ──────────────────────────────────────────────────┤
│ Touches 12 pages · 860 clicks/28d at risk · reversible (GitHub PR)    │
│ Expected: CTR +10–20% on 34 queries · measured over 28 d vs 12 control│
│ Next: approve to open the pull request                                │
├ Tabs: Proposal │ Evidence │ Change set │ Verification plan │ Activity ┤
│ Proposal: hypothesis · why now · dependencies (after "Fix duplicate   │
│   titles") · effort S                                                  │
│ Evidence: GSC queries table (position 8–20, impressions), SERP titles │
│ Change set: per-URL diff  before → after (title, pixel width meter)   │
│ Verification plan: re-crawl these 12 URLs after merge; falsified if   │
│   CTR on target queries is not ≥ control + 5% after 28 d; leading      │
│   indicator: impressions-weighted CTR, daily                           │
├ Sticky bar ───────────────────────────────────────────────────────────┤
│ Policy: needs approval (site.content at L1)    [Reject] [Approve]     │
└───────────────────────────────────────────────────────────────────────┘
```

The approval drawer from the sister product shows the same tabs, so reviewers and builders see the same thing.

### 4.4 Change set detail

- **Pipeline strip:** Draft → In review / Held (veto window countdown) → Applying → Applied → Verified / Verification failed → Measuring → Outcome. Each step has a timestamp and an actor.
- **Diff per URL:**
  - text changes use the inherited DiffView;
  - JSON-LD gets a JSON diff plus a "Valid for rich results" check;
  - robots.txt gets a line diff plus the "URLs newly blocked: N" consequence;
  - redirects get a from/to table with chain detection.
- **Connector panel:** "GitHub · TimChr78/martechsignal · PR #42 · Preview deploy verified".
- **Actions:** Approve, Veto (during the hold), Roll back (when applied and the connector supports revert), Retry verification.

### 4.5 Audit detail

- **Header:** progress while running ("Crawling · 3,120 of ≈ 9,800 pages · 41 pages/s"; a static progress icon, no spinner or fake percentage).
- **Final state:** Completed, Partial (with reason) or Failed (with reason).
- **Tabs:** Overview (score by category, with "Not evaluated" rows), Issues, Pages, Performance (CWV per template from CrUX, with thresholds), Structure (depth distribution, orphan pages, internal-link hubs), Drift (vs baseline), Settings (scope, limits, render mode, crawler access used).

### 4.6 Research screens

- **Keywords:** a seed input, market select, a source/cost hint ("≈ $0.03 · DataForSEO · cached results are free"), and results in a table: keyword, volume, KD, CPC, intent, trend sparkline, SERP features. Bulk actions: Save to list, Cluster, Track.
- **SERP explorer:** a SERP snapshot as a list that mirrors the result page (position, title, URL, features), the AI Overview with its cited sources, and a "Compare with <date>" diff.
- **Competitors:** a domain gap table and a Venn summary (as a table plus bars; no decorative Venn).
- **Backlinks:** KPI tiles (referring domains, new and lost over 30 d), a table, and source labels per row (DataForSEO / Common Crawl / Bing).

### 4.7 Rankings and AI visibility

- **Rankings:** tracker list with the monthly cost on each tracker. The detail shows position distribution bars (top 3 / 4–10 / 11–20 / 21–100 / not ranking) per date, and a keyword table with sparkline (the y-axis inverted and labelled "Position, lower is better"). Local grids render as a map-free grid of numbered cells using the sequential ramp, with numbers in cells.
- **AI visibility:**
  - share of voice per engine as small multiples;
  - prompt table: mentioned / cited / position / sentiment;
  - answer detail with highlighted mentions and the cited sources list.

  A persistent note on every view: "Answers come from engine APIs and can differ from what signed-in users see."

### 4.8 Agents

As in the sister product: list, mandates, holds, activity ledger, reports, shadow report, kill switch. SEO additions:

- **traffic at risk** on every ledger entry for site changes;
- **outcomes** (confirmed / refuted / pending) per agent;
- **programme templates** in the create gallery.

## 5. New components

All live in `apps/web/src/ui/` (or a `seo/` sub-folder) and are the only way to build their pattern.

| Component | Contract |
|---|---|
| **SeverityPill** | Critical → bad/octagon; High → bad/triangle; Medium → warn/circle; Low → neutral/dot; Info → info/i. Text always shown; 20 px; non-interactive |
| **IssueStatePill** | Open → warn; Regressed → bad/arrow-up; Resolved → good/check; Ignored → neutral/eye-off; Not evaluated → neutral/dash |
| **ChangeStatePill** | Draft, In review, Held, Applying, Applied, Verified, Verification failed, Rolled back, Measuring, Confirmed, Refuted (tones as the sister product's mapping rules) |
| **HealthScore** | A KPI tile variant: value /100; a category breakdown with bars; "Not evaluated" rows listed explicitly; never a gauge or ring |
| **TrafficAtRisk** | Inline "860 clicks/28d" with source and freshness; "Unknown" in warn tone when GSC is missing |
| **CostHint** | Estimate + provider + cache state; on paid buttons "Run research · ≈ $0.04"; on cache "Cached 3 d ago · Refresh ≈ $0.02" |
| **SerpResult** | A result row as it appears in search: favicon, site, URL breadcrumb, title (with pixel truncation), description; used in SERP explorer and title-change previews |
| **TitlePreview** | A desktop and mobile SERP snippet preview with a pixel-width meter (580 px desktop), before/after |
| **PositionSparkline** | An inverted y-axis sparkline, 96×32, with an accessible summary "Position 14 → 9 over 28 days" |
| **UrlCell** | Path-first display (`/pricing`), host shown when it differs from the site; middle truncation; full URL in tooltip and copy |
| **EvidenceList** | Finding evidence: subject, value, expected, source (crawl date / GSC / provider), link to the snapshot |
| **PipelineStrip** | Horizontal steps with state, timestamp and actor; vertical below 768 |
| **Annotations** | Chart markers for change sets and Google updates, listed in the chart's data table too |

## 6. Copy specific to SEO

- Use "page", not "URL", in prose. Show the URL in cells. Write "search engines", not "Google", unless the data comes from Google.
- Name the source with every number: "Clicks (Search Console)", "Volume (DataForSEO, monthly average)".
- Estimated numbers say so: "≈ 1,200 visits/month (estimated)".
- Never say "Rank #1 guaranteed", "boost", "skyrocket" or "SEO juice". Recommendations state hypotheses, not promises: "Expected", "We will know this failed if…".
- AI-assessed findings carry "Assessed by AI" and the model name in technical details.

## 7. Showcase and verification

Phase 0 ports the sister product's showcase (`docs/design/showcase/`) and `verify_palette.py` unchanged, then adds the SEO components above to it. The visual-regression and axe suites cover every route in both themes from the first screen.
