"""Trace event payload helpers for the Python SDK."""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone
from typing import Any

from .serialization import _tensor_to_python
from .validation import _validate_step

MAX_TRACE_NAME_BYTES = 512
MAX_TRACE_FIELD_BYTES = 512
MAX_TRACE_ATTRIBUTES_BYTES = 32 * 1024
MAX_TRACE_METRICS_BYTES = 16 * 1024
MAX_TRACE_LINKS_BYTES = 16 * 1024
MAX_TRACE_PREVIEW_BYTES = 4 * 1024
MAX_TRACE_EVENTS_PER_BATCH = 500

TRACE_EVENT_KINDS = {"started", "updated", "finished", "exception", "interrupted"}
TRACE_KINDS = {
    "rollout",
    "env_step",
    "model",
    "tool",
    "retrieval",
    "reward",
    "evaluator",
    "dataset",
    "preprocessing",
    "postprocessing",
    "checkpoint",
    "artifact",
    "system",
    "custom",
}
TRACE_STATUSES = {"running", "ok", "error", "cancelled", "interrupted"}
TRACE_CAPTURE_POLICIES = {"off", "preview"}
_REDACTED = "[REDACTED]"
_SECRET_KEY_PARTS = {
    "api_key",
    "apikey",
    "authorization",
    "cookie",
    "password",
    "secret",
    "set_cookie",
    "token",
    "x_api_key",
}
_SECRET_VALUE_PATTERNS = [
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"\binstantml_[A-Za-z0-9_=-]{6,}"),
    re.compile(r"\b(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9]{8,}"),
    re.compile(r"\bwhsec_[A-Za-z0-9]{8,}"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"\bghp_[A-Za-z0-9_]{16,}"),
    re.compile(r"\bxox[a-z]-[A-Za-z0-9-]{10,}"),
]
_SECRET_ASSIGNMENT_PATTERN = re.compile(
    r"(?i)\b(api[_-]?key|authorization|password|token|secret|cookie|set-cookie|x-api-key)\s*[:=]\s*['\"]?[^'\",\s}\]]+"
)


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def normalize_trace_id(value: str, field: str = "trace_id") -> str:
    return _normalize_hex_id(value, field, 32)


def normalize_span_id(value: str, field: str = "span_id") -> str:
    return _normalize_hex_id(value, field, 16)


def normalize_name(value: str, field: str = "name") -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    text = value.strip()
    if not text:
        raise ValueError(f"{field} must be a non-empty string")
    if len(text.encode("utf-8")) > MAX_TRACE_NAME_BYTES:
        raise ValueError(f"{field} must be at most {MAX_TRACE_NAME_BYTES} bytes")
    return redact_string(text)


def normalize_optional_label(value: str | None, field: str) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    if len(value.encode("utf-8")) > MAX_TRACE_FIELD_BYTES:
        raise ValueError(f"{field} must be at most {MAX_TRACE_FIELD_BYTES} bytes")
    return redact_string(value)


def normalize_kind(value: str) -> str:
    return _normalize_choice(value, "kind", TRACE_KINDS)


def normalize_status(value: str) -> str:
    return _normalize_choice(value, "status", TRACE_STATUSES)


def normalize_event_kind(value: str) -> str:
    return _normalize_choice(value, "event_kind", TRACE_EVENT_KINDS)


def normalize_capture(value: str | None) -> str:
    return _normalize_choice(value or "off", "capture", TRACE_CAPTURE_POLICIES)


def normalize_rank(value: int | None) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError("rank must be an integer")
    if value < 0:
        raise ValueError("rank must be nonnegative")
    return value


def normalize_duration_ms(value: float | None) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError("duration_ms must be a number")
    duration = float(value)
    if not math.isfinite(duration) or duration < 0:
        raise ValueError("duration_ms must be a nonnegative finite number")
    return duration


def json_object(value: dict[str, Any] | None, field: str, max_bytes: int) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise TypeError(f"{field} must be a dictionary")
    normalized = redact_json_value(_jsonable(value, field))
    if not isinstance(normalized, dict):
        raise TypeError(f"{field} must be a dictionary")
    _ensure_serialized_size(normalized, field, max_bytes)
    return normalized


def json_object_or_array(value: Any, field: str, max_bytes: int) -> dict[str, Any] | list[Any]:
    if value is None:
        return {}
    if not isinstance(value, (dict, list, tuple)):
        raise TypeError(f"{field} must be a dictionary or list")
    normalized = redact_json_value(_jsonable(value, field))
    if not isinstance(normalized, (dict, list)):
        raise TypeError(f"{field} must be a dictionary or list")
    _ensure_serialized_size(normalized, field, max_bytes)
    return normalized


def preview_payload(value: Any, capture: str, field: str) -> tuple[str, bool]:
    if capture != "preview" or value is None:
        return "", False
    try:
        normalized = redact_json_value(_jsonable(value, field, stringify_unknown=True))
        text = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except Exception:  # noqa: BLE001 - preview capture must never break user code
        text = _safe_string(value)
    return _truncate_utf8(redact_string(text), MAX_TRACE_PREVIEW_BYTES)


def preview_text(value: str, capture: str) -> tuple[str, bool]:
    if capture != "preview" or not value:
        return "", False
    return _truncate_utf8(redact_string(value), MAX_TRACE_PREVIEW_BYTES)


