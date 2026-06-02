"""JSON serialization helpers and payload builders."""

from __future__ import annotations

import json
from typing import Any

from .validation import (
    _is_scalar_number,
    _validate_numeric_list,
    _validate_text,
)

MAX_CLASSIFICATION_EVAL_CLASS_NAME_BYTES = 128
MAX_CLASSIFICATION_EVAL_SAMPLE_COUNT = 1_000_000
MAX_CLASSIFICATION_EVAL_PREDICTION_ROWS = 100


def _json_serializable(value: Any, field: str) -> None:
    try:
        json.dumps(value)
    except (TypeError, ValueError) as exc:
        raise TypeError(f"{field} must be JSON serializable") from exc


def _validate_optional_json_object(value: dict[str, Any] | None, field: str) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise TypeError(f"{field} must be a dictionary")
    _json_serializable(value, field)
    return dict(value)


def _merge_metadata(*values: dict[str, Any] | None) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    for value in values:
        merged.update(_validate_optional_json_object(value, "metadata"))
    return merged


def _flatten(data: dict[str, Any], prefix: str = "") -> dict[str, Any]:
    flattened: dict[str, Any] = {}
    for key, value in data.items():
        path = f"{prefix}/{key}" if prefix else str(key)
        if isinstance(value, dict):
            flattened.update(_flatten(value, path))
        else:
            flattened[path] = value
    return flattened


def _tensor_to_python(value: Any) -> Any:
    for method_name in ("detach", "cpu", "numpy", "tolist"):
        method = getattr(value, method_name, None)
        if callable(method):
            try:
                value = method()
            except TypeError:
                continue
    return value


def _flatten_numeric_value(value: Any) -> list[int | float]:
    if _is_scalar_number(value):
        return [value]
    if isinstance(value, dict):
        flattened: list[int | float] = []
        for item in value.values():
            flattened.extend(_flatten_numeric_value(item))
        return flattened
    if isinstance(value, (str, bytes)):
        return []
    try:
        iterator = iter(value)
    except TypeError:
        return []
    flattened = []
    for item in iterator:
        flattened.extend(_flatten_numeric_value(_tensor_to_python(item)))
    return flattened


