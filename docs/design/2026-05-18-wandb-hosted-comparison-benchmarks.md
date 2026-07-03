# Design: W&B Hosted Comparison Benchmarks

Date: 2026-05-18

Status: Accepted for benchmark tooling

Owner: Codex

## Summary

InstantML needs direct comparison evidence between the deployed Cloud Run data
API and W&B hosted cloud for the same large-run workflow. This design adds
guarded benchmark tooling under `benchmarks/` that can seed deterministic W&B
runs, query W&B through documented public SDK/Public API surfaces, run the
existing InstantML hosted Cloud Run benchmark without seeding InstantML data,
and render a sanitized `benchmarks/RESULTS.md` comparison.

The closest full-fidelity target is the existing hosted scale dataset:
100,000 runs, two source projects, 1,000 steps per run, and six scalar metric
keys. W&B does not expose a documented bulk history import API equivalent to
our direct ClickHouse seed path, so the tool supports an explicit exact mode
while defaulting to bounded, clearly labeled W&B history seeding. Run-summary,
search, filter, and sort comparisons can be close to 1:1 with W&B summaries.
Large selected-run time-series comparisons must be labeled by the W&B public
API surface used.

## Goals

- Seed new data only into W&B, never into InstantML hosted ClickHouse.
- Preserve the deterministic hosted-scale run names, tags, source status,
  config fields, notes text, metric keys, and metric formulas where practical.
- Benchmark W&B using documented SDK/Public API calls, not private GraphQL
  request shapes.
- Query InstantML through the existing hosted Cloud Run benchmark only when the
  hosted dataset already exists.
- Produce sanitized committed analysis in `benchmarks/RESULTS.md`.
- Make exact 100k x 1k-step W&B seeding possible behind explicit flags while
  keeping smaller smoke and summary-only runs practical.

## Non-Goals

- Do not seed or mutate InstantML hosted ClickHouse.
- Do not use private W&B backend endpoints or internal GraphQL documents.
- Do not claim perfect parity for W&B surfaces that lack a documented public
  equivalent, such as org-wide cross-project listing or InstantML's selected
  run-id batch-series endpoint.
- Do not add a product API, database table, SDK public API, or frontend screen.

## Proposed Design

Add `benchmarks/wandb_hosted_compare.py` with subcommands:

- `seed-wandb`: create W&B runs in one W&B project, with source InstantML
  project stored in config and tags. By default, seed one summary row per run
  and optional full history for a bounded selected subset. `--history-mode exact`
  logs every configured step for every run and requires an explicit confirmation
  flag.
- `benchmark-wandb`: time W&B public read paths using `wandb.Api`, including
  newest pages, source-project filters, tag/config/notes-mirror/status filters,
  summary-metric sorting, single-run history, and optional selected-run history
  batches.
- `benchmark-instantml`: wrapper around the existing
  `tools/hosted-cloud-run-benchmark.mjs`; it refuses to run any InstantML seed
  command and only writes the sanitized read-only benchmark output.
- `render-results`: combine sanitized InstantML and W&B JSON into
  `benchmarks/RESULTS.md`.

Use one W&B project rather than two because W&B's documented run query surface is
project-scoped. The InstantML source project is represented by
`config.instantml_source_project` and a matching tag. This gives W&B a single
large project comparable to the InstantML org-wide 100,000-run workspace while
still allowing project-filter equivalents.

## API Mapping

| InstantML hosted case | W&B public equivalent |
| --- | --- |
| `GET /api/runs/summary` newest pages | `Api.runs(path, order="-created_at", lazy=True)` |
| Project filter | `config.instantml_source_project == ...` |
| Tag search | `tags` filter with `hosted-scale` or `seed-13` |
| Config search | `config.model == "transformer"` |
| Notes search | mirrored `config.instantml_notes` regex, labeled as a mirror |
| Status filter | mirrored `config.instantml_source_status`; actual W&B `state` is recorded separately |
| Metric-best sort | `order="-summary_metrics.eval/return_mean"` with alias fallback if slash-key sorting fails |
| Single-run chart | `Run.history(samples=...)` and optional `Run.scan_history(...)` |
| Selected-run batch series | `Runs.histories(...)` over a selected run-id filter when supported, otherwise labeled unavailable |

