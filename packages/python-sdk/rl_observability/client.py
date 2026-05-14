"""Small SDK for logging training runs."""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import platform
import socket
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
import warnings
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class RlobsError(Exception):
    """Raised when the SDK cannot complete a logging request."""


DEFAULT_PROCESS_SPOOL_DIR = ".rlobs/spool"
PROCESS_UPLOAD_MODES = {"sync", "spool"}
SNAPSHOT_KEYS = {"metrics", "metadata"}
CONSOLE_LOG_STREAMS = {"stdout", "stderr"}
MAX_CONSOLE_LOG_MESSAGE_BYTES = 16 * 1024
MAX_CONSOLE_LOG_LINES_PER_BATCH = 50


@dataclass(frozen=True)
class Table:
    columns: list[str]
    rows: list[dict[str, Any] | list[Any] | tuple[Any, ...]]
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class Histogram:
    bins: list[int | float]
    counts: list[int | float]
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class Image:
    path: str
    caption: str | None = None
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class Video:
    path: str
    caption: str | None = None
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class Audio:
    path: str
    caption: str | None = None
    metadata: dict[str, Any] | None = None


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
        response = self._request(
            "POST",
            "/runs",
            {
                "project": project,
                "name": name,
                "config": config or {},
                "tags": tags or [],
                "metadata": combined_metadata,
            },
        )
        return Run(
            client=Client(base_url=self.base_url, timeout=self.timeout, offline_dir=offline_dir or self.offline_dir, api_key=self.api_key),
            run_id=response["run"]["id"],
            buffer_size=buffer_size,
            upload_mode=upload_mode,
            spool_dir=spool_dir,
        )

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
        api_key = self.api_key or os.environ.get("RLOBS_API_KEY")
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
            raise RlobsError(f"{method} {path} failed: {message}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise RlobsError(f"{method} {path} failed: {exc}") from exc
        try:
            decoded = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise RlobsError("server returned invalid JSON") from exc
        if not isinstance(decoded, dict):
            raise RlobsError("server returned a non-object JSON payload")
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


@dataclass
class Run:
    client: Client
    run_id: str
    buffer_size: int = 0
    upload_mode: str = "sync"
    spool_dir: str | None = None
    _queue: list[dict[str, Any]] = field(default_factory=list)
    _last_steps: dict[str, float] = field(default_factory=dict)
    _console_line_numbers: dict[str, int] = field(default_factory=dict)
    _process_sequence: int = field(default=0, init=False)

    def __post_init__(self) -> None:
        _validate_upload_mode(self.upload_mode)

    def __enter__(self) -> "Run":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.finish("failed" if exc_type else "finished")

    def log(self, metrics: dict[str, float], step: int | float) -> None:
        self.log_metrics(metrics, step=step)

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
        metric_timestamp = timestamp
        if self.upload_mode == "spool" and metric_timestamp is None:
            metric_timestamp = _utc_timestamp()
        for key in data:
            previous = self._last_steps.get(key)
            if previous is not None and step < previous and not preview:
                warnings.warn(f"metric {key!r} logged at non-increasing step {step}", RuntimeWarning, stacklevel=2)
            if not preview:
                self._last_steps[key] = float(step)
        self._submit(
            "POST",
            f"/runs/{self.run_id}/metrics",
            {
                "metrics": data,
                "step": step,
                "timestamp": metric_timestamp,
                "preview": preview,
                "preview_completion": preview_completion,
            },
            data={"metrics": data},
            step=step,
            event_timestamp=metric_timestamp,
        )

    def log_text(self, data: dict[str, str], step: int | float | None = None, timestamp: str | None = None) -> None:
        attributes = [{"path": key, "type": "string_series", "step": step, "timestamp": timestamp, "value": value} for key, value in data.items()]
        self._submit(
            "POST",
            f"/api/runs/{self.run_id}/attributes",
            {"attributes": attributes},
            data={"text": data},
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
        payload = {
            "type": artifact_type,
            "name": name,
            "uri": uri,
            "step": step,
            "size_bytes": size_bytes,
            "metadata": metadata or {},
        }
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
        source = Path(path).expanduser().resolve()
        if self.upload_mode == "spool":
            payload = {
                "type": artifact_type,
                "name": name or source.name,
                "source_path": str(source),
                "step": step,
                "mime_type": mimetypes.guess_type(source.name)[0] or "application/octet-stream",
                "metadata": metadata or {},
            }
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
            "metadata": metadata or {},
        }
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
                raise RlobsError("rich media object logging requires upload_mode='sync' until uploader response chaining is supported")
            source = Path(rich_object.path).expanduser().resolve()
            if not source.exists() or not source.is_file():
                raise RlobsError(f"media source does not exist: {source}")
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
            return self._request_or_spool("POST", f"/api/runs/{self.run_id}/objects", payload)["object"]
        raise TypeError("unsupported rich object type")

    def _submit_or_spool_object(self, payload: dict[str, Any], data: dict[str, Any], step: int | float | None) -> dict[str, Any]:
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

    def flush(self) -> None:
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
        self.flush()
        if self.upload_mode == "spool":
            self._submit("PATCH", f"/runs/{self.run_id}", {"status": status}, data={"status": status})
            return
        self._request_or_spool("PATCH", f"/runs/{self.run_id}", {"status": status})

    def _submit(
        self,
        method: str,
        path: str,
        body: dict[str, Any],
        data: dict[str, Any] | None = None,
        step: int | float | None = None,
        event_timestamp: str | None = None,
    ) -> None:
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
            if len(self._queue) >= self.buffer_size:
                self.flush()
            return
        self._request_or_spool(method, path, body)

    def _request_or_spool(self, method: str, path: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            return self.client._request(method, path, body)
        except RlobsError:
            if not self.client.offline_dir:
                raise
            _spool_event(self.client.offline_dir, self.run_id, {"method": method, "path": path, "body": body})
            return {"spooled": True, "artifact": {"id": "spooled", **body}}


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
    )


def _validate_note_text(notes: str) -> str:
    if not isinstance(notes, str):
        raise TypeError("notes must be a string")
    encoded = notes.strip().encode("utf-8")
    if len(encoded) > 512:
        raise ValueError("notes must be at most 512 bytes")
    return notes.strip()


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
    if len(text.encode("utf-8")) > 512:
        raise ValueError(f"{field} must be at most 512 bytes")
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
