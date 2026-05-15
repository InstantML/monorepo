"""Real-data NumPy classification example logged through the public SDK."""

from __future__ import annotations

import argparse
import csv
import json
import math
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import instantml as ro

DATA_URL = "https://archive.ics.uci.edu/ml/machine-learning-databases/iris/iris.data"
FEATURE_NAMES = ("sepal_length_cm", "sepal_width_cm", "petal_length_cm", "petal_width_cm")
DEFAULT_CLASSES = ("Iris-setosa", "Iris-versicolor", "Iris-virginica")


@dataclass(frozen=True)
class Dataset:
    features: np.ndarray
    labels: np.ndarray
    class_names: tuple[str, ...]
    feature_names: tuple[str, ...] = FEATURE_NAMES


@dataclass(frozen=True)
class Split:
    train: np.ndarray
    validation: np.ndarray
    test: np.ndarray


@dataclass(frozen=True)
class ExperimentConfig:
    name: str
    learning_rate: float
    l2: float
    epochs: int = 160


@dataclass(frozen=True)
class ModelState:
    weights: np.ndarray
    bias: np.ndarray
    mean: np.ndarray
    std: np.ndarray


CONFIGS = (
    ExperimentConfig(name="baseline", learning_rate=0.14, l2=0.0005),
    ExperimentConfig(name="regularized", learning_rate=0.12, l2=0.015),
    ExperimentConfig(name="fast-lr", learning_rate=0.22, l2=0.001),
)


