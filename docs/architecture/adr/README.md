# Architecture Decision Records

| # | Decision | Status |
|---|---|---|
| [0001](0001-sister-product-reuse.md) | A sister product that reuses Agentic Marketing's foundations; match OpenSEO's features without forking it | Proposed |
| [0002](0002-modular-monolith.md) | TypeScript modular monolith, one image, role-based processes | Proposed |
| [0003](0003-storage.md) | Postgres as the only required database; object storage for blobs | Proposed |
| [0004](0004-data-provider-gateway.md) | A provider gateway for every paid or rate-limited external call | Proposed |
| [0005](0005-rendering.md) | Own HTTP crawler; rendering through a pluggable sidecar; PSI for Lighthouse | Proposed (spike 2 decides the default) |
| [0006](0006-agent-autonomy-for-seo.md) | Agentic Marketing's autonomy model with SEO action classes and traffic at risk | Proposed |
| [0007](0007-change-sets-and-site-connectors.md) | Site changes as versioned change sets through connectors, verified and reversible | Proposed (spike 4 validates) |
| [0008](0008-checks-findings-recommendations.md) | Checks are code; recommendations are reasoned and must be falsifiable | Proposed |

Format: context, decision, alternatives, consequences. A later ADR can overturn an earlier one; ADRs keep their original text.
