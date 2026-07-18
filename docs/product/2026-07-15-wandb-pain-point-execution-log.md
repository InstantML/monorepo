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
| PR-02 client run IDs + resume | merged | #374 | Live E2E matrix verified; fresh review fixes applied (fast-path visibility check, per-org project-create lock) |
| PR-03 offline/disabled SDK modes | merged | #375 | Native `mode="offline"` (local run directory: run.json manifest, spool segments with session/class/persisted deterministic idempotency keys, staged `files/`, bounded drop-on-write-failure, offline finish/SIGTERM signatures) and strict `mode="disabled"`; wandb-compat mapping. Review blockers fixed: crash-resume partial-segment scan (SIGKILL-reproduced), fork safety, finish preservation. Full suite green at 100% coverage |
| PR-04 resumable `instantml sync` | implemented on branch | – | `instantml sync <run_dir \| offline_root>` (branch `claude/pr04-resumable-sync`): `--status`/`--dry-run`/`--json`, idempotent `mode="auto"` create (never reopens; 409 run_id_conflict → exit 4), cursor-journaled delivery through the async-queue drain via a throwaway per-segment SQLite queue preserving persisted idempotency keys, deterministic within-segment batching (batch keys reproduce across reruns), staged-file base64 delivery, full-class key attachment, final session manifest PUT with graceful 404 fallback (route ships in PR-05), typed exit codes 0/3/4/5. Live E2E vs local Rust server: SIGKILL'd offline run synced, mid-sync kill + re-run converged to exact metric counts. Review fixes: oversized-event fail-stop (64 MiB sync cap, refused events are reported permanent failures, never skipped), live-partial synced-marker guard + `--assume-dead`, session manifests posted on exit-3/exit-4 paths (`active`/`final`) so data-state reads incomplete, not unknown. Full suite green at 100% coverage |
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
