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

## Phase 1 implementation notes (2026-11-15)

Building the GitHub connector against the pilot, `TimChr78/martechsignal` (martechsignal.com), settled
four points the decision left open. They are recorded here because a later connector should expect the
same shapes.

- **The pilot's deploy is a direct upload, so GitHub never sees it.** `deploy.sh` runs
  `npx wrangler pages deploy deploy-out` after the build; merging a PR is not deploying. The GitHub
  Deployments API therefore has nothing for this site, and "PR merged" cannot be read as "live". The
  connector detects the deploy from the site itself: the build writes `deploy-out/version.txt` whose
  first line is the deployed commit SHA and whose second line is `built <ISO-8601>`, and the deployed
  site serves it at `/version.txt`. `deploy.sh` already polls that file after an upload, for the same
  reason. A change set is deployed when GitHub's compare API reports the deployed SHA is `identical` to
  or `ahead` of the merge commit; `behind` or `diverged` stays pending. A site that does not publish a
  version file is a configuration error, not a failed deploy: detection returns `unknown` with the
  reason, and the change set is not marked failed.
- **The files that look like pages are often build output.** Blog posts are generated from
  `content/drafts/<slug>-<YYYY-MM-DD>.md` (YAML frontmatter) by `tools/build_blog.py`, tool and
  category pages from JSON catalogues by `tools/build_tools.py`, and the sitemap and `llms.txt` by
  `tools/build_indexes.py`. Editing a generated `index.html` survives until the next deploy and then
  disappears, so the mapping resolves `/blog/<slug>/` to the draft and refuses a generated path with
  the build script to change instead. The route is not the file name: `build_blog.py` takes
  `slug = meta.get('slug') or slugify(title)`, and real drafts either declare a slug unrelated to
  their file name or none at all, so the mapping's `resolveBy: "frontmatter_slug"` rule lists
  `content/drafts/*.md`, reads each draft's slug (falling back to the slugified title) and refuses a
  slug that zero or several drafts claim rather than guessing. Generated-path protection is one gate
  (`assertEditable`) that every resolver returns through — a literal path, a glob, a frontmatter-slug
  match, a layout template or the redirects file — not only the literal route.
- **Frontmatter quoting follows the build's reader.** `build_blog.py`'s `parse_frontmatter` reads a
  value as `val.strip().strip('"').strip("'")`: it removes surrounding quotes and never unescapes, so
  a JSON-style `\"` written for YAML would reach the live `<title>` as a backslash. The pilot's rule
  therefore sets `frontmatterDialect: "strip_quotes"`, which writes the value inside a quote character
  it does not contain and refuses values that parser cannot carry (both quote kinds, a leading or
  trailing quote, leading `#`, surrounding whitespace, a literal `---` that would close the block
  early, and a leading `[` or `{` that the build reads as a collection). Each written value is read
  back through a port of that parser before it is returned, so the refusal list cannot fall behind
  the build. The default `yaml` dialect keeps standard quoting for sites that read their frontmatter
  with a YAML parser. The port has to use Python's character classes, not JavaScript's: Python's
  `str.isspace()`, `\s`, `str.strip()` and `\w` differ from JavaScript's (U+0085, U+001C–U+001F and
  the Unicode spaces are whitespace to Python; U+FEFF is whitespace to JavaScript only), and Python's
  `.` stops only at `\n`, so a U+2028 inside a value is part of it. `test/fixtures/pilot/
  python-expectations.json` holds the expected slugs and frontmatter output produced by running the
  pilot's own functions (the script that writes it is `packages/changes/scripts/pilot-expectations.py`),
  and the editor refuses a value carrying a character Python treats as whitespace or as a line
  boundary other than a plain space.
- **A change can carry the source file's hash.** `before` catches a file that moved on for values the
  file already carries, but not for one it does not: inserting a missing `seo_description` has nothing
  to compare `before` with. A change may therefore carry `sourceHash` (sha256 of the file as read when
  drafted); every editor refuses a file that hashes differently, and the frontmatter editor requires
  it before inserting a key.
- **The build decides which frontmatter key is the page title.** `build_blog.py` uses
  `seo_title or title` for `<title>` and `seo_description` for the meta description, falling back to a
  body excerpt. The mapping therefore names `seo_title` for a title change and `seo_description` for
  the description — never `title`, which is the post's H1 and, when the draft declares no `slug`, the
  input to `slugify(title)` and therefore the route. For the same reason the frontmatter editor
  recomputes the route with that rule before and after every edit and refuses one that would move it.
  A change to a generated page is a change to the draft that feeds the build, not to a rendered file;
  a JSON-LD change is refused on such a source because the frontmatter has no field for it and the
  schema belongs in the build template.
