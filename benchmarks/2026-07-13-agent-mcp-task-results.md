# Agent MCP task benchmark — July 13, 2026

Harness: `benchmarks/agent-mcp/`. Public summary: `apps/docs/guides/agent-mcp-benchmark.mdx`.

Same deterministic dataset (30 runs + 3 distractor runs, 4 metric series, seed
20260708) seeded to a local InstantML dev backend and to W&B cloud; identical
data spot-verified through the W&B public API. Agent: headless Claude Code
(`claude -p`), model `claude-sonnet-5`, `--strict-mcp-config`, max 30 turns,
8 read/analysis tasks with computed ground truth, 3 trials per side (n=24
task-runs per side). InstantML MCP server ran from `tools/mcp-server.mjs`
against the local backend; W&B used the hosted `https://mcp.withwandb.com/mcp`.

## Totals (3 trials x 8 tasks per side)

| Metric | InstantML MCP | W&B MCP |
| --- | ---: | ---: |
| Correct answers | 24 / 24 | 21 / 24 |
| Average task score | 1.00 | 0.90 |
| Tool calls (incl. 1 ToolSearch/task) | 80 | 106 |
| Failed tool calls | 0 | 1 (recovered) |
| Output tokens | 19,099 | 24,054 |

Wall time was 376 s vs 473 s but is NOT publishable: the InstantML server ran
locally while W&B's ran hosted, and some trials ran concurrently. Rerun both
hosted in one pass before making any latency claim.

## Per-task scores across trials [t1, t2, t3]

| Task | InstantML | W&B |
| --- | --- | --- |
| count_runs | 1, 1, 1 | 1, 1, 1 |
| count_failed | 1, 1, 1 | 1, 1, 1 |
| best_run | 1, 1, 1 | 1, 1, 1 |
| best_lr | 1, 1, 1 | 1, 1, 1 |
| top3 | 1, 1, 1 | 0.67, 1, 1 |
| optimizer_avg | 1, 1, 1 | 1, 1, 1 |
| loss_threshold_step | 1, 1, 1 | 0, 0, 1 |
| config_diff | 1, 1, 1 | 1, 1, 1 |

## Failure analysis

Both W&B failure modes were in-context data processing after correct raw
fetches; the W&B platform itself returned correct data both times (verified
via `wandb.Api` after the runs):

- `top3` (1/3 trials): the agent fetched all 30 runs' `summaryMetrics` via
  hand-written GraphQL through `query_wandb_tool` and ranked them in-context,
  dropping the true #3 (415.1) for a 404.1 run.
- `loss_threshold_step` (2/3 trials): the agent pulled the full 120-row
  `train/loss` history (correct: first < 0.5 at step 40) and misread the table,
  answering 37 in one trial and 39 in another.

On the same questions the InstantML agent used server-computed results
(`tracker.list_runs` with `sort_by: "metric-best"` / `"metric-latest"`,
`tracker.query_metrics`, `tracker.compare_runs`) and in one trial
`tracker.export_runs` plus a local script for the per-optimizer average, and
made no in-context processing errors.

## Caveats

- 8 read/analysis tasks, 3 trials, one model. Small n; treat as directional.
- No report-writing, artifact, sweep, or Weave-trace tasks.
- Latency not measured (see above).
- W&B's MCP server had essentially clean tool-call reliability (one transient
  error, recovered). The gap is answer quality per token, not availability.
