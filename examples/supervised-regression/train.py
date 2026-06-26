"""Supervised regression example that logs multiple runs through the SDK."""

from __future__ import annotations

import argparse
import json
import math
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import instantml as im

try:  # NumPy is optional; the pure-Python path keeps this example portable.
    import numpy as np
except ImportError:  # pragma: no cover - exercised only when NumPy is absent locally.
    np = None


@dataclass(frozen=True)
class ExperimentConfig:
    name: str
    learning_rate: float
    l2: float
    epochs: int = 30
    features: int = 8
    train_examples: int = 180
    validation_examples: int = 80


CONFIGS = (
    ExperimentConfig(name="baseline", learning_rate=0.045, l2=0.0005),
    ExperimentConfig(name="regularized", learning_rate=0.035, l2=0.008),
    ExperimentConfig(name="fast-lr", learning_rate=0.075, l2=0.0005),
)


def build_dataset(seed: int, examples: int, features: int) -> tuple[list[list[float]], list[float]]:
    rng = random.Random(seed)
    true_weights = [1.4 / (index + 1) * (1 if index % 2 == 0 else -1) for index in range(features)]
    rows: list[list[float]] = []
    targets: list[float] = []
    for _ in range(examples):
        row = [rng.gauss(0.0, 1.0) for _ in range(features)]
        nonlinear = 0.25 * math.sin(row[0]) - 0.15 * row[1] * row[2]
        noise = rng.gauss(0.0, 0.08)
        target = sum(value * weight for value, weight in zip(row, true_weights)) + nonlinear + noise
        rows.append(row)
        targets.append(target)
    return rows, targets


def train_one_epoch(
    weights: list[float],
    bias: float,
    rows: list[list[float]],
    targets: list[float],
    learning_rate: float,
    l2: float,
) -> tuple[list[float], float, float]:
    count = len(rows)
    errors = [predict_one(weights, bias, row) - target for row, target in zip(rows, targets)]
    grad_weights = []
    for index in range(len(weights)):
        grad = sum(error * row[index] for error, row in zip(errors, rows)) * (2.0 / count)
        grad_weights.append(grad + 2.0 * l2 * weights[index])
    grad_bias = sum(errors) * (2.0 / count)
    next_weights = [weight - learning_rate * grad for weight, grad in zip(weights, grad_weights)]
    next_bias = bias - learning_rate * grad_bias
    grad_norm = math.sqrt(sum(grad * grad for grad in grad_weights) + grad_bias * grad_bias)
    return next_weights, next_bias, grad_norm


def evaluate(weights: list[float], bias: float, rows: list[list[float]], targets: list[float]) -> dict[str, float]:
    predictions = [predict_one(weights, bias, row) for row in rows]
    residuals = [prediction - target for prediction, target in zip(predictions, targets)]
    mse = sum(error * error for error in residuals) / len(residuals)
    mean_target = sum(targets) / len(targets)
    total_variance = sum((target - mean_target) ** 2 for target in targets)
    residual_variance = sum(error * error for error in residuals)
    r2 = 1.0 - residual_variance / total_variance if total_variance else 0.0
    return {
        "loss": mse,
        "rmse": math.sqrt(mse),
        "mae": sum(abs(error) for error in residuals) / len(residuals),
        "r2": r2,
    }


def predict_one(weights: list[float], bias: float, row: list[float]) -> float:
    return bias + sum(value * weight for value, weight in zip(row, weights))