def _table_object_payload(
    key: str,
    table: Any,
    step: int | float | None,
    shared_metadata: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(table.columns, list) or not table.columns:
        raise ValueError("table columns must be a non-empty list")
    columns = [_validate_text(column, "table column") for column in table.columns]
    rows = _normalize_table_rows(columns, table.rows)
    metadata = _merge_metadata(shared_metadata, table.metadata)
    return {
        "key": key,
        "kind": "table",
        "step": step,
        "metadata": metadata,
        "summary": {"columns": columns, "row_count": len(rows)},
        "rows": rows,
    }


def _normalize_table_rows(columns: list[str], rows: list[Any]) -> list[dict[str, Any]]:
    if not isinstance(rows, list):
        raise TypeError("table rows must be a list")
    normalized: list[dict[str, Any]] = []
    for row in rows:
        if isinstance(row, dict):
            normalized_row = dict(row)
        elif isinstance(row, (list, tuple)):
            if len(row) != len(columns):
                raise ValueError("table row length must match columns")
            normalized_row = dict(zip(columns, row))
        else:
            raise TypeError("table rows must be dictionaries or sequences")
        _json_serializable(normalized_row, "table row")
        normalized.append(normalized_row)
    return normalized


def _histogram_object_payload(
    key: str,
    histogram: Any,
    step: int | float | None,
    shared_metadata: dict[str, Any],
) -> dict[str, Any]:
    bins = _validate_numeric_list(histogram.bins, "histogram bins", nonnegative=False)
    counts = _validate_numeric_list(histogram.counts, "histogram counts", nonnegative=True)
    if not bins or not counts:
        raise ValueError("histogram bins and counts must not be empty")
    if len(bins) not in {len(counts), len(counts) + 1}:
        raise ValueError("histogram bins length must match counts length or counts length plus one")
    value = {"bins": bins, "counts": counts}
    metadata = _merge_metadata(shared_metadata, histogram.metadata)
    if metadata:
        value["metadata"] = metadata
    return {
        "key": key,
        "kind": "histogram",
        "step": step,
        "metadata": metadata,
        "summary": {"bins": len(bins), "counts": len(counts)},
        "value": value,
    }


def _classification_eval_object_payload(
    key: str,
    evaluation: Any,
    step: int | float | None,
    shared_metadata: dict[str, Any],
) -> dict[str, Any]:
    class_names = _normalize_eval_class_names(evaluation.class_names)
    positive_label = _normalize_eval_positive_label(evaluation.positive_label, class_names)
    threshold = _validate_unit_number(evaluation.threshold, "threshold")
    split = _validate_text(evaluation.split, "split")
    true_labels = [_normalize_eval_label(value, class_names, "y_true") for value in _sequence_list(evaluation.y_true, "y_true")]
    scores = _validate_numeric_list(_sequence_list(evaluation.y_score, "y_score"), "y_score", nonnegative=False)
    if len(true_labels) != len(scores):
        raise ValueError("y_true and y_score must have the same length")
    if not true_labels:
        raise ValueError("classification eval must include at least one sample")
    if len(true_labels) > MAX_CLASSIFICATION_EVAL_SAMPLE_COUNT:
        raise ValueError(
            f"classification eval must include at most {MAX_CLASSIFICATION_EVAL_SAMPLE_COUNT} samples"
        )
    for score in scores:
        if score < 0.0 or score > 1.0:
            raise ValueError("y_score values must be in 0..1")
    if evaluation.y_pred is None:
        predicted_labels = [positive_label if score >= threshold else _negative_label(class_names, positive_label) for score in scores]
    else:
        predicted_labels = [_normalize_eval_label(value, class_names, "y_pred") for value in _sequence_list(evaluation.y_pred, "y_pred")]
        if len(predicted_labels) != len(true_labels):
            raise ValueError("y_pred must have the same length as y_true")

    confusion = [[0, 0], [0, 0]]
    index_by_label = {label: index for index, label in enumerate(class_names)}
    for true_label, predicted_label in zip(true_labels, predicted_labels):
        confusion[index_by_label[true_label]][index_by_label[predicted_label]] += 1

    per_class = []
    f1_values = []
    for label, index in index_by_label.items():
        tp = confusion[index][index]
        fp = sum(confusion[row][index] for row in range(2) if row != index)
        fn = sum(confusion[index][column] for column in range(2) if column != index)
        support = sum(confusion[index])
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        f1_values.append(f1)
        per_class.append({
            "class_name": label,
            "precision": precision,
            "recall": recall,
            "f1": f1,
            "support": support,
        })

    sample_count = len(true_labels)
    accuracy = (confusion[0][0] + confusion[1][1]) / sample_count
    macro_f1 = sum(f1_values) / len(f1_values)
    pr_curve, roc_curve = _classification_curves(true_labels, scores, positive_label)
    predictions = _normalize_eval_predictions(evaluation.predictions, true_labels, predicted_labels, scores, class_names)
    metadata = _merge_metadata(shared_metadata, evaluation.metadata)
    value = {
        "schema_version": 1,
        "task": "binary_classification",
        "split": split,
        "positive_label": positive_label,
        "threshold": threshold,
        "threshold_direction": "score_gte_threshold",
        "class_names": class_names,
        "sample_count": sample_count,
        "confusion_matrix": confusion,
        "per_class": per_class,
        "accuracy": accuracy,
        "macro_f1": macro_f1,
        "pr_curve": pr_curve,
        "roc_curve": roc_curve,
    }
    if predictions:
        value["predictions"] = predictions
    if metadata:
        value["metadata"] = metadata
    _json_serializable(value, "classification eval value")
    return {
        "key": key,
        "kind": "classification_eval",
        "step": step,
        "metadata": metadata,
        "summary": {
            "task": "binary_classification",
            "split": split,
            "sample_count": sample_count,
            "accuracy": accuracy,
            "macro_f1": macro_f1,
            "class_names": class_names,
            "positive_label": positive_label,
        },
        "value": value,
    }


def _sequence_list(value: Any, field: str) -> list[Any]:
    value = _tensor_to_python(value)
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, list):
        return value
    raise TypeError(f"{field} must be a list")


def _normalize_eval_class_names(class_names: Any) -> list[str]:
    if not isinstance(class_names, (list, tuple)) or len(class_names) != 2:
        raise ValueError("class_names must contain exactly two labels")
    names = [
        _validate_eval_text(str(value), "class name", MAX_CLASSIFICATION_EVAL_CLASS_NAME_BYTES)
        for value in class_names
    ]
    if names[0] == names[1]:
        raise ValueError("class_names must be unique")
    return names


def _normalize_eval_positive_label(value: Any, class_names: list[str]) -> str:
    if value is None:
        return class_names[1]
    return _normalize_eval_label(value, class_names, "positive_label")


