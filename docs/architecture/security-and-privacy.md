# Security and privacy

> Status: design (2026-11-12). Agentic Marketing's model (RLS per workspace, envelope-encrypted secrets, hash-chained audit log, OAuth 2.1 for MCP, roles ∩ scopes) is ported unchanged. This page covers what is new for SEO.

## 1. Fetching arbitrary URLs (SSRF)

The crawler, the renderer, the IndexNow key check and the connectors all fetch URLs that people or agents supply. All of them go through the `fetch` package:

- **DNS-pinned connections.** Resolve the name, check **every** address, connect to the checked address, and re-check on every redirect hop (max 10).
- **Blocked by default:**
  - loopback, link-local and the cloud metadata addresses (`169.254.169.254`, `fd00:ec2::254`);
  - RFC 1918 and unique-local ranges, CGNAT, multicast;
  - IPv4-mapped IPv6;
  - `0.0.0.0/8`;
  - non-HTTP(S) schemes;
  - ports other than 80 and 443, unless allowed for the site.
- **Private targets** (a homelab site, a staging host on the LAN) need an explicit per-site allow-list entry, made by an admin. It is a `settings` action, never autonomous.
- **Limits:** response size (HTML 10 MB, other 2 MB), time (connect 10 s, total 30 s), decompression-bomb guard, content-type sniffing.
- **The renderer has its own egress contract**, because a browser makes its own requests: subresources, redirects, WebSockets, service workers and DNS. Every renderer adapter must route **all** browser traffic through an egress proxy that applies the same checks as `fetch` (the `builtin` renderer starts Chromium with `--proxy-server` pointing at an SSRF-guarding proxy in the app, and has no other network route in Compose or Helm). For `crawl4ai` and `browserless`, which we do not control, the adapter is allowed only for **public** targets, and the admin must confirm that the external service enforces egress rules. Without that confirmation, private-target exceptions are disabled for those adapters. The renderer never receives crawler-access credentials for other hosts and has no route to the app database.
- **Other fetch paths** go through the same guard or are disabled: JSON-LD remote `@context` loading (disabled; bundled contexts), sitemap index children, hreflang targets, IndexNow key files and connector webhooks.
- A regression suite of SSRF payloads runs in CI: redirect to metadata, DNS rebinding, decimal/octal IPs, IPv6 tricks, **malicious subresources and WebSockets in rendered pages**, and credential leaks on cross-host redirects.

## 2. Being a polite crawler

- An honest user agent: `AgenticSEO/<version> (+<PUBLIC_URL>/bot)`, with a public page explaining the bot and how to block it.
- robots.txt is obeyed for every host. An override exists only for **verified** own sites, by a person.
- Concurrency and backoff per host, `Retry-After` honoured, crawl-delay honoured.
- Competitor crawls are limited to single pages or small samples by default (the `crawl` class with a page cap).

## 3. Site ownership verification

Actions that change a site, override robots or crawl at full speed need a **verified** site. Any one of these verifies it:

- a DNS TXT record;
- an HTML file or meta tag;
- a verified GSC property for the domain;
- a working site connector with write access.

Verification is re-checked periodically.

## 4. Credentials

- Provider keys, OAuth tokens and connector credentials are envelope-encrypted (ported `secrets`). They are never returned by any API, never logged and never passed to an LLM.
- Connector scopes are as narrow as the platform allows. For GitHub: a fine-grained token or a GitHub App limited to the site repository, with *contents* and *pull requests* permissions only.
- Crawler-access credentials are bound to their site's hosts and are never sent to another host, even on redirect.

## 5. Agents and content safety

- **Prompt injection from crawled pages.** Page text reaching an LLM (judged checks, briefs, AI answers) is wrapped as untrusted data. Specialists' tool subsets do not include write tools during analysis. Writes happen in a separate step, and the policy engine checks them whatever the model says.
- **Generated content:**
  - change sets that add content are marked "AI-generated" in their metadata;
  - a schema generator only emits properties backed by visible page content;
  - claims checks (numbers, prices, reviews) flag unverifiable statements for human review.
- **No fabricated data.** Tools return "no data" explicitly; the copilot and specialists are instructed and validated not to state metrics they did not receive.

## 6. Privacy (GDPR)

SEO data is mostly about pages, not people. The exceptions:

- **GA4 and GSC data** are aggregated. We request no user-level data, and GA4 reports below Google's thresholds are shown as suppressed.
- **Local SEO reviews** contain reviewer names. We store the review text and an author display name for the retention period only, with no further profiling. Data export and erasure cover them.
- **Workspace members and agents** get Agentic Marketing's account data handling.
- **Public report share links** are unguessable, revocable and `noindex`, and a new share mints a new link (as OpenSEO).

## 7. Threats specific to this product

| Threat | Control |
|---|---|
| An agent ruins a site's rankings | Policy engine, traffic at risk, fixed rules, L1 default, verification, guardian rollback |
| A malicious page manipulates an agent | Untrusted-data wrapping, tool separation, policy on writes |
| SSRF into the host network | §1 |
| Using the platform to attack or scrape a third-party site | Polite crawling, competitor page caps, per-workspace crawl quotas, an honest UA |
| Cost runaway from a looping agent | Credit holds, budgets, mandate spend limits, guardian spend anomaly |
| Leaked connector token | Narrow scopes, encrypted storage, connection revoke, audit log |
