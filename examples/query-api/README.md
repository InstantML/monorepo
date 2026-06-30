# Query API Example

This example seeds a small deterministic project and then uses the public
Python SDK query helpers to read it back.

## Setup

From the repository root:

```bash
export INSTANTML_API_KEY="instantml_..."
PYTHONPATH=packages/python-sdk python examples/query-api/query.py \
  --server http://127.0.0.1:8000
```

Use `--skip-seed` to query an existing project without creating runs.

## What It Exercises

- `Api.query_runs()` over the shared dashboard `q` language.
- `Api.iter_runs()` lazy pagination.
- `Api.query_metrics()` for bounded multi-run metric reads.
- `Api.query_objects(run_id=...)` on the single-run object fallback path.
- `Api.object_rows()` for table preview rows.

The default seed creates 20 short runs in project `query-api-demo`, logs
`train/loss`, `eval/score`, and one `eval/samples` table object per run, then
prints a compact JSON summary.

## Testing

The example has no model dependency. It needs a reachable InstantML API and an
API key with SDK ingest plus read/export scopes.
