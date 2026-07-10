"""Agent-RL tracing dogfood example for InstantML.

A GRPO-style tool-agent loop that exercises every production telemetry
surface in one run: rollout traces with nested model/tool/reward spans,
step metrics, per-rank distributed metrics, console logs, checkpoint
artifacts, file artifacts, and a stepless evaluation trace.

A configurable "tool outage" window injects a cluster of failed rollouts
with a correlated reward dip, which is exactly the shape the run
workspace trace x metric timeline is built to surface.

The toy agent is deterministic and standard-library only.
"""

from __future__ import annotations

import argparse
import json
import math
import random
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import instantml as im
from instantml import InstantMLError

PROMPTS = (
    "What is the population of France divided by the area of Texas?",
    "Book a table for 4 at a highly rated sushi place near SoMa.",
    "Summarize the attached quarterly report and flag anomalies.",
    "Convert 1500 USD to JPY using today's rate.",
    "Plan a 3-day Kyoto itinerary under $900.",
)


@dataclass(frozen=True)
class TrainConfig:
    project: str = "agent-rl-tracing"
    steps: int = 30
    world_size: int = 4
    outage_start: int = 18
    outage_end: int = 22
    checkpoint_every: int = 10
    tool_failure_rate: float = 0.6
    seed: int = 11

    def outage_steps(self) -> range:
        return range(self.outage_start, self.outage_end + 1)


class ToolOutageError(RuntimeError):
    """Raised when the simulated tool backend times out."""


def rubric_score(step: int, config: TrainConfig, rng: random.Random, degraded: bool) -> float:
    base = 0.55 + 0.35 * (1 - math.exp(-step / 9.0))
    if degraded:
        base -= 0.38
    return round(max(0.02, min(0.98, base + rng.uniform(-0.06, 0.06))), 4)


def length_penalty(completion: str) -> float:
    return round(min(len(completion) / 2048.0, 1.0), 4)


def run_rollout(
    run: Any,
    config: TrainConfig,
    rng: random.Random,
    step: int,
    group: int,
    fail_tool: bool,
) -> float:
    prompt = PROMPTS[(step + group) % len(PROMPTS)]
    degraded = step in config.outage_steps()
    with run.trace(
        f"rollout.step{step}.g{group}",
        kind="rollout",
        step=step,
        rollout_id=f"step{step}-g{group}",
        capture="preview",
        inputs={"prompt": prompt, "temperature": 0.7},
        attributes={"policy": "qwen2.5-7b", "group": group},
    ) as rollout:
        with rollout.span(
            "policy.generate",
            kind="model",
            capture="preview",
            inputs={"messages": [{"role": "user", "content": prompt}]},
            metrics={
                "gen_ai.usage.input_tokens": 96 + group * 13,
                "gen_ai.usage.output_tokens": 180 + step * 7,
            },
        ) as generation:
            completion = f"<plan>step {step}</plan> Tool plan for: {prompt[:40]}"
            generation.set_output({"completion": completion, "finish_reason": "tool_use"})
        with rollout.span(
            "tool.calculator",
            kind="tool",
            capture="preview",
            inputs={"expression": "67_800_000 / 695_662"},
        ) as tool:
            if fail_tool:
                raise ToolOutageError("calculator backend timed out after 30s")
            tool.set_output({"value": 97.46})
        with rollout.span(
            "reward.rubric_score",
            kind="reward",
            capture="preview",
            attributes={"rubric": "helpfulness-v2"},
        ) as scorer:
            score = rubric_score(step, config, rng, degraded)
            scorer.set_output({"reward": score})
        penalty = length_penalty(completion)
        reward = round(score - penalty, 4)
        rollout.log_metric({"reward.final": reward})
        rollout.set_output({"reward": score, "penalty": penalty})
        return reward


def train_step(run: Any, config: TrainConfig, rng: random.Random, step: int) -> dict[str, Any]:
    outage = step in config.outage_steps()
    rollouts = rng.randint(2, 4)
    rewards: list[float] = []
    failures = 0
    for group in range(rollouts):
        fail_tool = outage and rng.random() < config.tool_failure_rate
        try:
            rewards.append(run_rollout(run, config, rng, step, group, fail_tool))
        except ToolOutageError:
            failures += 1
            rewards.append(0.02)
    metrics = {
        "reward/mean": round(sum(rewards) / len(rewards), 4),
        "kl": round(rng.uniform(0.002, 0.02) + (0.03 if outage else 0.0), 5),
        "loss": round(1.8 * math.exp(-step / 11.0) + rng.uniform(-0.03, 0.03) + (0.25 if outage else 0.0), 4),
    }
    run.log(metrics, step=step)
    for rank in range(config.world_size):
        run.log_rank_metrics(
            {
                "grad_norm": round(1.1 + 0.2 * math.sin(step / 3.0 + rank) + (0.6 if outage else 0.0), 4),
                "tokens_per_second": round(2400 - rank * 55 + rng.uniform(-40, 40) - (350 if outage else 0.0), 1),
            },
            step=step,
            rank=rank,
            world_size=config.world_size,
        )
    run.log_console(f"step {step}: {rollouts} rollouts, reward/mean={metrics['reward/mean']}")
    if failures:
        run.log_console(
            f"step {step}: {failures}/{rollouts} rollouts hit calculator timeouts",
            stream="stderr",
        )
    return {"step": step, "rollouts": rollouts, "failures": failures, **metrics}


