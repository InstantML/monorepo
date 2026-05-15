# Design: Hosted ClickHouse Query Benchmarks

Date: 2026-05-14

Status: Accepted

Owner: Codex

## Summary

InstantML now has a hosted ClickHouse demo tenant seeded with the large 100,000-run benchmark. This slice adds a repeatable benchmark/reporting pass for the daily dashboard queries that determine whether the product feels faster than heavyweight experiment trackers: newest runs, larger run pages, run name/tag/text search, status filtering, combined search+filter, selected-metric sort, overview stats, and bounded chart reads.

The smallest useful version extends the existing guarded hosted demo benchmark instead of adding a second ClickHouse client or a new query layer. It writes sanitized benchmark output into a committed `benchmarks/` folder. This slice started as measurement/report-only. The first full hosted pass exposed two narrow route implementation issues that made the benchmark fail its own budgets, so the accepted implementation also includes scoped, contract-preserving query fixes described below.

## Goals

- Benchmark the existing hosted ClickHouse demo tenant with 100,000 seeded runs.
- Cover run list, search, filter, combined search/filter, metric sort, overview, and chart-series endpoints.
- Preserve the guarded seed/provision behavior already documented for `INSTANTML_HOSTED_DEMO_ALLOW_PROVISION=1`.
- Record sanitized results and budgets without committing secrets, raw ClickHouse URLs, cookies, or API keys.
- Keep claims about W&B comparative performance honest: use InstantML interactive budgets unless an apples-to-apples W&B benchmark is actually run.

## Non-Goals

- Do not create another hosted service if the shared demo tenant route is already ready.
- Do not run or publish a live W&B benchmark in this slice.
- Do not add a new production query API unless measurements show the current route is too slow.
- Do not commit `.env`, service credentials, raw endpoint URLs, or generated local ClickHouse data.

## Users and Use Cases

ML engineers need to open a large project, search by run names/tags/notes/config text, filter to failed/running/finished runs, sort by a selected metric, and open charts without waiting seconds. Operators need a benchmark command that can be rerun against the hosted demo service after query changes.

## Proposed Design

Extend `tools/hosted-demo-seed-benchmark.mjs`:

- Keep the existing idempotent shared demo sign-in and seed guard.
- Measure these API paths after tenant replay:
  - `GET /api/runs/summary?project=...&limit=25&sort_by=created`
  - `GET /api/runs/summary?project=...&limit=100&sort_by=created`
  - `GET /api/runs/summary?project=...&q=demo-bench-100000` (name lookup)
  - `GET /api/runs/summary?project=...&q=seed 13` (tag/config/name token lookup)
  - `GET /api/runs/summary?project=...&q=llm` (tag/config lookup)
  - `GET /api/runs/summary?project=...&q=reward stability` (notes lookup)
  - `GET /api/runs/summary?project=...&status=failed`
  - `GET /api/runs/summary?project=...&status=running`
  - `GET /api/runs/summary?project=...&status=finished`
  - `GET /api/runs/summary?project=...&status=finished&q=reward stability`
  - `GET /api/runs/summary?project=...&sort_by=metric-best&metric_key=eval/return_mean`
  - `GET /api/overview?project=...&metric_key=eval/return_mean`
  - `GET /runs/:id/metrics?key=eval/return_mean&limit=5000`
- Return p50, p95, min, max, and response sanity counts for each path.
- Measurement protocol:
  - Use `INSTANTML_HOSTED_DEMO_WARMUPS` warm requests per endpoint, default 2.
  - Use `INSTANTML_HOSTED_DEMO_SAMPLES` measured requests per endpoint, default 8. Result files must record the actual count; p95 is computed with the existing nearest-rank method over sorted measured timings.
  - Measure warmed steady-state latency. The temporary Rust API may be restarted before measurement so direct ClickHouse seed rows are replayed, but endpoint timings start after readiness and warmups.
  - Use fixed endpoint order for reproducibility and record raw measured timings in local JSON output. Committed Markdown may summarize p50/p95/min/max without raw timings.
  - Every measured request must be a 2xx JSON response with the expected shape; non-2xx, malformed JSON, wrong shape, or known-empty cases fail the benchmark instead of being timed as successes.
  - Use the existing fetch timeout behavior; timeout failures should be explicit errors, not large synthetic timings.
- Preflight validation before timing:
  - seeded run count for the project is at least the configured run count.
  - first page has runs and includes `eval/return_mean` in metric keys where the route returns metric keys.
  - status counts include failed, running, and finished rows.
  - known search terms return non-zero totals for name, tag/config, and notes cases.
  - chart target run has at least one `eval/return_mean` metric row and the chart response honors the requested limit.
- Response validation during measurement:
  - summary endpoints: `runs` is an array, `total` is positive, returned rows are `<= limit`, and cases with expected results return non-empty pages.
  - status endpoints: returned runs, when present, match requested status.
  - search endpoints: returned runs are non-empty for the known fixture terms.
  - metric sort endpoint: returned runs are non-empty and metric summaries include the selected metric on at least one row.
  - overview endpoint: expected numeric counters are present.
  - chart endpoint: `metrics` is an array, non-empty, and `metrics.length <= limit`.
- Add budgets:
  - run summary pages: hosted end-to-end p95 <= 750 ms; internal local target remains 300 ms from `2026-05-11-large-run-query-performance.md`.
  - search/filter/sort: hosted end-to-end p95 <= 1000 ms; internal local target remains 500 ms.
  - overview: p95 <= 1000 ms hosted
  - chart series: hosted end-to-end p95 <= 750 ms; internal local target remains 200 ms.
