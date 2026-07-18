# Castform Observability Demo Plan

Research date: 2026-06-30.

## Goal

Show how InstantML can provide a cross-run observability layer for Castform
training jobs: fast comparison, searchable run context, reward/debug evidence,
exports, and agent-assisted analysis.

This should feel collaborative, not competitive. Castform trains and inspects
individual RL jobs. InstantML helps teams understand a fleet of Castform runs.

## Demo Thesis

Castform already captures rich per-run training behavior. The collaboration
opportunity is to make that behavior easier to compare across many runs and
easier to preserve for model-selection decisions.

## Demo Data Shape

Use a RAG or trace-fine-tuning scenario because it matches Castform's public
docs and makes reward components concrete.

Run variants:

- `qwen3-4b-rag-grpo-lr1e-5-g9`
- `qwen3-4b-rag-grpo-lr3e-5-g9`
- `qwen3-4b-rag-grpo-lr1e-5-g6`
- `qwen3-8b-rag-grpo-lr1e-5-g9`
- a deliberately overfit run with train reward up and eval reward flat;
- a deliberately verbose run with rising response length;
- a sparse-reward run with solve rate stuck.

Metrics:

- `train/reward_mean`
- `train/reward_max`
- `train/solve_rate`
- `train/response_tokens_mean`
- `eval/reward_mean`
- `eval/reward_max`
- `eval/solve_rate`
- `comp/reward_delta_vs_baseline`
- `comp/inference_cost_index`
- `comp/baseline_inference_cost_index`
- `comp/cost_reduction_pct`
- `train/reward_components/correctness/mean`
- `train/reward_components/citation/mean`
- `train/reward_components/search_efficiency/mean`
- `eval/reward_components/*/mean`

Metadata:

- Castform run ID and URL.
- model, learning rate, batch size, group size, epochs, rollout length, max
  turns, LoRA rank/alpha.
- environment name, dataset hash/profile, trace/corpus source, reward version.
- tags: `castform`, `rag`, `trace-trained`, `candidate`, `overfit`,
  `verbose-regression`, or `best`.

Evidence:

- lifecycle events as text series or notes;
- selected environment logs as console/text records;
- evaluation summaries and checkpoint references as artifacts where available.

## Preferred Live Demo Flow

1. Castform context, 2 minutes.
   Start from their launch shape: environment + datasets + trainer parameters.
   Explain that we are not changing their launch path.

2. Mirror one Castform run, 2 minutes.
   Run `demo/castform/castform_instantml_adapter.py` against a Castform run ID. The
   script pulls metadata, scalar modes, lifecycle events, and environment logs,
   then logs them to an InstantML project.

3. Open InstantML Runs workspace, 4 minutes.
   Filter `tag:castform`. Sort by `eval/reward_mean` or `eval/solve_rate`.
   Show dense run table, tags, launcher args, notes, and run links.

4. Compare candidate runs, 5 minutes.
   Plot reward mean, solve rate, response length, and eval reward across 5-10
   runs. Call out the winning run and one failure mode:
   train reward rises while eval reward plateaus, or response length grows.

5. Debug evidence, 4 minutes.
   Open a run detail. Show Castform lifecycle events and environment log
   excerpts captured as evidence. Emphasize that Castform remains the raw
   rollout inspector; InstantML preserves selected evidence next to metrics and
   configs.

6. Export or agent analysis, 3 minutes.
   Export selected runs or use the MCP-style run analysis story:
   "find the best Castform run by eval solve rate and explain why the verbose
   candidate lost." This demonstrates why a durable cross-run store matters.

7. Integration roadmap, 5 minutes.
   Walk through pull sync now, webhook/observer next, and embedded/panel sharing
   later.

## Synthetic Fallback Flow

If live Castform credentials or a shareable run are not available, seed
Castform-shaped runs into InstantML:

```bash
INSTANTML_API_KEY=instantml_... \
PYTHONPATH=packages/python-sdk \
python3 demo/castform/seed_castform_demo.py --project castform-demo --runs 10
```

Then run the same InstantML UI flow. Be explicit that the data is synthetic but
the schema and failure modes are based on Castform's public monitoring docs.

## What To Show In The UI

Runs table:

- Search: `tag:castform`
- Filters/tags: `candidate`, `best`, `overfit`, `verbose-regression`
- Sort: best `eval/solve_rate` or `eval/reward_mean`

Charts:

- Reward mean by step across selected runs.
- Eval reward mean against train reward mean.
- Solve rate by step.
- Response length by step.
- Reward and inference-cost comparison against baseline/frontier models.
- Reward component breakdown: correctness, citation, search efficiency.

Run detail:

- Config panel with Castform launcher args.
- Notes containing the Castform run URL and source context.
- Console/text evidence for lifecycle events and logs.

Compare:

- Reference the selected best run.
- Diff launcher args: model, learning rate, group size, max turns.
- Show metric deltas, reward lift, cost-reduction index, and identify the
  likely decision.

## Success Criteria

By the end of the call, Castform should understand:

- the integration can start without changing their trainer;
- InstantML complements, rather than replaces, their run page;
- the first useful slice is small: run metadata, scalar curves, logs, and links;
- a deeper integration can make Castform observability exportable, comparable,
  and agent-readable.

## Non-Goals For This Demo

- Do not build Castform job control inside InstantML.
- Do not claim full raw rollout parity with Castform's inspector.
- Do not require Castform to expose private APIs for the first demo.
- Do not block on real checkpoint artifact downloads.