def build_trace_event(
    *,
    trace_id: str,
    span_id: str,
    parent_span_id: str | None,
    event_id: str,
    sequence: int,
    event_kind: str,
    name: str,
    kind: str,
    status: str,
    step: int | float | None,
    rank: int | None,
    thread_id: str | None,
    rollout_id: str | None,
    started_at: str,
    ended_at: str | None,
    duration_ms: float | None,
    input_preview: str,
    output_preview: str,
    error_type: str | None,
    error_preview: str,
    attributes: dict[str, Any] | None,
    metrics: dict[str, Any] | None,
    links: Any,
    content_policy: str,
    redaction_state: str,
    truncated: bool,
) -> dict[str, Any]:
    event = {
        "trace_id": normalize_trace_id(trace_id),
        "span_id": normalize_span_id(span_id),
        "event_id": event_id,
        "sequence": int(sequence),
        "event_kind": normalize_event_kind(event_kind),
        "name": normalize_name(name),
        "kind": normalize_kind(kind),
        "status": normalize_status(status),
        "step": _validate_step(step),
        "rank": normalize_rank(rank),
        "thread_id": normalize_optional_label(thread_id, "thread_id"),
        "rollout_id": normalize_optional_label(rollout_id, "rollout_id"),
        "started_at": started_at,
        "ended_at": ended_at,
        "duration_ms": normalize_duration_ms(duration_ms),
        "input_preview": redact_string(input_preview),
        "output_preview": redact_string(output_preview),
        "error_type": normalize_optional_label(error_type, "error_type"),
        "error_preview": redact_string(error_preview),
        "attributes": json_object(attributes, "attributes", MAX_TRACE_ATTRIBUTES_BYTES),
        "metrics": json_object(metrics, "metrics", MAX_TRACE_METRICS_BYTES),
        "links": json_object_or_array(links, "links", MAX_TRACE_LINKS_BYTES),
        "content_policy": _normalize_choice(content_policy, "content_policy", TRACE_CAPTURE_POLICIES),
        "redaction_state": _normalize_choice(redaction_state, "redaction_state", {"not_captured", "redacted", "truncated", "captured"}),
        "truncated": bool(truncated),
    }
    if parent_span_id:
        event["parent_span_id"] = normalize_span_id(parent_span_id, "parent_span_id")
    return event


def _normalize_hex_id(value: str, field: str, length: int) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    text = value.strip().lower()
    if len(text) != length or not all(character in "0123456789abcdef" for character in text):
        raise ValueError(f"{field} must be {length} hex characters")
    if set(text) == {"0"}:
        raise ValueError(f"{field} cannot be all zeros")
    return text


def _normalize_choice(value: str, field: str, allowed: set[str]) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    text = value.strip().lower()
    if text not in allowed:
        choices = ", ".join(sorted(allowed))
        raise ValueError(f"{field} must be one of: {choices}")
    return text


def _jsonable(value: Any, field: str, *, stringify_unknown: bool = False) -> Any:
    value = _tensor_to_python(value)
    if isinstance(value, dict):
        return {str(key): _jsonable(item, field, stringify_unknown=stringify_unknown) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item, field, stringify_unknown=stringify_unknown) for item in value]
    if isinstance(value, set):
        return [_jsonable(item, field, stringify_unknown=stringify_unknown) for item in sorted(value, key=repr)]
    if value is None or isinstance(value, (str, int, float, bool)):
        if isinstance(value, float) and not math.isfinite(value):
            if stringify_unknown:
                return str(value)
            raise ValueError(f"{field} must contain finite numbers")
        return value
    if stringify_unknown:
        return str(value)
    raise TypeError(f"{field} must be JSON serializable")


def redact_json_value(value: Any, key: str | None = None) -> Any:
    if key is not None and _is_secret_key(key):
        return _REDACTED
    if isinstance(value, dict):
        return {str(item_key): redact_json_value(item_value, str(item_key)) for item_key, item_value in value.items()}
    if isinstance(value, list):
        if len(value) == 2 and isinstance(value[0], str) and _is_secret_key(value[0]):
            return [redact_string(value[0]), _REDACTED]
        return [redact_json_value(item) for item in value]
    if isinstance(value, str):
        return redact_string(value)
    return value


def redact_string(value: str) -> str:
    text = value
    for pattern in _SECRET_VALUE_PATTERNS:
        text = pattern.sub(_REDACTED, text)
    text = _SECRET_ASSIGNMENT_PATTERN.sub(lambda match: f"{match.group(1)}={_REDACTED}", text)
    return text


def _is_secret_key(key: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]+", "_", key.lower()).strip("_")
    if normalized in _SECRET_KEY_PARTS:
        return True
    sensitive_suffixes = (
        "_api_key",
        "_apikey",
        "_authorization",
        "_cookie",
        "_password",
        "_secret",
        "_set_cookie",
        "_token",
        "_x_api_key",
    )
    return normalized.endswith(sensitive_suffixes)


def _safe_string(value: Any) -> str:
    try:
        return str(value)
    except Exception:  # noqa: BLE001 - preview fallback must be best effort
        try:
            return repr(value)
        except Exception:  # noqa: BLE001
            return "<unrepresentable>"


def _ensure_serialized_size(value: Any, field: str, max_bytes: int) -> None:
    try:
        serialized = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise TypeError(f"{field} must be JSON serializable") from exc
    if len(serialized.encode("utf-8")) > max_bytes:
        raise ValueError(f"{field} must be at most {max_bytes} serialized bytes")


def _truncate_utf8(value: str, max_bytes: int) -> tuple[str, bool]:
    raw = value.encode("utf-8")
    if len(raw) <= max_bytes:
        return value, False
    clipped = raw[:max_bytes]
    while clipped:
        try:
            return clipped.decode("utf-8"), True
        except UnicodeDecodeError:
            clipped = clipped[:-1]
    return "", True
