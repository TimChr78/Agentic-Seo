# @agentic-seo/web

The admin UI. React 19, Vite, Tailwind 4, Lucide icons and ECharts, ported from Agentic
Marketing's `apps/web` (see [porting](../../docs/process/porting.md)).

```bash
corepack pnpm dev:web                         # Vite on :5173, proxies /api to :3000
corepack pnpm --filter @agentic-seo/web build # typecheck and build to dist/
corepack pnpm --filter @agentic-seo/web gen:brand
```

## The API seam

`src/app/api.ts` owns the typed interface the UI is written against. Two implementations exist:

- `httpApi` is the real client: every read and write is one command call through
  `createClient<Commands>` from `@agentic-seo/client`, with the command types taken from the
  server's registry (`@agentic-seo/server/src/registry`). A command's schema change therefore breaks
  the UI at compile time. The cookie session and the `Origin`/CSRF rules are the server's
  (`apps/server/src/app.ts`, `http/csrf.ts`); only Better Auth's own session endpoints
  (`/api/auth/get-session`, sign-in, sign-out) are called directly.
- `createCommandApi()` maps command outputs to the shapes the pages use, and takes the transport as
  an argument, so the mapping is unit-tested without a server.

Where the Phase 0 server has no source, the page says so instead of showing a number: Home's health,
clicks, positions and AI citations come back `null` with a `noDataReason` ("Connect Search Console to
collect clicks."). Recommendations and agent activity are empty arrays until their phase.

`createDemoApi()` answers with fixed sample data: one workspace and the two pilot sites
(`martechsignal.com`, `oresund.live`). It is selected when `VITE_API_MODE=demo`, and in development
when `/healthz` does not answer. The shell marks that session "Demo · sample data".

No page branches on the mode. A page calls `api.getHome(siteId)` and the selected client answers.

## Signing in

The server serves this SPA, so a signed-out person gets the app's own sign-in screen (`SignIn.tsx`)
on the same origin; it posts to Better Auth and the session cookie is set. The server-rendered
`/login` and `/consent` pages belong to the MCP OAuth flow only.

## Layout

- `src/app/nav.ts` is the canonical navigation from [DESIGN.md §3](../../docs/design/DESIGN.md).
  Every destination has a unique path.
- `src/app/planned.ts` names what an unbuilt destination will hold and the phase that delivers it;
  `src/pages/PlannedPage.tsx` renders it with a real h1 and an EmptyState.
- `src/app/Shell.tsx` is the 232/64 px sidebar, 56 px top bar and mobile drawer, with the site
  switcher in place of a brand switcher.
- `src/ui/` holds the shared primitives and templates; `src/index.css` holds the tokens, including
  the data-visualisation palette. Do not hard-code colours or spacing outside those files.

## Tests

`corepack pnpm test` runs the `web` project in jsdom. Tests live in `test/`; `test/setup.ts`
installs the matchMedia polyfill and Testing Library cleanup.

Playwright covers the UI in a real browser against the real server, including axe over every route in
light and dark: see [docs/process/e2e.md](../../docs/process/e2e.md). `corepack pnpm e2e` runs it.
