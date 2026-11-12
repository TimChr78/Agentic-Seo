# ADR-0006: Agentic Marketing's autonomy model, re-cut for SEO

- Status: Proposed
- Date: 2026-11-12

## Context
Agentic Marketing enforces agent borders in the command layer: agents as principals, mandates with levels L0–L4, action classes, impact estimates, holds, a guardian, shadow mode and undo. SEO actions have different consequences: a wrong robots.txt can de-index a site, and harm shows up in traffic days later.

## Decision
Port the model unchanged and define SEO action classes:

- `read`, `research.spend`, `crawl`, `draft`, `report.share`, `index.submit`;
- `site.content`, `site.structural`;
- `settings`, `destructive`.

The impact estimate for site changes is **traffic at risk**: GSC clicks over 28 days on the affected URLs, where "unknown" counts as above any threshold. Fixed rules forbid autonomous robots.txt tightening, noindex or canonical-away on pages with traffic, mass redirects and page removal. The guardian gets SEO tripwires: failed verification, unintended drift, new critical issues, traffic or rank drops against a control group, and spend anomalies. It can roll back reversible change sets.

## Alternatives
- Approval-only (OpenSEO-style tools plus a human): safe, but not agentic.
- Autonomy decided in prompts or skills (claude-seo-style): not enforceable.

## Review update (2026-11-12, external review)
Traffic at risk alone is not a safe boundary. The impact estimate is a structured **reach**: affected URLs including template and link reach, clicks and impressions (with last year's season), critical pages and data freshness. Unknown reach always needs approval. Limits are also cumulative per site across agents, and the fixed rules survive a level drop. The guardian auto-reverts only directly verified technical failures; traffic anomalies pause the agent and ask a person. L4 needs evaluated change sets, not just quiet days. See agents-and-autonomy.md §3, §4, §9 and §10.

## Consequences
Every command needs an action class from Phase 0. Traffic-based tripwires are slow (GSC latency of 2–3 days), so fast crawl-based tripwires and L2 veto windows carry the early safety.
