# End-to-end tests

The admin UI runs in a real browser against a real server, a disposable database and the built
UI — the same artifact a self-hoster gets. Two Playwright projects:

| Project | Spec | What it proves |
|---|---|---|
| `functional` | `e2e/journey.spec.ts` | A person signs up and is told they have no workspace; signs in, creates a site, sees the setup checklist, opens the verification screen from it, checks ownership and sees either the verification or the server's exact reason. |
| `functional` | `e2e/loop.spec.ts` | The thin loop: an issue an audit found, a recommendation created from it in the form, a second person approving in the Inbox, and the change set's pipeline and pull request. |
| `axe` | `e2e/axe.spec.ts` | Every Phase 0 route has no axe violation of WCAG 2.1/2.2 A and AA, light and dark, at 1440 px. |

```bash
corepack pnpm e2e                         # build the UI, start the server, run both projects
corepack pnpm e2e --project axe           # only the accessibility scan
corepack pnpm e2e --project functional    # only the journey
eval "$(scripts/test-services.sh env)" && corepack pnpm e2e   # against the shared test Postgres
```

Playwright needs its Chromium: `corepack pnpm exec playwright install chromium` (CI installs the
system packages too, with `--with-deps`).

## How it is put together

- `playwright.config.ts` starts `apps/server/test/e2e/server.ts` through `webServer`, after building
  `apps/web`. The server seeds three people — `owner@example.com` (one site), `newcomer@example.com`
  (no sites; the journey creates one) and `no-sites@example.com` (never changed, so the first-run
  screen is always scannable) — plus `no-workspace@example.com` (an account with no workspace).
  All use the harness password, printed when the server starts.
- `e2e/ports.ts` is the one source for the port: `E2E_PORT`, `E2E_BASE` and `TEST_PORT_OFFSET` move
  it, and the readiness port beside it, together. `E2E_DB` names the database.
- The readiness endpoint on the next port answers only after the seed finishes; `/healthz` is up
  before that.
- The ownership check is real. The e2e entry injects the sites package's test-only DNS resolver
  (`setTxtResolver`), which answers a TXT record only for domains starting with `verify-`, carrying
  that site's own token. Every other domain keeps the real "no record" answer, which is what the
  failed check asserts. No production code path can reach the override, and there is no bypass.
- `e2e/routes.mjs` reads the signed-in routes from `apps/web/src/app/nav.ts`, so a new destination is
  scanned without editing the list. It adds the states no navigation entry reaches — signed out, no
  site yet, no workspace — and the detail and list screens the navigation does not name
  (`/recommendations`, and the four detail pages with ids of the right shape, which render their own
  "couldn't open this" state when nothing is seeded).
- `e2e/seed.ts` writes the rows the crawler and the GitHub connector would have written: an audit
  with a score, an issue and its finding, a recommendation with a pending approval, and a change set
  at its pull request. The e2e server wires neither the crawl fixture host nor a GitHub fake, so the
  journey seeds them through the owner connection and then uses the real commands for everything it
  does: the recommendation is created in a form, the approval is decided by a second person, and the
  screens read the rows those commands produced. Drafting a change set through GitHub is not part of
  the journey for the same reason; it is covered with fixtures in `apps/web/test/phaseOne.test.tsx`.
- `e2e/axe-known-issues.json` starts empty, and it should stay empty: fix a violation instead of
  listing it. An entry is a rule id, the route name it appears on (or `*`) and why it is deferred.

A failure keeps a trace and a page snapshot under `test-results/`; CI uploads that directory.