def run_experiment(
    config: ExperimentConfig,
    seed: int,
    server: str,
    artifact_metadata: bool,
) -> dict[str, Any]:
    train_rows, train_targets, val_rows, val_targets = make_split(seed, config)
    weights, bias = initial_parameters(seed, config.features)
    run = None
    try:
        run = im.init(
            project="supervised-regression",
            name=f"{config.name}-seed-{seed}",
            config={
                "task": "synthetic tabular regression",
                "optimizer": "full-batch-gradient-descent",
                "seed": seed,
                "learning_rate": config.learning_rate,
                "l2": config.l2,
                "epochs": config.epochs,
                "features": config.features,
                "backend": "numpy" if np is not None else "standard-library",
            },
            tags=["example", "supervised", config.name],
            notes=f"Regression run for {config.name}: compare validation loss, R2, and artifact quality.",
            metadata={"example": "examples/supervised-regression", "artifact_metadata": artifact_metadata},
            base_url=server,
        )

        final_metrics = {}
        checkpoint_epochs = {max(1, config.epochs // 2), config.epochs}
        for epoch in range(1, config.epochs + 1):
            weights, bias, grad_norm = train_one_epoch(weights, bias, train_rows, train_targets, config.learning_rate, config.l2)
            train_metrics = evaluate(weights, bias, train_rows, train_targets)
            val_metrics = evaluate(weights, bias, val_rows, val_targets)
            final_metrics = flatten_metrics(train_metrics, val_metrics, grad_norm, weights)
            run.log(final_metrics, step=epoch)
            if artifact_metadata and epoch in checkpoint_epochs:
                run.log_checkpoint(
                    name=f"{config.name}-seed-{seed}-epoch-{epoch}.json",
                    uri=f"example://supervised-regression/{config.name}/seed-{seed}/epoch-{epoch}.json",
                    step=epoch,
                    size_bytes=estimate_checkpoint_size(weights),
                    metadata={"val_loss": round(val_metrics["loss"], 6), "val_r2": round(val_metrics["r2"], 6)},
                )

        if artifact_metadata:
            run.log_artifact(
                name=f"{config.name}-seed-{seed}-summary.json",
                uri=f"example://supervised-regression/{config.name}/seed-{seed}/summary.json",
                size_bytes=1024,
                metadata={"final_val_loss": round(final_metrics["val/loss"], 6), "epochs": config.epochs},
            )
            run.log_rollout(
                name=f"{config.name}-seed-{seed}-prediction-scan",
                uri=f"example://supervised-regression/{config.name}/seed-{seed}/prediction-scan.jsonl",
                step=config.epochs,
                size_bytes=2048,
                metadata={"return": round(final_metrics["val/r2"], 4), "kind": "prediction-vs-target"},
            )

        run.finish()
        return {
            "name": f"{config.name}-seed-{seed}",
            "run_id": run.run_id,
            "final_val_loss": final_metrics["val/loss"],
            "final_val_r2": final_metrics["val/r2"],
        }
    except Exception:
        if run is not None:
            run.finish("failed")
        raise


def make_split(
    seed: int,
    config: ExperimentConfig,
) -> tuple[list[list[float]], list[float], list[list[float]], list[float]]:
    train_rows, train_targets = build_dataset(seed, config.train_examples, config.features)
    val_rows, val_targets = build_dataset(seed + 10_000, config.validation_examples, config.features)
    if np is None:
        return train_rows, train_targets, val_rows, val_targets
    return numpy_to_lists(train_rows, train_targets, val_rows, val_targets)


def numpy_to_lists(
    train_rows: list[list[float]],
    train_targets: list[float],
    val_rows: list[list[float]],
    val_targets: list[float],
) -> tuple[list[list[float]], list[float], list[list[float]], list[float]]:
    train_x = np.asarray(train_rows, dtype=float)
    train_y = np.asarray(train_targets, dtype=float)
    val_x = np.asarray(val_rows, dtype=float)
    val_y = np.asarray(val_targets, dtype=float)
    return train_x.tolist(), train_y.tolist(), val_x.tolist(), val_y.tolist()


def initial_parameters(seed: int, features: int) -> tuple[list[float], float]:
    rng = random.Random(seed + 777)
    return [rng.uniform(-0.05, 0.05) for _ in range(features)], 0.0


def flatten_metrics(
    train_metrics: dict[str, float],
    val_metrics: dict[str, float],
    grad_norm: float,
    weights: list[float],
) -> dict[str, float]:
    return {
        "train/loss": round(train_metrics["loss"], 6),
        "train/rmse": round(train_metrics["rmse"], 6),
        "train/mae": round(train_metrics["mae"], 6),
        "val/loss": round(val_metrics["loss"], 6),
        "val/rmse": round(val_metrics["rmse"], 6),
        "val/mae": round(val_metrics["mae"], 6),
        "val/r2": round(val_metrics["r2"], 6),
        "optimizer/grad_norm": round(grad_norm, 6),
        "model/weight_norm": round(math.sqrt(sum(weight * weight for weight in weights)), 6),
    }


def estimate_checkpoint_size(weights: list[float]) -> int:
    return len(json.dumps({"weights": weights, "bias": 0.0}).encode("utf-8"))


def parse_seeds(raw: str) -> list[int]:
    seeds = [int(value.strip()) for value in raw.split(",") if value.strip()]
    if not seeds:
        raise argparse.ArgumentTypeError("at least one seed is required")
    return seeds


def write_summary(path: Path | None, results: list[dict[str, Any]]) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"runs": results}, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Log supervised synthetic-regression runs to Training Observability")
    parser.add_argument("--server", default="http://127.0.0.1:8000", help="Training Observability API URL")
    parser.add_argument("--seeds", default="11,29", type=parse_seeds, help="Comma-separated seeds to run")
    parser.add_argument("--epochs", default=30, type=int, help="Epochs per config/seed")
    parser.add_argument("--no-artifact-metadata", action="store_true", help="Skip Node-only artifact metadata logging")
    parser.add_argument("--summary-json", type=Path, default=None, help="Optional path for a local run summary JSON file")
    args = parser.parse_args()

    configs = tuple(
        ExperimentConfig(name=config.name, learning_rate=config.learning_rate, l2=config.l2, epochs=args.epochs)
        for config in CONFIGS
    )
    results = [
        run_experiment(config, seed, args.server, artifact_metadata=not args.no_artifact_metadata)
        for seed in args.seeds
        for config in configs
    ]
    write_summary(args.summary_json, results)
    for result in results:
        print(
            f"{result['name']} run_id={result['run_id']} "
            f"val/loss={result['final_val_loss']:.4f} val/r2={result['final_val_r2']:.4f}"
        )


if __name__ == "__main__":  # pragma: no cover
    main()