def _normalize_eval_label(value: Any, class_names: list[str], field: str) -> str:
    if isinstance(value, bool):
        raise TypeError(f"{field} labels must be strings or class indices")
    if isinstance(value, int):
        if value not in {0, 1}:
            raise ValueError(f"{field} class indices must be 0 or 1")
        return class_names[value]
    if isinstance(value, str):
        label = _validate_text(value, field)
        if label not in class_names:
            raise ValueError(f"{field} labels must be in class_names")
        return label
    raise TypeError(f"{field} labels must be strings or class indices")


def _validate_eval_text(value: str, field: str, max_bytes: int) -> str:
    text = _validate_text(value, field)
    if len(text.encode("utf-8")) > max_bytes:
        raise ValueError(f"{field} must be at most {max_bytes} bytes")
    return text


def _negative_label(class_names: list[str], positive_label: str) -> str:
    return class_names[0] if class_names[1] == positive_label else class_names[1]


def _validate_unit_number(value: Any, field: str) -> float:
    if not _is_scalar_number(value):
        raise TypeError(f"{field} must be a finite number")
    number = float(value)
    if number < 0.0 or number > 1.0:
        raise ValueError(f"{field} must be in 0..1")
    return number


def _classification_curves(
    true_labels: list[str],
    scores: list[float],
    positive_label: str,
) -> tuple[list[dict[str, float]], list[dict[str, float]]]:
    scored_labels = sorted(zip(scores, true_labels), key=lambda item: item[0], reverse=True)
    threshold_count = 0
    previous_score = None
    for score, _label in scored_labels:
        if threshold_count == 0 or score != previous_score:
            threshold_count += 1
            previous_score = score
    sampled_thresholds = None
    if threshold_count > 200:
        max_index = threshold_count - 1
        sampled_thresholds = {round((max_index * index) / 199) for index in range(200)}
    positives = sum(1 for label in true_labels if label == positive_label)
    negatives = len(true_labels) - positives
    pr_curve = []
    roc_curve = []
    tp = 0
    fp = 0
    threshold_index = 0
    index = 0
    while index < len(scored_labels):
        threshold = scored_labels[index][0]
        while index < len(scored_labels) and scored_labels[index][0] == threshold:
            if scored_labels[index][1] == positive_label:
                tp += 1
            else:
                fp += 1
            index += 1
        if sampled_thresholds is not None and threshold_index not in sampled_thresholds:
            threshold_index += 1
            continue
        fn = positives - tp
        tn = negatives - fp
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        tpr = recall if positives else 0.0
        fpr = fp / (fp + tn) if negatives else 0.0
        pr_curve.append({"threshold": threshold, "precision": precision, "recall": recall})
        roc_curve.append({"threshold": threshold, "tpr": tpr, "fpr": fpr})
        threshold_index += 1
    return pr_curve, roc_curve


def _normalize_eval_predictions(
    predictions: list[dict[str, Any]] | tuple[dict[str, Any], ...],
    true_labels: list[str],
    predicted_labels: list[str],
    scores: list[float],
    class_names: list[str],
) -> list[dict[str, Any]]:
    if not predictions:
        return []
    if not isinstance(predictions, (list, tuple)):
        raise TypeError("predictions must be a list")
    if len(predictions) > MAX_CLASSIFICATION_EVAL_PREDICTION_ROWS:
        raise ValueError(
            f"predictions must include at most {MAX_CLASSIFICATION_EVAL_PREDICTION_ROWS} rows"
        )
    rows = []
    for index, row in enumerate(predictions):
        if not isinstance(row, dict):
            raise TypeError("prediction rows must be dictionaries")
        true_label = _normalize_eval_label(row.get("true_label", true_labels[index] if index < len(true_labels) else ""), class_names, "prediction true_label")
        predicted_label = _normalize_eval_label(row.get("predicted_label", predicted_labels[index] if index < len(predicted_labels) else ""), class_names, "prediction predicted_label")
        normalized = {
            "id": _validate_text(str(row.get("id", index)), "prediction id"),
            "true_label": true_label,
            "predicted_label": predicted_label,
            "score": _validate_unit_number(row.get("score", scores[index] if index < len(scores) else None), "prediction score"),
        }
        correct = row.get("correct", normalized["true_label"] == normalized["predicted_label"])
        if not isinstance(correct, bool):
            raise TypeError("prediction correct must be a boolean")
        normalized["correct"] = correct
        _json_serializable(normalized, "prediction row")
        rows.append(normalized)
    return rows
