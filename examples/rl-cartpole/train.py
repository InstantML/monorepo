"""Deterministic RL-style logging example for the bootstrap SDK."""

from __future__ import annotations

import argparse
import math

import rl_observability as ro


def generate_metrics(step: int, seed: int) -> dict[str, float]:
    reward = 20.0 + step * 1.5 + math.sin(seed + step / 3.0) * 2.0
    loss = max(0.01, 1.0 / (step + 1))
    return {
        "train/reward": round(reward, 4),
        "train/loss": round(loss, 4),
        "eval/return_mean": round(reward * 1.08, 4),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Log a deterministic RL-style example run")
    parser.add_argument("--server", default="http://127.0.0.1:8000", help="Training Observability API URL")
    parser.add_argument("--seed", default=42, type=int, help="Deterministic seed value")
    parser.add_argument("--steps", default=10, type=int, help="Number of training steps to log")
    parser.add_argument("--upload-mode", choices=["sync", "spool"], default="sync", help="Post-init SDK upload mode")
    parser.add_argument("--spool-dir", default=".rlobs/spool", help="Process uploader spool directory")
    args = parser.parse_args()

    run = ro.init(
        project="cartpole",
        name=f"cartpole-seed-{args.seed}",
        config={"env": "CartPole-v1", "algo": "example-policy", "seed": args.seed},
        tags=["example", "rl"],
        notes="CartPole SDK smoke run for checking reward trends and ingestion health.",
        base_url=args.server,
        upload_mode=args.upload_mode,
        spool_dir=args.spool_dir,
    )
    for step in range(args.steps):
        run.log(generate_metrics(step, args.seed), step=step)
    run.finish()


if __name__ == "__main__":  # pragma: no cover
    main()
