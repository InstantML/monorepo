"""Input validation helpers for the SDK."""

from __future__ import annotations

import math
from typing import Any

from .errors import InstantMLError

MAX_TEXT_BYTES = 512
MAX_CONSOLE_LOG_MESSAGE_BYTES = 16 * 1024
MAX_CONSOLE_LOG_LINES_PER_BATCH = 50
CONSOLE_LOG_STREAMS = {"stdout", "stderr"}
PROCESS_UPLOAD_MODES = {"sync", "spool", "async"}


def _validate_upload_mode(upload_mode: str) -> None:
    if upload_mode not in PROCESS_UPLOAD_MODES:
        raise ValueError(f"upload_mode must be one of: {', '.join(sorted(PROCESS_UPLOAD_MODES))}")


def _validate_note_text(notes: str) -> str:
    if not isinstance(notes, str):
        raise TypeError("notes must be a string")
    encoded = notes.strip().encode("utf-8")
    if len(encoded) > MAX_TEXT_BYTES:
        raise ValueError(f"notes must be at most {MAX_TEXT_BYTES} bytes")
    return notes.strip()


def _validate_text(value: str, field: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    text = value.strip()
    if not text:
        raise ValueError(f"{field} must be a non-empty string")
    if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise ValueError(f"{field} must be at most {MAX_TEXT_BYTES} bytes")
    return text


def _validate_plain_string(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    return value


def _validate_step(step: int | float | None) -> int | float | None:
    if step is None:
        return None
    if not isinstance(step, (int, float)) or isinstance(step, bool):
        raise TypeError("step must be a number")
    if not math.isfinite(float(step)):
        raise ValueError("step must be finite")
    if float(step) < 0:
        raise ValueError("step must be nonnegative")
    return step


def _is_scalar_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(float(value))


def _validate_metrics(data: dict[str, Any]) -> dict[str, float]:
    if not isinstance(data, dict):
        raise TypeError("metrics must be a dictionary")
    if not data:
        raise ValueError("metrics must include at least one key")
    metrics: dict[str, float] = {}
    for key, value in data.items():
        metric_key = _validate_text(key, "metric key")
        if not _is_scalar_number(value):
            raise TypeError("metrics values must be finite numbers")
        metrics[metric_key] = float(value)
    return metrics


def _validate_text_series(data: dict[str, Any]) -> dict[str, str]:
    if not isinstance(data, dict):
        raise TypeError("text values must be a dictionary")
    return {_validate_text(key, "text key"): _validate_plain_string(value, "text value") for key, value in data.items()}


def _validate_console_stream(stream: str) -> str:
    if not isinstance(stream, str):
        raise TypeError("stream must be a string")
    value = stream.strip()
    if value not in CONSOLE_LOG_STREAMS:
        raise ValueError("stream must be stdout or stderr")
    return value


def _normalize_console_lines(lines: str | list[str] | tuple[str, ...]) -> list[str]:
    if isinstance(lines, str):
        messages = [lines]
    elif isinstance(lines, (list, tuple)):
        messages = list(lines)
    else:
        raise TypeError("console lines must be a string or a list of strings")
    if not messages:
        raise ValueError("console lines must include at least one line")
    if len(messages) > MAX_CONSOLE_LOG_LINES_PER_BATCH:
        raise ValueError(f"console lines must include at most {MAX_CONSOLE_LOG_LINES_PER_BATCH} lines")
    for message in messages:
        if not isinstance(message, str):
            raise TypeError("console lines must contain strings")
        if len(message.encode("utf-8")) > MAX_CONSOLE_LOG_MESSAGE_BYTES:
            raise ValueError("console line is too large")
    return messages


def _validate_numeric_list(values: list[int | float], field: str, nonnegative: bool) -> list[float]:
    if not isinstance(values, list):
        raise TypeError(f"{field} must be a list")
    normalized = []
    for value in values:
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise TypeError(f"{field} must contain numbers")
        number = float(value)
        if not number == number or number in {float("inf"), float("-inf")}:
            raise ValueError(f"{field} must contain finite numbers")
        if nonnegative and number < 0:
            raise ValueError(f"{field} must contain nonnegative numbers")
        normalized.append(number)
    return normalized


def _coerce_numeric_values(values: Any, field: str) -> list[float]:
    from .serialization import _tensor_to_python, _flatten_numeric_value
    flattened = _flatten_numeric_value(_tensor_to_python(values))
    if not flattened:
        raise ValueError(f"{field} must not be empty")
    return _validate_numeric_list(flattened, field, nonnegative=False)