- **Redirects are a plain `_redirects` file** in the Cloudflare Pages / Netlify format
  (`/from  /to  301`, `#` comments), so one editor serves both hosts. **A change writes one literal
  rule**: `from` and `to` carry no `*` splat and no `:name` segment, and a change that names a
  pattern is refused ("Pattern redirects are written by people in Phase 1"). Pattern rules are a
  person's edit; proving what a pattern graph does for every path is not something a change can do,
  and the three pattern cases a review found (a self-referential splat, a splat loop through an
  existing rule, a splat chain) are all refused by that one rule. The file may still contain pattern
  rules, so the analysis around a new rule understands them.
  Rules are edited in place to keep comments and ordering — an update rewrites only the changed
  `to`/`status` spans, so an inline comment and the spacing around it survive. Loop and chain
  analysis evaluates the *resulting* file the way the platform applies it: **first match wins on the
  request path**. Identity is the path with trailing slashes dropped, plus the query only when a rule
  spells one (Cloudflare Pages and Netlify match the path; a fragment is never part of a match, so
  `/a -> /a#section` is a self-loop), and an absolute target keeps its origin. For the new rule's
  source and every rule whose effective target is that source, the walk follows the first matching
  rule — literal or pattern, with `:splat`/`:name` substituted — and refuses a loop or a chain with
  the final target to point at. A pattern rule that answers the new rule's own source or target, or
  whose target needs a placeholder it cannot supply, is refused with the line to edit by hand, unless
  first match wins shows an earlier rule shadows the pattern for that path (so `/old/item /safe`
  before `/old/* /new/:splat` does not make `/new/item -> /end` a chain). A `#` inside the target
  token is a fragment (`/new-page#section`), while ` #` after whitespace is still an inline comment.
  Redirecting more than 20 URLs remains a fixed rule that always needs a person
  (agents-and-autonomy.md §3).

### Phase 1 change sets (2026-11-15)

The change-set half of this ADR, implemented as `packages/change-sets` on top of the merged
`packages/changes` library. The decisions the brief left open, recorded for the next connector:

- **A change set is a `change_set` artifact and a run row.** The artifact (versioned, reviewed,
  approved) holds the content; `change_set_runs` holds where the change is in the world, and
  `change_set_events` is the append-only log with evidence. An artifact version is immutable once
  published, so the two cannot be one row. Every content field is stamped with the base commit and
  the source file's sha256, and the draft's diff is stored with it, because the reviewer sees the
  diff without the repository being read again.
- **Publishing the artifact is the approval to apply.** The apply job is enqueued from a publish
  hook, inside the publishing transaction, so a published version is always applied and an
  unapproved one never is. A change set goes `draft → in_review → approved → applying → pr_open`;
  `changes.requestApply` is the change-set door to the same approval flow (`artifacts.requestPublish`
  is the other), and the artifact's class is now the class of its strongest change, not `draft`.
- **`approved_head_sha` is the pull-request head the approval covers.** The PR does not exist when
  the version is approved, so the apply job records the commit it writes as the approved head. A
  later push makes `head` differ, which is exactly the stale-approval signal; the change set returns
  to review with its published version back in draft, and Agentic SEO closes the pull request it
  opened (the branch keeps the work) so an unapproved PR cannot be merged by mistake.
- **Drafting refuses as a whole by default.** `changes.create` returns one refusal per change and
  creates nothing when any change is refused; `allowPartial: true` keeps the rest. A change the
  source already carries is refused rather than recorded as a no-op.
- **A retried apply job adopts only the commit it would write.** The branch name is
  `aseo/<change-set id>-v<version>`. Before creating anything the job looks for the branch and for a
  pull request with that head; it adopts one only when that commit's single parent is the expected
  base and its tree is identical to the base tree with our file blobs at our paths and their base
  modes. Entries are compared in full — path, object type, mode and SHA — because a blob SHA alone
  hides an executable bit, a symlink where a file was, or a submodule that appeared, moved or went
  away; a truncated tree answer proves nothing and refuses adoption too. Anything else (a push after
  the attempt, an extra file, a different edit) is not adopted: the approval is withdrawn and the
  change set returns to review. A branch created before the commit (base head, no commit) resumes
  the multi-file commit from the base. A response lost after GitHub created the PR therefore still
  cannot produce a second one.
- **Verification fetches the URL each change is about.** A redirect change stores `from` as a path
  (that is what the redirects file holds), so verification resolves it against the site's own origin
  (primary domain, https) before fetching and checks both the status and the resolved `Location`. A
  layout's rendered routes are counted in the reach estimate (they are what a template edit puts at
  risk) but are not re-fetched: a change's expectation is about its own URL, and a route the change
  does not name has no expected value to compare. A fetch that fails is retried three times with
  backoff before it becomes `verification_failed` with "could not fetch" evidence, so a flaky site
  does not fail a good change on the first attempt.
- **A conflict hold is an approval, not a refusal.** Two open change sets on one site that touch the
  same URL or the same source file: the second is always sent to a person, with the first change set
  named in the hold reason and in the approval note, whatever the agent's mandate allows and even
  when the workspace policy would publish directly.
