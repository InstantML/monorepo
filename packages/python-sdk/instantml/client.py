"""Small SDK for logging training runs."""

from __future__ import annotations

import atexit
import base64
import functools
import hashlib
import json
import math
import mimetypes
import os
import signal
import sqlite3
import sys
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import warnings
import weakref
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from .async_queue import (
    AsyncQueueRepository,
    DEFAULT_PRODUCER_BATCH_BYTES,
    DEFAULT_PRODUCER_BATCH_EVENTS,
    DEFAULT_PRODUCER_FLUSH_SECONDS,
    DEFAULT_PRODUCER_MAX_BUFFER_BYTES,
    DEFAULT_PRODUCER_MAX_BUFFER_EVENTS,
    DEFAULT_PRODUCER_RETRY_SECONDS,
    PreparedQueuedEvent,
    queue_path_for_run,
)
from .errors import InstantMLError
from .log_payload import (
    _classify_log_payload,
    _classify_log_sequence,
    _validate_rank_context,
    _validate_rank_weight,
)
from .media import (
    _FileStats,
    _hash_file,
    _is_local_file_uri,
    _strip_file_uri,
    _write_audio_data,
    _write_image_data,
    _write_video_data,
)
from .objects import (
    Artifact,
    Audio,
    CheckpointPolicy,
    ClassificationEval,
    File,
    Histogram,
    Image,
    Table,
    Text,
    Video,
    VersionedArtifact,
    _histogram_counts_for_edges,
    _histogram_from_count,
)
from .serialization import (
    _flatten,
    _flatten_numeric_value,
    _histogram_object_payload,
    _classification_eval_object_payload,
    _json_serializable,
    _merge_metadata,
    _normalize_table_rows,
    _table_object_payload,
    _tensor_to_python,
    _validate_optional_json_object,
)
from .credentials import _check_credentials_or_raise, _resolve_api_key as _resolve_api_key_from_env
from .http import _error_message, _offline_path, _spool_event
from .shadow import ShadowWandb, build_shadow as _build_shadow_wandb
from .source import (
    SourceTracking,
    _environment_metadata,
    _git_metadata,
    _normalize_source_tracking,
    _source_metadata,
)
from .validation import (
    CONSOLE_LOG_STREAMS,
    MAX_CONSOLE_LOG_LINES_PER_BATCH,
    MAX_CONSOLE_LOG_MESSAGE_BYTES,
    MAX_TEXT_BYTES,
    PROCESS_UPLOAD_MODES,
    _coerce_numeric_values,
    _is_scalar_number,
    _normalize_console_lines,
    _validate_console_stream,
    _validate_metrics,
    _validate_note_text,
    _validate_numeric_list,
    _validate_plain_string,
    _validate_step,
    _validate_text,
    _validate_text_series,
    _validate_upload_mode,
)


DEFAULT_PROCESS_SPOOL_DIR = ".instantml/spool"
SNAPSHOT_KEYS = {"metrics", "metadata"}
_PENDING_RUN_ID = "__instantml_pending__"
_RATE_LIMIT_RETRY_ATTEMPTS = 3
_RATE_LIMIT_RETRY_BASE_SECONDS = 0.25
_RATE_LIMIT_RETRY_MAX_SECONDS = 5.0


def _default_base_url() -> str:
    return os.environ.get("INSTANTML_API_BASE_URL") or "https://api.instantml.ai"


_DEFAULT_INIT_WAIT_SECONDS = 30.0


@dataclass(frozen=True)
class Client:
    base_url: str = field(default_factory=_default_base_url)
    timeout: float = 10.0
    offline_dir: str | None = None
    api_key: str | None = None

    def init(
        self,
        project: str | None = None,
        name: str | None = None,
        config: dict[str, Any] | None = None,
        tags: list[str] | None = None,
        notes: str | None = None,
        metadata: dict[str, Any] | None = None,
        buffer_size: int = 0,
        offline_dir: str | None = None,
        source_tracking: bool | SourceTracking = True,
        upload_mode: str = "async",
        spool_dir: str | None = None,
        local_store: bool = False,
        local_store_dir: str | None = None,
        system_metrics: bool = True,
        system_metrics_interval: float = 15.0,
        capture_console: bool = False,
        async_init: bool = True,
        shadow_wandb: Any = False,
        queue_dir: str | None = None,
        stop_check_interval_seconds: float = 10.0,
    ) -> "Run":
        _validate_upload_mode(upload_mode)
        if metadata and "_rlobs" in metadata:
            raise ValueError("metadata key '_rlobs' is reserved for SDK-owned metadata")
        source_settings = _normalize_source_tracking(source_tracking)
        combined_metadata = _environment_metadata(source_settings)
        if source_settings is not None:
            combined_metadata["_rlobs"] = {"source": _source_metadata(source_settings)}
        combined_metadata.update(metadata or {})
        if notes is not None:
            combined_metadata["notes"] = _validate_note_text(notes)
        create_body = {
            "project": project,
            "name": name,
            "config": config or {},
            "tags": tags or [],
            "metadata": combined_metadata,
        }
        run_client = Client(
            base_url=self.base_url,
            timeout=self.timeout,
            offline_dir=offline_dir or self.offline_dir,
            api_key=self.api_key,
        )

        shadow = _build_shadow_wandb(
            shadow_wandb,
            project=project,
            name=name,
            config=config,
            tags=tags,
            notes=notes,
        )

        if not async_init:
            response = self._request("POST", "/runs", create_body)
            run = Run(
                client=run_client,
                run_id=response["run"]["id"],
                buffer_size=buffer_size,
                upload_mode=upload_mode,
                spool_dir=spool_dir,
                queue_dir=queue_dir,
                stop_check_interval_seconds=stop_check_interval_seconds,
                _local_store=_LocalStore(local_store_dir, response["run"]["id"]) if local_store else None,
                shadow=shadow,
            )
            if system_metrics:
                run.start_system_metrics(interval=system_metrics_interval)
            if capture_console:
                run.capture_console()
            return run

        run = Run(
            client=run_client,
            run_id=_PENDING_RUN_ID,
            buffer_size=buffer_size,
            upload_mode=upload_mode,
            spool_dir=spool_dir,
            queue_dir=queue_dir,
            stop_check_interval_seconds=stop_check_interval_seconds,
            shadow=shadow,
        )

        def _resolve_init() -> None:
            try:
                response = self._request("POST", "/runs", create_body)
                real_run_id = response["run"]["id"]
                if local_store:
                    run._local_store = _LocalStore(local_store_dir, real_run_id)
                run._set_run_id(real_run_id)
                if system_metrics:
                    try:
                        run.start_system_metrics(interval=system_metrics_interval)
                    except Exception as exc:  # noqa: BLE001 — keep init alive but surface optional setup failure
                        warnings.warn(f"system metrics sampler could not start: {exc}", RuntimeWarning, stacklevel=2)
                if capture_console:
                    try:
                        run.capture_console()
                    except Exception as exc:  # noqa: BLE001
                        warnings.warn(f"console capture could not start: {exc}", RuntimeWarning, stacklevel=2)
                run._init_done.set()
            except BaseException as exc:  # noqa: BLE001 — propagate to foreground via property
                run._init_error = exc
                run._init_done.set()

        thread = threading.Thread(
            target=_resolve_init,
            name=f"instantml-init-{project}",
            daemon=True,
        )
        thread.start()
        return run

    def attach_run(
        self,
        run_id: str,
        buffer_size: int = 0,
        upload_mode: str = "async",
        spool_dir: str | None = None,
        local_store: bool = False,
        local_store_dir: str | None = None,
        system_metrics: bool = True,
        system_metrics_interval: float = 15.0,
        capture_console: bool = False,
        queue_dir: str | None = None,
        validate: bool = True,
        stop_check_interval_seconds: float = 10.0,
    ) -> "Run":
        """Return a Run handle for an existing server-side run."""

        run_id = _validate_text(run_id, "run id")
        _validate_upload_mode(upload_mode)
        if not isinstance(validate, bool):
            raise TypeError("validate must be a bool")
        if validate:
            response = self._request(
                "GET",
                f"/runs/{urllib.parse.quote(run_id, safe='')}",
            )
            run_payload = response.get("run")
            if not isinstance(run_payload, dict) or str(run_payload.get("id", "")) != run_id:
                raise InstantMLError("server returned an invalid run response")
        run = Run(
            client=self,
            run_id=run_id,
            buffer_size=buffer_size,
            upload_mode=upload_mode,
            spool_dir=spool_dir,
            queue_dir=queue_dir,
            stop_check_interval_seconds=stop_check_interval_seconds,
            _local_store=_LocalStore(local_store_dir, run_id) if local_store else None,
        )
        if system_metrics:
            run.start_system_metrics(interval=system_metrics_interval)
        if capture_console:
            run.capture_console()
        return run

    def _resolve_api_key(self) -> str | None:
        return _resolve_api_key_from_env(self.api_key)

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        url = self.base_url.rstrip("/") + path
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        api_key = self._resolve_api_key()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        payload = ""
        for attempt in range(_RATE_LIMIT_RETRY_ATTEMPTS + 1):
            request = urllib.request.Request(
                url,
                data=data,
                method=method,
                headers=headers,
            )
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    payload = response.read().decode("utf-8")
                break
            except urllib.error.HTTPError as exc:
                if exc.code == 429 and _is_retryable_rate_limit(exc) and attempt < _RATE_LIMIT_RETRY_ATTEMPTS:
                    time.sleep(_rate_limit_retry_delay(exc, attempt))
                    continue
                message = _error_message(exc)
                raise InstantMLError(f"{method} {path} failed: {message}") from exc
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                raise InstantMLError(f"{method} {path} failed: {exc}") from exc
        try:
            decoded = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise InstantMLError("server returned invalid JSON") from exc
        if not isinstance(decoded, dict):
            raise InstantMLError("server returned a non-object JSON payload")
        return decoded


@dataclass(frozen=True)
class StopRequest:
    run_id: str
    stop_request_id: str
    requested_at: str | None = None
    acknowledged_at: str | None = None


class InstantMLStopRequested(InstantMLError):
    """Raised when a cooperative dashboard stop request is observed."""

    def __init__(self, request: StopRequest):
        super().__init__(f"stop requested for run {request.run_id}")
        self.run_id = request.run_id
        self.stop_request_id = request.stop_request_id
        self.requested_at = request.requested_at
        self.acknowledged_at = request.acknowledged_at
        self.request = request


def _rate_limit_retry_delay(exc: urllib.error.HTTPError, attempt: int) -> float:
    retry_after = exc.headers.get("Retry-After") if exc.headers else None
    if retry_after:
        try:
            seconds = float(retry_after)
        except (TypeError, ValueError):
            seconds = 0.0
        if seconds > 0:
            return min(seconds, _RATE_LIMIT_RETRY_MAX_SECONDS)
    return min(
        _RATE_LIMIT_RETRY_BASE_SECONDS * (2**attempt),
        _RATE_LIMIT_RETRY_MAX_SECONDS,
    )


def _is_retryable_rate_limit(exc: urllib.error.HTTPError) -> bool:
    scope = exc.headers.get("X-InstantML-RateLimit-Scope") if exc.headers else None
    return str(scope or "second").strip().lower() != "monthly"


def _stop_signal_unsupported(exc: InstantMLError) -> bool:
    message = str(exc).lower()
    return "404" in message or "405" in message or "not found" in message or "method not allowed" in message


def _versioned_artifact_idempotency_key(run_id: str, body: dict[str, Any]) -> str:
    payload = json.dumps({"run_id": run_id, "body": body}, sort_keys=True, separators=(",", ":"), default=str)
    return "instantml-artifact-" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _safe_artifact_download_path(value: str) -> Path:
    path = _validate_artifact_manifest_path(value)
    return Path(*path.split("/"))


def _validate_artifact_manifest_path(value: str) -> str:
    if not isinstance(value, str):
        raise TypeError("artifact manifest path must be a string")
    text = value.strip()
    if not text:
        raise ValueError("artifact manifest path must be non-empty")
    if text.startswith("/") or "\\" in text:
        raise ValueError("artifact manifest path must be relative and use '/' separators")
    segments = text.split("/")
    if any(segment in {"", ".", ".."} for segment in segments):
        raise ValueError("artifact manifest path cannot contain empty, '.', or '..' segments")
    return "/".join(segments)


def _prepare_versioned_artifact_files(artifact: VersionedArtifact) -> list[dict[str, Any]]:
    if not artifact.files:
        raise ValueError("versioned artifact must include at least one file")
    prepared = []
    seen = set()
    for item in artifact.files:
        source = Path(item["path"]).expanduser().resolve()
        if not source.exists() or not source.is_file():
            raise InstantMLError(f"artifact file does not exist: {source}")
        artifact_path = _validate_artifact_manifest_path(item["name"])
        if artifact_path in seen:
            raise ValueError(f"duplicate artifact manifest path: {artifact_path}")
        seen.add(artifact_path)
        stats = _hash_file(source)
        prepared.append(
            {
                "source": source,
                "artifact_path": artifact_path,
                "stats": stats,
                "mime_type": mimetypes.guess_type(artifact_path)[0] or "application/octet-stream",
            }
        )
    return prepared


