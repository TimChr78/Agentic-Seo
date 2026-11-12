# ADR-0007: Site changes as versioned change sets through connectors

- Status: Proposed. Spike 4 validates the GitHub connector.
- Date: 2026-11-12

## Context
Closing the loop means changing the site. Sites live in many places (a static-site repository, WordPress, Shopify, a custom CMS), and changes must be reviewable, verifiable and reversible.

## Decision
A **change set** is a versioned artifact holding typed **changes** (`meta.title`, `meta.description`, `canonical`, `robots.meta`, `redirect`, `robots_txt`, `sitemap`, `schema.jsonld`, `hreflang`, `image.alt`, `internal_link`, `content.patch`, `content.new_page`, `llms_txt`), each defined by a JSON Schema. **Connectors** declare which change types they support, how to preview, apply and revert them, and whether a revert is exact. The order of connectors is:
1. **GitHub pull request**: a URL→source mapping per framework; the PR is the review surface, and a merge is the apply.
2. **WordPress**: REST API, plus Yoast and Rank Math meta.
3. **Shopify**: Admin API. *(Deferred: WordPress is the only CMS connector for now; owner decision 2026-11-12.)*
4. **Manual/export**: instructions and patch files for anything else.

After apply, a **verification** job re-fetches the affected URLs and re-runs the relevant checks. Outcomes are measured later against a control group.

## Alternatives
- Recommendations only: leaves the loop to people (OpenSEO, claude-seo).
- Edge-injected changes (Cloudflare Workers): powerful, but it hides changes from the site's source of truth. Later, as a connector.

## Review update (2026-11-12, external review)
- **Merge is not deployment.** The PR states are PR open → merged → deploying → deployed (read from the deploy provider: GitHub deployments/checks, Cloudflare Pages, Netlify, Vercel). Verification runs against the **deployed commit**, never the merge.
- **Source mapping starts explicit.** For the pilot, a person configures the mapping (route patterns → content files, layout files → affected templates) in the site's connector settings. Each change records the source paths, base commit, affected routes (including every route rendered by a changed layout) and a mapping confidence. Framework auto-detection comes later.
- **Stale approvals.** Any commit pushed to the PR after approval sends the change set back to review.
- **Safe rollback.** A revert is applied automatically only if the touched files still match the merged version; otherwise the revert becomes a new proposed change set.

## Consequences
URL→source mapping for static sites is the hardest part and needs per-framework adapters. With a PR connector the apply happens when a person merges, so with GitHub, L2/L3 can also mean "auto-merge when checks pass" if the repository allows it.
