# Agent MCP task benchmark

Measures how reliably an MCP-connected coding agent answers experiment-tracking
questions through the InstantML MCP server versus the W&B MCP server on
identical data. Committed results: `benchmarks/2026-07-13-agent-mcp-task-results.md`;
public summary: `apps/docs/guides/agent-mcp-benchmark.mdx`.

## Protocol

- `generate-dataset.mjs` builds a deterministic dataset (fixed seed): 30 PPO
  runs in `mcp-bench-cartpole` (3 failed) plus 3 distractor runs in a second
  project; 4 metric series, up to 120 steps per run. It also computes
  `ground-truth.json` (best run, top-3 ranking, per-optimizer averages,
  threshold crossings, config diffs) directly from the generated data.
- The same dataset is seeded to both trackers: `seed-instantml.mjs` (against a
  local dev backend) and `seed-wandb.py` (against W&B cloud; needs `wandb`
  installed and `WANDB_API_KEY` or `~/.netrc`).
- `run-bench.mjs` runs each task in `tasks.json` as an isolated headless
  `claude -p` session (`--strict-mcp-config`, so exactly one MCP server is
  visible), identical prompts on both sides, and stores the full stream-json
  transcript under `runs/`.
- `grade.mjs` scores final answers against ground truth (regex/order graders,
  no LLM judge) and counts tool calls, tool errors, turns, output tokens, and
  wall time per task.

## Run it

```bash
node generate-dataset.mjs
node seed-instantml.mjs http://127.0.0.1:8077   # local dev backend; mints an API key
WANDB_API_KEY=... python3 seed-wandb.py

INSTANTML_API_KEY=instantml_... node run-bench.mjs instantml
WANDB_API_KEY=... node run-bench.mjs wandb
TRIAL=2 INSTANTML_API_KEY=... node run-bench.mjs instantml   # repeat trials
node grade.mjs
```

`run-bench.mjs` needs the `claude` CLI on PATH and a directory for
`tools/mcp-server.mjs` where `@modelcontextprotocol/sdk` resolves (the repo
worktree after `npm install`, or set `INSTANTML_MCP_SERVER` to a standalone
copy).

## Fairness notes

- Both sides are public, documented MCP servers; the agent, model, prompts,
  grading, and dataset are identical. Only the server differs.
- Wall time is not comparable when the InstantML server runs locally and the
  W&B server is hosted — do not publish latency from this harness unless both
  sides run hosted in the same pass.
- W&B seeding writes to an external SaaS: seed a scratch entity, and sanitize
  transcripts (they contain entity names) before sharing raw output.
- The tasks are read/analysis only. Report writing, artifacts, sweeps, and
  Weave traces are out of scope for this harness.
