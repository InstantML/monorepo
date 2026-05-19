"""JSON serialization helpers and payload builders."""

from __future__ import annotations

import json
from typing import Any

from .validation import (
    _is_scalar_number,
    _validate_numeric_list,
    _validate_plain_string,
    _validate_text,
)


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
