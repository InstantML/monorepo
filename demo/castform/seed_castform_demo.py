#!/usr/bin/env python3
"""Seed Castform-shaped synthetic runs into InstantML for the call demo."""

from __future__ import annotations

import argparse
import math
import os
import random
from datetime import datetime, timezone


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"{name} is required")
    return value


def _curve(step: int, *, ceiling: float, speed: float, noise: float, rng: random.Random) -> float:
    base = ceiling * (1.0 - math.exp(-step / speed))
    return max(0.0, min(1.0, base + rng.uniform(-noise, noise)))


def _run_profile(index: int) -> dict[str, object]:
    profiles = [
        {
            "suffix": "best-balanced",
            "model": "Qwen/Qwen3.5-4B",
            "learning_rate": 1e-5,
            "group_size": 9,
            "tags": ["candidate", "best"],
            "reward_ceiling": 0.86,
            "eval_gap": 0.04,
            "length_drift": -0.20,
        },
        {
            "suffix": "fast-overfit",
            "model": "Qwen/Qwen3.5-4B",
            "learning_rate": 3e-5,
            "group_size": 9,
            "tags": ["candidate", "overfit"],
            "reward_ceiling": 0.91,
            "eval_gap": 0.22,
            "length_drift": -0.05,
        },
        {
            "suffix": "verbose-regression",
            "model": "Qwen/Qwen3.5-4B",
            "learning_rate": 1e-5,
            "group_size": 6,
            "tags": ["candidate", "verbose-regression"],
            "reward_ceiling": 0.80,
            "eval_gap": 0.09,
            "length_drift": 0.45,
        },
        {
            "suffix": "sparse-reward",
            "model": "Qwen/Qwen3.5-8B",
            "learning_rate": 8e-6,
            "group_size": 9,
            "tags": ["candidate", "sparse-reward"],
            "reward_ceiling": 0.58,
            "eval_gap": 0.08,
            "length_drift": 0.05,
        },
    ]
    profile = dict(profiles[index % len(profiles)])
    profile["seed"] = 1000 + index
    return profile


def seed_runs(
    *,
    project: str,
    runs: int,
    steps: int,
    api_key: str,
    base_url: str | None,
) -> list[str]:
    import instantml as im

    run_ids: list[str] = []
    for i in range(runs):
        profile = _run_profile(i)
        rng = random.Random(int(profile["seed"]))
        castform_run_id = f"demo-castform-{i + 1:03d}"
        run_name = f"castform-rag-grpo-{profile['suffix']}-{i + 1:02d}"
        config = {
            "castform": {
                "run_id": castform_run_id,
                "url": f"https://app.castform.com/train/{castform_run_id}",
                "source": "synthetic demo seed",
                "mirrored_at": datetime.now(timezone.utc).isoformat(),
            },
            "launcher_args": {
                "model": profile["model"],
                "learning_rate": profile["learning_rate"],
                "num_epochs": 5,
                "batch_size": 14,
                "group_size": profile["group_size"],
                "max_rollout_len": 4000,
                "max_turns": 6,
                "lora_rank": 128,
                "lora_alpha": 256,
            },
            "environment": {
                "name": "RagTraceSearchEnv",
                "reward_version": "demo-v2",
                "dataset": "support-trace-rag-sample",
            },
        }
        tags = ["castform", "mirrored", "rag", *profile["tags"]]
        notes = (
            "Synthetic Castform-shaped run for collaboration demo.\n"
            f"Source run: https://app.castform.com/train/{castform_run_id}"
        )
        init_kwargs = {
            "project": project,
            "name": run_name,
            "config": config,
            "tags": tags,
            "notes": notes,
            "api_key": api_key,
            "upload_mode": "sync",
        }
        if base_url:
            init_kwargs["base_url"] = base_url
        run = im.init(**init_kwargs)
        run_ids.append(run.run_id)

        reward_ceiling = float(profile["reward_ceiling"])
        eval_gap = float(profile["eval_gap"])
        length_drift = float(profile["length_drift"])
        for step in range(0, steps + 1, 10):
            train_reward = _curve(step, ceiling=reward_ceiling, speed=95, noise=0.025, rng=rng)
            if "overfit" in profile["tags"] and step > steps * 0.45:
                eval_reward = max(0.0, train_reward - eval_gap - (step / steps) * 0.10)
            else:
                eval_reward = max(0.0, train_reward - eval_gap + rng.uniform(-0.015, 0.015))
            solve_rate = _curve(step, ceiling=min(0.95, reward_ceiling + 0.06), speed=70, noise=0.02, rng=rng)
            eval_solve = max(0.0, min(1.0, solve_rate - eval_gap + rng.uniform(-0.02, 0.02)))
            response_tokens = 820 + int(260 * math.exp(-step / 120)) + int(length_drift * step)

            correctness = max(0.0, min(1.0, train_reward + rng.uniform(-0.02, 0.02)))
            citation = max(0.0, min(1.0, train_reward - 0.10 + rng.uniform(-0.03, 0.03)))
            search_efficiency = max(0.0, min(1.0, 1.0 - response_tokens / 1500 + rng.uniform(-0.03, 0.03)))

            run.log(
                {
                    "train/reward_mean": train_reward,
                    "train/reward_max": min(1.0, train_reward + 0.10),
                    "train/solve_rate": solve_rate,
                    "train/response_tokens_mean": response_tokens,
                    "eval/reward_mean": eval_reward,
                    "eval/reward_max": min(1.0, eval_reward + 0.09),
                    "eval/solve_rate": eval_solve,
                    "train/reward_components/correctness/mean": correctness,
                    "train/reward_components/citation/mean": citation,
                    "train/reward_components/search_efficiency/mean": search_efficiency,
                    "eval/reward_components/correctness/mean": max(0.0, correctness - eval_gap),
                    "eval/reward_components/citation/mean": max(0.0, citation - eval_gap),
                    "eval/reward_components/search_efficiency/mean": search_efficiency,
                },
                step=step,
            )

        run.log_text(
            {
                "castform/events": (
                    "training.created\n"
                    "training.gpu_warmup\n"
                    "training.metrics_streaming\n"
                    "training.eval_checkpoint\n"
                    "training.completed"
                ),
                "castform/environment_logs": (
                    "reward gate: answer tag parsed\n"
                    "tool search returned 4 candidate passages\n"
                    "judge score: correctness/citation/search_efficiency recorded"
                ),
            },
            step=steps,
        )
        run.log_stdout(
            [
                f"{castform_run_id} environment initialized",
                "sample rollout scored correctness=0.83 citation=0.71 search_efficiency=0.64",
                "eval checkpoint completed",
            ]
        )
        run.finish()

    return run_ids


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed synthetic Castform-shaped InstantML runs")
    parser.add_argument("--project", default="castform-demo")
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--steps", type=int, default=240)
    parser.add_argument("--instantml-base-url")
    args = parser.parse_args()

    run_ids = seed_runs(
        project=args.project,
        runs=args.runs,
        steps=args.steps,
        api_key=_require_env("INSTANTML_API_KEY"),
        base_url=args.instantml_base_url,
    )
    print("Seeded InstantML runs:")
    for run_id in run_ids:
        print(f"- {run_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