def resolve_dataset_path(data_path: Path | None, cache_dir: Path, allow_download: bool) -> Path:
    path = data_path or cache_dir / "iris.data"
    if path.exists():
        return path
    if not allow_download:
        raise FileNotFoundError(f"dataset not found at {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with urllib.request.urlopen(DATA_URL, timeout=15) as response:
            payload = response.read().decode("utf-8")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise RuntimeError(f"could not download Iris dataset from {DATA_URL}: {exc}") from exc
    path.write_text(payload, encoding="utf-8")
    return path


def load_dataset(path: Path) -> Dataset:
    rows: list[list[float]] = []
    raw_labels: list[str] = []
    with path.open(newline="", encoding="utf-8") as handle:
        for row in csv.reader(handle):
            if not row:
                continue
            if len(row) != 5:
                raise ValueError(f"expected 5 columns in {path}, got {len(row)}")
            rows.append([float(value) for value in row[:4]])
            raw_labels.append(row[4])
    if not rows:
        raise ValueError(f"dataset is empty: {path}")
    class_names = tuple(sorted(set(raw_labels)))
    label_map = {name: index for index, name in enumerate(class_names)}
    return Dataset(
        features=np.asarray(rows, dtype=np.float64),
        labels=np.asarray([label_map[label] for label in raw_labels], dtype=np.int64),
        class_names=class_names,
    )


def dataset_profile(dataset: Dataset) -> dict[str, Any]:
    counts = np.bincount(dataset.labels, minlength=len(dataset.class_names))
    return {
        "rows": int(dataset.features.shape[0]),
        "features": list(dataset.feature_names),
        "classes": {name: int(counts[index]) for index, name in enumerate(dataset.class_names)},
        "feature_mean": {
            name: round(float(value), 4)
            for name, value in zip(dataset.feature_names, dataset.features.mean(axis=0))
        },
        "feature_std": {
            name: round(float(value), 4)
            for name, value in zip(dataset.feature_names, dataset.features.std(axis=0))
        },
    }


def stratified_split(labels: np.ndarray, seed: int, train_fraction: float = 0.6, validation_fraction: float = 0.2) -> Split:
    rng = np.random.default_rng(seed)
    train_parts = []
    validation_parts = []
    test_parts = []
    for label in sorted(np.unique(labels)):
        indices = np.flatnonzero(labels == label)
        if len(indices) < 3:
            raise ValueError("stratified split requires at least 3 examples per class")
        rng.shuffle(indices)
        train_count = min(max(1, int(round(len(indices) * train_fraction))), len(indices) - 2)
        validation_count = min(max(1, int(round(len(indices) * validation_fraction))), len(indices) - train_count - 1)
        train_parts.append(indices[:train_count])
        validation_parts.append(indices[train_count : train_count + validation_count])
        test_parts.append(indices[train_count + validation_count :])
    return Split(
        train=np.sort(np.concatenate(train_parts)),
        validation=np.sort(np.concatenate(validation_parts)),
        test=np.sort(np.concatenate(test_parts)),
    )


def standardize(train_features: np.ndarray, all_features: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mean = train_features.mean(axis=0)
    std = train_features.std(axis=0)
    std = np.where(std < 1e-12, 1.0, std)
    return (all_features - mean) / std, mean, std


def train_model(dataset: Dataset, split: Split, config: ExperimentConfig, seed: int) -> tuple[ModelState, list[dict[str, float]]]:
    features, mean, std = standardize(dataset.features[split.train], dataset.features)
    class_count = len(dataset.class_names)
    rng = np.random.default_rng(seed + 101)
    weights = rng.normal(0.0, 0.02, size=(features.shape[1], class_count))
    bias = np.zeros(class_count, dtype=np.float64)
    history: list[dict[str, float]] = []

    train_x = features[split.train]
    train_y = dataset.labels[split.train]
    validation_x = features[split.validation]
    validation_y = dataset.labels[split.validation]

    for epoch in range(1, config.epochs + 1):
        probabilities = softmax(train_x @ weights + bias)
        one_hot = np.eye(class_count)[train_y]
        grad_logits = (probabilities - one_hot) / len(train_y)
        grad_weights = train_x.T @ grad_logits + 2.0 * config.l2 * weights
        grad_bias = grad_logits.sum(axis=0)
        weights = weights - config.learning_rate * grad_weights
        bias = bias - config.learning_rate * grad_bias
        history.append(
            {
                "epoch": float(epoch),
                "train/loss": cross_entropy(train_x, train_y, weights, bias, config.l2),
                "train/accuracy": accuracy(train_x, train_y, weights, bias),
                "val/loss": cross_entropy(validation_x, validation_y, weights, bias, config.l2),
                "val/accuracy": accuracy(validation_x, validation_y, weights, bias),
                "optimizer/grad_norm": float(np.sqrt(np.sum(grad_weights * grad_weights) + np.sum(grad_bias * grad_bias))),
                "model/weight_norm": float(np.linalg.norm(weights)),
            }
        )
    return ModelState(weights=weights, bias=bias, mean=mean, std=std), history


def softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=1, keepdims=True)


def cross_entropy(x: np.ndarray, y: np.ndarray, weights: np.ndarray, bias: np.ndarray, l2: float) -> float:
    probabilities = softmax(x @ weights + bias)
    selected = probabilities[np.arange(len(y)), y]
    return float(-np.log(np.clip(selected, 1e-12, 1.0)).mean() + l2 * np.sum(weights * weights))


def accuracy(x: np.ndarray, y: np.ndarray, weights: np.ndarray, bias: np.ndarray) -> float:
    return float(np.mean(np.argmax(x @ weights + bias, axis=1) == y))


def evaluate_model(dataset: Dataset, split: Split, state: ModelState) -> dict[str, Any]:
    features = (dataset.features - state.mean) / state.std
    probabilities = softmax(features[split.test] @ state.weights + state.bias)
    predictions = np.argmax(probabilities, axis=1)
    truth = dataset.labels[split.test]
    matrix = confusion_matrix(truth, predictions, len(dataset.class_names))
    per_class = per_class_metrics(matrix, dataset.class_names)
    return {
        "test/loss": cross_entropy(features[split.test], truth, state.weights, state.bias, 0.0),
        "test/accuracy": float(np.mean(predictions == truth)),
        "test/macro_f1": macro_f1(per_class),
        "test/ece": expected_calibration_error(probabilities, truth),
        "test/mean_confidence": float(np.max(probabilities, axis=1).mean()),
        "confusion_matrix": matrix.tolist(),
        "per_class": per_class,
        "predictions": predictions.tolist(),
        "probabilities": probabilities.tolist(),
    }


def confusion_matrix(truth: np.ndarray, predictions: np.ndarray, class_count: int) -> np.ndarray:
    matrix = np.zeros((class_count, class_count), dtype=np.int64)
    for expected, predicted in zip(truth, predictions):
        matrix[int(expected), int(predicted)] += 1
    return matrix


def per_class_metrics(matrix: np.ndarray, class_names: tuple[str, ...]) -> dict[str, dict[str, float]]:
    metrics = {}
    for index, name in enumerate(class_names):
        true_positive = float(matrix[index, index])
        false_positive = float(matrix[:, index].sum() - matrix[index, index])
        false_negative = float(matrix[index, :].sum() - matrix[index, index])
        precision = true_positive / (true_positive + false_positive) if true_positive + false_positive else 0.0
        recall = true_positive / (true_positive + false_negative) if true_positive + false_negative else 0.0
        f1 = 2.0 * precision * recall / (precision + recall) if precision + recall else 0.0
        metrics[name] = {"precision": precision, "recall": recall, "f1": f1}
    return metrics


def macro_f1(per_class: dict[str, dict[str, float]]) -> float:
    return float(sum(values["f1"] for values in per_class.values()) / len(per_class))


def expected_calibration_error(probabilities: np.ndarray, truth: np.ndarray, bins: int = 5) -> float:
    confidences = probabilities.max(axis=1)
    correct = np.argmax(probabilities, axis=1) == truth
    total = 0.0
    edges = np.linspace(0.0, 1.0, bins + 1)
    for lower, upper in zip(edges[:-1], edges[1:]):
        mask = (confidences > lower) & (confidences <= upper)
        if not np.any(mask):
            continue
        total += abs(float(correct[mask].mean()) - float(confidences[mask].mean())) * float(mask.mean())
    return float(total)


def metric_payload(row: dict[str, float], evaluation: dict[str, Any] | None = None) -> dict[str, float]:
    payload = {
        key: round(float(value), 6)
        for key, value in row.items()
        if key != "epoch"
    }
    if evaluation:
        for key in ("test/loss", "test/accuracy", "test/macro_f1", "test/ece", "test/mean_confidence"):
            payload[key] = round(float(evaluation[key]), 6)
    return payload


def write_artifacts(
    artifact_dir: Path,
    run_name: str,
    dataset: Dataset,
    split: Split,
    state: ModelState,
    evaluation: dict[str, Any],
) -> dict[str, Path]:
    output_dir = artifact_dir / run_name
    output_dir.mkdir(parents=True, exist_ok=True)
    paths = {
        "profile": output_dir / "dataset-profile.json",
        "model": output_dir / "model.json",
        "predictions": output_dir / "test-predictions.csv",
        "confusion": output_dir / "confusion-matrix.json",
    }
    paths["profile"].write_text(json.dumps(dataset_profile(dataset), indent=2) + "\n", encoding="utf-8")
    paths["model"].write_text(
        json.dumps(
            {
                "feature_names": list(dataset.feature_names),
                "class_names": list(dataset.class_names),
                "mean": state.mean.tolist(),
                "std": state.std.tolist(),
                "weights": state.weights.tolist(),
                "bias": state.bias.tolist(),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    paths["confusion"].write_text(
        json.dumps(
            {
                "class_names": list(dataset.class_names),
                "matrix": evaluation["confusion_matrix"],
                "per_class": evaluation["per_class"],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    write_predictions(paths["predictions"], dataset, split, evaluation)
    return paths


def write_predictions(path: Path, dataset: Dataset, split: Split, evaluation: dict[str, Any]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["row_index", "true_class", "predicted_class", "confidence"])
        for row_index, truth, prediction, probabilities in zip(
            split.test,
            dataset.labels[split.test],
            evaluation["predictions"],
            evaluation["probabilities"],
        ):
            writer.writerow(
                [
                    int(row_index),
                    dataset.class_names[int(truth)],
                    dataset.class_names[int(prediction)],
                    round(float(max(probabilities)), 6),
                ]
            )


def log_artifacts(run: Any, paths: dict[str, Path], final_epoch: int, evaluation: dict[str, Any]) -> None:
    run.upload_file(str(paths["profile"]), name="dataset-profile.json", artifact_type="file", metadata={"kind": "dataset-profile"})
    run.upload_file(
        str(paths["model"]),
        name="softmax-model.json",
        artifact_type="checkpoint",
        step=final_epoch,
        metadata={"test_accuracy": round(float(evaluation["test/accuracy"]), 6)},
    )
    run.upload_file(
        str(paths["predictions"]),
        name="test-predictions.csv",
        artifact_type="file",
        step=final_epoch,
        metadata={"kind": "prediction-table"},
    )
    run.upload_file(
        str(paths["confusion"]),
        name="confusion-matrix.json",
        artifact_type="file",
        step=final_epoch,
        metadata={"kind": "confusion-matrix"},
    )
    run.log_table(
        "test-predictions.csv",
        f"file://{paths['predictions'].resolve()}",
        step=final_epoch,
        size_bytes=paths["predictions"].stat().st_size,
        metadata={"kind": "prediction-table", "uploaded": True},
    )


def histogram_payload(values: np.ndarray, bins: int = 8) -> dict[str, list[float] | list[int]]:
    counts, edges = np.histogram(values, bins=bins)
    return {"bins": [round(float(value), 6) for value in edges.tolist()], "counts": [int(value) for value in counts.tolist()]}


def run_experiment(
    dataset: Dataset,
    config: ExperimentConfig,
    seed: int,
    server: str,
    artifact_dir: Path,
    log_every: int,
    upload_artifacts: bool,
) -> dict[str, Any]:
    split = stratified_split(dataset.labels, seed)
    run_name = f"iris-{config.name}-seed-{seed}"
    run = None
    try:
        run = ro.init(
            project="iris-classification",
            name=run_name,
            config={
                "dataset": "UCI Iris",
                "source_url": DATA_URL,
                "model": "multiclass-softmax-regression",
                "optimizer": "full-batch-gradient-descent",
                "seed": seed,
                "learning_rate": config.learning_rate,
                "l2": config.l2,
                "epochs": config.epochs,
                "features": list(dataset.feature_names),
                "classes": list(dataset.class_names),
                "split": {"train": int(len(split.train)), "validation": int(len(split.validation)), "test": int(len(split.test))},
            },
            tags=["example", "real-data", "numpy", "classification", config.name],
            notes=f"Iris softmax run {config.name}: compare accuracy, calibration, and class-level errors.",
            metadata={"example": "examples/iris-classification", "dataset_profile": dataset_profile(dataset)},
            base_url=server,
        )
        state, history = train_model(dataset, split, config, seed)
        evaluation = evaluate_model(dataset, split, state)
        for row in history:
            epoch = int(row["epoch"])
            if epoch == 1 or epoch % log_every == 0 or epoch == config.epochs:
                run.log_metrics(metric_payload(row, evaluation if epoch == config.epochs else None), step=epoch)
        run.log_histogram("model/weights", histogram_payload(state.weights.ravel()), step=config.epochs)
        if upload_artifacts:
            paths = write_artifacts(artifact_dir, run_name, dataset, split, state, evaluation)
            log_artifacts(run, paths, config.epochs, evaluation)
        run.finish()
        return {
            "name": run_name,
            "run_id": run.run_id,
            "test_accuracy": round(float(evaluation["test/accuracy"]), 6),
            "test_macro_f1": round(float(evaluation["test/macro_f1"]), 6),
            "test_ece": round(float(evaluation["test/ece"]), 6),
        }
    except Exception:
        if run is not None:
            run.finish("failed")
        raise


def parse_seeds(raw: str) -> list[int]:
    seeds = [int(value.strip()) for value in raw.split(",") if value.strip()]
    if not seeds:
        raise argparse.ArgumentTypeError("at least one seed is required")
    return seeds


def select_configs(raw: str) -> tuple[ExperimentConfig, ...]:
    names = [value.strip() for value in raw.split(",") if value.strip()]
    by_name = {config.name: config for config in CONFIGS}
    unknown = [name for name in names if name not in by_name]
    if unknown:
        raise argparse.ArgumentTypeError(f"unknown config(s): {', '.join(unknown)}")
    selected = tuple(by_name[name] for name in names) if names else CONFIGS
    return selected


def write_summary(path: Path | None, results: list[dict[str, Any]]) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"runs": results}, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a NumPy softmax classifier on UCI Iris and log it")
    parser.add_argument("--server", default="http://127.0.0.1:8000", help="Training Observability API URL")
    parser.add_argument("--data-path", type=Path, default=None, help="Optional local Iris CSV path")
    parser.add_argument("--cache-dir", type=Path, default=Path(".instantml/datasets"), help="Directory for downloaded public data")
    parser.add_argument("--artifact-dir", type=Path, default=Path(".instantml/iris-classification-artifacts"))
    parser.add_argument("--seeds", default="7,17", type=parse_seeds, help="Comma-separated random seeds")
    parser.add_argument("--configs", default="baseline,regularized,fast-lr", type=select_configs, help="Comma-separated config names")
    parser.add_argument("--epochs", default=160, type=int, help="Epochs per run")
    parser.add_argument("--log-every", default=10, type=int, help="Metric logging interval in epochs")
    parser.add_argument("--no-download", action="store_true", help="Require --data-path or a cached dataset")
    parser.add_argument("--no-upload-artifacts", action="store_true", help="Skip server-managed artifact uploads")
    parser.add_argument("--summary-json", type=Path, default=None, help="Optional path for a local run summary JSON file")
    args = parser.parse_args()

    data_path = resolve_dataset_path(args.data_path, args.cache_dir, allow_download=not args.no_download)
    dataset = load_dataset(data_path)
    configs = tuple(
        ExperimentConfig(config.name, config.learning_rate, config.l2, epochs=args.epochs)
        for config in args.configs
    )
    results = [
        run_experiment(
            dataset=dataset,
            config=config,
            seed=seed,
            server=args.server,
            artifact_dir=args.artifact_dir,
            log_every=max(1, args.log_every),
            upload_artifacts=not args.no_upload_artifacts,
        )
        for seed in args.seeds
        for config in configs
    ]
    write_summary(args.summary_json, results)
    for result in results:
        print(
            f"{result['name']} run_id={result['run_id']} "
            f"test/accuracy={result['test_accuracy']:.3f} "
            f"test/macro_f1={result['test_macro_f1']:.3f} "
            f"test/ece={result['test_ece']:.3f}"
        )


if __name__ == "__main__":  # pragma: no cover
    main()
