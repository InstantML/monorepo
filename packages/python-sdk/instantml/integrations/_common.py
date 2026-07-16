from __future__ import annotations

import importlib
import json
import math
import numbers
import re
import warnings
from pathlib import Path
from typing import Any

from instantml.client import Run, init
from instantml.errors import InstantMLError
from instantml.validation import _coerce_scalar_number, _validate_text

MAX_DATASET_METADATA_BYTES = 32 * 1024
MAX_DATASET_PREVIEW_ROWS = 100
MAX_DATASET_PREVIEW_STRING_CHARS = 1_000
SECRET_KEY_PARTS = ("api_key", "apikey", "authorization", "credential", "password", "secret", "token")

_ADAPTER_CLASS_CACHE: dict[tuple[type, type], type] = {}
_MISSING = object()


def require_optional(module_name: str, extra: str, package: str | None = None) -> Any:
    try:
        return importlib.import_module(module_name)
    except ImportError as exc:
        name = package or module_name.split(".", 1)[0]
        raise InstantMLError(
            f"{name} integration requires installing the optional dependency: "
            f"`python -m pip install \"instantml[{extra}]\"`."
        ) from exc


def optional_base(module_name: str, attr_path: str) -> type | None:
    try:
        module = importlib.import_module(module_name)
    except ImportError:
        return None
    value: Any = module
    for part in attr_path.split("."):
        value = getattr(value, part, None)
        if value is None:
            return None
    return value if isinstance(value, type) else None


def framework_adapter_new(cls: type, base: type | None, name: str) -> Any:
    if base is None or issubclass(cls, base):
        return object.__new__(cls)
    key = (cls, base)
    specialized = _ADAPTER_CLASS_CACHE.get(key)
    if specialized is None:
        try:
            specialized = type(name, (cls, base), {})
        except TypeError:
            return object.__new__(cls)
        _ADAPTER_CLASS_CACHE[key] = specialized
    return object.__new__(specialized)


class OwnedRunMixin:
    def _configure_run_owner(
        self,
        *,
        run: Run | None,
        project: str | None,
        default_project: str,
        finish_run: bool,
        init_kwargs: dict[str, Any],
    ) -> None:
        self.run = run
        self._owns_run = run is None
        self._finish_run = bool(finish_run)
        self._project = project or default_project
        self._init_kwargs = dict(init_kwargs)

    def _ensure_run(self) -> Run:
        if self.run is None:
            self.run = init(project=self._project, **self._init_kwargs)
            self._owns_run = True
        return self.run

    def finish(self, status: str = "finished") -> None:
        run = self.run
        owned = self._owns_run
        if run is not None and (owned or self._finish_run):
            run.finish(status)
        if owned:
            self.run = None
            self._owns_run = False

    close = finish


def sanitize_metric_key(*parts: Any) -> str | None:
    raw_parts = []
    for part in parts:
        if part is None:
            continue
        text = str(part).strip()
        if text:
            raw_parts.append(text)
    if not raw_parts:
        return None
    key = "/".join(raw_parts).replace("\\", "/")
    key = re.sub(r"\s+", "_", key)
    key = re.sub(r"/+", "/", key).strip("/")
    try:
        return _validate_text(key, "metric key")
    except (TypeError, ValueError) as exc:
        warnings.warn(f"skipped framework metric with invalid key {key!r}: {exc}", RuntimeWarning, stacklevel=2)
        return None


def latest_scalar(value: Any) -> float | None:
    scalar = scalar_number(value)
    if scalar is not None:
        return scalar
    if isinstance(value, (str, bytes, bool)) or value is None:
        return None
    try:
        values = list(value)
    except TypeError:
        return None
    if not values:
        return None
    latest = values[-1]
    scalar = scalar_number(latest)
    if scalar is not None:
        return scalar
    if isinstance(latest, (list, tuple)):
        for item in latest:
            scalar = scalar_number(item)
            if scalar is not None:
                return scalar
    return latest_scalar(latest)


def scalar_number(value: Any) -> float | None:
    if isinstance(value, (str, bytes, bool)) or value is None:
        return None
    coerced = _coerce_scalar_number(value)
    if coerced is not None:
        return coerced
    if isinstance(value, numbers.Real):
        try:
            number = float(value)
        except (TypeError, ValueError, OverflowError):
            return None
        return number if math.isfinite(number) else None
    item = getattr(value, "item", None)
    if callable(item):
        try:
            item_value = item()
        except (TypeError, ValueError, RuntimeError):
            return None
        if item_value is not value:
            return scalar_number(item_value)
    return None