def _upload_versioned_artifact_file(
    source: Path,
    upload_file: dict[str, Any],
    timeout: float,
    renew_parts: Callable[[str, int, int], list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    entry_id = _validate_text(str(upload_file.get("entry_id", "")), "artifact entry id")
    upload_kind = str(upload_file.get("upload_kind", ""))
    if upload_kind == "inline":
        return {
            "entry_id": entry_id,
            "content_base64": base64.b64encode(source.read_bytes()).decode("ascii"),
        }
    parts = upload_file.get("parts")
    if not isinstance(parts, list) or not parts:
        raise InstantMLError("server did not return upload URLs for artifact file")
    if upload_kind == "put":
        part = parts[0]
        if _artifact_part_expires_soon(part):
            if renew_parts is None:
                raise InstantMLError("artifact upload URL expired before upload")
            renewed = renew_parts(entry_id, 1, 1)
            if not isinstance(renewed, list) or not renewed:
                raise InstantMLError("server did not renew artifact upload URL")
            part = renewed[0]
        if _artifact_part_expires_soon(part):
            raise InstantMLError("server returned an expired artifact upload URL")
        _put_presigned_url_with_headers(str(part.get("url", "")), source.read_bytes(), timeout, _artifact_required_headers(part))
        return {"entry_id": entry_id}
    if upload_kind != "multipart":
        raise InstantMLError(f"unsupported artifact upload kind: {upload_kind}")
    part_size = int(upload_file.get("part_size_bytes") or 0)
    if part_size <= 0:
        raise InstantMLError("server returned an invalid artifact multipart size")
    part_count = int(upload_file.get("part_count") or len(parts))
    if part_count <= 0:
        raise InstantMLError("server returned an invalid artifact multipart part count")
    parts_by_number: dict[int, dict[str, Any]] = {}
    for part in parts:
        part_number = int(part.get("part_number") or 0)
        if part_number > 0:
            parts_by_number[part_number] = part
    completed_parts = []
    with source.open("rb") as handle:
        for part_number in range(1, part_count + 1):
            part = parts_by_number.get(part_number)
            if part is None or _artifact_part_expires_soon(part):
                if renew_parts is None:
                    raise InstantMLError("server did not return enough artifact multipart upload URLs")
                renewed = renew_parts(entry_id, part_number, min(256, part_count - part_number + 1))
                if not isinstance(renewed, list) or not renewed:
                    raise InstantMLError("server did not renew artifact multipart upload URLs")
                for renewed_part in renewed:
                    renewed_part_number = int(renewed_part.get("part_number") or 0)
                    if renewed_part_number > 0:
                        parts_by_number[renewed_part_number] = renewed_part
                part = parts_by_number.get(part_number)
                if part is None:
                    raise InstantMLError("server did not renew the requested artifact multipart upload URL")
                if _artifact_part_expires_soon(part):
                    raise InstantMLError("server returned an expired artifact multipart upload URL")
            url = str(part.get("url", ""))
            chunk = handle.read(part_size)
            if not chunk:
                raise InstantMLError("artifact source ended before all multipart parts were read")
            etag = _put_presigned_url_with_headers(url, chunk, timeout, _artifact_required_headers(part))
            completed_parts.append({"part_number": part_number, "etag": etag})
        if handle.read(1):
            raise InstantMLError("artifact source changed after manifest hashing")
    return {"entry_id": entry_id, "parts": completed_parts}


def _artifact_part_expires_soon(part: dict[str, Any], skew_seconds: int = 60) -> bool:
    expires_at = part.get("expires_at")
    if not isinstance(expires_at, str) or not expires_at:
        return False
    try:
        parsed = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed <= datetime.now(timezone.utc) + timedelta(seconds=skew_seconds)


def _artifact_required_headers(part: dict[str, Any]) -> dict[str, str]:
    headers = part.get("required_headers")
    if not isinstance(headers, dict):
        return {}
    return {str(key): str(value) for key, value in headers.items()}


def _put_presigned_url_with_headers(url: str, payload: bytes, timeout: float, headers: dict[str, str]) -> str:
    try:
        return _put_presigned_url(url, payload, timeout, headers)
    except TypeError:
        if headers:
            raise
        return _put_presigned_url(url, payload, timeout)


def _put_presigned_url(url: str, payload: bytes, timeout: float, headers: dict[str, str] | None = None) -> str:
    if not url:
        raise InstantMLError("artifact upload URL is missing")
    request = urllib.request.Request(url, data=payload, method="PUT", headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            etag = response.headers.get("ETag", "")
            response.read()
            return etag.strip('"')
    except urllib.error.HTTPError as exc:
        raise InstantMLError(f"artifact upload PUT failed: {_error_message(exc)}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise InstantMLError(f"artifact upload PUT failed: {exc}") from exc


def _async_request_supported(method: str, path: str, body: dict[str, Any]) -> bool:
    if method == "POST" and (path.endswith("/metrics") or path.endswith("/rank-metrics") or path.endswith("/logs")):
        return True
    if method == "PATCH" and path.startswith("/runs/") and set(body) == {"status"}:
        return True
    return False


@dataclass(frozen=True)
class Api:
    """Tiny raw API helper for post-hoc queries and run fork creation."""

    base_url: str = field(default_factory=_default_base_url)
    timeout: float = 10.0
    api_key: str | None = None

    def runs(
        self,
        cursor: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
        project: str | None = None,
        project_id: str | None = None,
        status: str | None = None,
        q: str | None = None,
        sort_by: str | None = None,
        metric_key: str | None = None,
    ) -> dict[str, Any]:
        if cursor not in (None, "") and offset not in (None, 0):
            raise ValueError("cursor cannot be used with a nonzero offset")
        params = {
            "cursor": cursor,
            "limit": limit,
            "offset": offset,
            "project": project,
            "project_id": project_id,
            "status": status,
            "q": q,
            "sort_by": sort_by,
            "metric_key": metric_key,
        }
        query = urllib.parse.urlencode(
            [(key, value) for key, value in params.items() if value is not None and value != ""]
        )
        path = "/api/runs/summary"
        if query:
            path = f"{path}?{query}"
        return Client(base_url=self.base_url, timeout=self.timeout, api_key=self.api_key)._request(
            "GET",
            path,
        )

    def fork_run(
        self,
        source_run_id: str,
        *,
        step: int | float | None = None,
        checkpoint_artifact_id: str | None = None,
        inherit_config: bool = True,
        config_overrides: dict[str, Any] | None = None,
        tags: list[str] | None = None,
        name: str | None = None,
        notes: str | None = None,
        metadata: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        source_run_id = _validate_text(source_run_id, "source run id")
        if not isinstance(inherit_config, bool):
            raise TypeError("inherit_config must be a bool")
        body: dict[str, Any] = {"inherit_config": inherit_config}
        normalized_step = _validate_step(step)
        if normalized_step is not None:
            body["step"] = normalized_step
        if checkpoint_artifact_id is not None:
            body["checkpoint_artifact_id"] = _validate_text(checkpoint_artifact_id, "checkpoint artifact id")
        if config_overrides is not None:
            body["config_overrides"] = _validate_optional_json_object(config_overrides, "config_overrides")
        if tags is not None:
            if isinstance(tags, (str, bytes)) or not isinstance(tags, (list, tuple)):
                raise TypeError("tags must be a list of strings")
            body["tags"] = [_validate_text(tag, "tag") for tag in tags]
        if name is not None:
            body["name"] = _validate_text(name, "run name")
        if notes is not None:
            normalized_notes = _validate_note_text(notes)
            if not normalized_notes.strip():
                raise ValueError("notes must not be empty")
            body["notes"] = normalized_notes
        if metadata is not None:
            body["metadata"] = _validate_optional_json_object(metadata, "metadata")
        safe_idempotency_key = (
            _validate_text(idempotency_key, "idempotency key")
            if idempotency_key is not None
            else _fork_idempotency_key(source_run_id, body)
        )
        response = Client(base_url=self.base_url, timeout=self.timeout, api_key=self.api_key)._request(
            "POST",
            f"/api/runs/{urllib.parse.quote(source_run_id, safe='')}/forks",
            body,
            idempotency_key=safe_idempotency_key,
        )
        run = response.get("run")
        if not isinstance(run, dict):
            raise InstantMLError("server returned an invalid fork response")
        return run

    def download_artifact(self, artifact_id: str, output_path: str | os.PathLike[str]) -> str:
        artifact_id = _validate_text(artifact_id, "artifact id")
        if not isinstance(output_path, (str, os.PathLike)):
            raise TypeError("output_path must be a path")
        raw_output = os.fspath(output_path)
        target = Path(raw_output).expanduser()
        if target.exists() and target.is_dir():
            target = target / artifact_id
        elif raw_output.endswith((os.sep, "/")):
            target.mkdir(parents=True, exist_ok=True)
            target = target / artifact_id
        target.parent.mkdir(parents=True, exist_ok=True)

        url = f"{self.base_url.rstrip('/')}/api/artifacts/{urllib.parse.quote(artifact_id, safe='')}/download"
        headers = {"Accept": "application/octet-stream"}
        api_key = _resolve_api_key_from_env(self.api_key)
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        request = urllib.request.Request(url, method="GET", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = response.read()
        except urllib.error.HTTPError as exc:
            message = _error_message(exc)
            raise InstantMLError(f"GET /api/artifacts/{artifact_id}/download failed: {message}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise InstantMLError(f"GET /api/artifacts/{artifact_id}/download failed: {exc}") from exc
        target.write_bytes(payload)
        return str(target)

    def artifact(
        self,
        ref: str,
        type: str | None = None,
        project: str | None = None,
    ) -> "LoggedArtifact":
        ref = _validate_text(ref, "artifact ref")
        params = {"ref": ref, "type": type, "project": project}
        query = urllib.parse.urlencode(
            [(key, value) for key, value in params.items() if value is not None and value != ""]
        )
        payload = Client(base_url=self.base_url, timeout=self.timeout, api_key=self.api_key)._request(
            "GET",
            f"/api/artifact-versions/resolve?{query}",
        )
        artifact_version = payload.get("artifact_version")
        if not isinstance(artifact_version, dict):
            raise InstantMLError("server returned an invalid artifact response")
        return LoggedArtifact(self, artifact_version)

    def _manifest_entries(self, artifact_version_id: str) -> list[dict[str, Any]]:
        artifact_version_id = _validate_text(artifact_version_id, "artifact version id")
        payload = Client(base_url=self.base_url, timeout=self.timeout, api_key=self.api_key)._request(
            "GET",
            f"/api/artifact-versions/{urllib.parse.quote(artifact_version_id, safe='')}/manifest?limit=1000",
        )
        entries = payload.get("entries")
        if not isinstance(entries, list):
            raise InstantMLError("server returned an invalid artifact manifest")
        return [entry for entry in entries if isinstance(entry, dict)]

    def _download_artifact_entry(self, entry_id: str, output_path: str | os.PathLike[str]) -> str:
        entry_id = _validate_text(entry_id, "artifact entry id")
        if not isinstance(output_path, (str, os.PathLike)):
            raise TypeError("output_path must be a path")
        target = Path(output_path).expanduser()
        target.parent.mkdir(parents=True, exist_ok=True)
        url = f"{self.base_url.rstrip('/')}/api/artifact-entries/{urllib.parse.quote(entry_id, safe='')}/download"
        headers = {"Accept": "application/octet-stream"}
        api_key = _resolve_api_key_from_env(self.api_key)
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        request = urllib.request.Request(url, method="GET", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                with target.open("wb") as handle:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        handle.write(chunk)
        except urllib.error.HTTPError as exc:
            message = _error_message(exc)
            raise InstantMLError(f"GET /api/artifact-entries/{entry_id}/download failed: {message}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            target.unlink(missing_ok=True)
            raise InstantMLError(f"GET /api/artifact-entries/{entry_id}/download failed: {exc}") from exc
        return str(target)


class LoggedArtifact:
    """Handle returned by versioned artifact logging or resolution."""

    def __init__(self, api: Api, artifact_version: dict[str, Any]) -> None:
        self._api = api
        self.artifact_version = artifact_version

    @property
    def id(self) -> str:
        return str(self.artifact_version.get("id", ""))

    @property
    def name(self) -> str:
        return str(self.artifact_version.get("name", ""))

    @property
    def version(self) -> str:
        return str(self.artifact_version.get("version", ""))

    @property
    def aliases(self) -> list[str]:
        aliases = self.artifact_version.get("aliases")
        return [str(alias) for alias in aliases] if isinstance(aliases, list) else []

    def download(self, output_dir: str | os.PathLike[str] = ".") -> list[str]:
        root = Path(output_dir).expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
        written: list[str] = []
        for entry in self._api._manifest_entries(self.id):
            if not entry.get("downloadable"):
                continue
            relative_path = _safe_artifact_download_path(str(entry.get("path", "")))
            target = (root / relative_path).resolve()
            if root != target and root not in target.parents:
                raise InstantMLError("artifact manifest entry escapes the output directory")
            written.append(self._api._download_artifact_entry(str(entry.get("id", "")), target))
        return written

    def promote(self, alias: str = "best", *, reason: str = "sdk alias promotion") -> "LoggedArtifact":
        alias = _validate_text(alias, "artifact alias")
        collection_id = _validate_text(str(self.artifact_version.get("collection_id", "")), "collection id")
        payload = Client(base_url=self._api.base_url, timeout=self._api.timeout, api_key=self._api.api_key)._request(
            "PUT",
            f"/api/artifact-collections/{urllib.parse.quote(collection_id, safe='')}/aliases/{urllib.parse.quote(alias, safe='')}",
            {"artifact_version_id": self.id, "confirm": alias, "reason": reason},
        )
        artifact_version = payload.get("artifact_version")
        if isinstance(artifact_version, dict):
            self.artifact_version = artifact_version
        return self

    def delete(self, *, delete_aliases: bool = False, reason: str = "sdk artifact delete") -> dict[str, Any]:
        body = {"delete_aliases": delete_aliases, "confirm": self.id, "reason": reason}
        payload = Client(base_url=self._api.base_url, timeout=self._api.timeout, api_key=self._api.api_key)._request(
            "DELETE",
            f"/api/artifact-versions/{urllib.parse.quote(self.id, safe='')}",
            body,
        )
        artifact_version = payload.get("artifact_version")
        if isinstance(artifact_version, dict):
            self.artifact_version = artifact_version
        return payload


def _is_retryable_sqlite_enqueue_error(message: str) -> bool:
    lowered = message.lower()
    return "locked" in lowered or "busy" in lowered


class _AsyncProducerBuffer:
    def __init__(
        self,
        run: "Run",
        *,
        max_events: int = DEFAULT_PRODUCER_BATCH_EVENTS,
        max_bytes: int = DEFAULT_PRODUCER_BATCH_BYTES,
        max_age_seconds: float = DEFAULT_PRODUCER_FLUSH_SECONDS,
        hard_max_events: int = DEFAULT_PRODUCER_MAX_BUFFER_EVENTS,
        hard_max_bytes: int = DEFAULT_PRODUCER_MAX_BUFFER_BYTES,
        retry_seconds: float = DEFAULT_PRODUCER_RETRY_SECONDS,
        clock: Any = time.monotonic,
    ) -> None:
        self._run = run
        self._max_events = max_events
        self._max_bytes = max_bytes
        self._max_age_seconds = max_age_seconds
        self._hard_max_events = hard_max_events
        self._hard_max_bytes = hard_max_bytes
        self._retry_seconds = retry_seconds
        self._clock = clock
        self._condition = threading.Condition(threading.RLock())
        self._buffer: list[tuple[int, PreparedQueuedEvent]] = []
        self._buffer_bytes = 0
        self._oldest_buffered_at: float | None = None
        self._next_sequence = 1
        self._completed_sequence = 0
        self._flush_requested = False
        self._closed = False
        self._worker: threading.Thread | None = None
        self._last_flush_error: str | None = None

    def append(self, event: PreparedQueuedEvent) -> bool:
        warning: tuple[str, int] | None = None
        with self._condition:
            if self._closed:
                warning = ("async producer buffer is closed; dropped event", 1)
            elif len(self._buffer) + 1 > self._hard_max_events or self._buffer_bytes + event.body_size_bytes > self._hard_max_bytes:
                warning = ("async producer buffer hard limit reached; dropped event", 1)
            else:
                sequence = self._next_sequence
                self._next_sequence += 1
                self._buffer.append((sequence, event))
                self._buffer_bytes += event.body_size_bytes
                if self._oldest_buffered_at is None:
                    self._oldest_buffered_at = self._clock()
                try:
                    self._ensure_worker_locked()
                except Exception:
                    self._buffer.pop()
                    self._next_sequence -= 1
                    self._buffer_bytes -= event.body_size_bytes
                    if not self._buffer:
                        self._oldest_buffered_at = None
                    raise
                if len(self._buffer) >= self._max_events or self._buffer_bytes >= self._max_bytes:
                    self._flush_requested = True
                self._condition.notify_all()
                return True
        if warning is not None:
            self._run._warn_async_drop(warning[0], count_local=True, count=warning[1])
        return False

    def force_flush(self, timeout: float | None = None) -> bool:
        deadline = None if timeout is None else self._clock() + max(0.0, timeout)
        with self._condition:
            target_sequence = self._next_sequence - 1
            if target_sequence <= self._completed_sequence:
                return True
            self._ensure_worker_locked()
            self._flush_requested = True
            self._condition.notify_all()
            while self._completed_sequence < target_sequence:
                worker_dead = self._worker is not None and not self._worker.is_alive()
                if worker_dead and self._buffer:
                    self._ensure_worker_locked()
                    self._flush_requested = True
                    self._condition.notify_all()
                if deadline is not None:
                    remaining = deadline - self._clock()
                    if remaining <= 0:
                        self._last_flush_error = "async producer flush timed out"
                        return False
                    self._condition.wait(timeout=min(remaining, 0.05))
                else:
                    self._condition.wait(timeout=0.05)
            return True

    def stop(self, timeout: float | None = None) -> bool:
        ok = self.force_flush(timeout=timeout)
        with self._condition:
            self._closed = True
            self._condition.notify_all()
            worker = self._worker
        if worker is not None and worker.is_alive():
            worker.join(timeout=timeout)
            if worker.is_alive():
                with self._condition:
                    self._last_flush_error = "async producer writer did not stop before timeout"
                return False
        return ok

    def status(self) -> dict[str, Any]:
        with self._condition:
            return {
                "buffered_events": len(self._buffer),
                "buffered_bytes": self._buffer_bytes,
                "last_flush_error": self._last_flush_error,
            }

    def _ensure_worker_locked(self) -> None:
        if self._closed:
            return
        if self._worker is not None and self._worker.is_alive():
            return
        self._worker = threading.Thread(
            target=self._worker_loop,
            name=f"instantml-async-producer-{self._run._run_id}",
            daemon=True,
        )
        self._worker.start()

    def _flush_due_locked(self) -> bool:
        if not self._buffer:
            return False
        if self._flush_requested or len(self._buffer) >= self._max_events or self._buffer_bytes >= self._max_bytes:
            return True
        if self._oldest_buffered_at is None:
            return False
        return self._clock() - self._oldest_buffered_at >= self._max_age_seconds

    def _worker_loop(self) -> None:
        while True:
            with self._condition:
                while not self._closed and not self._flush_due_locked():
                    timeout = None
                    if self._buffer and self._oldest_buffered_at is not None:
                        timeout = max(0.0, self._max_age_seconds - (self._clock() - self._oldest_buffered_at))
                    self._condition.wait(timeout=timeout)
                if self._closed and not self._buffer:
                    return
                if not self._buffer:
                    continue
                batch = self._buffer
                self._buffer = []
                self._buffer_bytes = 0
                self._oldest_buffered_at = None
                self._flush_requested = False
            ok, retryable, message, completed = self._write_batch(batch)
            with self._condition:
                if ok or not retryable:
                    if completed:
                        self._completed_sequence = max(self._completed_sequence, completed)
                    self._last_flush_error = message
                    self._condition.notify_all()
                    continue
                self._buffer = batch + self._buffer
                self._buffer_bytes += sum(event.body_size_bytes for _, event in batch)
                self._oldest_buffered_at = self._clock()
                self._flush_requested = True
                self._last_flush_error = message
                self._condition.notify_all()
            time.sleep(self._retry_seconds)

    def _write_batch(self, batch: list[tuple[int, PreparedQueuedEvent]]) -> tuple[bool, bool, str | None, int | None]:
        if not batch:
            return True, False, None, None
        last_sequence = batch[-1][0]
        events = [event for _, event in batch]
        try:
            queue = self._run._require_async_queue()
            result = queue.enqueue_many_prepared(events)
            if result.inserted:
                self._run._start_async_uploader()
            if result.dropped:
                message = result.message or "async queue dropped buffered events because local queue limits were reached"
                self._run._warn_async_drop(message)
                return True, False, message, last_sequence
            return True, False, None, last_sequence
        except Exception as exc:  # noqa: BLE001 - async producer must not stop training
            message = f"async producer flush failed: {exc}"
            if _is_retryable_sqlite_enqueue_error(str(exc)):
                return False, True, message, None
            self._run._warn_async_drop(message, count_local=True, count=len(batch))
            return False, False, message, last_sequence


# --- Process lifecycle: flush and close out runs on interpreter exit, on
# SIGTERM/SIGINT (SLURM/k8s preemption), and reset inherited connections after
# os.fork() (PyTorch DataLoader workers). Without this a forgotten finish()
# silently loses buffered data, a preempted job stays "running" forever, and a
# forked child sharing the parent's SQLite file descriptor corrupts the queue.

_ACTIVE_RUNS: "weakref.WeakSet[Run]" = weakref.WeakSet()
_ACTIVE_RUNS_LOCK = threading.Lock()
_LIFECYCLE_INSTALLED = False
_PREVIOUS_SIGNAL_HANDLERS: dict[int, Any] = {}


def _register_active_run(run: "Run") -> None:
    with _ACTIVE_RUNS_LOCK:
        _ACTIVE_RUNS.add(run)
    _install_lifecycle_handlers()


def _unregister_active_run(run: "Run") -> None:
    with _ACTIVE_RUNS_LOCK:
        _ACTIVE_RUNS.discard(run)


def _active_runs_snapshot() -> list["Run"]:
    with _ACTIVE_RUNS_LOCK:
        return list(_ACTIVE_RUNS)


def _flush_active_runs(status: str) -> None:
    for run in _active_runs_snapshot():
        try:
            run._finish_from_lifecycle(status)
        except Exception:  # noqa: BLE001 - shutdown must stay best-effort
            pass


def _atexit_flush() -> None:
    _flush_active_runs("finished")


def _handle_termination_signal(signum: int, frame: Any) -> None:
    # A preempted run is interrupted, not cleanly finished.
    _flush_active_runs("failed")
    previous = _PREVIOUS_SIGNAL_HANDLERS.get(signum, signal.SIG_DFL)
    if callable(previous):
        previous(signum, frame)
        return
    if previous == signal.SIG_IGN:
        return
    # Restore default disposition and re-raise so normal termination semantics
    # (KeyboardInterrupt for SIGINT, process exit for SIGTERM) still apply.
    signal.signal(signum, signal.SIG_DFL)
    os.kill(os.getpid(), signum)


def _before_fork() -> None:
    _ACTIVE_RUNS_LOCK.acquire()


def _after_fork_parent() -> None:
    _ACTIVE_RUNS_LOCK.release()


def _after_fork_child() -> None:
    try:
        runs = list(_ACTIVE_RUNS)
    finally:
        _ACTIVE_RUNS_LOCK.release()
    for run in runs:
        try:
            run._reset_after_fork()
        except Exception:  # noqa: BLE001 - never let a fork hook crash the child
            pass


def _install_lifecycle_handlers() -> None:
    global _LIFECYCLE_INSTALLED
    if _LIFECYCLE_INSTALLED:
        return
    _LIFECYCLE_INSTALLED = True
    atexit.register(_atexit_flush)
    if hasattr(os, "register_at_fork"):
        os.register_at_fork(
            before=_before_fork,
            after_in_parent=_after_fork_parent,
            after_in_child=_after_fork_child,
        )
    if threading.current_thread() is threading.main_thread():
        for signum in (signal.SIGINT, signal.SIGTERM):
            try:
                previous = signal.getsignal(signum)
                signal.signal(signum, _handle_termination_signal)
                _PREVIOUS_SIGNAL_HANDLERS[signum] = previous
            except (ValueError, OSError, RuntimeError):
                # Signals can only be set from the main thread of the main
                # interpreter; skip quietly when that is not the case.
                pass


def _async_hot_path(method):
    """Make a public ``log*`` method warn-and-drop instead of raising on the async path.

    The README promises that async ``log_metrics``/``log_rank_metrics``/``log_console``
    (and ``log()`` which dispatches to them) surface problems through
    ``upload_status()`` rather than raising into the training loop. Validation and
    classification errors (``TypeError``/``ValueError``) — e.g. ``log({"loss": float('nan')})``
    or logging a raw tensor — would otherwise crash the loop. Sync and spool modes
    keep raising so scripts and CI still fail fast.
    """

    @functools.wraps(method)
    def wrapper(self: "Run", *args: Any, **kwargs: Any) -> Any:
        if self.upload_mode != "async":
            return method(self, *args, **kwargs)
        try:
            return method(self, *args, **kwargs)
        except (TypeError, ValueError) as exc:
            self._warn_async_drop(
                f"{method.__name__}() dropped an invalid payload on the async path: {exc}",
                count_local=True,
            )
            return None

    return wrapper


class Run:
    def __init__(
        self,
        client: Client,
        run_id: str,
        buffer_size: int = 0,
        upload_mode: str = "sync",
        spool_dir: str | None = None,
        queue_dir: str | None = None,
        media_dir: str | None = None,
        stop_check_interval_seconds: float = 10.0,
        _local_store: "_LocalStore | None" = None,
        shadow: "ShadowWandb | None" = None,
    ) -> None:
        _validate_upload_mode(upload_mode)
        self.client = client
        self._run_id = run_id
        self.buffer_size = buffer_size
        self.upload_mode = upload_mode
        self.spool_dir = spool_dir
        self.queue_dir = queue_dir
        self.media_dir = media_dir
        self.stop_check_interval_seconds = max(0.0, float(stop_check_interval_seconds))
        self._lock = threading.RLock()
        self._process_spool_run_dir = _process_spool_run_dir(spool_dir, run_id) if upload_mode == "spool" and run_id and run_id != _PENDING_RUN_ID else None
        if self._process_spool_run_dir is not None:
            self._process_spool_run_dir.mkdir(parents=True, exist_ok=True)
        self._async_queue: AsyncQueueRepository | None = None
        self._async_process: subprocess.Popen[Any] | None = None
        self._async_process_lock = threading.RLock()
        self._async_buffer: _AsyncProducerBuffer | None = _AsyncProducerBuffer(self) if upload_mode == "async" else None
        self._async_start_warning_emitted = False
        self._last_async_warning_at = 0.0
        self._async_disabled_reason: str | None = None
        self._async_local_dropped = 0
        if upload_mode == "async" and run_id and run_id != _PENDING_RUN_ID:
            if self._open_async_queue_or_warn(run_id):
                self._start_async_uploader()
        self._queue: list[dict[str, Any]] = []
        self._last_steps: dict[str, float] = {}
        self._console_line_numbers: dict[str, int] = {}
        self._process_sequence: int = 0
        self._auto_step: int | float = 0
        self._finished = False
        self._next_stop_check_at = 0.0
        self._stop_signal_supported = True
        self._stop_request: StopRequest | None = None
        self._stop_acknowledged = False
        self._local_store: "_LocalStore | None" = _local_store
        _register_active_run(self)
        self._system_sampler: "_SystemMetricsSampler | None" = None
        self._console_capture: "_ConsoleCapture | None" = None
        self._init_done = threading.Event()
        self._init_error: BaseException | None = None
        self._shadow: "ShadowWandb | None" = shadow
        if run_id and run_id != _PENDING_RUN_ID:
            self._init_done.set()

    @property
    def run_id(self) -> str:
        if not self._init_done.is_set():
            self._init_done.wait()
        if self._init_error is not None:
            raise self._init_error
        return self._run_id

    @run_id.setter
    def run_id(self, value: str) -> None:
        self._set_run_id(value)
        if value and value != _PENDING_RUN_ID:
            self._init_done.set()

    def _set_run_id(self, value: str) -> None:
        self._run_id = value
        if value and value != _PENDING_RUN_ID:
            if self.upload_mode == "spool":
                self._process_spool_run_dir = _process_spool_run_dir(self.spool_dir, value)
                self._process_spool_run_dir.mkdir(parents=True, exist_ok=True)
            elif self.upload_mode == "async":
                if self._open_async_queue_or_warn(value):
                    self._start_async_uploader()

    def wait_for_init(self, timeout: float | None = None) -> str:
        """Block until init resolves and return the real run_id.

        Raises ``InstantMLError`` if the deadline expires. Re-raises any
        exception that the background init thread captured.
        """
        if not self._init_done.is_set():
            if not self._init_done.wait(timeout=timeout):
                raise InstantMLError("run init did not complete in time")
        if self._init_error is not None:
            raise self._init_error
        return self._run_id

    def upload_status(self) -> dict[str, Any]:
        buffer_status = self._async_buffer_status()
        if self.upload_mode != "async":
            return {
                "mode": self.upload_mode,
                "pending": 0,
                "in_flight": 0,
                "processed": 0,
                "failed": 0,
                "dropped": 0,
                "oldest_pending_age_seconds": None,
                "last_error": None,
                **buffer_status,
            }
        if self._async_disabled_reason is not None:
            return {
                "mode": "async",
                "pending": 0,
                "in_flight": 0,
                "processed": 0,
                "failed": 0,
                "dropped": self._async_local_dropped,
                "oldest_pending_age_seconds": None,
                "last_error": f"async queue unavailable: {self._async_disabled_reason}",
                "queue_available": False,
                **buffer_status,
            }
        self._force_async_buffer_flush(timeout=0.1)
        buffer_status = self._async_buffer_status()
        queue = self._require_async_queue()
        status = queue.status()
        status["dropped"] += self._async_local_dropped
        if buffer_status["last_flush_error"] and not status["last_error"]:
            status["last_error"] = buffer_status["last_flush_error"]
        return {"mode": "async", "queue_available": True, **status, **buffer_status}

    def wait_for_submission(self, timeout: float | None = None) -> bool:
        """Wait until async queued events have been claimed or completed."""
        return self._wait_for_async_queue(timeout=timeout, include_in_flight=False)

    def wait_for_processing(self, timeout: float | None = None) -> bool:
        """Wait until async queued events have finished or failed."""
        return self._wait_for_async_queue(timeout=timeout, include_in_flight=True)

    def _wait_for_async_queue(self, timeout: float | None, include_in_flight: bool) -> bool:
        if self.upload_mode != "async":
            return True
        if self._async_disabled_reason is not None:
            return False
        deadline = None if timeout is None else time.monotonic() + max(0.0, timeout)
        flush_timeout = None if deadline is None else max(0.0, deadline - time.monotonic())
        if not self._force_async_buffer_flush(timeout=flush_timeout):
            return False
        queue = self._require_async_queue()
        while True:
            status = queue.status()
            if status["failed"] or status["dropped"] or self._async_local_dropped:
                return False
            pending = status["pending"] + (status["in_flight"] if include_in_flight else 0)
            if pending == 0:
                return True
            if self._async_process is not None and self._async_process.poll() is not None:
                return False
            if deadline is not None and time.monotonic() >= deadline:
                return False
            time.sleep(0.05)

    def _open_async_queue(self, run_id: str) -> None:
        if self._async_queue is not None:
            return
        path = queue_path_for_run(self.queue_dir, run_id)
        queue = AsyncQueueRepository(path)
        queue.init_db()
        self._async_queue = queue

    def _open_async_queue_or_warn(self, run_id: str) -> bool:
        if self._async_disabled_reason is not None:
            return False
        try:
            self._open_async_queue(run_id)
            return True
        except Exception as exc:  # noqa: BLE001 - default async must not stop training
            self._async_disabled_reason = str(exc)
            warnings.warn(
                f"async upload disabled because the local queue could not start: {exc}",
                RuntimeWarning,
                stacklevel=2,
            )
            return False

    def _require_async_queue(self) -> AsyncQueueRepository:
        if self._async_queue is None:
            self._open_async_queue(self.run_id)
        assert self._async_queue is not None
        return self._async_queue

    def _async_buffer_status(self) -> dict[str, Any]:
        if self._async_buffer is None:
            return {"buffered_events": 0, "buffered_bytes": 0, "last_flush_error": None}
        return self._async_buffer.status()

    def _force_async_buffer_flush(self, timeout: float | None = None) -> bool:
        if self.upload_mode != "async" or self._async_buffer is None:
            return True
        ok = self._async_buffer.force_flush(timeout=timeout)
        if not ok:
            self._warn_async_drop("async producer buffer did not flush before timeout")
        return ok

    def _start_async_uploader(self) -> None:
        with self._async_process_lock:
            run_id = self._run_id
            if self.upload_mode != "async" or not run_id or run_id == _PENDING_RUN_ID:
                return
            if self._async_disabled_reason is not None:
                return
            if self._async_process is not None and self._async_process.poll() is None:
                return
            queue = self._require_async_queue()
            stderr_file = None
            try:
                resolved_api_key = self.client._resolve_api_key()
                args = {
                    "queue_path": str(queue.path),
                    "base_url": self.client.base_url,
                    "api_key": None,
                    "timeout": self.client.timeout,
                    "run_id": run_id,
                    "parent_pid": os.getpid(),
                }
                env = os.environ.copy()
                if resolved_api_key:
                    env["INSTANTML_API_KEY"] = resolved_api_key
                stderr_path = queue.path.with_name("uploader.stderr.log")
                stderr_file = stderr_path.open("ab")
                process = subprocess.Popen(
                    [
                        sys.executable,
                        "-c",
                        (
                            "import json, sys; "
                            "from instantml.async_queue import run_async_uploader; "
                            "from instantml.credentials import _resolve_api_key; "
                            "args = json.loads(sys.argv[1]); "
                            "args['api_key'] = _resolve_api_key(None); "
                            "run_async_uploader(**args)"
                        ),
                        json.dumps(args, separators=(",", ":")),
                    ],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=stderr_file,
                    close_fds=True,
                    env=env,
                )
                stderr_file.close()
                stderr_file = None
                self._async_process = process
            except Exception as exc:  # noqa: BLE001 - queue remains durable for CLI recovery
                if stderr_file is not None:
                    stderr_file.close()
                if not self._async_start_warning_emitted:
                    warnings.warn(f"async uploader process could not start: {exc}", RuntimeWarning, stacklevel=2)
                    self._async_start_warning_emitted = True

    def _stop_async_uploader(self, timeout: float | None = None) -> None:
        with self._async_process_lock:
            process = self._async_process
            if process is None:
                return
            wait_timeout = max(0.0, min(timeout if timeout is not None else 0.2, 2.0))
            try:
                process.wait(timeout=wait_timeout)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=1.0)
            self._async_process = None

    def stop_request(self, force: bool = False) -> StopRequest | None:
        """Return the active cooperative stop request, if the server has one."""

        if self._is_finished():
            return self._stop_request
        if not force and not self._stop_poll_due():
            return self._stop_request
        if not self._stop_signal_supported and not force:
            return self._stop_request
        self._next_stop_check_at = time.monotonic() + self.stop_check_interval_seconds
        try:
            payload = self._stop_client()._request(
                "GET",
                f"/api/runs/{urllib.parse.quote(self.run_id, safe='')}/stop-signal",
            )
        except InstantMLError as exc:
            if _stop_signal_unsupported(exc):
                self._stop_signal_supported = False
            return self._stop_request
        if not payload.get("stop_requested"):
            return None
        raw = payload.get("stop_request")
        if not isinstance(raw, dict):
            return None
        stop_request_id = str(raw.get("stop_request_id") or "")
        if not stop_request_id:
            return None
        request = StopRequest(
            run_id=str(payload.get("run_id") or self.run_id),
            stop_request_id=stop_request_id,
            requested_at=raw.get("requested_at") if isinstance(raw.get("requested_at"), str) else None,
            acknowledged_at=raw.get("acknowledged_at") if isinstance(raw.get("acknowledged_at"), str) else None,
        )
        self._stop_request = request
        return request

    def should_stop(self, force: bool = False) -> bool:
        """Return True when a cooperative dashboard stop request is active."""

        return self.stop_request(force=force) is not None

    def raise_if_stop_requested(self) -> None:
        """Acknowledge and raise when a cooperative dashboard stop is pending."""

        request = self.stop_request()
        if request is None:
            return
        self._ack_stop_request(request, "acknowledged")
        raise InstantMLStopRequested(request)

    def finish_stopped(self, message: str | None = None, timeout: float | None = None) -> None:
        """Finish a run after honoring a cooperative dashboard stop request."""

        request = self._stop_request or self.stop_request(force=True)
        if request is not None:
            self._ack_stop_request(request, "completed", message=message)
        self.finish("failed", timeout=timeout)

    def _stop_poll_due(self) -> bool:
        if self.stop_check_interval_seconds <= 0:
            return False
        return time.monotonic() >= self._next_stop_check_at

    def _stop_client(self) -> Client:
        return Client(
            base_url=self.client.base_url,
            timeout=min(max(getattr(self.client, "timeout", 10.0), 0.1), 0.75),
            offline_dir=getattr(self.client, "offline_dir", None),
            api_key=getattr(self.client, "api_key", None),
        )

    def _ack_stop_request(self, request: StopRequest, state: str, message: str | None = None) -> None:
        if state == "acknowledged" and self._stop_acknowledged:
            return
        body: dict[str, Any] = {"stop_request_id": request.stop_request_id, "state": state}
        if message is not None:
            body["message"] = message
        try:
            self._stop_client()._request(
                "POST",
                f"/api/runs/{urllib.parse.quote(self.run_id, safe='')}/stop-ack",
                body,
            )
            if state == "acknowledged":
                self._stop_acknowledged = True
        except InstantMLError:
            # Stop helpers should not make user shutdown less reliable than a
            # normal failed finish. The next helper call or finish_stopped() can
            # retry the acknowledgement.
            pass

    def __enter__(self) -> "Run":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        if isinstance(exc, InstantMLStopRequested):
            self.finish_stopped()
            return
        self.finish("failed" if exc_type else "finished")

    @_async_hot_path
    def log(self, data: dict[str, Any], step: int | float | None = None) -> None:
        metrics, text, objects, files = _classify_log_payload(data)
        log_step = self._resolve_log_step(step)
        if metrics:
            self.log_metrics(metrics, step=log_step)
        if text:
            self.log_text(text, step=log_step)
        if objects:
            self.log_objects(objects, step=log_step)
        for key, file_value in files.items():
            self._log_file_wrapper(key, file_value, step=log_step)

    def watch(
        self,
        model: Any,
        log: str = "gradients",
        log_freq: int = 1000,
        bins: int = 64,
        log_graph: bool = False,
    ) -> "_HookHandle":
        return _watch_torch_model(self, model, log=log, log_freq=log_freq, bins=bins, log_graph=log_graph)

    def start_system_metrics(self, interval: float = 15.0) -> None:
        if interval <= 0:
            raise ValueError("system_metrics_interval must be positive")
        with self._lock:
            if self._system_sampler is not None:
                raise InstantMLError("system metrics sampler is already running")
            self._system_sampler = _SystemMetricsSampler(self, interval)
            self._system_sampler.start()

    def capture_console(self) -> None:
        with self._lock:
            if self._console_capture is not None:
                raise InstantMLError("console capture is already enabled")
            self._console_capture = _ConsoleCapture(self)
            self._console_capture.start()

    def log_snapshot(
        self,
        data: dict[str, Any],
        step: int | float = 0,
        timestamp: str | None = None,
    ) -> None:
        if not isinstance(data, dict):
            raise TypeError("snapshot data must be a dictionary")
        unknown = set(data) - SNAPSHOT_KEYS
        if unknown:
            raise ValueError(f"unknown snapshot keys: {', '.join(sorted(unknown))}")
        metrics = data.get("metrics", {})
        if not isinstance(metrics, dict):
            raise TypeError("snapshot metrics must be a dictionary")
        metadata = data.get("metadata", {})
        if not isinstance(metadata, dict):
            raise TypeError("snapshot metadata must be a dictionary")
        event_timestamp = timestamp or _utc_timestamp()
        body = {
            "metrics": metrics,
            "step": step,
            "timestamp": event_timestamp,
            "preview": False,
            "preview_completion": 0.0,
        }
        self._submit(
            "POST",
            f"/runs/{self.run_id}/metrics",
            body,
            data={"metrics": metrics, "metadata": metadata},
            step=step,
            event_timestamp=event_timestamp,
        )

    def log_config(self, data: dict[str, Any], flatten: bool = True) -> None:
        attributes = [
            {"path": f"config/{key}", "type": "config", "value": value}
            for key, value in (_flatten(data).items() if flatten else data.items())
        ]
        self._submit(
            "POST",
            f"/api/runs/{self.run_id}/attributes",
            {"attributes": attributes},
            data={"config": data},
        )
        if self._shadow is not None:
            self._shadow.update_config(data)

    @_async_hot_path
    def log_metrics(
        self,
        data: dict[str, float],
        step: int | float,
        timestamp: str | None = None,
        preview: bool = False,
        preview_completion: float = 0.0,
    ) -> None:
        step = _validate_step(step)
        metrics = _validate_metrics(data)
        metric_timestamp = timestamp
        if self.upload_mode in {"spool", "async"} and metric_timestamp is None:
            metric_timestamp = _utc_timestamp()
        with self._lock:
            for key in metrics:
                previous = self._last_steps.get(key)
                if previous is not None and float(step) < previous and not preview:
                    warnings.warn(f"metric {key!r} logged at non-increasing step {step}", RuntimeWarning, stacklevel=2)
                if not preview:
                    self._last_steps[key] = float(step)
        self._record_metrics(metrics, step, metric_timestamp or _utc_timestamp())
        self._submit(
            "POST",
            f"/runs/{self.run_id}/metrics",
            {
                "metrics": metrics,
                "step": step,
                "timestamp": metric_timestamp,
                "preview": preview,
                "preview_completion": preview_completion,
            },
            data={"metrics": metrics},
            step=step,
            event_timestamp=metric_timestamp,
        )
        if self._shadow is not None:
            self._shadow.log(metrics, step=step)

    @_async_hot_path
    def log_rank_metrics(
        self,
        data: dict[str, float],
        step: int | float,
        rank: int,
        world_size: int,
        local_rank: int | None = None,
        weight: int | float | None = None,
        timestamp: str | None = None,
    ) -> None:
        step = _validate_step(step)
        if step is None:
            raise ValueError("step is required for rank metrics")
        metrics = _validate_metrics(data)
        rank, world_size, local_rank = _validate_rank_context(rank, world_size, local_rank)
        rank_weight = _validate_rank_weight(weight)
        metric_timestamp = timestamp
        if self.upload_mode in {"spool", "async"} and metric_timestamp is None:
            metric_timestamp = _utc_timestamp()
        self._submit(
            "POST",
            f"/runs/{self.run_id}/rank-metrics",
            {
                "metrics": metrics,
                "step": step,
                "rank": rank,
                "world_size": world_size,
                "local_rank": local_rank,
                "weight": rank_weight,
                "timestamp": metric_timestamp,
            },
            data={"rank_metrics": metrics, "rank": rank, "world_size": world_size},
            step=step,
            event_timestamp=metric_timestamp,
        )

    def log_text(self, data: dict[str, str], step: int | float | None = None, timestamp: str | None = None) -> None:
        step = _validate_step(step)
        text = _validate_text_series(data)
        attributes = [{"path": key, "type": "string_series", "step": step, "timestamp": timestamp, "value": value} for key, value in text.items()]
        for key, value in text.items():
            self._record_event("text", key, {"value": value}, step, timestamp or _utc_timestamp())
        self._submit(
            "POST",
            f"/api/runs/{self.run_id}/attributes",
            {"attributes": attributes},
            data={"text": text},
            step=step,
            event_timestamp=timestamp,
        )

    @_async_hot_path
    def log_console(self, lines: str | list[str] | tuple[str, ...], stream: str = "stdout", timestamp: str | None = None) -> None:
        stream = _validate_console_stream(stream)
        messages = _normalize_console_lines(lines)
        start = self._console_line_numbers.get(stream, 0) + 1
        self._console_line_numbers[stream] = start + len(messages) - 1
        event_timestamp = timestamp
        if self.upload_mode in {"spool", "async"} and event_timestamp is None:
            event_timestamp = _utc_timestamp()
        payload = {
            "stream": stream,
            "lines": [
                {"line_number": start + index, "message": message, "timestamp": event_timestamp}
                for index, message in enumerate(messages)
            ],
        }
        self._submit(
            "POST",
            f"/api/runs/{self.run_id}/logs",
            payload,
            data={"logs": {stream: messages}},
            event_timestamp=event_timestamp,
        )

    def log_stdout(self, lines: str | list[str] | tuple[str, ...], timestamp: str | None = None) -> None:
        self.log_console(lines, stream="stdout", timestamp=timestamp)

    def log_stderr(self, lines: str | list[str] | tuple[str, ...], timestamp: str | None = None) -> None:
        self.log_console(lines, stream="stderr", timestamp=timestamp)

    def log_histogram(self, path: str, histogram: dict[str, Any], step: int | float, timestamp: str | None = None) -> None:
        step = _validate_step(step)
        if isinstance(histogram, Histogram):
            self._log_rich_object(path, histogram, step=step, metadata=None)
            return
        self._submit(
            "POST",
            f"/api/runs/{self.run_id}/attributes",
            {"path": path, "type": "histogram_series", "step": step, "timestamp": timestamp, "value": histogram},
            data={"histograms": {path: histogram}},
            step=step,
            event_timestamp=timestamp,
        )

    def log_objects(
        self,
        objects: dict[str, Table | Histogram | ClassificationEval | Image | Video | Audio],
        step: int | float | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        step = _validate_step(step)
        if not isinstance(objects, dict):
            raise TypeError("objects must be a dictionary")
        return [self._log_rich_object(key, value, step=step, metadata=metadata) for key, value in objects.items()]

    def log_classification_eval(
        self,
        key: str,
        *,
        y_true: Any,
        y_score: Any,
        y_pred: Any | None = None,
        class_names: list[str] | tuple[str, str] = ("negative", "positive"),
        positive_label: str | int | None = None,
        split: str = "validation",
        threshold: int | float = 0.5,
        predictions: list[dict[str, Any]] | tuple[dict[str, Any], ...] | None = None,
        step: int | float | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        step = _validate_step(step)
        evaluation = ClassificationEval(
            y_true=y_true,
            y_score=y_score,
            y_pred=y_pred,
            class_names=class_names,
            positive_label=positive_label,
            split=split,
            threshold=threshold,
            predictions=predictions,
            metadata=metadata,
        )
        return self._log_rich_object(key, evaluation, step=step, metadata=None)

    def log_table_object(
        self,
        key: str,
        columns: list[str],
        rows: list[dict[str, Any] | list[Any] | tuple[Any, ...]],
        step: int | float | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self._log_rich_object(key, Table(columns=columns, rows=rows, metadata=metadata), step=step, metadata=None)

    def log_image(
        self,
        key: str,
        path: str,
        step: int | float | None = None,
        caption: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self._log_rich_object(key, Image(path=path, caption=caption, metadata=metadata), step=step, metadata=None)

    def log_audio(
        self,
        key: str,
        path: str,
        step: int | float | None = None,
        caption: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self._log_rich_object(key, Audio(path=path, caption=caption, metadata=metadata), step=step, metadata=None)

    def log_video_object(
        self,
        key: str,
        path: str,
        step: int | float | None = None,
        caption: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self._log_rich_object(key, Video(path=path, caption=caption, metadata=metadata), step=step, metadata=None)

    def add_tags(self, tags: list[str], group_tags: bool = False) -> None:
        attributes = [{"path": "sys/group_tags" if group_tags else "sys/tags", "type": "tag", "value": tag, "summary": {"group": group_tags}} for tag in tags]
        self._submit(
            "POST",
            f"/api/runs/{self.run_id}/attributes",
            {"attributes": attributes},
            data={"group_tags" if group_tags else "tags": tags},
        )

    def set_tags(self, tags: list[str]) -> None:
        self._submit(
            "PATCH",
            f"/runs/{self.run_id}",
            {"tags": tags},
            data={"tags": tags},
        )

    def set_notes(self, notes: str) -> None:
        note = _validate_note_text(notes)
        self._submit(
            "PATCH",
            f"/runs/{self.run_id}",
            {"notes": note},
            data={"notes": note},
        )

    def log_artifact(
        self,
        name: str | VersionedArtifact,
        uri: str | None = None,
        artifact_type: str = "file",
        step: int | None = None,
        size_bytes: int | None = None,
        metadata: dict[str, Any] | None = None,
        aliases: list[str] | tuple[str, ...] | None = None,
        ttl_days: int | None = None,
    ) -> dict[str, Any] | LoggedArtifact:
        if isinstance(name, VersionedArtifact):
            if uri is not None:
                raise ValueError("uri must not be passed when logging a VersionedArtifact")
            return self.log_versioned_artifact(name, step=step, aliases=aliases, ttl_days=ttl_days)
        if uri is None:
            raise TypeError("uri is required when logging a metadata artifact")
        if aliases is not None or ttl_days is not None:
            raise ValueError("aliases and ttl_days are only valid when logging a VersionedArtifact")
        step = _validate_step(step)
        payload = {
            "type": artifact_type,
            "name": name,
            "uri": uri,
            "step": step,
            "size_bytes": size_bytes,
            "metadata": metadata or {},
        }
        self._record_event("artifact", name, payload, step, _utc_timestamp())
        if self._shadow is not None and _is_local_file_uri(uri):
            self._shadow.log_artifact_file(_strip_file_uri(uri), name=name, artifact_type=artifact_type)
        if self.upload_mode == "spool":
            self._submit(
                "POST",
                f"/api/runs/{self.run_id}/artifacts",
                payload,
                data={"artifacts": [payload]},
                step=step,
            )
            return {"id": "spooled", **payload}
        return self._request_or_spool("POST", f"/api/runs/{self.run_id}/artifacts", payload)["artifact"]

    def log_versioned_artifact(
        self,
        artifact: VersionedArtifact,
        step: int | float | None = None,
        aliases: list[str] | tuple[str, ...] | None = None,
        ttl_days: int | None = None,
    ) -> LoggedArtifact:
        if self.upload_mode == "spool":
            raise InstantMLError("versioned artifact uploads require upload_mode='sync' or 'async'")
        if not isinstance(artifact, VersionedArtifact):
            raise TypeError("artifact must be a VersionedArtifact")
        source_step = _validate_step(step)
        artifact_files = _prepare_versioned_artifact_files(artifact)
        manifest_entries = [
            {
                "path": item["artifact_path"],
                "kind": "file",
                "size_bytes": item["stats"].size_bytes,
                "sha256": item["stats"].sha256,
                "mime_type": item["mime_type"],
            }
            for item in artifact_files
        ]
        requested_aliases = list(artifact.aliases)
        if aliases is not None:
            requested_aliases.extend(str(alias) for alias in aliases)
        body: dict[str, Any] = {
            "collection": {
                "name": artifact.name,
                "type": artifact.type,
                "description": artifact.description,
                "metadata": _validate_optional_json_object(artifact.metadata, "artifact metadata"),
            },
            "manifest": {"entries": manifest_entries},
            "aliases": requested_aliases,
            "ttl_days": ttl_days if ttl_days is not None else artifact.ttl_days,
            "source_step": source_step,
        }
        initiate = self.client._request(
            "POST",
            f"/api/runs/{self.run_id}/artifact-uploads",
            body,
            idempotency_key=_versioned_artifact_idempotency_key(self.run_id, body),
        )
        deduplicated_version = initiate.get("artifact_version")
        if initiate.get("deduplicated") and isinstance(deduplicated_version, dict):
            return LoggedArtifact(
                Api(base_url=self.client.base_url, timeout=self.client.timeout, api_key=self.client.api_key),
                deduplicated_version,
            )
        upload_files = initiate.get("files")
        upload_session = initiate.get("upload_session")
        if not isinstance(upload_files, list) or not isinstance(upload_session, dict):
            raise InstantMLError("server returned an invalid artifact upload session")
        upload_session_id = _validate_text(str(upload_session.get("id", "")), "artifact upload session id")

        def renew_file_parts(entry_id: str, start_part_number: int, part_count: int) -> list[dict[str, Any]]:
            payload = self.client._request(
                "POST",
                f"/api/artifact-uploads/{urllib.parse.quote(upload_session_id, safe='')}/renew",
                {"entry_id": entry_id, "start_part_number": start_part_number, "part_count": part_count},
            )
            renewed = payload.get("parts")
            if not isinstance(renewed, list):
                raise InstantMLError("server returned invalid renewed artifact upload URLs")
            return renewed

        files_by_path = {str(item["artifact_path"]): item for item in artifact_files}
        complete_files = []
        try:
            for upload_file in upload_files:
                if not isinstance(upload_file, dict):
                    continue
                upload_path = str(upload_file.get("path", ""))
                prepared = files_by_path.get(upload_path)
                if prepared is None and len(artifact_files) == 1:
                    prepared = artifact_files[0]
                if prepared is None:
                    raise InstantMLError("server returned an unknown artifact upload entry")
                complete_files.append(
                    _upload_versioned_artifact_file(
                        prepared["source"],
                        upload_file,
                        self.client.timeout,
                        renew_file_parts,
                    )
                )
            complete = self.client._request(
                "POST",
                f"/api/artifact-uploads/{urllib.parse.quote(upload_session_id, safe='')}/complete",
                {"files": complete_files},
                idempotency_key=_versioned_artifact_idempotency_key(upload_session_id, {"files": complete_files}),
            )
        except Exception:
            try:
                self.client._request(
                    "POST",
                    f"/api/artifact-uploads/{urllib.parse.quote(upload_session_id, safe='')}/abort",
                    {"reason": "sdk upload failed"},
                )
            except Exception:
                pass
            raise
        artifact_version = complete.get("artifact_version")
        if not isinstance(artifact_version, dict):
            raise InstantMLError("server returned an invalid artifact version")
        return LoggedArtifact(
            Api(base_url=self.client.base_url, timeout=self.client.timeout, api_key=self.client.api_key),
            artifact_version,
        )

    def use_artifact(
        self,
        ref: str | LoggedArtifact,
        type: str | None = None,
        project: str | None = None,
    ) -> LoggedArtifact:
        api = Api(base_url=self.client.base_url, timeout=self.client.timeout, api_key=self.client.api_key)
        artifact = ref if isinstance(ref, LoggedArtifact) else api.artifact(ref, type=type, project=project)
        payload = self.client._request(
            "POST",
            f"/api/runs/{self.run_id}/artifact-inputs",
            {"artifact_version_id": artifact.id},
        )
        artifact_version = payload.get("artifact_version")
        if isinstance(artifact_version, dict):
            return LoggedArtifact(api, artifact_version)
        return artifact

    def log_checkpoint(
        self,
        name: str,
        uri: str,
        step: int,
        size_bytes: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self.log_artifact(
            name=name,
            uri=uri,
            artifact_type="checkpoint",
            step=step,
            size_bytes=size_bytes,
            metadata=metadata,
        )

    def log_checkpoint_file(
        self,
        path: str,
        step: int | float,
        name: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        step = _validate_step(step)
        if step is None:
            raise ValueError("checkpoint step is required")
        payload_metadata = _validate_optional_json_object(metadata, "metadata")
        checkpoint_metadata = {}
        if isinstance(payload_metadata.get("checkpoint"), dict):
            checkpoint_metadata.update(payload_metadata["checkpoint"])
        checkpoint_metadata.setdefault("step", step)
        checkpoint_metadata.setdefault("source_run_id", self.run_id)
        payload_metadata["kind"] = payload_metadata.get("kind", "checkpoint")
        payload_metadata["checkpoint"] = checkpoint_metadata
        return self.upload_file(
            path,
            name=name,
            artifact_type="checkpoint",
            step=step,
            metadata=payload_metadata,
        )

    def log_rollout(
        self,
        name: str,
        uri: str,
        step: int,
        size_bytes: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self.log_artifact(
            name=name,
            uri=uri,
            artifact_type="rollout",
            step=step,
            size_bytes=size_bytes,
            metadata=metadata,
        )

    def log_video(
        self,
        name: str,
        uri: str,
        step: int,
        size_bytes: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        video_metadata = {"kind": "video"}
        video_metadata.update(metadata or {})
        return self.log_artifact(
            name=name,
            uri=uri,
            artifact_type="rollout",
            step=step,
            size_bytes=size_bytes,
            metadata=video_metadata,
        )

    def log_table(
        self,
        name: str,
        uri: str,
        step: int | None = None,
        size_bytes: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        table_metadata = {"kind": "table"}
        table_metadata.update(metadata or {})
        return self.log_artifact(
            name=name,
            uri=uri,
            artifact_type="file",
            step=step,
            size_bytes=size_bytes,
            metadata=table_metadata,
        )

    def log_file(
        self,
        name: str,
        uri: str,
        step: int | float | None = None,
        size_bytes: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self.log_artifact(name=name, uri=uri, artifact_type="file", step=step, size_bytes=size_bytes, metadata=metadata)

    def log_files(
        self,
        files: dict[str, str],
        step: int | float,
        metadata: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        return [
            self.log_artifact(name=path, uri=uri, artifact_type="file", step=step, metadata=metadata)
            for path, uri in files.items()
        ]

    def upload_file(
        self,
        path: str,
        name: str | None = None,
        artifact_type: str = "file",
        step: int | float | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        step = _validate_step(step)
        source = Path(path).expanduser().resolve()
        file_stats = _hash_file(source)
        payload_metadata = dict(metadata or {})
        if self.upload_mode == "spool":
            payload = {
                "type": artifact_type,
                "name": name or source.name,
                "source_path": str(source),
                "step": step,
                "mime_type": mimetypes.guess_type(source.name)[0] or "application/octet-stream",
                "size_bytes": file_stats.size_bytes,
                "sha256": file_stats.sha256,
                "metadata": payload_metadata,
            }
            self._record_file(payload["name"], file_stats, artifact_type, step, _utc_timestamp())
            self._submit(
                "POST",
                f"/api/runs/{self.run_id}/artifacts/upload",
                payload,
                data={"upload_file": payload},
                step=step,
            )
            return {"id": "spooled", **payload}
        content = base64.b64encode(source.read_bytes()).decode("ascii")
        payload = {
            "type": artifact_type,
            "name": name or source.name,
            "content_base64": content,
            "step": step,
            "mime_type": mimetypes.guess_type(source.name)[0] or "application/octet-stream",
            "size_bytes": file_stats.size_bytes,
            "sha256": file_stats.sha256,
            "metadata": payload_metadata,
        }
        self._record_file(payload["name"], file_stats, artifact_type, step, _utc_timestamp())
        return self._request_or_spool("POST", f"/api/runs/{self.run_id}/artifacts/upload", payload)["artifact"]

    def _log_rich_object(
        self,
        key: str,
        rich_object: Table | Histogram | ClassificationEval | Image | Video | Audio,
        step: int | float | None,
        metadata: dict[str, Any] | None,
    ) -> dict[str, Any]:
        object_key = _validate_text(key, "object key")
        shared_metadata = _validate_optional_json_object(metadata, "metadata")
        if isinstance(rich_object, Table):
            payload = _table_object_payload(object_key, rich_object, step, shared_metadata)
            return self._submit_or_spool_object(payload, {"table": object_key}, step)
        if isinstance(rich_object, Histogram):
            payload = _histogram_object_payload(object_key, rich_object, step, shared_metadata)
            return self._submit_or_spool_object(payload, {"histogram": object_key}, step)
        if isinstance(rich_object, ClassificationEval):
            payload = _classification_eval_object_payload(object_key, rich_object, step, shared_metadata)
            return self._submit_or_spool_object(payload, {"classification_eval": object_key}, step)
        if isinstance(rich_object, (Image, Video, Audio)):
            if self.upload_mode == "spool":
                raise InstantMLError("rich media object logging requires upload_mode='sync' until uploader response chaining is supported")
            source = self._materialize_media_source(rich_object)
            if not source.exists() or not source.is_file():
                raise InstantMLError(f"media source does not exist: {source}")
            kind = "image" if isinstance(rich_object, Image) else "video" if isinstance(rich_object, Video) else "audio"
            artifact_type = "rollout" if kind == "video" else "file"
            object_metadata = _merge_metadata(shared_metadata, rich_object.metadata)
            if rich_object.caption is not None:
                object_metadata["caption"] = _validate_text(rich_object.caption, "caption")
            artifact = self.upload_file(
                str(source),
                name=source.name,
                artifact_type=artifact_type,
                step=step,
                metadata={"kind": kind, **object_metadata},
            )
            payload = {
                "key": object_key,
                "kind": kind,
                "step": step,
                "artifact_id": artifact["id"],
                "metadata": object_metadata,
                "summary": {
                    "artifact_name": artifact.get("name"),
                    "mime_type": artifact.get("mime_type"),
                    "size_bytes": artifact.get("size_bytes"),
                },
            }
            self._record_event("object", object_key, payload, step, _utc_timestamp())
            return self._request_or_spool("POST", f"/api/runs/{self.run_id}/objects", payload)["object"]
        raise TypeError("unsupported rich object type")

    def _submit_or_spool_object(self, payload: dict[str, Any], data: dict[str, Any], step: int | float | None) -> dict[str, Any]:
        self._record_event("object", payload["key"], payload, step, _utc_timestamp())
        if self.upload_mode == "spool":
            self._submit(
                "POST",
                f"/api/runs/{self.run_id}/objects",
                payload,
                data={"objects": data},
                step=step,
            )
            return {"id": "spooled", **payload}
        return self._request_or_spool("POST", f"/api/runs/{self.run_id}/objects", payload)["object"]

    def _resolve_log_step(self, step: int | float | None) -> int | float:
        with self._lock:
            if step is None:
                self._auto_step += 1
                return self._auto_step
            validated = _validate_step(step)
            if float(validated) > float(self._auto_step):
                self._auto_step = validated
            return validated

    def _current_log_step(self) -> int | float:
        with self._lock:
            return self._auto_step if self._auto_step else 0

    def _log_system_metrics(self, metrics: dict[str, float]) -> None:
        if not metrics or self._is_finished():
            return
        self.log_metrics(metrics, step=self._current_log_step())

    def _is_finished(self) -> bool:
        with self._lock:
            return self._finished

    def _log_file_wrapper(self, key: str, value: File, step: int | float | None) -> dict[str, Any]:
        object_key = _validate_text(key, "file key")
        metadata = _merge_metadata(value.metadata)
        metadata["log_key"] = object_key
        return self.upload_file(
            value.path,
            name=value.name or Path(value.path).name,
            artifact_type=value.artifact_type,
            step=step,
            metadata=metadata,
        )

    def _materialize_media_source(self, rich_object: Image | Video | Audio) -> Path:
        if rich_object.path is not None:
            return Path(rich_object.path).expanduser().resolve()
        root = self._media_root()
        if isinstance(rich_object, Image):
            target = root / f"{uuid.uuid4().hex}.png"
            _write_image_data(rich_object.data, target)
            return target
        if isinstance(rich_object, Audio):
            target = root / f"{uuid.uuid4().hex}.wav"
            _write_audio_data(rich_object.data, target, rich_object.sample_rate)
            return target
        target = root / f"{uuid.uuid4().hex}.{rich_object.format}"
        _write_video_data(rich_object.data, target, rich_object.fps)
        return target

    def _media_root(self) -> Path:
        if self.media_dir:
            root = Path(self.media_dir).expanduser().resolve()
        elif self.upload_mode == "spool":
            root = Path(self.spool_dir or DEFAULT_PROCESS_SPOOL_DIR).expanduser().resolve() / "_media" / _safe_path_segment(self.run_id)
        else:
            root = Path(tempfile.gettempdir()) / "instantml-media" / _safe_path_segment(self.run_id)
        root.mkdir(parents=True, exist_ok=True)
        return root

    def _record_metrics(self, metrics: dict[str, float], step: int | float, timestamp: str) -> None:
        if self._local_store is not None:
            self._local_store.record_metrics(self.run_id, step, metrics, timestamp)

    def _record_event(self, kind: str, key: str, payload: dict[str, Any], step: int | float | None, timestamp: str) -> None:
        if self._local_store is not None:
            self._local_store.record_event(self.run_id, step, kind, key, payload, timestamp)

    def _record_file(
        self,
        key: str,
        stats: _FileStats,
        artifact_type: str,
        step: int | float | None,
        timestamp: str,
    ) -> None:
        if self._local_store is not None:
            self._local_store.record_file(self.run_id, step, key, stats, artifact_type, timestamp)

    def _flush_pending_requests(self) -> None:
        with self._lock:
            pending = self._queue
            self._queue = []
        for event in pending:
            self._request_or_spool(event["method"], event["path"], event["body"])

    def flush(self) -> None:
        self._flush_pending_requests()
        if self.upload_mode == "async":
            self._force_async_buffer_flush(timeout=getattr(self.client, "timeout", 10.0))

    def replay_offline(self) -> int:
        if not self.client.offline_dir:
            return 0
        path = _offline_path(self.client.offline_dir, self.run_id)
        if not path.exists():
            return 0
        events = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        replayed = 0
        for event in events:
            self.client._request(event["method"], event["path"], event["body"])
            replayed += 1
        path.unlink()
        return replayed

    def finish(self, status: str = "finished", timeout: float | None = None) -> None:
        with self._lock:
            if self._finished:
                return
            # Claim the finish atomically so a concurrent atexit/signal flush
            # (or a second finish() call) cannot double-PATCH or double-drain.
            self._finished = True
        async_processed = True
        async_finish_timeout = max(0.0, getattr(self.client, "timeout", 10.0) if timeout is None else timeout)
        sampler = self._system_sampler
        if sampler is not None:
            sampler.stop()
        capture = self._console_capture
        if capture is not None:
            capture.restore()
        try:
            self._flush_pending_requests()
            if self.upload_mode == "spool":
                self._submit("PATCH", f"/runs/{self.run_id}", {"status": status}, data={"status": status})
                return
            if self.upload_mode == "async":
                self._force_async_buffer_flush(timeout=async_finish_timeout)
                self._submit("PATCH", f"/runs/{self.run_id}", {"status": status}, data={"status": status})
                status_flushed = self._force_async_buffer_flush(timeout=async_finish_timeout)
                async_processed = status_flushed and self.wait_for_processing(timeout=async_finish_timeout)
                if not async_processed:
                    if self._async_disabled_reason is not None:
                        message = f"async upload unavailable; finish status was not delivered: {self._async_disabled_reason}"
                    else:
                        message = (
                            "async upload did not finish before finish() timeout; flushed queue rows remain on disk for the "
                            "background uploader or instantml-uploader recovery, while any still-buffered producer events "
                            "remain process-local"
                        )
                    warnings.warn(message, RuntimeWarning, stacklevel=2)
                return
            self._request_or_spool("PATCH", f"/runs/{self.run_id}", {"status": status})
        finally:
            with self._lock:
                self._system_sampler = None
                self._console_capture = None
            _unregister_active_run(self)
            if self._local_store is not None:
                self._local_store.close()
            if self.upload_mode == "async":
                producer_stopped = True
                if self._async_buffer is not None:
                    producer_stopped = self._async_buffer.stop(timeout=async_finish_timeout)
                if self._async_queue is not None:
                    if not async_processed:
                        status_snapshot = self._async_queue.status()
                        async_processed = status_snapshot["pending"] + status_snapshot["in_flight"] == 0
                    if producer_stopped:
                        self._async_queue.close()
                    else:
                        async_processed = False
                        warnings.warn(
                            "async producer writer did not stop before finish() timeout; leaving the local queue open for the writer",
                            RuntimeWarning,
                            stacklevel=2,
                        )
                if async_processed and producer_stopped:
                    self._stop_async_uploader(timeout=async_finish_timeout)
            if self._shadow is not None:
                self._shadow.finish(status)

    def _finish_from_lifecycle(self, status: str) -> None:
        """Best-effort finish triggered by atexit / SIGTERM / SIGINT.

        Never blocks shutdown indefinitely: a run whose async init has not yet
        resolved is given a short grace period, then skipped if still pending.
        """
        with self._lock:
            if self._finished:
                return
        if not self._init_done.is_set():
            if not self._init_done.wait(timeout=2.0):
                return
        if self._init_error is not None or self._run_id == _PENDING_RUN_ID:
            return
        try:
            if status == "finished" and self._stop_request is not None:
                self.finish_stopped()
            else:
                self.finish(status)
        except Exception:  # noqa: BLE001 - shutdown must stay best-effort
            pass

    def _reset_after_fork(self) -> None:
        """Reset inherited state in a forked child (DataLoader workers, DDP spawn).

        The child inherits this run's locks — possibly held by parent threads
        that no longer exist in the child — plus SQLite connections and the
        uploader subprocess handle that belong to the parent. Reusing the
        parent's file descriptors corrupts the WAL queue, so swap in fresh locks,
        drop the inherited connections (reopened lazily per process), and forget
        the parent's uploader instead of reaping it.
        """
        self._lock = threading.RLock()
        self._async_process_lock = threading.RLock()
        self._async_process = None
        if self._async_queue is not None:
            self._async_queue._reset_after_fork()
        if self._async_buffer is not None:
            # The producer worker thread does not survive fork; its condition
            # variable may be left locked. Replace the buffer wholesale.
            self._async_buffer = _AsyncProducerBuffer(self)
        if self._local_store is not None:
            self._local_store._reset_after_fork()

    def _submit(
        self,
        method: str,
        path: str,
        body: dict[str, Any],
        data: dict[str, Any] | None = None,
        step: int | float | None = None,
        event_timestamp: str | None = None,
    ) -> None:
        if self.upload_mode == "async" and _async_request_supported(method, path, body):
            self._enqueue_async_request(method, path, body)
            return
        with self._lock:
            if self.upload_mode == "spool":
                self._process_sequence += 1
                event = _process_event(
                    self.run_id,
                    {"method": method, "path": path, "body": body},
                    data=data or {},
                    step=step,
                    timestamp=event_timestamp,
                    sequence=self._process_sequence,
                )
                _write_process_event(self._process_spool_run_dir, event, _serialize_process_event(event))
                return
            event = {"method": method, "path": path, "body": body}
            if self.buffer_size > 0:
                self._queue.append(event)
                should_flush = len(self._queue) >= self.buffer_size
            else:
                should_flush = False
        if self.buffer_size > 0:
            if should_flush:
                self.flush()
            return
        self._request_or_spool(method, path, body)

    def _enqueue_async_request(self, method: str, path: str, body: dict[str, Any]) -> None:
        if self._async_disabled_reason is not None:
            self._warn_async_drop(
                f"async queue unavailable; dropped event: {self._async_disabled_reason}",
                count_local=True,
            )
            return
        try:
            queue = self._require_async_queue()
            event = queue.prepare_event(
                method,
                path,
                body,
                idempotency_key=f"instantml-{self.run_id}-{uuid.uuid4().hex}",
                created_at=time.time(),
            )
            if self._async_buffer is None:
                result = queue.enqueue_many_prepared([event])
                if result.inserted:
                    self._start_async_uploader()
                elif result.dropped:
                    self._warn_async_drop(result.message or "async queue dropped an event because local queue limits were reached")
                return
            self._async_buffer.append(event)
        except Exception as exc:  # noqa: BLE001 - async delivery must not stop training
            self._warn_async_drop(f"async queue could not record event: {exc}", count_local=True)

    def _warn_async_drop(self, message: str, *, count_local: bool = False, count: int = 1) -> None:
        if count_local:
            self._async_local_dropped += max(1, count)
        now = time.time()
        if now - self._last_async_warning_at > 5:
            warnings.warn(message, RuntimeWarning, stacklevel=2)
            self._last_async_warning_at = now

    def _request_or_spool(self, method: str, path: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            return self.client._request(method, path, body)
        except InstantMLError:
            if not self.client.offline_dir:
                raise
            _spool_event(self.client.offline_dir, self.run_id, {"method": method, "path": path, "body": body})
            return {"spooled": True, "artifact": {"id": "spooled", **body}}


def init(
    project: str | None = None,
    name: str | None = None,
    config: dict[str, Any] | None = None,
    tags: list[str] | None = None,
    notes: str | None = None,
    metadata: dict[str, Any] | None = None,
    base_url: str | None = None,
    timeout: float = 10.0,
    buffer_size: int = 0,
    offline_dir: str | None = None,
    api_key: str | None = None,
    source_tracking: bool | SourceTracking = True,
    upload_mode: str = "async",
    spool_dir: str | None = None,
    local_store: bool = False,
    local_store_dir: str | None = None,
    system_metrics: bool = True,
    system_metrics_interval: float = 15.0,
    capture_console: bool = False,
    async_init: bool = True,
    shadow_wandb: Any = False,
    queue_dir: str | None = None,
    stop_check_interval_seconds: float = 10.0,
) -> Run:
    """Start a new run and return a :class:`Run` handle.

    Raises :class:`InstantMLError` immediately if no credentials are available
    via ``api_key`` kwarg, ``INSTANTML_API_KEY`` env var, or ``~/.instantml/credentials``.

    Set ``shadow_wandb=True`` (or pass a ``dict`` of wandb.init kwargs, or an
    already-initialized ``wandb.Run``) to mirror scalar ``log`` calls,
    ``finish``, and local-file ``log_artifact("name", "file://path", ...)``
    metadata artifacts to Weights & Biases for shadow→graduate pilots.
    """
    _check_credentials_or_raise(api_key)
    return Client(base_url=base_url or _default_base_url(), timeout=timeout, offline_dir=offline_dir, api_key=api_key).init(
        project=project,
        name=name,
        config=config,
        tags=tags,
        notes=notes,
        metadata=metadata,
        buffer_size=buffer_size,
        offline_dir=offline_dir,
        source_tracking=source_tracking,
        upload_mode=upload_mode,
        spool_dir=spool_dir,
        queue_dir=queue_dir,
        local_store=local_store,
        local_store_dir=local_store_dir,
        system_metrics=system_metrics,
        system_metrics_interval=system_metrics_interval,
        capture_console=capture_console,
        async_init=async_init,
        shadow_wandb=shadow_wandb,
        stop_check_interval_seconds=stop_check_interval_seconds,
    )


def attach_run(
    run_id: str,
    base_url: str | None = None,
    timeout: float = 10.0,
    buffer_size: int = 0,
    offline_dir: str | None = None,
    api_key: str | None = None,
    upload_mode: str = "async",
    spool_dir: str | None = None,
    local_store: bool = False,
    local_store_dir: str | None = None,
    system_metrics: bool = True,
    system_metrics_interval: float = 15.0,
    capture_console: bool = False,
    queue_dir: str | None = None,
    validate: bool = True,
    stop_check_interval_seconds: float = 10.0,
) -> Run:
    """Attach SDK logging to an existing run, such as a UI-created fork."""

    _check_credentials_or_raise(api_key)
    return Client(
        base_url=base_url or _default_base_url(),
        timeout=timeout,
        offline_dir=offline_dir,
        api_key=api_key,
    ).attach_run(
        run_id,
        buffer_size=buffer_size,
        upload_mode=upload_mode,
        spool_dir=spool_dir,
        local_store=local_store,
        local_store_dir=local_store_dir,
        system_metrics=system_metrics,
        system_metrics_interval=system_metrics_interval,
        capture_console=capture_console,
        queue_dir=queue_dir,
        validate=validate,
        stop_check_interval_seconds=stop_check_interval_seconds,
    )


def _fork_idempotency_key(source_run_id: str, body: dict[str, Any]) -> str:
    canonical_body = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    digest = hashlib.sha256(f"{source_run_id}\0{canonical_body}".encode("utf-8")).hexdigest()
    return f"instantml-fork-{digest[:32]}"


class _LocalStore:
    def __init__(self, root: str | None, run_id: str) -> None:
        directory = Path(root or ".instantml/local").expanduser().resolve()
        directory.mkdir(parents=True, exist_ok=True)
        self.path = directory / "store.sqlite3"
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(self.path, timeout=1.0, check_same_thread=False)
        self._connection.execute("pragma journal_mode=wal")
        self._connection.execute("pragma busy_timeout=1000")
        self._create_schema()
        self._connection.execute(
            "insert or ignore into schema_meta (key, value) values (?, ?)",
            ("version", "1"),
        )
        self._connection.execute(
            "insert into events (event_id, run_id, step, kind, key, status, payload_json, timestamp) values (?, ?, ?, ?, ?, ?, ?, ?)",
            (uuid.uuid4().hex, run_id, None, "run", "init", "attempted", "{}", _utc_timestamp()),
        )
        self._connection.commit()

    def _create_schema(self) -> None:
        self._connection.executescript(
            """
            create table if not exists schema_meta (
              key text primary key,
              value text not null
            );
            create table if not exists metrics (
              id integer primary key autoincrement,
              event_id text not null,
              run_id text not null,
              step real not null,
              key text not null,
              value real not null,
              status text not null,
              timestamp text not null
            );
            create table if not exists events (
              id integer primary key autoincrement,
              event_id text not null,
              run_id text not null,
              step real,
              kind text not null,
              key text not null,
              status text not null,
              payload_json text not null,
              timestamp text not null
            );
            create table if not exists files (
              id integer primary key autoincrement,
              event_id text not null,
              run_id text not null,
              step real,
              key text not null,
              path text not null,
              sha256 text not null,
              size_bytes integer not null,
              artifact_type text not null,
              status text not null,
              timestamp text not null
            );
            create index if not exists metrics_run_key_step_idx on metrics (run_id, key, step);
            create index if not exists events_run_kind_key_idx on events (run_id, kind, key);
            create index if not exists files_run_key_idx on files (run_id, key);
            """
        )

    def record_metrics(self, run_id: str, step: int | float, metrics: dict[str, float], timestamp: str) -> None:
        event_id = uuid.uuid4().hex
        with self._lock:
            self._connection.executemany(
                "insert into metrics (event_id, run_id, step, key, value, status, timestamp) values (?, ?, ?, ?, ?, ?, ?)",
                [(event_id, run_id, float(step), key, float(value), "attempted", timestamp) for key, value in metrics.items()],
            )
            self._connection.commit()

    def record_event(
        self,
        run_id: str,
        step: int | float | None,
        kind: str,
        key: str,
        payload: dict[str, Any],
        timestamp: str,
    ) -> None:
        with self._lock:
            self._connection.execute(
                "insert into events (event_id, run_id, step, kind, key, status, payload_json, timestamp) values (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    uuid.uuid4().hex,
                    run_id,
                    None if step is None else float(step),
                    kind,
                    key,
                    "attempted",
                    json.dumps(payload, sort_keys=True),
                    timestamp,
                ),
            )
            self._connection.commit()

    def record_file(
        self,
        run_id: str,
        step: int | float | None,
        key: str,
        stats: _FileStats,
        artifact_type: str,
        timestamp: str,
    ) -> None:
        with self._lock:
            self._connection.execute(
                "insert into files (event_id, run_id, step, key, path, sha256, size_bytes, artifact_type, status, timestamp) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    uuid.uuid4().hex,
                    run_id,
                    None if step is None else float(step),
                    key,
                    stats.path,
                    stats.sha256,
                    stats.size_bytes,
                    artifact_type,
                    "attempted",
                    timestamp,
                ),
            )
            self._connection.commit()

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def _reset_after_fork(self) -> None:
        # Drop the parent's connection without closing it (closing would flush
        # through the shared fd and corrupt the WAL); open a fresh per-process
        # connection against the already-created schema.
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(self.path, timeout=1.0, check_same_thread=False)
        self._connection.execute("pragma journal_mode=wal")
        self._connection.execute("pragma busy_timeout=1000")


class _SystemMetricsSampler:
    def __init__(self, run: Run, interval: float) -> None:
        self._run = run
        self._interval = interval
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name=f"instantml-system-{run._run_id}", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=max(0.1, min(self._interval, 2.0)))

    def _loop(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                self._run._log_system_metrics(_collect_system_metrics())
            except Exception as exc:
                warnings.warn(f"system metrics sampler stopped after error: {exc}", RuntimeWarning, stacklevel=2)
                return


class _ConsoleCapture:
    def __init__(self, run: Run) -> None:
        self._run = run
        self._stdout = sys.stdout
        self._stderr = sys.stderr
        self._out_wrapper = _ConsoleStream(run, self._stdout, "console/stdout")
        self._err_wrapper = _ConsoleStream(run, self._stderr, "console/stderr")

    def start(self) -> None:
        sys.stdout = self._out_wrapper
        sys.stderr = self._err_wrapper

    def restore(self) -> None:
        sys.stdout = self._stdout
        sys.stderr = self._stderr


class _ConsoleStream:
    def __init__(self, run: Run, stream: Any, key: str) -> None:
        self._run = run
        self._stream = stream
        self._key = key
        self._buffer = ""
        self._logging = False

    def write(self, text: str) -> int:
        written = self._stream.write(text)
        self._stream.flush()
        if text and not self._logging:
            self._buffer += text
            lines = self._buffer.splitlines(keepends=True)
            self._buffer = ""
            for line in lines:
                if line.endswith(("\n", "\r")):
                    self._log_line(line.strip())
                else:
                    self._buffer += line
        return written

    def flush(self) -> None:
        if self._buffer.strip():
            self._log_line(self._buffer.strip())
            self._buffer = ""
        self._stream.flush()

    def isatty(self) -> bool:
        return bool(getattr(self._stream, "isatty", lambda: False)())

    def _log_line(self, line: str) -> None:
        if not line or self._run._is_finished():
            return
        try:
            self._logging = True
            self._run.log_text({self._key: line}, step=self._run._current_log_step())
        except Exception as exc:
            warnings.warn(f"console capture failed: {exc}", RuntimeWarning, stacklevel=2)
        finally:
            self._logging = False


class _HookHandle:
    def __init__(self, handles: list[Any]) -> None:
        self._handles = handles

    def remove(self) -> None:
        for handle in self._handles:
            remover = getattr(handle, "remove", None)
            if callable(remover):
                remover()
        self._handles = []


def _watch_torch_model(
    run: Run,
    model: Any,
    log: str,
    log_freq: int,
    bins: int,
    log_graph: bool,
) -> _HookHandle:
    if log_graph:
        warnings.warn("log_graph is not supported yet", RuntimeWarning, stacklevel=2)
    if log_freq <= 0:
        raise ValueError("log_freq must be positive")
    if log not in {"gradients", "parameters", "all", "none"}:
        raise ValueError("log must be one of: all, gradients, none, parameters")
    named_parameters = getattr(model, "named_parameters", None)
    if not callable(named_parameters):
        raise TypeError("model must expose named_parameters()")
    handles: list[Any] = []
    calls = {"count": 0}
    for name, parameter in named_parameters():
        if log in {"gradients", "all"} and callable(getattr(parameter, "register_hook", None)):
            handles.append(parameter.register_hook(_torch_gradient_hook(run, name, bins, log_freq, calls)))
        if log in {"parameters", "all"}:
            try:
                run.log({f"parameters/{name}": Histogram.from_values(parameter, bins=bins)})
            except Exception as exc:
                warnings.warn(f"parameter logging failed for {name}: {exc}", RuntimeWarning, stacklevel=2)
    return _HookHandle(handles)


def _torch_gradient_hook(run: Run, name: str, bins: int, log_freq: int, calls: dict[str, int]):
    def hook(gradient: Any) -> None:
        calls["count"] += 1
        if run._is_finished() or calls["count"] % log_freq != 0:
            return
        try:
            run.log({f"gradients/{name}": Histogram.from_values(gradient, bins=bins)})
        except Exception as exc:
            warnings.warn(f"gradient logging failed for {name}: {exc}", RuntimeWarning, stacklevel=2)

    return hook


def _rank_zero(args: Any = None, state: Any = None, trainer: Any = None) -> bool:
    for candidate in (state, args, trainer):
        if candidate is None:
            continue
        value = getattr(candidate, "is_world_process_zero", None)
        if isinstance(value, bool):
            return value
        value = getattr(candidate, "is_global_zero", None)
        if isinstance(value, bool):
            return value
    rank = os.environ.get("RANK") or os.environ.get("LOCAL_RANK")
    return rank in (None, "", "0")


_ADAPTER_CLASS_CACHE: dict[tuple[type, type], type] = {}


def _optional_framework_base(module_name: str, attr_path: str) -> type | None:
    try:
        module = __import__(module_name, fromlist=[attr_path.split(".")[0]])
    except ImportError:
        return None
    value: Any = module
    for part in attr_path.split("."):
        value = getattr(value, part, None)
        if value is None:
            return None
    return value if isinstance(value, type) else None


def _framework_adapter_new(cls: type, base: type | None, name: str) -> Any:
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


def _transformers_callback_base() -> type | None:
    return _optional_framework_base("transformers", "TrainerCallback")


def _lightning_logger_base() -> type | None:
    return (
        _optional_framework_base("lightning.pytorch.loggers.logger", "Logger")
        or _optional_framework_base("pytorch_lightning.loggers.logger", "Logger")
    )


def _keras_callback_base() -> type | None:
    return (
        _optional_framework_base("keras.callbacks", "Callback")
        or _optional_framework_base("tensorflow.keras.callbacks", "Callback")
    )


class InstantMLCallback:
    def __new__(cls, *args: Any, **kwargs: Any) -> Any:
        if cls is InstantMLCallback:
            return _framework_adapter_new(cls, _transformers_callback_base(), "InstantMLTransformersCallback")
        return object.__new__(cls)

    def __init__(self, run: Run | None = None, **init_kwargs: Any) -> None:
        self.run = run
        self.init_kwargs = init_kwargs

    def setup(self, args: Any, state: Any, model: Any | None = None, **kwargs: Any) -> None:
        if not _rank_zero(args=args, state=state):
            return
        if self.run is None:
            init_kwargs = {"project": getattr(args, "project", "transformers"), **self.init_kwargs}
            self.run = init(**init_kwargs)

    def on_log(self, args: Any, state: Any, control: Any, logs: dict[str, Any] | None = None, **kwargs: Any) -> None:
        if not _rank_zero(args=args, state=state):
            return
        if self.run is None:
            self.setup(args, state, **kwargs)
        if self.run is None:
            return
        metrics = {key: value for key, value in (logs or {}).items() if _is_scalar_number(value)}
        if metrics:
            self.run.log(metrics, step=getattr(state, "global_step", None))

    def on_save(self, args: Any, state: Any, control: Any, **kwargs: Any) -> None:
        if not _rank_zero(args=args, state=state) or self.run is None:
            return
        output_dir = getattr(args, "output_dir", None)
        if output_dir:
            self.run.log_artifact("checkpoint", str(output_dir), artifact_type="checkpoint", step=getattr(state, "global_step", None))


TransformersCallback = InstantMLCallback


class InstantMLLogger:
    def __new__(cls, *args: Any, **kwargs: Any) -> Any:
        if cls is InstantMLLogger:
            return _framework_adapter_new(cls, _lightning_logger_base(), "InstantMLLightningLogger")
        return object.__new__(cls)

    def __init__(self, project: str | None = None, run: Run | None = None, **init_kwargs: Any) -> None:
        self.project = project
        self._run = run
        self._init_kwargs = init_kwargs

    @property
    def name(self) -> str:
        return self.project or "default"

    @property
    def version(self) -> str:
        if not _rank_zero():
            return "rank-nonzero"
        return self.experiment.run_id

    @property
    def experiment(self) -> Run:
        if self._run is None:
            self._run = init(project=self.project, **self._init_kwargs)
        return self._run

    def log_metrics(self, metrics: dict[str, Any], step: int | float | None = None) -> None:
        if not _rank_zero():
            return
        self.experiment.log(metrics, step=step)

    def log_hyperparams(self, params: dict[str, Any]) -> None:
        if not _rank_zero():
            return
        self.experiment.log_config(params)

    def log_image(self, key: str, images: list[Any], step: int | float | None = None, **kwargs: Any) -> None:
        if not _rank_zero():
            return
        self.experiment.log({key: [Image.from_data(image, metadata=kwargs or None) for image in images]}, step=step)

    def log_audio(self, key: str, audios: list[Any], step: int | float | None = None, **kwargs: Any) -> None:
        if not _rank_zero():
            return
        self.experiment.log({key: [Audio.from_data(audio, metadata=kwargs or None) for audio in audios]}, step=step)

    def log_video(self, key: str, videos: list[Any], step: int | float | None = None, **kwargs: Any) -> None:
        if not _rank_zero():
            return
        self.experiment.log({key: [Video.from_data(video, metadata=kwargs or None) for video in videos]}, step=step)

    def finalize(self, status: str = "finished") -> None:
        if self._run is not None:
            self._run.finish(status)


LightningLogger = InstantMLLogger


class InstantMLKerasCallback:
    def __new__(cls, *args: Any, **kwargs: Any) -> Any:
        if cls is InstantMLKerasCallback:
            return _framework_adapter_new(cls, _keras_callback_base(), "InstantMLKerasNativeCallback")
        return object.__new__(cls)

    def __init__(self, run: Run | None = None, project: str | None = None, log_batch: bool = False, **init_kwargs: Any) -> None:
        self.run = run
        self.project = project
        self.log_batch = log_batch
        self.init_kwargs = init_kwargs

    def _ensure_run(self) -> Run:
        if self.run is None:
            self.run = init(project=self.project or "keras", **self.init_kwargs)
        return self.run

    def on_train_begin(self, logs: dict[str, Any] | None = None) -> None:
        self._ensure_run()

    def on_epoch_end(self, epoch: int, logs: dict[str, Any] | None = None) -> None:
        metrics = {key: value for key, value in (logs or {}).items() if _is_scalar_number(value)}
        if metrics:
            self._ensure_run().log(metrics, step=epoch)

    def on_train_batch_end(self, batch: int, logs: dict[str, Any] | None = None) -> None:
        if not self.log_batch:
            return
        metrics = {f"batch/{key}": value for key, value in (logs or {}).items() if _is_scalar_number(value)}
        if metrics:
            self._ensure_run().log(metrics, step=batch)

    def on_train_end(self, logs: dict[str, Any] | None = None) -> None:
        if self.run is not None:
            self.run.finish("finished")


def _collect_system_metrics(psutil_module: Any | None = None, pynvml_module: Any | None = None) -> dict[str, float]:
    psutil = psutil_module
    if psutil is None:
        try:
            import psutil as psutil
        except ImportError:
            return {}
    metrics: dict[str, float] = {}
    try:
        metrics["system/cpu_percent"] = float(psutil.cpu_percent(interval=None))
        virtual_memory = psutil.virtual_memory()
        metrics["system/memory_percent"] = float(virtual_memory.percent)
        metrics["system/memory_used_bytes"] = float(virtual_memory.used)
        process = psutil.Process(os.getpid())
        metrics["system/process_rss_bytes"] = float(process.memory_info().rss)
        disk = psutil.disk_usage(os.getcwd())
        metrics["system/disk_percent"] = float(disk.percent)
        network = psutil.net_io_counters()
        metrics["system/network_bytes_sent"] = float(network.bytes_sent)
        metrics["system/network_bytes_recv"] = float(network.bytes_recv)
    except Exception as exc:
        warnings.warn(f"system metrics collection failed: {exc}", RuntimeWarning, stacklevel=2)
    nvml = pynvml_module
    if nvml is None:
        try:
            import pynvml as nvml
        except ImportError:
            return metrics
    try:
        nvml.nvmlInit()
        for index in range(nvml.nvmlDeviceGetCount()):
            handle = nvml.nvmlDeviceGetHandleByIndex(index)
            utilization = nvml.nvmlDeviceGetUtilizationRates(handle)
            memory = nvml.nvmlDeviceGetMemoryInfo(handle)
            metrics[f"system/gpu/{index}/utilization_percent"] = float(utilization.gpu)
            metrics[f"system/gpu/{index}/memory_percent"] = float(memory.used / memory.total * 100) if memory.total else 0.0
            metrics[f"system/gpu/{index}/memory_used_bytes"] = float(memory.used)
            power_usage = getattr(nvml, "nvmlDeviceGetPowerUsage", lambda _handle: None)(handle)
            if power_usage is not None:
                metrics[f"system/gpu/{index}/power_watts"] = float(power_usage) / 1000.0
    except Exception as exc:
        warnings.warn(f"NVML metrics collection failed: {exc}", RuntimeWarning, stacklevel=2)
    finally:
        shutdown = getattr(nvml, "nvmlShutdown", None)
        if callable(shutdown):
            shutdown()
    return metrics


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _process_event(
    run_id: str,
    request: dict[str, Any],
    data: dict[str, Any],
    step: int | float | None = None,
    timestamp: str | None = None,
    sequence: int = 0,
) -> dict[str, Any]:
    event = {
        "version": 1,
        "event_id": uuid.uuid4().hex,
        "sequence": sequence,
        "run_id": run_id,
        "timestamp": timestamp or _utc_timestamp(),
        "step": step,
        "data": data,
        "requests": [request],
    }
    return event


def _process_spool_run_dir(spool_dir: str | None, run_id: str) -> Path:
    root = Path(spool_dir or DEFAULT_PROCESS_SPOOL_DIR).expanduser().resolve()
    return root / _safe_path_segment(run_id)


def _serialize_process_event(event: dict[str, Any]) -> str:
    return json.dumps(event, separators=(",", ":"))


def _write_process_event(run_dir: Path | None, event: dict[str, Any], serialized: str) -> Path:
    if run_dir is None:
        raise InstantMLError("process spool directory is not ready")
    filename = f"{event['sequence']:020d}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}-{event['event_id']}.json"
    final_path = run_dir / filename
    tmp_path = run_dir / f".{filename}.tmp"
    with tmp_path.open("w", encoding="utf-8") as handle:
        handle.write(serialized)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp_path, final_path)
    _fsync_dir(run_dir)
    return final_path


def _safe_path_segment(value: str) -> str:
    return "".join(character if character.isalnum() or character in {"-", "_", "."} else "_" for character in value)


def _fsync_dir(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