- **A rollback re-reads the current value for its inverse.** The inverse of a change whose file kept
  moving is drafted against the file as it is now (`before` is today's value, `after` restores the
  original), because the editor would otherwise refuse the rollback as stale. A change that cannot be
  inverted from the change record is **uncovered**: `meta.description` cannot be removed by a change
  (the schema requires a non-empty `after`, and no editor can delete the tag), and a replaced or
  removed JSON-LD block's previous contents were never stored. An uncovered change is recorded on the
  proposal in `uncovered_changes` with its reason; the proposal still reverses the rest (dropping it
  silently would report a partial revert as a complete one), but it is **never `exact`**, it is judged
  with the **original change set's action class and reach** (a subset is not a smaller change), and
  it **never marks the original `rolled_back`** — the original keeps its state and the event on it
  names what is still live. Only a rollback that covers every original change can complete one. When
  nothing can be inverted the command refuses and names the merge commit to revert by hand.
- **One open rollback per original, and a rejected proposal releases it.** `changes.rollback` locks
  the original run row (`FOR UPDATE`) before asking whether a rollback is already in flight, and a
  partial unique index on `(workspace_id, rollback_of)` over the open states backs the same rule up,
  so two simultaneous requests produce one proposal and one clear refusal. A rejected
  `approvals.reject` or a discarded draft closes the proposal's run (`closed`) through a
  version-closed hook in the artifact package — the same way a publish moves the run to `approved` —
  because a run left in `in_review` would block the next attempt forever.
- **`deploy_not_detected` is terminal and visible.** It is a distinct state, not `failed`: the merge
  happened and the site did not serve it, which is a pipeline problem a person fixes by looking at
  the deploy, then rolling back or re-running. An `unknown` detector answer (no version file, a
  comparison that cannot be read) counts toward the same window: a detector that never answers must
  become visible, not extend the wait forever, and the last detector reason is kept as evidence.

### Approval invariant (review round 1)

The guarantee is one sentence: **nothing reaches the repository except the exact content a person
approved, and only after that exact version was approved.** Every step derives its own answer from
the repository and refuses when it differs; no later step trusts a caller-supplied field from an
earlier one.

- **Draft (`changes.create` / `changes.updateDraft`).** Each change is resolved through the
  person-written mapping and applied in memory. The resulting source path, editor, affected routes,
  base commit, file sha256, rendered diff and verify target are written by these commands only:
  `artifactTypes.change_set.serverOwned` makes `artifacts.create` and `artifacts.updateDraft` refuse
  the type, so the generic artifact door cannot write or edit them.
- **Approval (`changes.requestApply`, or `artifacts.requestPublish`).** The impact estimator locks
  the artifact row and judges the **latest** version — the one the handler publishes — not the last
  published one, so a stale change redrafted as a structural redirect is held as `site.structural`.
  The handler re-derives every server-owned field from the file at its own `baseSha`: the mapping
  must resolve the URL to the same path and editor, the file must hash to `sourceHash`, applying the
  edit must reproduce the stored diff byte for byte, and the stored change must equal the editor's
  verify target. A mismatch refuses the submission and names the field.
- **Apply (`changes_apply`).** After re-reading the base head for the stale check, the worker runs
  the same re-derivation before writing anything. It then commits only those re-applied texts, each
  at the mode the file already had at the base. If it finds a branch or pull request from an earlier
  attempt, it adopts it only when the head commit has exactly one parent (the base) and a tree whose
  entries (path, type, mode, SHA) are exactly the base tree with our blobs at our paths; an executable
  bit, a symlink, a submodule or any added/deleted path is a refusal. Anything else returns the change
  set to `in_review`, withdraws the approval and closes the pull request Agentic SEO opened. A branch
  that still points at the base resumes the commit (fast-forward from base only).
- **Pull request and merge (`changes_poll`).** The poller compares the pull request head with
  `approved_head_sha` before any progression. An open PR that moved on returns to `in_review`, and a
  PR that was **merged** with a different head goes to `failed` with "merged with commits that were
  not approved": nothing is deployed or verified, and a person decides what to do with the merged
  content.
- **Deploy and verification.** Deploy detection and verification re-fetch, both queued in the same
  transaction as the state that makes them due (`change_set_enqueue`, a narrow security-definer door
  like `crawl_enqueue`), with the poller reconciling an `approved` or `deployed` row whose job was
  lost. Redirect sources are resolved against the site's own origin before fetching and checked
  end to end (status and `Location`).
- **Rollback.** `changes.rollback` writes no GitHub state. It creates a draft rollback change set
  linked as `rollback_of`, judged with the original's action class and reach. Its pull request opens
  only through the approved apply worker. It calls itself `exact` only when it covers every original
  change and every touched file still matches the merge; a change it cannot invert is listed in
  `uncovered_changes` with the reason, and such a proposal never marks the original `rolled_back`.
  The original becomes `rolled_back` only when a rollback that covers every change is verified; a
  rejected or abandoned proposal closes its run and leaves the original exactly as it was, so another
  may be requested.