- Add `INSTANTML_HOSTED_DEMO_RESULT_PATH` to write the sanitized JSON payload to a chosen path.
- Add a `benchmarks/README.md` and one dated Markdown result file with machine/date caveats and no secrets.
- Sanitized result allowlist:
  - commit SHA, branch name, generated timestamp, client platform/architecture, Node version, sample/warmup counts, configured run count, seeded run count, long-run steps, project name, ClickHouse provider/region if derivable, tenant provisioner, endpoint host only, and measurement summaries.
  - Exclude full URLs, URL query strings with secrets, headers, cookies, session tokens, API keys, raw response bodies, raw tenant/org/user identifiers, passwords, signed artifact URLs, and complete ClickHouse credentials.

If any endpoint misses budget:

- First inspect whether latency is API replay/startup, in-memory index filtering, ClickHouse aggregate reads, or network/hosted service latency.
- Keep optimization in this PR only when it is a narrow route fix that preserves existing API contracts and data models. Larger schema/index/cache work needs a follow-up design with the measured slow query, failure mode, and candidate fix.

Implementation adjustment after measurement:

- Broad created-sort search/status pages were using the fallback path that collected and sorted all matching runs. The implemented fix lets the existing created index serve text/status filtered pages while preserving exact totals, status matching, project scoping, auth scoping, and precomputed search-text matching.
- Project overview was counting metric points through many run-id chunks. The implemented fix adds direct project-scoped ClickHouse aggregate reads for top metric series and total metric point count, avoiding chunk fanout without changing the overview response shape.

## Component Impact

Backend:

- No production backend contract changes expected. The benchmark drives existing REST routes.

Frontend:

- No UI changes.

Python SDK:

- No SDK changes.

Storage:

- No schema changes in this measurement slice.

Docs:

- Add benchmark docs and recorded hosted result summary.

## Data Model

No data model changes.

## API Contracts

No API contract changes. The benchmark validates existing response shapes.

## Performance Considerations

- Data volume: 100,000 run operational records and the configured long-run metric series in the hosted demo project.
- Read shapes are summary-only for run list endpoints and bounded for chart reads.
- The benchmark records hosted API latency, including network and Rust route overhead, because that is what the dashboard experiences.
- Exact W&B comparison is out of scope without running the same workload through W&B. The acceptance criterion is sub-second hosted p95 for daily run browsing/search/filtering, which is the product speed wedge.
- Reproducibility metadata must include commit SHA, branch, dataset parameters, seeded row counts, sample/warmup counts, client platform, API mode, ClickHouse provider/region if known, and whether results are warmed.

## Simplicity Review

This design extends an existing guarded benchmark script and adds a committed result folder. It avoids adding a second benchmark stack, production caches, or schema changes before measurements justify them.

## Failure Modes

- User Data credentials missing: benchmark fails clearly before querying.
- Tenant route not ready: benchmark fails clearly and does not fabricate results.
- Partial seed: existing script refuses to continue unless a new project name is chosen.
- Hosted ClickHouse/network transient: p95 may spike; rerun with enough samples before optimizing.
- Results accidentally include secrets: result writer must sanitize endpoint details to host-only metadata.

## Testing Plan

- Add unit/smoke coverage for benchmark result sanitization and response validation where practical without reaching hosted ClickHouse.
- Run a small hosted benchmark sample to verify the expanded measurement set.
- Run the full hosted demo benchmark against the 100,000-run project when credentials are available.
- Run `npm run test:node`, `npm run web:build`, and targeted script smoke checks after edits.
- If production code changes are needed, run the relevant Rust tests and hosted benchmark again.

## Documentation Plan

- `tools/README.md`: document expanded hosted query benchmark coverage and result-path variable.
- `apps/rust-server/README.md`: update hosted benchmark description.
- `benchmarks/README.md`: describe benchmark result files and caveats.
- `benchmarks/2026-05-14-hosted-clickhouse-query-results.md`: record sanitized results from this run.

## Alternatives Considered

- Add a brand-new benchmark command: rejected for this slice because the hosted demo command already handles auth, tenant route lookup, idempotent seeding, and temporary Rust API startup.
- Add query caches before measuring: rejected because the existing design explicitly measures before adding complexity.
- Publish direct W&B comparison numbers: rejected unless the same workload is run against W&B with the same query shapes and account/environment caveats.

## Review Notes

Fresh reviewer 1:

- Finding: Measurement protocol, expected result counts, hosted/internal budgets, reproducibility metadata, and optimization scope were underspecified.
- Risk: Fast zero-result queries or noisy hosted timing could be mistaken for product speed, and optimization could make the slice too broad.
- Recommended edit: Define warmups/samples/p95, preflight validation, hosted versus local budgets, result metadata, and make this PR measurement/report-only.
- Decision: Accepted and incorporated before implementation.

Fresh reviewer 2:

- Finding: Query coverage did not independently prove name/tag/notes/config search, missed running/finished status filters, had ambiguous chart path validation, and needed an allowlisted sanitized output schema.
- Risk: The benchmark could answer a narrower question than requested or leak sensitive hosted metadata.
- Recommended edit: Add independent fixture terms, all status filters, response-shape validation, preflight dataset validation, and explicit output allowlist/exclusions.
- Decision: Accepted and incorporated before implementation.

## Coverage Exceptions

None expected.

## Decision

Accepted after review revisions.