def collect_scalar_metrics(
    values: dict[Any, Any],
    *,
    prefix: str | None = None,
    warn_prefix: str = "framework",
) -> dict[str, float]:
    metrics: dict[str, float] = {}
    for raw_key, raw_value in values.items():
        key = sanitize_metric_key(prefix, raw_key)
        if key is None:
            continue
        value = latest_scalar(raw_value)
        if value is None:
            warnings.warn(
                f"skipped nonnumeric {warn_prefix} metric {str(raw_key)!r}",
                RuntimeWarning,
                stacklevel=2,
            )
            continue
        metrics[key] = value
    return metrics


def json_safe_config(values: dict[Any, Any] | None) -> dict[str, Any]:
    if not isinstance(values, dict):
        return {}
    config: dict[str, Any] = {}
    for raw_key, value in values.items():
        key = str(raw_key)
        normalized = _json_config_value(value, key=key)
        if normalized is not _MISSING:
            config[key] = normalized
    return config


def _json_config_value(value: Any, *, key: str | None = None) -> Any:
    if key is not None and key_is_secret(key):
        return "[redacted]"
    if value is None or isinstance(value, (str, int, bool)):
        return redact_metadata(value, key=key)
    if isinstance(value, float):
        return value if math.isfinite(value) else _MISSING
    if isinstance(value, dict):
        nested = {}
        for raw_key, item in value.items():
            nested_value = _json_config_value(item, key=str(raw_key))
            if nested_value is not _MISSING:
                nested[str(raw_key)] = nested_value
        return nested
    if isinstance(value, (list, tuple)):
        nested_items = []
        for item in value:
            nested_value = _json_config_value(item, key=key)
            if nested_value is not _MISSING:
                nested_items.append(nested_value)
        return nested_items
    return _MISSING


def key_is_secret(key: str) -> bool:
    lowered = key.lower()
    return any(part in lowered for part in SECRET_KEY_PARTS)


def redact_metadata(value: Any, *, key: str | None = None, cwd: Path | None = None) -> Any:
    if key is not None and key_is_secret(key):
        return "[redacted]"
    if isinstance(value, dict):
        return {str(item_key): redact_metadata(item_value, key=str(item_key), cwd=cwd) for item_key, item_value in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact_metadata(item, key=key, cwd=cwd) for item in value[:MAX_DATASET_PREVIEW_ROWS]]
    if isinstance(value, str):
        text = safe_path_string(value, cwd=cwd)
        return truncate_string(text)
    if isinstance(value, (int, bool)) or value is None:
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    return truncate_string(str(value))


def truncate_string(value: str) -> str:
    if len(value) <= MAX_DATASET_PREVIEW_STRING_CHARS:
        return value
    return value[:MAX_DATASET_PREVIEW_STRING_CHARS] + "...[truncated]"


def safe_path_string(value: str, *, cwd: Path | None = None) -> str:
    if not value:
        return value
    if looks_secret_value(value):
        return "[redacted]"
    try:
        path = Path(value).expanduser()
    except (RuntimeError, ValueError, OSError):
        return value
    if not path.is_absolute():
        return value
    root = cwd or Path.cwd()
    try:
        relative = path.resolve().relative_to(root.resolve())
        return f"./{relative.as_posix()}"
    except (RuntimeError, ValueError, OSError):
        return path.name or "[redacted-path]"


def looks_secret_value(value: str) -> bool:
    lowered = value.lower()
    if any(marker in lowered for marker in ("token=", "api_key=", "apikey=", "password=", "secret=")):
        return True
    return bool(re.search(r"(bearer|basic)\s+[a-z0-9._~+/-]{12,}", lowered))


def clamp_preview_rows(preview_rows: int) -> int:
    if isinstance(preview_rows, bool) or not isinstance(preview_rows, int):
        raise TypeError("preview_rows must be an integer")
    if preview_rows <= 0:
        raise ValueError("preview_rows must be positive")
    return min(preview_rows, MAX_DATASET_PREVIEW_ROWS)


def bounded_metadata(payload: dict[str, Any]) -> dict[str, Any]:
    redacted = redact_metadata(payload)
    encoded = json.dumps(redacted, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if len(encoded) <= MAX_DATASET_METADATA_BYTES:
        return redacted
    compact = {
        "truncated": True,
        "truncated_reason": f"metadata exceeded {MAX_DATASET_METADATA_BYTES} bytes",
        "keys": sorted(str(key) for key in redacted.keys()),
    }
    for key in ("kind", "name", "split", "num_rows", "num_columns", "column_names", "files"):
        if key in redacted:
            compact[key] = redacted[key]
    return compact


def nested_config_path(key: str, value: dict[str, Any]) -> dict[str, Any]:
    parts = [part for part in str(key).strip("/").split("/") if part]
    if not parts:
        return value
    current: dict[str, Any] = value
    for part in reversed(parts):
        current = {part: current}
    return current


def log_dataset_config(run: Run, key: str, metadata: dict[str, Any]) -> None:
    run.log_config({"datasets": nested_config_path(key, metadata)})
