# ADR-0001: A sister product that reuses Agentic Marketing's foundations

- Status: Proposed
- Date: 2026-11-12

## Context
Agentic SEO is the sister product of Agentic Marketing, which already has a working command registry (REST + MCP + UI), auth with MCP OAuth, agents as principals, mandates, a policy engine, versioned artifacts, secrets, telemetry, a design system and a release pipeline. The functional target is OpenSEO, an MIT-licensed, Cloudflare Workers-first app built on TanStack Start, D1/Postgres, Durable Objects and Workflows.

## Decision
Build a new codebase that **ports Agentic Marketing's foundation packages and conventions**. Match OpenSEO's **features**, not its code, and re-implement claude-seo's checks in TypeScript, with credit to both projects in the README.

## Alternatives
- **Fork OpenSEO** and add autonomy. Its runtime model (Workers, D1, Durable Objects) and conventions differ from the sister product, so we would maintain two architectures and two design systems. Autonomy would also have to be retrofitted into a codebase that has no command-layer policy hook.
- **Build SEO into Agentic Marketing.** One product would grow too large; the release cadence, data model and buyers differ.
- **Start from scratch.** This would throw away tested foundations.

## Consequences
Phase 0 is mostly porting. Drift between the two copies of shared packages is a risk (open question 1); each port records its source commit, so fixes can flow both ways.
