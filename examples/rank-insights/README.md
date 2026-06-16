# Rank Insights Example

This example seeds a project named `rank-insights-research` with runs that
exercise:

- rank reducer charts
- rank heatmaps
- rank outlier and coverage panels
- grouped run reducers
- hyperparameter scatter and parallel-coordinate views
- K-means clustering
- evaluation metric cards

## Run

Start the Rust API first:

```bash
npm run dev:api
```

Then run the example from the repo root:

```bash
PYTHONPATH=packages/python-sdk python3 examples/rank-insights/train.py --server http://127.0.0.1:8000
```

`--server` defaults to the local API (`http://127.0.0.1:8000`); the example
never targets the hosted API unless you pass its URL explicitly.

Open the dashboard, choose the `rank-insights-research` project, and inspect the
`Distributed` and `Insights` tabs.

## Scale Projects

For larger local dogfood, seed multiple separate projects with thousands of
runs plus a few long rank-metric runs:

```bash
npm run example:rank-scale
```

Defaults:

- 3 projects: vision, language, and RL-shaped sweeps.
- 2,000 runs per project.
- 2 long rank-metric runs per project.
- Long runs use 10,000, 15,000, and 20,000 steps.
- Rank metrics use 8 ranks and three keys per rank/step.

Useful overrides:

```bash
INSTANTML_RANK_SCALE_RUNS=500 \
INSTANTML_RANK_SCALE_STEPS=2000,3000,4000 \
npm run example:rank-scale
```

The scale seeder writes product-shaped operational, scalar metric, and rank
metric rows directly to local ClickHouse so it can create millions of rows
without turning the SDK's per-step API into hundreds of thousands of tiny local
HTTP inserts. Restart a running local Rust API after this seed so the
operational index replays the new projects, then sign in with
`rank-scale@example.com`.

## Notes

`train.py` uses only the public Python SDK. `scale-projects.mjs` is a local
scale/dogfood seeder and intentionally uses direct ClickHouse inserts for bulk
data volume.
