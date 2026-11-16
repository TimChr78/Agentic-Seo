# ADR-0005: Own HTTP crawler; rendering through a pluggable sidecar

- Status: Proposed. Spike 2 chooses the default adapter.
- Date: 2026-11-12

## Context
Most SEO checks need the raw HTML that search engines fetch first. Rendering is needed for JS-only sites, rendered-vs-raw comparison, screenshots, agent-readiness checks and local Lighthouse. Chromium is heavy, and some users already run Crawl4AI or Browserless.

## Decision
The crawler fetches HTML itself (undici + a streaming parser). Rendering goes through a `Renderer` port with adapters: `none` (the default), `builtin` (the optional `agentic-seo-renderer` sidecar with Playwright and Chromium, which can also run Lighthouse), `crawl4ai` and `browserless`. Lab and field performance data come from PageSpeed Insights and CrUX by default.

## Alternatives
- Render every page: 10–50× slower, and it hides raw-HTML problems.
- Chromium in the main image: size and attack surface.
- Crawl4AI only: Python service as a hard dependency.
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) as a renderer (considered 2026-11-16): it is an MCP server that lets an agent drive Chrome, with performance traces (LCP, CLS and INP breakdowns), network and console. Our server calling another MCP server to drive a browser adds a protocol layer for nothing: it is built on Puppeteer, so a Puppeteer or Playwright adapter behind the `Renderer` port gets the same traces directly. A browser that opens any URL it is told also sits outside the `fetch` egress policy. Rejected as a renderer; it stays a companion tool for external agents ([agents-and-autonomy.md §2](../agents-and-autonomy.md#2-one-command-layer)).

## Consequences
Render-dependent checks report "Not evaluated" when no renderer is configured; they are never treated as passed. The renderer must obey the same SSRF egress policy.
