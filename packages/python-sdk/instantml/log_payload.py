"""Validation and classification helpers for ergonomic run logging."""

from __future__ import annotations

import math
from typing import Any

from .objects import Audio, ClassificationEval, File, Histogram, Image, Table, Text, Video
from .validation import _is_scalar_number, _validate_plain_string, _validate_text


def _classify_log_payload(
    data: dict[str, Any],
) -> tuple[dict[str, float], dict[str, str], dict[str, Table | Histogram | ClassificationEval | Image | Video | Audio], dict[str, File]]:
    if not isinstance(data, dict):
        raise TypeError("log data must be a dictionary")
    metrics: dict[str, float] = {}
    text: dict[str, str] = {}
    objects: dict[str, Table | Histogram | ClassificationEval | Image | Video | Audio] = {}
    files: dict[str, File] = {}
    for raw_key, value in data.items():
        key = _validate_text(raw_key, "log key")
        if _is_scalar_number(value):
            metrics[key] = float(value)
        elif isinstance(value, str):
            text[key] = value
        elif isinstance(value, Text):
            text[key] = _validate_plain_string(value.data, "text data")
        elif isinstance(value, (Table, Histogram, ClassificationEval, Image, Video, Audio)):
            objects[key] = value
        elif isinstance(value, File):
            files[key] = value
        elif isinstance(value, (list, tuple)):
            _classify_log_sequence(key, value, objects, files)
        else:
            raise TypeError(f"log value for {key!r} has unsupported type {type(value).__name__}")
    return metrics, text, objects, files


def _classify_log_sequence(
    key: str,
    values: list[Any] | tuple[Any, ...],
    objects: dict[str, Table | Histogram | ClassificationEval | Image | Video | Audio],
    files: dict[str, File],
) -> None:
    if not values:
        raise ValueError(f"log sequence for {key!r} must not be empty")
    if all(_is_scalar_number(value) for value in values):
        raise TypeError(f"log sequence for {key!r} is numeric; use Histogram.from_values() or Table")
    if all(isinstance(value, (Table, Histogram, ClassificationEval, Image, Video, Audio)) for value in values):
        for index, value in enumerate(values):
            objects[f"{key}/{index}"] = value
        return
    if all(isinstance(value, File) for value in values):
        for index, value in enumerate(values):
            files[f"{key}/{index}"] = value
        return
    raise TypeError(f"log sequence for {key!r} must contain one homogeneous supported type")


def _validate_rank_context(rank: int, world_size: int, local_rank: int | None) -> tuple[int, int, int]:
    if not isinstance(world_size, int) or isinstance(world_size, bool):
        raise TypeError("world_size must be an integer")
    if world_size < 1:
        raise ValueError("world_size must be at least 1")
    if world_size > 512:
        raise ValueError("world_size must be at most 512")
    if not isinstance(rank, int) or isinstance(rank, bool):
        raise TypeError("rank must be an integer")
    if rank < 0 or rank >= world_size:
        raise ValueError("rank must be between 0 and world_size - 1")
    resolved_local_rank = rank if local_rank is None else local_rank
    if not isinstance(resolved_local_rank, int) or isinstance(resolved_local_rank, bool):
        raise TypeError("local_rank must be an integer")
    if resolved_local_rank < 0 or resolved_local_rank >= world_size:
        raise ValueError("local_rank must be between 0 and world_size - 1")
    return rank, world_size, resolved_local_rank


def _validate_rank_weight(weight: int | float | None) -> float:
    if weight is None:
        return 1.0
    if isinstance(weight, bool) or not isinstance(weight, (int, float)):
        raise TypeError("weight must be a number")
    value = float(weight)
    if not math.isfinite(value) or value <= 0:
        raise ValueError("weight must be finite and positive")
    return value
