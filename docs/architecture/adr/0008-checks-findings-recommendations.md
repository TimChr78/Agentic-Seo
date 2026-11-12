# ADR-0008: Checks are code; recommendations are reasoned and falsifiable

- Status: Proposed
- Date: 2026-11-12

## Context
claude-seo's checks are prompts and Python scripts run by an LLM, which gives broad but non-repeatable results. OpenSEO's audit has a small set of deterministic issue types. People need repeatable, explainable results, and agents need structured evidence to reason on.

## Decision
- **Checks** are `defineCheck` code with fixtures, ids, severities and references. A check is either `deterministic` or `judged`. Judged checks (LLM) run on samples with budgets, fixed output schemas and logged rationale, and they are never critical alone.
- **Findings** are evidence. **Issues** are long-lived groups of findings that people triage.
- **Recommendations** are artifacts that must cite evidence ids and include a hypothesis, expected impact, effort, dependencies, a verification plan, a falsification check and a leading indicator. Output validation enforces this.
- **Freshness rules** (deprecations, Google changes) are data with review dates.

## Alternatives
- LLM-only audits: not repeatable, costly, hard to diff over time.
- Deterministic-only: misses E-E-A-T, intent and citability.

## Consequences
The check catalogue is a large, testable body of code (≈120 checks in wave 1). Drift and verification reuse the same checks. A recommendation is comparable with its outcome, which makes learnings possible.
