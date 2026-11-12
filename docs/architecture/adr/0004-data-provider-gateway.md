# ADR-0004: A provider gateway for every paid or rate-limited external call

- Status: Proposed
- Date: 2026-11-12

## Context
SEO data costs money per call, and agents can call tools in loops. OpenSEO learned that letting feature code call DataForSEO helpers directly leads to skipped metering and estimate-vs-actual drift.

## Decision
All external data access goes through `providers`. It exposes typed ports (KeywordData, SerpData, DomainData, BacklinkData, LocalData, AnswerEngines, SearchConsole, Analytics, PageExperience, IndexSubmit, WebmasterData), backed by adapters. The gateway alone does estimates, atomic credit holds against budgets and mandate limits, caching, rate limiting, retries, normalisation and metering. A lint rule forbids importing adapter modules outside `providers`.

## Alternatives
- Per-feature clients: drift and missed metering.
- A generic HTTP proxy: no typed estimates or normalisation.

## Consequences
Adding a vendor means writing an adapter against a port. Every paid command can offer `estimate: true`. The `research.spend` action class gets real numbers for the policy engine.
