# W&B Pain-Point Roadmap Execution Log (PR-00 – PR-08)

Date started: 2026-07-15

Tracks delivery of the P0 reliability slice of
`docs/product/2026-07-14-wandb-pain-point-roadmap.md`. Updated in every PR
that advances the roadmap. Status values: `pending`, `in progress`,
`in review`, `merged`.

| Roadmap item | Status | PR | Notes |
| --- | --- | --- | --- |
| PR-00 TODO reconciliation | merged | #372 | 20+ checked-off claims re-verified against code |
| PR-01 offline lifecycle design | merged | #373 | Two fresh reviews (Accept-with-edits); all blockers/should-fixes incorporated |
| PR-02 client run IDs + resume | in review | – | Implemented + live E2E matrix verified (create/replay/conflict/auto-no-reopen/resume side effects/404 leak rules); fresh review fixes applied (fast-path visibility check, per-org project-create lock) |
| PR-03 offline/disabled SDK modes | pending | – | Blocked on PR-02 |
| PR-04 resumable `instantml sync` | pending | – | Blocked on PR-03 |
| PR-05 upload completeness persistence | pending | – | Blocked on PR-01/PR-02 |
| PR-06 honest run data-state UI | pending | – | Blocked on PR-05 |
| PR-07 doctor + recover CLI | pending | – | Blocked on PR-03 |
| PR-08 crash/network regression matrix | pending | – | Blocked on PR-05 |

## Verification evidence

Recorded per PR as work lands (commands, benchmark numbers, E2E notes).

### Baseline (2026-07-15)

- Worktree environment: `npm ci` and `cargo build` pass on
  `main`-equivalent branch at `cac3df6f`.
- Codebase audit sources: Rust run lifecycle map, Python SDK internals map,
  web run-state UI map, TODO staleness audit (all verified against code in
  this worktree).
