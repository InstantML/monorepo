# Benchmarks

Benchmark result summaries live here when they are useful for product or performance decisions. Keep committed reports sanitized: no ClickHouse credentials, raw endpoint URLs, cookies, API keys, org IDs, user IDs, or signed artifact URLs.

## Hosted ClickHouse Query Benchmark

Use the hosted demo script from the repo root:

```bash
INSTANTML_HOSTED_DEMO_ALLOW_PROVISION=1 \
INSTANTML_HOSTED_DEMO_RESULT_PATH=/tmp/instantml-hosted-clickhouse-query-benchmark.json \
npm run benchmark:hosted-demo
```

The script signs in as the shared `hello@instantml.ai` demo account, reuses the existing tenant route when present, verifies the 100,000-run project seed, warms each route, then measures the dashboard query shapes documented in `docs/design/2026-05-14-hosted-clickhouse-query-benchmarks.md`.

The committed Markdown summaries should include:

- commit and branch tested
- project and dataset sizes
- warmup/sample counts
- ClickHouse provider/region and endpoint host only
- p50/p95/min/max per endpoint
- whether hosted budgets passed

Do not commit the optional JSON output unless it has been reviewed for the same sanitization rules.
