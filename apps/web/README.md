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

- `httpApi` calls `/api/…`; the integrator replaces its bodies with the generated command client.
- `createDemoApi()` answers with fixed sample data: one workspace and the two pilot sites
  (`martechsignal.com`, `oresund.live`). It is selected when `VITE_API_MODE=demo`, and in
  development when `/api/health` does not answer. The shell marks that session "Demo · sample data".

No page branches on the mode. A page calls `api.getHome(siteId)` and the selected client answers.

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
