from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from instantml.client import Run, Table
from instantml.errors import InstantMLError

from ._common import (
    bounded_metadata,
    clamp_preview_rows,
    json_safe_config,
    log_dataset_config,
    redact_metadata,
)


def log_hf_dataset(
    run: Run,
    dataset: Any,
    *,
    key: str = "data/train",
    include_preview: bool = False,
    preview_rows: int = 20,
) -> dict[str, Any]:
    """Log bounded Hugging Face Dataset or DatasetDict metadata."""

    limit = clamp_preview_rows(preview_rows)
    metadata = bounded_metadata(_hf_dataset_metadata(dataset))
    log_dataset_config(run, key, metadata)
    if include_preview:
        rows = _dataset_preview_rows(dataset, limit)
        if rows:
            run.log({f"datasets/{key}/preview": Table.from_data(rows)})
    return metadata


def log_dvc_metadata(run: Run, *, repo_path: str | Path = ".", key: str = "data/dvc") -> dict[str, Any]:
    """Log bounded metadata from local DVC files without uploading data."""

    root = Path(repo_path).expanduser()
    if not root.exists():
        raise InstantMLError(f"DVC repo path does not exist: {root}")
    files = _dvc_metadata_files(root)
    if not files:
        raise InstantMLError(f"no DVC metadata files found under {root}")
    metadata = bounded_metadata(
        {
            "kind": "dvc",
            "repo": "." if root.resolve() == Path.cwd().resolve() else root.name,
            "files": [_dvc_file_metadata(path, root) for path in files],
        }
    )
    log_dataset_config(run, key, metadata)
    return metadata


def _hf_dataset_metadata(dataset: Any) -> dict[str, Any]:
    if isinstance(dataset, dict) or hasattr(dataset, "keys") and not hasattr(dataset, "num_rows"):
        splits = {}
        for split in list(dataset.keys()):
            try:
                splits[str(split)] = _single_hf_dataset_metadata(dataset[split])
            except Exception:  # noqa: BLE001 - metadata helper should be best-effort per split
                splits[str(split)] = {"error": "metadata unavailable"}
        return {"kind": "huggingface_dataset_dict", "splits": splits}
    return _single_hf_dataset_metadata(dataset)


def _single_hf_dataset_metadata(dataset: Any) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "kind": "huggingface_dataset",
        "num_rows": getattr(dataset, "num_rows", None),
        "num_columns": getattr(dataset, "num_columns", None),
        "column_names": list(getattr(dataset, "column_names", []) or []),
        "split": str(getattr(dataset, "split", "")) or None,
        "fingerprint": getattr(dataset, "_fingerprint", None),
        "features": str(getattr(dataset, "features", "")) or None,
    }
    info = getattr(dataset, "info", None)
    if info is not None:
        metadata["info"] = json_safe_config(
            {
                "builder_name": getattr(info, "builder_name", None),
                "dataset_name": getattr(info, "dataset_name", None),
                "version": str(getattr(info, "version", "")) or None,
                "description": getattr(info, "description", None),
                "citation": getattr(info, "citation", None),
            }
        )
    cache_files = getattr(dataset, "cache_files", None)
    if isinstance(cache_files, list):
        metadata["cache_files"] = [redact_metadata(item) for item in cache_files[:20]]
    return {key: value for key, value in metadata.items() if value not in (None, "", [])}


def _dataset_preview_rows(dataset: Any, limit: int) -> list[dict[str, Any]]:
    if isinstance(dataset, dict) or hasattr(dataset, "keys") and not hasattr(dataset, "num_rows"):
        first_key = next(iter(dataset.keys()), None)
        if first_key is None:
            return []
        dataset = dataset[first_key]
    rows: list[Any]
    selector = getattr(dataset, "select", None)
    if callable(selector):
        selected = selector(range(min(limit, int(getattr(dataset, "num_rows", limit) or limit))))
        to_list = getattr(selected, "to_list", None)
        if callable(to_list):
            rows = to_list()
        else:
            rows = [selected[index] for index in range(min(limit, len(selected)))]
    else:
        rows = []
        for index in range(limit):
            try:
                rows.append(dataset[index])
            except (IndexError, KeyError, TypeError):
                break
    normalized = []
    for row in rows[:limit]:
        if isinstance(row, dict):
            normalized.append(redact_metadata(row))
        else:
            normalized.append({"value": redact_metadata(row)})
    return normalized


def _dvc_metadata_files(root: Path) -> list[Path]:
    candidates = [root / "dvc.lock", root / "dvc.yaml"]
    candidates.extend(sorted(root.glob("*.dvc")))
    return [path for path in candidates if path.is_file()]


def _dvc_file_metadata(path: Path, root: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8", errors="replace")
    metadata: dict[str, Any] = {
        "path": path.relative_to(root).as_posix(),
        "size_bytes": path.stat().st_size,
        "entries": _parse_dvc_metadata_text(text),
    }
    return metadata


def _parse_dvc_metadata_text(text: str) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    current: dict[str, Any] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("- "):
            if current:
                entries.append(current)
                current = {}
            stripped = stripped[2:].strip()
        if ":" not in stripped:
            continue
        raw_key, raw_value = stripped.split(":", 1)
        key = raw_key.strip()
        value = raw_value.strip().strip("\"'")
        if not value:
            continue
        if key in {"path", "md5", "hash", "size", "nfiles", "outs", "deps"}:
            current[key] = redact_metadata(_coerce_dvc_value(value), key=key)
    if current:
        entries.append(current)
    return entries[:100]


def _coerce_dvc_value(value: str) -> Any:
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        pass
    if value.isdigit():
        return int(value)
    return value


__all__ = ["log_dvc_metadata", "log_hf_dataset"]
