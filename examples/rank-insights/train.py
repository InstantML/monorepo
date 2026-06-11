"""Seed rank-aware research dashboards through the public InstantML SDK."""

from __future__ import annotations

import argparse
import math
import random

import instantml as ro


PROJECT = "rank-insights-research"
WORLD_SIZE = 8
STEPS = 60


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed rank-aware research dashboard runs")
    # Examples must never default to the hosted API: without this flag the SDK
    # falls back to https://api.instantml.ai and sends INSTANTML_API_KEY there.
    parser.add_argument("--server", default="http://127.0.0.1:8000", help="Training Observability API URL")
    args = parser.parse_args()

    random.seed(20260523)
    for run_index in range(12):
        config = {
            "seed": run_index,
            "optimizer": {"lr": 0.0008 + run_index * 0.00012},
            "width": 128 + (run_index % 4) * 64,
            "dropout": round(0.05 * (run_index % 3), 3),
        }
        tags = ["rank-demo", "wide" if config["width"] >= 256 else "compact"]
        run = ro.init(
            project=PROJECT,
            name=f"rank-insights-{run_index:02d}",
            config=config,
            tags=tags,
            notes="Synthetic rank-aware dashboard seed run.",
            base_url=args.server,
        )
        try:
            for step in range(STEPS):
                progress = step / max(1, STEPS - 1)
                base_loss = 1.2 - progress * (0.55 + run_index * 0.015) + config["dropout"] * 0.25
                eval_accuracy = 0.52 + progress * (0.32 + run_index * 0.006) - config["dropout"] * 0.04
                run.log_metrics(
                    {
                        "train/loss": base_loss,
                        "eval/accuracy": min(0.98, eval_accuracy),
                        "eval/f1": min(0.97, eval_accuracy - 0.035),
                        "eval/precision": min(0.98, eval_accuracy - 0.015),
                        "eval/recall": min(0.98, eval_accuracy - 0.055),
                        "eval/auc": min(0.99, eval_accuracy + 0.045),
                        "system/tokens_per_second": 2100 + run_index * 35 - config["dropout"] * 120,
                    },
                    step=step,
                )
                if run_index < 4:
                    for rank in range(WORLD_SIZE):
                        shard_bias = (rank - (WORLD_SIZE - 1) / 2) * 0.012
                        outlier = 0.18 if run_index == 1 and rank == 6 and step > STEPS * 0.65 else 0.0
                        local_loss = base_loss + shard_bias + outlier + math.sin(step / 7 + rank) * 0.01
                        batch_size = 28 if rank == 7 and step % 9 == 0 else 32
                        run.log_rank_metrics(
                            {"train/loss": local_loss, "system/rank_tokens_per_second": 250 + rank * 3 - outlier * 120},
                            step=step,
                            rank=rank,
                            world_size=WORLD_SIZE,
                            local_rank=rank % 4,
                            weight=batch_size,
                        )
            run.finish()
        except Exception:
            run.finish("failed")
            raise


if __name__ == "__main__":
    main()
