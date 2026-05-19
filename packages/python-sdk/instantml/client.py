"""Small SDK for logging training runs."""

from __future__ import annotations

import base64
import hashlib
import json
import math
import mimetypes
import os
import platform
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import warnings
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class InstantMLError(Exception):
    """Raised when the SDK cannot complete a logging request."""


DEFAULT_PROCESS_SPOOL_DIR = ".instantml/spool"
PROCESS_UPLOAD_MODES = {"sync", "spool"}
SNAPSHOT_KEYS = {"metrics", "metadata"}
CONSOLE_LOG_STREAMS = {"stdout", "stderr"}
MAX_CONSOLE_LOG_MESSAGE_BYTES = 16 * 1024
MAX_CONSOLE_LOG_LINES_PER_BATCH = 50
MAX_TEXT_BYTES = 512
_PENDING_RUN_ID = "__instantml_pending__"
_DEFAULT_INIT_WAIT_SECONDS = 30.0


class Table:
    """Inline table object for rich run logging."""

    def __init__(
        self,
        columns: list[str] | tuple[str, ...] | None = None,
        rows: list[dict[str, Any] | list[Any] | tuple[Any, ...]] | tuple[dict[str, Any] | list[Any] | tuple[Any, ...], ...] | None = None,
        metadata: dict[str, Any] | None = None,
        *,
        dataframe: Any | None = None,
        data: Any | None = None,
    ) -> None:
        if dataframe is not None and data is not None:
            raise ValueError("table accepts either dataframe or data, not both")
        if dataframe is not None:
            columns = list(getattr(dataframe, "columns", []))
            rows = dataframe.to_dict(orient="records")
        elif data is not None:
            rows = data
            if columns is None and isinstance(rows, list) and rows and isinstance(rows[0], dict):
                columns = list(rows[0].keys())
        self.columns = list(columns) if columns is not None else []
        self.rows = list(rows) if isinstance(rows, tuple) else rows if rows is not None else []
        self.metadata = metadata

    @classmethod
    def from_dataframe(cls, dataframe: Any, metadata: dict[str, Any] | None = None) -> "Table":
        return cls(metadata=metadata, dataframe=dataframe)

    @classmethod
    def from_data(
        cls,
        data: Any,
        columns: list[str] | tuple[str, ...] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> "Table":
        return cls(columns=columns, data=data, metadata=metadata)


class Histogram:
    """Histogram rich object.

    The positional ``Histogram(bins, counts)`` form is intentionally preserved.
    Use ``Histogram.from_values(...)`` for NumPy/tensor/list values.
    """

    def __init__(self, bins: list[int | float], counts: list[int | float], metadata: dict[str, Any] | None = None) -> None:
        self.bins = list(bins) if isinstance(bins, tuple) else bins
        self.counts = list(counts) if isinstance(counts, tuple) else counts
        self.metadata = metadata

    @classmethod
    def from_values(
        cls,
        values: Any,
        bins: int | list[int | float] | tuple[int | float, ...] = 64,
        metadata: dict[str, Any] | None = None,
    ) -> "Histogram":
        numeric_values = _coerce_numeric_values(values, "histogram values")
        if isinstance(bins, bool):
            raise TypeError("histogram bin count must be an integer")
        if isinstance(bins, int):
            if bins <= 0:
                raise ValueError("histogram bin count must be positive")
            return cls(*_histogram_from_count(numeric_values, bins), metadata=metadata)
        edges = _validate_numeric_list(list(bins), "histogram bins", nonnegative=False)
        if len(edges) < 2:
            raise ValueError("histogram bins must contain at least two edges")
        return cls(edges, _histogram_counts_for_edges(numeric_values, edges), metadata=metadata)


@dataclass(frozen=True)
class File:
    path: str
    name: str | None = None
    artifact_type: str = "file"
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class Artifact(File):
    pass


@dataclass(frozen=True)
class Text:
    data: str
    name: str | None = None
    metadata: dict[str, Any] | None = None


class Image:
    def __init__(
        self,
        path: str | os.PathLike[str] | Any | None = None,
        caption: str | None = None,
        metadata: dict[str, Any] | None = None,
        *,
        data: Any | None = None,
    ) -> None:
        if data is not None and path is not None:
            raise ValueError("image accepts either path or data, not both")
        if data is None and path is not None and not isinstance(path, (str, os.PathLike)):
            data = path
            path = None
        self.path = None if path is None else os.fspath(path)
        self.data = data
        self.caption = caption
        self.metadata = metadata

    @classmethod
    def from_data(
        cls,
        data: Any,
        caption: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> "Image":
        return cls(caption=caption, metadata=metadata, data=data)


class Video:
    def __init__(
        self,
        path: str | os.PathLike[str] | Any | None = None,
        caption: str | None = None,
        metadata: dict[str, Any] | None = None,
        *,
        data: Any | None = None,
        fps: int | float = 30,
        format: str = "mp4",
    ) -> None:
        if data is not None and path is not None:
            raise ValueError("video accepts either path or data, not both")
        if data is None and path is not None and not isinstance(path, (str, os.PathLike)):
            data = path
            path = None
        self.path = None if path is None else os.fspath(path)
        self.data = data
        self.caption = caption
        self.metadata = metadata
        self.fps = fps
        self.format = format

    @classmethod
    def from_data(
        cls,
        data: Any,
        fps: int | float = 30,
        format: str = "mp4",
        caption: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> "Video":
        return cls(caption=caption, metadata=metadata, data=data, fps=fps, format=format)


class Audio:
    def __init__(
        self,
        path: str | os.PathLike[str] | Any | None = None,
        caption: str | None = None,
        metadata: dict[str, Any] | None = None,
        *,
        data: Any | None = None,
        sample_rate: int = 48000,
    ) -> None:
        if data is not None and path is not None:
            raise ValueError("audio accepts either path or data, not both")
        if data is None and path is not None and not isinstance(path, (str, os.PathLike)):
            data = path
            path = None
        self.path = None if path is None else os.fspath(path)
        self.data = data
        self.caption = caption
        self.metadata = metadata
        self.sample_rate = sample_rate

    @classmethod
    def from_data(
        cls,
        data: Any,
        sample_rate: int = 48000,
        caption: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> "Audio":
        return cls(caption=caption, metadata=metadata, data=data, sample_rate=sample_rate)


@dataclass(frozen=True)
class _FileStats:
    path: str
    sha256: str
    size_bytes: int


@dataclass(frozen=True)
class Client:
    base_url: str = "http://127.0.0.1:8000"
    timeout: float = 2.0
    offline_dir: str | None = None
    api_key: str | None = None

    def init(
        self,
        project: str,
        name: str | None = None,
        config: dict[str, Any] | None = None,
        tags: list[str] | None = None,
        notes: str | None = None,
        metadata: dict[str, Any] | None = None,
        buffer_size: int = 0,
        offline_dir: str | None = None,
        source_tracking: bool = True,
        upload_mode: str = "sync",
        spool_dir: str | None = None,
        local_store: bool = False,
        local_store_dir: str | None = None,
        system_metrics: bool = False,
        system_metrics_interval: float = 15.0,
        capture_console: bool = False,
        async_init: bool = True,
    ) -> "Run":
        _validate_upload_mode(upload_mode)
        if metadata and "_rlobs" in metadata:
            raise ValueError("metadata key '_rlobs' is reserved for SDK-owned metadata")
        combined_metadata = _environment_metadata()
        if source_tracking:
            combined_metadata["_rlobs"] = {"source": _source_metadata()}
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

        if not async_init:
            response = self._request("POST", "/runs", create_body)
            run = Run(
                client=run_client,
                run_id=response["run"]["id"],
                buffer_size=buffer_size,
                upload_mode=upload_mode,
                spool_dir=spool_dir,
                _local_store=_LocalStore(local_store_dir, response["run"]["id"]) if local_store else None,
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
        )

        def _resolve_init() -> None:
            try:
                response = self._request("POST", "/runs", create_body)
                real_run_id = response["run"]["id"]
                if local_store:
                    run._local_store = _LocalStore(local_store_dir, real_run_id)
                run.run_id = real_run_id  # property setter sets _init_done
                if system_metrics:
                    try:
                        run.start_system_metrics(interval=system_metrics_interval)
                    except Exception:  # noqa: BLE001 — surface via warning, don't crash worker
                        pass
                if capture_console:
                    try:
                        run.capture_console()
                    except Exception:  # noqa: BLE001
                        pass
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

    def _resolve_api_key(self) -> str | None:
        """Resolve the API key using the priority chain:
        1. Explicit api_key kwarg on Client.
        2. INSTANTML_API_KEY environment variable.
        3. ~/.instantml/credentials file.
        Returns the resolved key or None (for unauthenticated local mode).
        """
        if self.api_key:
            return self.api_key
        env_key = os.environ.get("INSTANTML_API_KEY")
        if env_key:
            return env_key
        try:
            from .cli import resolve_api_key_from_credentials
            file_key = resolve_api_key_from_credentials()
            if file_key:
                return file_key
        except Exception:
            pass
        return None

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
        request = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers=headers,
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
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
class Api:
    """Tiny raw read-only API helper for post-hoc queries."""

    base_url: str = "http://127.0.0.1:8000"
    timeout: float = 2.0
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


class Run:
    def __init__(
        self,
        client: Client,
        run_id: str,
        buffer_size: int = 0,
        upload_mode: str = "sync",
        spool_dir: str | None = None,
        media_dir: str | None = None,
        _local_store: "_LocalStore | None" = None,
    ) -> None:
        _validate_upload_mode(upload_mode)
        self.client = client
        self._run_id = run_id
        self.buffer_size = buffer_size
        self.upload_mode = upload_mode
        self.spool_dir = spool_dir
        self.media_dir = media_dir
        self._queue: list[dict[str, Any]] = []
        self._last_steps: dict[str, float] = {}
        self._console_line_numbers: dict[str, int] = {}
        self._process_sequence: int = 0
        self._auto_step: int | float = 0
        self._lock = threading.RLock()
        self._finished = False
        self._local_store: "_LocalStore | None" = _local_store
        self._system_sampler: "_SystemMetricsSampler | None" = None
        self._console_capture: "_ConsoleCapture | None" = None
        self._init_done = threading.Event()
        self._init_error: BaseException | None = None
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
        self._run_id = value
        if value and value != _PENDING_RUN_ID:
            self._init_done.set()

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

    def __enter__(self) -> "Run":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.finish("failed" if exc_type else "finished")

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
        if self.upload_mode == "spool" and metric_timestamp is None:
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

    def log_console(self, lines: str | list[str] | tuple[str, ...], stream: str = "stdout", timestamp: str | None = None) -> None:
        stream = _validate_console_stream(stream)
        messages = _normalize_console_lines(lines)
        start = self._console_line_numbers.get(stream, 0) + 1
        self._console_line_numbers[stream] = start + len(messages) - 1
        event_timestamp = timestamp
        if self.upload_mode == "spool" and event_timestamp is None:
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
        objects: dict[str, Table | Histogram | Image | Video | Audio],
        step: int | float | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        step = _validate_step(step)
        if not isinstance(objects, dict):
            raise TypeError("objects must be a dictionary")
        return [self._log_rich_object(key, value, step=step, metadata=metadata) for key, value in objects.items()]

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
        name: str,
        uri: str,
        artifact_type: str = "file",
        step: int | None = None,
        size_bytes: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
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
        rich_object: Table | Histogram | Image | Video | Audio,
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

    def flush(self) -> None:
        with self._lock:
            pending = self._queue
            self._queue = []
        for event in pending:
            self._request_or_spool(event["method"], event["path"], event["body"])

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

    def finish(self, status: str = "finished") -> None:
        sampler = self._system_sampler
        if sampler is not None:
            sampler.stop()
        capture = self._console_capture
        if capture is not None:
            capture.restore()
        try:
            self.flush()
            if self.upload_mode == "spool":
                self._submit("PATCH", f"/runs/{self.run_id}", {"status": status}, data={"status": status})
                return
            self._request_or_spool("PATCH", f"/runs/{self.run_id}", {"status": status})
        finally:
            with self._lock:
                self._finished = True
                self._system_sampler = None
                self._console_capture = None
            if self._local_store is not None:
                self._local_store.close()

    def _submit(
        self,
        method: str,
        path: str,
        body: dict[str, Any],
        data: dict[str, Any] | None = None,
        step: int | float | None = None,
        event_timestamp: str | None = None,
    ) -> None:
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
                _write_process_event(self.spool_dir, self.run_id, event)
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

    def _request_or_spool(self, method: str, path: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            return self.client._request(method, path, body)
        except InstantMLError:
            if not self.client.offline_dir:
                raise
            _spool_event(self.client.offline_dir, self.run_id, {"method": method, "path": path, "body": body})
            return {"spooled": True, "artifact": {"id": "spooled", **body}}


def _check_credentials_or_raise(api_key: str | None) -> None:
    """Raise InstantMLError with a helpful message when no credentials are available.

    Only raises when `api_key` kwarg is not set; env var and file are checked inside
    Client._resolve_api_key(), so this is a fast-fail for the most common missing-creds
    scenario before the HTTP call is made.
    """
    if api_key:
        return
    if os.environ.get("INSTANTML_API_KEY"):
        return
    try:
        from .cli import resolve_api_key_from_credentials
        if resolve_api_key_from_credentials():
            return
    except Exception:
        pass
    interactive = sys.stdin is not None and hasattr(sys.stdin, "isatty") and sys.stdin.isatty()
    msg = (
        "No API key found. Run `instantml login` to set up credentials, "
        "or set the INSTANTML_API_KEY environment variable."
    )
    if interactive:
        warnings.warn(msg, stacklevel=3)
    # We do not raise here — allow unauthenticated local dev mode to proceed.
    # The server will return 401 if auth is actually required.


def init(
    project: str,
    name: str | None = None,
    config: dict[str, Any] | None = None,
    tags: list[str] | None = None,
    notes: str | None = None,
    metadata: dict[str, Any] | None = None,
    base_url: str = "http://127.0.0.1:8000",
    timeout: float = 2.0,
    buffer_size: int = 0,
    offline_dir: str | None = None,
    api_key: str | None = None,
    source_tracking: bool = True,
    upload_mode: str = "sync",
    spool_dir: str | None = None,
    local_store: bool = False,
    local_store_dir: str | None = None,
    system_metrics: bool = False,
    system_metrics_interval: float = 15.0,
    capture_console: bool = False,
    async_init: bool = True,
) -> Run:
    return Client(base_url=base_url, timeout=timeout, offline_dir=offline_dir, api_key=api_key).init(
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
        local_store=local_store,
        local_store_dir=local_store_dir,
        system_metrics=system_metrics,
        system_metrics_interval=system_metrics_interval,
        capture_console=capture_console,
        async_init=async_init,
    )


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


class _SystemMetricsSampler:
    def __init__(self, run: Run, interval: float) -> None:
        self._run = run
        self._interval = interval
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name=f"instantml-system-{run.run_id}", daemon=True)

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


class TransformersCallback:
    def __init__(self, run: Run | None = None, **init_kwargs: Any) -> None:
        self.run = run
        self.init_kwargs = init_kwargs

    def setup(self, args: Any, state: Any, model: Any | None = None, **kwargs: Any) -> None:
        if self.run is None:
            init_kwargs = {"project": getattr(args, "project", "transformers"), **self.init_kwargs}
            self.run = init(**init_kwargs)

    def on_log(self, args: Any, state: Any, control: Any, logs: dict[str, Any] | None = None, **kwargs: Any) -> None:
        if self.run is None:
            self.setup(args, state, **kwargs)
        assert self.run is not None
        metrics = {key: value for key, value in (logs or {}).items() if _is_scalar_number(value)}
        if metrics:
            self.run.log(metrics, step=getattr(state, "global_step", None))


class LightningLogger:
    def __init__(self, project: str, run: Run | None = None, **init_kwargs: Any) -> None:
        self.project = project
        self._run = run
        self._init_kwargs = init_kwargs

    @property
    def name(self) -> str:
        return self.project

    @property
    def version(self) -> str:
        return self.experiment.run_id

    @property
    def experiment(self) -> Run:
        if self._run is None:
            self._run = init(project=self.project, **self._init_kwargs)
        return self._run

    def log_metrics(self, metrics: dict[str, Any], step: int | float | None = None) -> None:
        self.experiment.log(metrics, step=step)

    def log_hyperparams(self, params: dict[str, Any]) -> None:
        self.experiment.log_config(params)

    def log_image(self, key: str, images: list[Any], step: int | float | None = None, **kwargs: Any) -> None:
        self.experiment.log({key: [Image.from_data(image, metadata=kwargs or None) for image in images]}, step=step)

    def log_audio(self, key: str, audios: list[Any], step: int | float | None = None, **kwargs: Any) -> None:
        self.experiment.log({key: [Audio.from_data(audio, metadata=kwargs or None) for audio in audios]}, step=step)

    def log_video(self, key: str, videos: list[Any], step: int | float | None = None, **kwargs: Any) -> None:
        self.experiment.log({key: [Video.from_data(video, metadata=kwargs or None) for video in videos]}, step=step)

    def finalize(self, status: str = "finished") -> None:
        if self._run is not None:
            self._run.finish(status)


def _validate_note_text(notes: str) -> str:
    if not isinstance(notes, str):
        raise TypeError("notes must be a string")
    encoded = notes.strip().encode("utf-8")
    if len(encoded) > MAX_TEXT_BYTES:
        raise ValueError(f"notes must be at most {MAX_TEXT_BYTES} bytes")
    return notes.strip()


def _classify_log_payload(
    data: dict[str, Any],
) -> tuple[dict[str, float], dict[str, str], dict[str, Table | Histogram | Image | Video | Audio], dict[str, File]]:
    if not isinstance(data, dict):
        raise TypeError("log data must be a dictionary")
    metrics: dict[str, float] = {}
    text: dict[str, str] = {}
    objects: dict[str, Table | Histogram | Image | Video | Audio] = {}
    files: dict[str, File] = {}
    for raw_key, value in data.items():
        key = _validate_text(raw_key, "log key")
        if _is_scalar_number(value):
            metrics[key] = float(value)
        elif isinstance(value, str):
            text[key] = value
        elif isinstance(value, Text):
            text[key] = _validate_plain_string(value.data, "text data")
        elif isinstance(value, (Table, Histogram, Image, Video, Audio)):
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
    objects: dict[str, Table | Histogram | Image | Video | Audio],
    files: dict[str, File],
) -> None:
    if not values:
        raise ValueError(f"log sequence for {key!r} must not be empty")
    if all(_is_scalar_number(value) for value in values):
        raise TypeError(f"log sequence for {key!r} is numeric; use Histogram.from_values() or Table")
    if all(isinstance(value, (Table, Histogram, Image, Video, Audio)) for value in values):
        for index, value in enumerate(values):
            objects[f"{key}/{index}"] = value
        return
    if all(isinstance(value, File) for value in values):
        for index, value in enumerate(values):
            files[f"{key}/{index}"] = value
        return
    raise TypeError(f"log sequence for {key!r} must contain one homogeneous supported type")


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


def _validate_metrics(data: dict[str, Any]) -> dict[str, float]:
    if not isinstance(data, dict):
        raise TypeError("metrics must be a dictionary")
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


def _validate_plain_string(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    return value


def _is_scalar_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(float(value))
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


def _validate_text(value: str, field: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    text = value.strip()
    if not text:
        raise ValueError(f"{field} must be a non-empty string")
    if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise ValueError(f"{field} must be at most {MAX_TEXT_BYTES} bytes")
    return text


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


def _json_serializable(value: Any, field: str) -> None:
    try:
        json.dumps(value)
    except (TypeError, ValueError) as exc:
        raise TypeError(f"{field} must be JSON serializable") from exc


def _table_object_payload(
    key: str,
    table: Table,
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


def _normalize_table_rows(columns: list[str], rows: list[dict[str, Any] | list[Any] | tuple[Any, ...]]) -> list[dict[str, Any]]:
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
    histogram: Histogram,
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
    flattened = _flatten_numeric_value(_tensor_to_python(values))
    if not flattened:
        raise ValueError(f"{field} must not be empty")
    return _validate_numeric_list(flattened, field, nonnegative=False)


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


def _histogram_from_count(values: list[float], bins: int) -> tuple[list[float], list[float]]:
    low = min(values)
    high = max(values)
    if low == high:
        if bins == 1:
            return [low - 0.5, high + 0.5], [float(len(values))]
        width = 1.0 / bins
        start = low - 0.5
        edges = [start + index * width for index in range(bins + 1)]
        return edges, _histogram_counts_for_edges(values, edges)
    width = (high - low) / bins
    edges = [low + index * width for index in range(bins)]
    edges.append(high)
    return edges, _histogram_counts_for_edges(values, edges)


def _histogram_counts_for_edges(values: list[float], edges: list[float]) -> list[float]:
    counts = [0.0 for _ in range(len(edges) - 1)]
    for value in values:
        if value < edges[0] or value > edges[-1]:
            continue
        if value == edges[-1]:
            counts[-1] += 1.0
            continue
        for index in range(len(edges) - 1):
            if edges[index] <= value < edges[index + 1]:
                counts[index] += 1.0
                break
    return counts


def _hash_file(path: Path) -> _FileStats:
    if not path.exists() or not path.is_file():
        raise InstantMLError(f"upload source does not exist: {path}")
    digest = hashlib.sha256()
    size_bytes = 0
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            size_bytes += len(chunk)
            digest.update(chunk)
    return _FileStats(path=str(path), sha256=digest.hexdigest(), size_bytes=size_bytes)


def _write_image_data(data: Any, target: Path) -> None:
    if data is None:
        raise InstantMLError("image data is required")
    if callable(getattr(data, "savefig", None)):
        data.savefig(target)
        return
    if callable(getattr(data, "save", None)):
        data.save(target)
        return
    try:
        from PIL import Image as PillowImage
    except ImportError as exc:
        raise InstantMLError("Pillow is required to log image data") from exc
    try:
        import numpy as np
    except ImportError as exc:
        raise InstantMLError("numpy is required to log image data arrays") from exc
    array = np.asarray(_tensor_to_python(data))
    if array.dtype != np.uint8:
        if array.max() <= 1.0:
            array = array * 255
        array = np.clip(array, 0, 255).astype("uint8")
    PillowImage.fromarray(array).save(target)


def _write_audio_data(data: Any, target: Path, sample_rate: int) -> None:
    if data is None:
        raise InstantMLError("audio data is required")
    try:
        import soundfile
    except ImportError as exc:
        raise InstantMLError("soundfile is required to log audio data") from exc
    soundfile.write(target, _tensor_to_python(data), sample_rate)


def _write_video_data(data: Any, target: Path, fps: int | float) -> None:
    if data is None:
        raise InstantMLError("video data is required")
    try:
        import imageio.v3 as imageio
    except ImportError as imageio_error:
        try:
            from moviepy.video.io.ImageSequenceClip import ImageSequenceClip
        except ImportError as moviepy_error:
            raise InstantMLError("moviepy or imageio is required to log video data") from moviepy_error
        clip = ImageSequenceClip(_tensor_to_python(data), fps=fps)
        clip.write_videofile(str(target), logger=None)
        return
    try:
        imageio.imwrite(target, _tensor_to_python(data), fps=fps)
    except TypeError as exc:
        raise InstantMLError("moviepy or imageio is required to log video data") from exc


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


def _environment_metadata() -> dict[str, Any]:
    return {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "hostname": socket.gethostname(),
        "pid": os.getpid(),
    }


def _source_metadata() -> dict[str, Any]:
    return {
        "argv": sys.argv,
        "cwd": os.getcwd(),
        "git": _git_metadata(),
    }


def _git_metadata() -> dict[str, Any]:
    def git(*args: str) -> str | None:
        try:
            return subprocess.check_output(["git", *args], stderr=subprocess.DEVNULL, text=True, timeout=0.5).strip()
        except (subprocess.SubprocessError, OSError):
            return None

    root = git("rev-parse", "--show-toplevel")
    if root is None:
        return {"available": False}
    return {
        "available": True,
        "root": root,
        "commit": git("rev-parse", "HEAD"),
        "branch": git("branch", "--show-current"),
        "dirty": bool(git("status", "--porcelain")),
    }


def _flatten(data: dict[str, Any], prefix: str = "") -> dict[str, Any]:
    flattened: dict[str, Any] = {}
    for key, value in data.items():
        path = f"{prefix}/{key}" if prefix else str(key)
        if isinstance(value, dict):
            flattened.update(_flatten(value, path))
        else:
            flattened[path] = value
    return flattened


def _validate_upload_mode(upload_mode: str) -> None:
    if upload_mode not in PROCESS_UPLOAD_MODES:
        raise ValueError(f"upload_mode must be one of: {', '.join(sorted(PROCESS_UPLOAD_MODES))}")


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
    json.dumps(event)
    return event


def _write_process_event(spool_dir: str | None, run_id: str, event: dict[str, Any]) -> Path:
    root = Path(spool_dir or DEFAULT_PROCESS_SPOOL_DIR).expanduser().resolve()
    run_dir = root / _safe_path_segment(run_id)
    run_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{event['sequence']:020d}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}-{event['event_id']}.json"
    final_path = run_dir / filename
    tmp_path = run_dir / f".{filename}.tmp"
    with tmp_path.open("w", encoding="utf-8") as handle:
        handle.write(json.dumps(event, sort_keys=True, separators=(",", ":")))
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


def _offline_path(offline_dir: str, run_id: str) -> Path:
    return Path(offline_dir).expanduser().resolve() / f"{run_id}.jsonl"


def _spool_event(offline_dir: str, run_id: str, event: dict[str, Any]) -> None:
    path = _offline_path(offline_dir, run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event) + "\n")


def _error_message(exc: urllib.error.HTTPError) -> str:
    try:
        payload = exc.read().decode("utf-8")
        decoded = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return str(exc)
    if isinstance(decoded, dict) and isinstance(decoded.get("error"), str):
        return decoded["error"]
    return str(exc)