## Performance Considerations

The exact hosted dataset is 100,000 runs x 1,000 history rows x six metrics,
which is 100 million W&B log rows and 600 million scalar values. That is a real
external-cost and time-consuming workload through public SDK ingestion. The seed
tool therefore separates:

- summary/list fidelity: one summary row plus deterministic summary metrics for
  every run;
- bounded chart fidelity: full history only for a selected subset;
- exact fidelity: every step for every run, behind an explicit flag.

W&B rate limits and SDK backoff are benchmark findings, not script errors to
hide. Results must report seeded mode, run count, step count, full-history run
count, upload duration, failures, and whether any W&B cases are closest-public
equivalents rather than exact route equivalents.

## Failure Modes

- W&B API key missing or invalid: fail before seeding or timing.
- W&B entity/project not provided: infer default entity where possible and
  record it in sanitized output.
- W&B rate limit/backoff: keep retry behavior conservative and record failures
  or incomplete seed status in the manifest.
- InstantML hosted dataset missing: read benchmark fails clearly and the results
  state that no new InstantML data was seeded.
- Slash metric sort unsupported by W&B Public API: benchmark alias sort and
  report the exact-key failure.

## Testing Plan

- Unit-test deterministic data generation, history selection, percentile
  summaries, and sanitization without network access.
- Run W&B SDK authentication preflight.
- Run a tiny W&B smoke seed/benchmark before larger seeding.
- Run `benchmark-instantml` only as a read-only query against the existing
  hosted dataset.

## Documentation Plan

- Update `docs/design/README.md`.
- Update `benchmarks/README.md`.
- Commit `benchmarks/RESULTS.md` with sanitized comparison and caveats.

## 2026-07-03 Competitive Gate Follow-Up

The hosted comparison tooling now includes a read-only competitive gate helper
that consumes sanitized Cloud Run benchmark JSON and reports `pass`, `fail`, or
`not_measured` against:

- W&B's published Multi-tenant Cloud scale guidance for runs/project,
  steps/run, metric cardinality, log frequency, scalar-value throughput, and
  video throughput.
- The committed historical W&B public-API comparison in `benchmarks/RESULTS.md`,
  using matching route names and a 10% tolerance because that W&B run was a
  partial public-API seed with closest-equivalent labels.
- Neptune's public "thousands of metrics in seconds" app claim, represented as
  a conservative >=1,000 metric-key/p95 <= 5 second gate.

This follow-up does not replace fresh W&B or Neptune benchmarks. It makes the
claim boundary explicit: benchmark reports can pass measured historical read
latency gates while still marking wider ingest, step-count, or metric-cardinality
claims as unmeasured until a payload contains those measurements.

## Review Notes

Fresh reviewer 1:

- Finding: Exact W&B parity can accidentally become a 100M-call SDK workload.
- Risk: A benchmark run could take days, hit rate limits, or create unclear
  partial W&B state.
- Recommended edit: make exact mode explicit, track manifest state, and label
  summary-only and bounded-history modes honestly.
- Decision: Accepted.

Fresh reviewer 2:

- Finding: W&B's documented API is project-scoped and does not match every
  InstantML route one-for-one.
- Risk: Results could overclaim parity for org-wide listing, notes search,
  status filters, overview, and selected-run batched series.
- Recommended edit: use one large W&B project, mirror source project/status into
  config/tags, and include an API mapping table plus caveat labels in results.
- Decision: Accepted.

## Coverage Exceptions

Coverage exception:
- Uncovered area: full 100,000 x 1,000-step x six-metric W&B exact seed in
  automated tests.
- Reason: external paid SaaS workload, rate-limited, and too large for routine
  verification.
- Risk: exact W&B chart-series performance may differ from bounded-history
  evidence.
- Follow-up: run exact mode only with explicit operator approval and preserve
  sanitized result output.
- Owner/date: Codex, 2026-05-18.

## Decision

Accepted for benchmark tooling and result reporting. The implementation must
not seed InstantML hosted ClickHouse.
