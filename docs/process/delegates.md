# Phase workflow with delegate tasks

Adapted from Agentic Marketing's `docs/process/delegates.md`.

```
main
 └── feat/phase-<n>                 phase branch: the integration point
      ├── task/p<n>-<letter>-<slug> →  draft PR into feat/phase-<n>  →  CI  →  review  →  merge
      └── …
 └── PR feat/phase-<n> → main       one full review and CI run
```

1. **Plan.** The integrator writes each task's brief (scope, files it owns, acceptance criteria).
2. **Dispatch.** Each delegate works in its own worktree on a task branch from the pushed phase branch.
   It commits and pushes its branch and opens a **draft PR into the phase branch**.
3. **Review.** Every task PR gets an independent review (GPT 6.1 Sol on Codex). Small findings are fixed
   by the integrator; larger ones go back to a delegate with the findings.
4. **Merge** into the phase branch once CI is green and review findings are resolved.
5. **Integrate.** After the last task: a full review of the phase branch, then one PR to `main`.

## Rules for delegates

- Edit only the files your brief names, plus new files in your package or namespace.
- Root `package.json` dependencies and `pnpm-lock.yaml` may only change when the brief says so.
- Migrations: only with the number your brief reserves.
- Run before reporting: `corepack pnpm install`, `corepack pnpm lint`, `corepack pnpm typecheck`,
  `corepack pnpm test` (against the shared stack: `eval "$(scripts/test-services.sh env)"`).
- Report: branch, PR URL, head SHA, decisions where the brief was silent, commands run with exit codes,
  and anything the integrator must do.