def save_checkpoint(path: Path, config: TrainConfig, step: int, reward_mean: float) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "format": "instantml-agent-rl-tracing-v1",
        "step": step,
        "reward_mean": reward_mean,
        "config": asdict(config),
    }
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return path


def upload_disabled(error: InstantMLError) -> bool:
    return "uploads are disabled" in str(error)


def log_checkpoint_artifact(run: Any, path: Path, step: int, reward_mean: float) -> dict[str, Any]:
    """Upload checkpoint bytes; fall back to a metadata-only artifact when the
    deployment has byte uploads disabled."""
    metadata = {"framework": "json", "reward_mean": reward_mean}
    try:
        return run.log_checkpoint_file(str(path), step=step, metadata=metadata)
    except InstantMLError as error:
        if not upload_disabled(error):
            raise
        run.log_console(
            f"step {step}: artifact byte uploads disabled; recording checkpoint metadata only",
            stream="stderr",
        )
        return run.log_checkpoint(
            name=path.name,
            uri=path.resolve().as_uri(),
            step=step,
            size_bytes=path.stat().st_size,
            metadata=metadata,
        )


def log_report_artifact(run: Any, path: Path, step: int) -> dict[str, Any]:
    try:
        return run.upload_file(str(path), name=path.name, step=step)
    except InstantMLError as error:
        if not upload_disabled(error):
            raise
        run.log_console(
            f"step {step}: artifact byte uploads disabled; recording {path.name} metadata only",
            stream="stderr",
        )
        return run.log_file(
            name=path.name,
            uri=path.resolve().as_uri(),
            step=step,
            size_bytes=path.stat().st_size,
        )


def run_training(run: Any, config: TrainConfig, artifact_dir: Path) -> dict[str, Any]:
    rng = random.Random(config.seed)
    step_summaries: list[dict[str, Any]] = []
    checkpoints: list[dict[str, Any]] = []
    for step in range(1, config.steps + 1):
        summary = train_step(run, config, rng, step)
        step_summaries.append(summary)
        if step % config.checkpoint_every == 0:
            checkpoint_path = save_checkpoint(
                artifact_dir / f"policy-step-{step}.json", config, step, summary["reward/mean"]
            )
            artifact = log_checkpoint_artifact(run, checkpoint_path, step, summary["reward/mean"])
            checkpoints.append({"step": step, "artifact_id": artifact.get("id")})

    report_path = artifact_dir / "eval-report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "steps": len(step_summaries),
        "failed_rollouts": sum(s["failures"] for s in step_summaries),
        "final_reward_mean": step_summaries[-1]["reward/mean"],
    }
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    report_artifact = log_report_artifact(run, report_path, config.steps)

    # A stepless evaluation trace: the timeline should report it in the
    # run-wide totals without granting it a step bucket.
    with run.trace(
        "eval.holdout_summary",
        kind="evaluator",
        capture="preview",
        inputs={"suite": "holdout-20"},
    ) as evaluation:
        evaluation.set_output(report)

    return {
        "steps": step_summaries,
        "checkpoints": checkpoints,
        "eval_report_artifact_id": report_artifact.get("id"),
        "failed_rollouts": report["failed_rollouts"],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="InstantML agent-RL tracing dogfood example")
    parser.add_argument("--server", default="http://127.0.0.1:8000")
    parser.add_argument("--api-key", default=None)
    parser.add_argument("--project", default="agent-rl-tracing")
    parser.add_argument("--name", default="grpo-tool-agent")
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--world-size", type=int, default=4)
    parser.add_argument("--outage-start", type=int, default=18)
    parser.add_argument("--outage-end", type=int, default=22)
    parser.add_argument("--checkpoint-every", type=int, default=10)
    parser.add_argument("--seed", type=int, default=11)
    parser.add_argument("--artifact-dir", type=Path, default=Path(".instantml/agent-rl-tracing"))
    parser.add_argument("--summary-json", type=Path, default=None)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = TrainConfig(
        project=args.project,
        steps=args.steps,
        world_size=args.world_size,
        outage_start=args.outage_start,
        outage_end=args.outage_end,
        checkpoint_every=args.checkpoint_every,
        seed=args.seed,
    )
    client = im.Client(base_url=args.server, api_key=args.api_key)
    run = client.init(
        project=config.project,
        name=args.name,
        config={**asdict(config), "model": "qwen2.5-7b", "lr": 1e-5},
        tags=["rl", "tracing-demo", "correlation"],
        metadata={"example": "agent-rl-tracing"},
    )
    try:
        summary = run_training(run, config, args.artifact_dir)
        run.finish()
    except Exception:
        run.finish("failed")
        raise

    result = {
        "run_id": run.run_id,
        "project": config.project,
        "checkpoints": summary["checkpoints"],
        "failed_rollouts": summary["failed_rollouts"],
        "eval_report_artifact_id": summary["eval_report_artifact_id"],
    }
    if args.summary_json:
        args.summary_json.parent.mkdir(parents=True, exist_ok=True)
        args.summary_json.write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
    else:
        print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
