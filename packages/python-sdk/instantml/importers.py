"""Local import translators for InstantML adoption workflows.

The server accepts canonical Import v2 chunks. This module keeps third-party
credentials and raw source files local, translates supported source schemas into
that canonical shape, and uploads sanitized chunks to InstantML.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any, Iterable

from .client import Client, InstantMLError, _default_base_url
from .credentials import _check_credentials_or_raise


IMPORT_SCHEMA_VERSION = 2
DEFAULT_CHUNK_METRICS = 25_000
MAX_TEXT_BYTES = 8 * 1024


_SECRET_PATTERNS = [
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{12,}"),
    re.compile(r"(?i)(api[_-]?key|token|secret|password)=([^&\s]+)"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"instantml_[A-Za-z0-9_=-]{8,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
]
_SIGNED_QUERY_PATTERN = re.compile(
    r"([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|AWSAccessKeyId|X-Goog-Credential|X-Goog-Signature|X-Goog-SignedHeaders|X-Goog-Algorithm|X-Goog-Expires|sig|signature|token|access_token|se|sp|spr|sv|sr|skoid|sktid|skt|ske|sks|skv)=)[^&\s]+",
    flags=re.IGNORECASE,
)


def redact_text(text: str) -> str:
    output = text
    for pattern in _SECRET_PATTERNS:
        output = pattern.sub("[REDACTED]", output)
    return _SIGNED_QUERY_PATTERN.sub(r"\1[REDACTED]", output)


def redact_value(value: Any) -> Any:
    if isinstance(value, str):
        return redact_text(value[:MAX_TEXT_BYTES])
    if isinstance(value, list):
        return [redact_value(item) for item in value]
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            if _secretish_key(str(key)):
                redacted[str(key)] = "[REDACTED]"
            else:
                redacted[str(key)] = redact_value(item)
        return redacted
    return value


def _secretish_key(key: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]+", "_", key.lower()).strip("_")
    exact = {
        "token",
        "auth_token",
        "access_token",
        "refresh_token",
        "id_token",
        "api_token",
        "api_key",
        "apikey",
        "secret",
        "secret_key",
        "client_secret",
        "password",
        "passwd",
        "access_key",
        "private_key",
    }
    return normalized in exact or normalized.endswith(("_token", "_api_key", "_secret", "_password", "_private_key"))


def content_hash(chunk: dict[str, Any]) -> str:
    copy = dict(chunk)
    copy.pop("content_hash", None)
    body = json.dumps(copy, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def canonical_chunk(
    *,
    source_type: str,
    source_project: str,
    target_project: str,
    job_id: int,
    chunk_id: str,
    sequence: int,
    runs: list[dict[str, Any]],
    metric_points: list[dict[str, Any]],
    attributes: list[dict[str, Any]] | None = None,
    artifact_refs: list[dict[str, Any]] | None = None,
    warnings: list[dict[str, Any]] | None = None,
    final: bool = False,
) -> dict[str, Any]:
    chunk = redact_value(
        {
            "schema_version": IMPORT_SCHEMA_VERSION,
            "source_type": source_type,
            "source_project": source_project,
            "target_project": target_project,
            "job_id": job_id,
            "chunk_id": chunk_id,
            "sequence": sequence,
            "runs": runs,
            "metric_points": metric_points,
            "attributes": attributes or [],
            "artifact_refs": artifact_refs or [],
            "warnings": warnings or [],
            "final": final,
        }
    )
    chunk["content_hash"] = content_hash(chunk)
    return chunk


def upload_chunks(
    *,
    source_type: str,
    source_project: str,
    target_project: str,
    chunks: Iterable[dict[str, Any]],
    base_url: str | None = None,
    api_key: str | None = None,
    timeout: float = 30.0,
    commit: bool = True,
) -> dict[str, Any]:
    _check_credentials_or_raise(api_key)
    client = Client(base_url=base_url or _default_base_url(), timeout=timeout, api_key=api_key)
    job = client._request(
        "POST",
        "/api/imports/jobs",
        {
            "schema_version": IMPORT_SCHEMA_VERSION,
            "source_type": source_type,
            "source_project": source_project,
            "target_project": target_project,
        },
    )["job"]
    job_id = int(job["id"])
    last_response: dict[str, Any] = {"job": job}
    iterator = iter(chunks)
    try:
        current = next(iterator)
    except StopIteration:
        current = canonical_chunk(
            source_type=source_type,
            source_project=source_project,
            target_project=target_project,
            job_id=job_id,
            chunk_id="chunk-0",
            sequence=0,
            runs=[],
            metric_points=[],
            final=True,
        )
    while current is not None:
        try:
            next_chunk = next(iterator)
            is_last = False
        except StopIteration:
            next_chunk = None
            is_last = True
        prepared = dict(current)
        prepared["job_id"] = job_id
        prepared["final"] = bool(prepared.get("final")) or is_last
        # Let the server compute the stored digest after its redaction pass so
        # retries remain idempotent even if JSON key order differs by client.
        prepared["content_hash"] = ""
        last_response = client._request(
            "POST",
            f"/api/imports/jobs/{job_id}/chunks",
            prepared,
        )
        current = next_chunk
    if commit:
        return client._request("POST", f"/api/imports/jobs/{job_id}/commit")
    return last_response


def chunks_from_transformed_json(
    payload: dict[str, Any],
    *,
    source_type: str,
    target_project: str,
    source_project: str | None = None,
    chunk_metric_limit: int = DEFAULT_CHUNK_METRICS,
) -> list[dict[str, Any]]:
    """Translate the existing transformed JSON shape into canonical chunks."""
    source_project = source_project or str(payload.get("project") or target_project)
    runs: list[dict[str, Any]] = []
    metrics: list[dict[str, Any]] = []
    artifacts: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    sequence = 0
    chunks: list[dict[str, Any]] = []
    for run_index, run in enumerate(payload.get("runs") or []):
        if not isinstance(run, dict):
            warnings.append({"code": "invalid_run", "message": f"Skipped non-object run at index {run_index}"})
            continue
        source_run_id = str(run.get("id") or run.get("run_id") or run.get("neptune_id") or f"run-{run_index + 1}")
        runs.append(
            {
                "source_run_id": source_run_id,
                "name": run.get("name") or source_run_id,
                "status": run.get("state") or run.get("status") or "finished",
                "config": run.get("config") or {},
                "tags": run.get("tags") or [],
                "metadata": run.get("metadata") or {},
                "started_at": run.get("started_at"),
                "finished_at": run.get("finished_at"),
            }
        )
        for row_index, point in enumerate(run.get("history") or run.get("metrics") or []):
            if not isinstance(point, dict):
                continue
            if "key" in point and "value" in point:
                value = point.get("value")
                if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
                    warnings.append({"code": "invalid_metric_value", "message": f"Skipped non-numeric metric at run {source_run_id}, row {row_index}"})
                    continue
                metrics.append(
                    {
                        "source_run_id": source_run_id,
                        "key": point["key"],
                        "step": _finite_number(point.get("step"), 0.0),
                        "value": float(value),
                        "timestamp": point.get("timestamp"),
                    }
                )
                if len(metrics) >= chunk_metric_limit:
                    chunks.append(canonical_chunk(source_type=source_type, source_project=source_project, target_project=target_project, job_id=0, chunk_id=f"chunk-{sequence}", sequence=sequence, runs=runs, metric_points=metrics, artifact_refs=artifacts, warnings=warnings))
                    sequence += 1
                    runs, metrics, artifacts, warnings = [], [], [], []
                continue
            step = _finite_number(point.get("_step"), float(row_index))
            timestamp = point.get("_timestamp")
            for key, value in point.items():
                if key.startswith("_") or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
                    continue
                metrics.append({"source_run_id": source_run_id, "key": key, "step": step, "value": float(value), "timestamp": timestamp})
            if len(metrics) >= chunk_metric_limit:
                chunks.append(canonical_chunk(source_type=source_type, source_project=source_project, target_project=target_project, job_id=0, chunk_id=f"chunk-{sequence}", sequence=sequence, runs=runs, metric_points=metrics, artifact_refs=artifacts, warnings=warnings))
                sequence += 1
                runs, metrics, artifacts, warnings = [], [], [], []
        for artifact in run.get("artifacts") or []:
            if isinstance(artifact, dict):
                item = dict(artifact)
                item["source_run_id"] = source_run_id
                artifacts.append(item)
    chunks.append(canonical_chunk(source_type=source_type, source_project=source_project, target_project=target_project, job_id=0, chunk_id=f"chunk-{sequence}", sequence=sequence, runs=runs, metric_points=metrics, artifact_refs=artifacts, warnings=warnings, final=True))
    return chunks


def neptune_exporter_payload(
    data_path: str | Path,
    *,
    files_path: str | Path | None = None,
    project: str | None = None,
) -> dict[str, Any]:
    """Read a Neptune Exporter parquet directory into the transformed shape.

    Neptune Exporter writes one sanitized directory per project and split
    Parquet parts with columns documented in its `model.py::SCHEMA`.
    """
    root = Path(data_path).expanduser()
    if not root.exists():
        raise InstantMLError(f"Neptune data path does not exist: {root}")
    if root.is_symlink():
        raise InstantMLError("Neptune data path must not be a symlink")
    parquet_files = _safe_parquet_files(root)
    if not parquet_files:
        raise InstantMLError("Neptune data path does not contain parquet files")
    try:
        import pyarrow.parquet as pq  # type: ignore[import-not-found]
    except ImportError as exc:
        raise InstantMLError("Neptune import requires installing the optional `pyarrow` package.") from exc

    files_root = Path(files_path).expanduser() if files_path is not None else None
    runs: dict[tuple[str, str], dict[str, Any]] = {}
    first_project: str | None = None
    for parquet_path in parquet_files:
        table_file = pq.ParquetFile(parquet_path)
        for batch in table_file.iter_batches(batch_size=10_000):
            rows = batch.to_pylist()
            for row in rows:
                project_id = str(row.get("project_id") or project or root.name)
                run_id = str(row.get("run_id") or parquet_path.stem)
                first_project = first_project or project_id
                run = runs.setdefault(
                    (project_id, run_id),
                    {
                        "id": run_id,
                        "name": run_id,
                        "status": "finished",
                        "config": {},
                        "tags": ["imported", "neptune"],
                        "metadata": {"neptune": {"project_id": project_id, "run_id": run_id}},
                        "metrics": [],
                        "artifacts": [],
                    },
                )
                _apply_neptune_exporter_row(run, row, files_root)
    payload_project = project or first_project or root.name
    return {"project": payload_project, "runs": list(runs.values())}


def chunks_from_neptune_exporter(
    data_path: str | Path,
    *,
    target_project: str,
    source_project: str | None = None,
    files_path: str | Path | None = None,
    chunk_metric_limit: int = DEFAULT_CHUNK_METRICS,
) -> Iterable[dict[str, Any]]:
    """Stream Neptune Exporter chunks without holding metric history in memory."""
    root = Path(data_path).expanduser()
    if not root.exists():
        raise InstantMLError(f"Neptune data path does not exist: {root}")
    if root.is_symlink():
        raise InstantMLError("Neptune data path must not be a symlink")
    parquet_files = _safe_parquet_files(root)
    if not parquet_files:
        raise InstantMLError("Neptune data path does not contain parquet files")
    try:
        import pyarrow.parquet as pq  # type: ignore[import-not-found]
    except ImportError as exc:
        raise InstantMLError("Neptune import requires installing the optional `pyarrow` package.") from exc
    files_root = Path(files_path).expanduser() if files_path is not None else None

    runs: dict[tuple[str, str], dict[str, Any]] = {}
    first_project: str | None = None
    for parquet_path in parquet_files:
        table_file = pq.ParquetFile(parquet_path)
        for batch in table_file.iter_batches(batch_size=10_000):
            for row in batch.to_pylist():
                project_id = str(row.get("project_id") or source_project or root.name)
                run_id = str(row.get("run_id") or parquet_path.stem)
                first_project = first_project or project_id
                run = runs.setdefault((project_id, run_id), _empty_neptune_run(project_id, run_id))
                if str(row.get("attribute_type") or "") != "float_series":
                    _apply_neptune_exporter_row(run, row, files_root)

    payload_project = source_project or first_project or root.name
    source_name = source_project or payload_project
    sequence = 0
    run_rows = list(runs.values())
    for offset in range(0, len(run_rows), 1_000):
        yield canonical_chunk(
            source_type="neptune",
            source_project=source_name,
            target_project=target_project,
            job_id=0,
            chunk_id=f"chunk-{sequence}",
            sequence=sequence,
            runs=run_rows[offset : offset + 1_000],
            metric_points=[],
            artifact_refs=[artifact for run in run_rows[offset : offset + 1_000] for artifact in run.get("artifacts", [])],
        )
        sequence += 1

    pending_metrics: list[dict[str, Any]] = []
    for parquet_path in parquet_files:
        table_file = pq.ParquetFile(parquet_path)
        for batch in table_file.iter_batches(batch_size=10_000):
            for row in batch.to_pylist():
                if str(row.get("attribute_type") or "") != "float_series":
                    continue
                value = row.get("float_value")
                if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
                    continue
                run_id = str(row.get("run_id") or parquet_path.stem)
                pending_metrics.append(
                    {
                        "source_run_id": run_id,
                        "key": str(row.get("attribute_path") or ""),
                        "step": _finite_number(row.get("step"), 0.0),
                        "value": float(value),
                        "timestamp": _iso_or_none(row.get("timestamp")),
                    }
                )
                if len(pending_metrics) >= chunk_metric_limit:
                    yield canonical_chunk(
                        source_type="neptune",
                        source_project=source_name,
                        target_project=target_project,
                        job_id=0,
                        chunk_id=f"chunk-{sequence}",
                        sequence=sequence,
                        runs=[],
                        metric_points=pending_metrics,
                    )
                    sequence += 1
                    pending_metrics = []
    yield canonical_chunk(
        source_type="neptune",
        source_project=source_name,
        target_project=target_project,
        job_id=0,
        chunk_id=f"chunk-{sequence}",
        sequence=sequence,
        runs=[],
        metric_points=pending_metrics,
        final=True,
    )


def _empty_neptune_run(project_id: str, run_id: str) -> dict[str, Any]:
    return {
        "id": run_id,
        "source_run_id": run_id,
        "name": run_id,
        "status": "finished",
        "config": {},
        "tags": ["imported", "neptune"],
        "metadata": {"neptune": {"project_id": project_id, "run_id": run_id}},
        "metrics": [],
        "artifacts": [],
    }


def _safe_parquet_files(root: Path) -> list[Path]:
    candidates = [root] if root.is_file() else sorted(root.rglob("*.parquet"))
    safe_files: list[Path] = []
    for candidate in candidates:
        if candidate.is_symlink() or not candidate.is_file():
            raise InstantMLError(f"Unsafe Neptune parquet path: {candidate}")
        resolved = candidate.resolve()
        root_resolved = root.resolve() if root.is_dir() else root.parent.resolve()
        if root_resolved not in resolved.parents and resolved != root_resolved:  # pragma: no cover
            raise InstantMLError(f"Unsafe Neptune parquet path: {candidate}")
        safe_files.append(candidate)
    return safe_files


def _apply_neptune_exporter_row(run: dict[str, Any], row: dict[str, Any], files_root: Path | None) -> None:
    path = str(row.get("attribute_path") or "")
    kind = str(row.get("attribute_type") or "")
    if not path or not kind:
        return
    if path == "sys/name" and row.get("string_value"):
        run["name"] = str(row["string_value"])
        return
    if path in {"sys/state", "sys/running_time"} and row.get("string_value"):
        run["status"] = str(row["string_value"]).lower()
        return
    if path in {"sys/tags", "sys/group_tags"}:
        tags = _neptune_scalar_value(row, kind)
        if isinstance(tags, list):
            run["tags"] = sorted(set([*run.get("tags", []), *[str(tag) for tag in tags]]))
        return
    if kind == "float_series":
        value = row.get("float_value")
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            run["metrics"].append(
                {
                    "key": path,
                    "step": _finite_number(row.get("step"), 0.0),
                    "value": float(value),
                    "timestamp": _iso_or_none(row.get("timestamp")),
                }
            )
        return
    if kind in {"float", "int", "string", "bool", "datetime", "string_set"}:
        if not path.startswith("sys/"):
            run["config"][path] = _neptune_scalar_value(row, kind)
        else:
            run["metadata"].setdefault("neptune", {})[path] = _neptune_scalar_value(row, kind)
        return
    if kind in {"file", "file_series"}:
        file_path = _neptune_file_path(row.get("file_value"))
        if not file_path:
            return
        artifact = {
            "name": Path(file_path).name or path,
            "type": "file",
            "uri": _safe_file_uri(files_root, file_path),
            "metadata": {"neptune_attribute_path": path},
        }
        if kind == "file_series":
            artifact["step"] = _finite_number(row.get("step"), 0.0)
        run["artifacts"].append(artifact)


def _neptune_scalar_value(row: dict[str, Any], kind: str) -> Any:
    if kind == "float":
        return row.get("float_value")
    if kind == "int":
        return row.get("int_value")
    if kind == "bool":
        return row.get("bool_value")
    if kind == "datetime":
        return _iso_or_none(row.get("datetime_value"))
    if kind == "string_set":
        value = row.get("string_set_value")
        return list(value) if isinstance(value, (list, tuple, set)) else value
    return row.get("string_value")


def _neptune_file_path(value: Any) -> str | None:
    if isinstance(value, dict):
        raw = value.get("path")
    else:
        raw = getattr(value, "path", None)
    if not isinstance(raw, str) or not raw:
        return None
    path = Path(raw)
    if path.is_absolute() or ".." in path.parts:
        return None
    return raw


def _safe_file_uri(files_root: Path | None, relative_path: str) -> str:
    if files_root is None:
        return f"neptune-export://{relative_path}"
    root = files_root.resolve()
    target = (root / relative_path).resolve()
    if root not in target.parents and target != root:
        return f"neptune-export://{relative_path}"
    return target.as_uri()


def _iso_or_none(value: Any) -> str | None:
    if value is None:
        return None
    iso = getattr(value, "isoformat", None)
    if callable(iso):
        return iso()
    return str(value)


def load_json_payload(path: str | Path) -> dict[str, Any]:
    with Path(path).expanduser().open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise InstantMLError("import JSON must contain an object payload")
    return payload


def import_transformed_json(
    *,
    source_type: str,
    input_path: str | Path,
    target_project: str,
    source_project: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    payload = load_json_payload(input_path)
    chunks = chunks_from_transformed_json(
        payload,
        source_type=source_type,
        target_project=target_project,
        source_project=source_project,
    )
    return upload_chunks(
        source_type=source_type,
        source_project=source_project or str(payload.get("project") or target_project),
        target_project=target_project,
        chunks=chunks,
        base_url=base_url,
        api_key=api_key,
        commit=not dry_run,
    )


def export_wandb_project(entity: str, project: str, *, limit: int | None = None) -> dict[str, Any]:
    try:
        import wandb  # type: ignore
    except ImportError as exc:
        raise InstantMLError("W&B import requires installing the optional `wandb` package.") from exc
    api = wandb.Api()
    runs = []
    for index, run in enumerate(api.runs(f"{entity}/{project}")):
        if limit is not None and index >= limit:
            break
        history = list(run.scan_history())
        runs.append(
            {
                "id": getattr(run, "id", None),
                "name": getattr(run, "name", None) or getattr(run, "id", None),
                "state": getattr(run, "state", None),
                "config": dict(getattr(run, "config", {}) or {}),
                "tags": list(getattr(run, "tags", []) or []),
                "metadata": {"entity": entity, "project": project, "path": getattr(run, "path", None)},
                "summary": dict(getattr(run, "summary", {}) or {}),
                "history": history,
                "artifacts": _wandb_artifact_refs(run),
            }
        )
    return {"project": project, "runs": runs}


def chunks_from_wandb_project(
    entity: str,
    project: str,
    *,
    target_project: str,
    limit: int | None = None,
    chunk_metric_limit: int = DEFAULT_CHUNK_METRICS,
) -> Iterable[dict[str, Any]]:
    try:
        import wandb  # type: ignore
    except ImportError as exc:
        raise InstantMLError("W&B import requires installing the optional `wandb` package.") from exc
    api = wandb.Api()
    source_project = f"{entity}/{project}"
    sequence = 0
    for index, run in enumerate(api.runs(source_project)):
        if limit is not None and index >= limit:
            break
        source_run_id = str(getattr(run, "id", None) or getattr(run, "name", None) or f"run-{index + 1}")
        run_row = {
            "source_run_id": source_run_id,
            "name": getattr(run, "name", None) or source_run_id,
            "status": getattr(run, "state", None) or "finished",
            "config": dict(getattr(run, "config", {}) or {}),
            "tags": list(getattr(run, "tags", []) or []),
            "metadata": {"entity": entity, "project": project, "path": getattr(run, "path", None)},
        }
        artifacts = [dict(ref, source_run_id=source_run_id) for ref in _wandb_artifact_refs(run)]
        pending_metrics: list[dict[str, Any]] = []
        run_sent = False
        for row_index, point in enumerate(run.scan_history()):
            if not isinstance(point, dict):
                continue
            step = _finite_number(point.get("_step"), float(row_index))
            timestamp = point.get("_timestamp")
            for key, value in point.items():
                if key.startswith("_") or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
                    continue
                pending_metrics.append({"source_run_id": source_run_id, "key": key, "step": step, "value": float(value), "timestamp": timestamp})
            if len(pending_metrics) >= chunk_metric_limit:
                yield canonical_chunk(source_type="wandb", source_project=source_project, target_project=target_project, job_id=0, chunk_id=f"chunk-{sequence}", sequence=sequence, runs=[run_row] if not run_sent else [], metric_points=pending_metrics, artifact_refs=artifacts if not run_sent else [])
                sequence += 1
                pending_metrics = []
                run_sent = True
        if pending_metrics or not run_sent:
            yield canonical_chunk(source_type="wandb", source_project=source_project, target_project=target_project, job_id=0, chunk_id=f"chunk-{sequence}", sequence=sequence, runs=[run_row] if not run_sent else [], metric_points=pending_metrics, artifact_refs=artifacts if not run_sent else [])
            sequence += 1


def _wandb_artifact_refs(run: Any) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    try:
        files = run.files()
    except Exception:
        files = []
    for file in files:
        name = getattr(file, "name", None)
        if name:
            refs.append({"name": name, "uri": f"wandb://{getattr(run, 'id', 'run')}/{name}", "type": "file"})
    return refs


def tensorboard_logdir_payload(logdir: str | Path, *, run_name: str | None = None) -> dict[str, Any]:
    try:
        from tensorboard.backend.event_processing.event_accumulator import EventAccumulator  # type: ignore
    except ImportError as exc:
        raise InstantMLError("TensorBoard sync requires installing the optional `tensorboard` package.") from exc
    path = Path(logdir).expanduser()
    event_dirs = _tensorboard_event_dirs(path)
    runs = []
    for run_path in event_dirs:
        accumulator = EventAccumulator(str(run_path))
        accumulator.Reload()
        source_run_id = run_path.relative_to(path).as_posix() if run_path != path else (path.name or "tensorboard-run")
        run = {
            "id": source_run_id,
            "name": run_name if len(event_dirs) == 1 and run_name else source_run_id,
            "status": "finished",
            "config": {},
            "tags": ["imported", "tensorboard"],
            "metadata": {"logdir": str(run_path)},
            "metrics": [],
        }
        for tag in accumulator.Tags().get("scalars", []):
            for event in accumulator.Scalars(tag):
                run["metrics"].append({"key": tag, "step": float(event.step), "value": float(event.value), "timestamp": float(event.wall_time)})
        for tag in accumulator.Tags().get("tensors", []):
            for event in accumulator.Tensors(tag):
                value = _tensor_scalar_value(getattr(event, "tensor_proto", None))
                if value is not None:
                    run["metrics"].append({"key": tag, "step": float(event.step), "value": value, "timestamp": float(event.wall_time)})
        runs.append(run)
    return {"project": path.name or "tensorboard", "runs": runs}


def _tensorboard_event_dirs(path: Path) -> list[Path]:
    dirs = {item.parent for item in path.rglob("events.out.tfevents.*")}
    if not dirs:
        return [path]
    if path in dirs:
        return [path, *sorted(dirs - {path})]
    return sorted(dirs)


def _tensor_scalar_value(tensor_proto: Any) -> float | None:
    if tensor_proto is None:
        return None
    for field in ("float_val", "double_val", "int_val", "int64_val"):
        values = getattr(tensor_proto, field, None)
        if values and len(values) == 1:
            return float(values[0])
    content = getattr(tensor_proto, "tensor_content", b"")
    dtype = getattr(tensor_proto, "dtype", None)
    if content and dtype in (1, 2) and len(content) in (4, 8):
        import struct

        return float(struct.unpack("<f" if len(content) == 4 else "<d", content)[0])
    return None


def _finite_number(value: Any, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default
