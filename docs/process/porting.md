# Porting from Agentic Marketing

Shared foundations are **copied with provenance**, not shared as a library (open question 1, decided
2026-11-12). Each ported package records the Agentic Marketing commit it came from, so upstream fixes
can be found and carried over. Extraction into a shared library happens only if the same fix has had to
be applied by hand in both repositories three times, or a third product needs the packages.

Source repository: https://github.com/TimChr78/Agentic-Marketing

| Package | Source path | Source commit | Changes on port |
|---|---|---|---|
| `core` | `packages/core` | `311460e` (0.14.8) | Package scope renamed; `personalData.ts` dropped (marketing-specific); brand name and glyph changed |
| `telemetry` | `packages/telemetry` | `311460e` (0.14.8) | Package scope renamed |

Rules: keep file structure and names where the code is unchanged, so a diff against upstream stays
readable. Remove marketing-only concepts (profiles, consent, journeys, e-mail, segments) instead of
leaving dead code. Record every port in this table in the same pull request.
