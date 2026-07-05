"""Process uploader for SDK spool events."""

from __future__ import annotations

import argparse
import base64
import json
import os
import time
from pathlib import Path
from typing import Any

from .async_queue import drain_async_queues
from .client import Client, DEFAULT_PROCESS_SPOOL_DIR, InstantMLError, _default_base_url
from .credentials import _resolve_api_key


LOCK_FILE = ".uploader.lock"
LEGACY_ACTIVE_SEGMENT_STALE_SECONDS = 30.0


def drain_spool(
    spool_dir: str,
    client: Client | None = None,
    base_url: str | None = None,
    timeout: float = 10.0,
    max_events: int | None = None,
) -> int:
    root = Path(spool_dir).expanduser().resolve()
    active_client = client or Client(base_url=base_url or _default_base_url(), timeout=timeout, api_key=os.environ.get("INSTANTML_API_KEY"))
    uploaded = 0
    with _UploaderLock(root):
        for run_dir in _run_dirs(root):
            uploaded = _drain_run_dir(active_client, run_dir, max_events, uploaded)
            if max_events is not None and uploaded >= max_events:
                return uploaded
    return uploaded


def _drain_run_dir(client: Client, run_dir: Path, max_events: int | None, uploaded: int) -> int:
    # Old single-event ``.json`` files and new append-only ``.jsonl`` segments
    # are drained together in filename order (both carry sequence-ordered
    # prefixes) so cross-format ordering within a run is preserved.
    _promote_recoverable_segments(run_dir)
    for event_path in sorted(list(run_dir.glob("*.json")) + list(run_dir.glob("*.jsonl"))):
        if max_events is not None and uploaded >= max_events:
            return uploaded
        try:
            events = _load_events(event_path)
        except InstantMLError:
            break
        sent = 0
        failed = False
        for event in events:
            if max_events is not None and uploaded + sent >= max_events:
                break
            try:
                _send_event(client, event)
            except InstantMLError:
                failed = True
                break
            sent += 1
        uploaded += sent
        remainder = events[sent:]
        if remainder:
            # Persist the not-yet-delivered remainder so a mid-segment stop
            # (failure or max_events) never re-sends already-delivered events.
            _rewrite_remainder(event_path, remainder)
        else:
            event_path.unlink()
        if failed:
            break
    return uploaded


def _promote_recoverable_segments(run_dir: Path) -> None:
    """Make crash-left active segment dotfiles visible to the normal drain loop."""
    for tmp_path in sorted(run_dir.glob(".*.jsonl.pid-*.tmp")):
        parsed = _pid_segment_final_path(tmp_path)
        if parsed is None:
            continue
        final_path, writer_pid = parsed
        if _pid_is_running(writer_pid):
            continue
        _promote_segment(tmp_path, final_path)

    # Older SDKs wrote active append-only segments as ``.name.jsonl.tmp``
    # without an owner PID. Recover only stale files so a follow-mode uploader
    # does not race a still-running legacy writer.
    now = time.time()
    for tmp_path in sorted(run_dir.glob(".*.jsonl.tmp")):
        final_path = _legacy_segment_final_path(tmp_path)
        if final_path is None:
            continue
        try:
            age_seconds = now - tmp_path.stat().st_mtime
        except OSError:
            continue
        if age_seconds < LEGACY_ACTIVE_SEGMENT_STALE_SECONDS:
            continue
        _promote_segment(tmp_path, final_path)


def _pid_segment_final_path(tmp_path: Path) -> tuple[Path, int] | None:
    name = tmp_path.name
    marker = ".pid-"
    suffix = ".tmp"
    marker_index = name.rfind(marker)
    if not name.startswith(".") or not name.endswith(suffix) or marker_index <= 1:
        return None
    pid_text = name[marker_index + len(marker) : -len(suffix)]
    if not pid_text.isdecimal():
        return None
    final_name = name[1:marker_index]
    if not final_name.endswith(".jsonl"):
        return None
    return tmp_path.with_name(final_name), int(pid_text)


def _legacy_segment_final_path(tmp_path: Path) -> Path | None:
    name = tmp_path.name
    suffix = ".tmp"
    if not name.startswith(".") or not name.endswith(".jsonl.tmp"):
        return None
    final_name = name[1:-len(suffix)]
    if not final_name.endswith(".jsonl"):
        return None
    return tmp_path.with_name(final_name)


def _promote_segment(tmp_path: Path, final_path: Path) -> None:
    if final_path.exists():
        return
    try:
        os.replace(tmp_path, final_path)
    except FileNotFoundError:
        return
    _fsync_dir(final_path.parent)


def _pid_is_running(pid: int) -> bool:
    if pid <= 0:
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _fsync_dir(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Drain Training Observability SDK spool events.")
    parser.add_argument("--spool-dir", default=DEFAULT_PROCESS_SPOOL_DIR)
    parser.add_argument("--queue-dir", default=None)
    parser.add_argument("--base-url", default=_default_base_url())
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--max-events", type=int, default=None)
    parser.add_argument("--follow", action="store_true")
    parser.add_argument("--poll-interval", type=float, default=1.0)
    args = parser.parse_args(argv)
    if args.queue_dir:
        kwargs = {
            "queue_dir": args.queue_dir,
            "base_url": args.base_url,
            "api_key": _resolve_api_key(None),
            "timeout": args.timeout,
            "max_events": args.max_events,
        }
        if args.follow:  # pragma: no cover
            while True:
                drain_async_queues(**kwargs)
                time.sleep(args.poll_interval)
        drain_async_queues(**kwargs)
        return 0
    if args.follow:  # pragma: no cover
        while True:
            drain_spool(args.spool_dir, base_url=args.base_url, timeout=args.timeout, max_events=args.max_events)
            time.sleep(args.poll_interval)
    drain_spool(args.spool_dir, base_url=args.base_url, timeout=args.timeout, max_events=args.max_events)
    return 0


class _UploaderLock:
    def __init__(self, root: Path):
        self.root = root
        self.path = root / LOCK_FILE
        self.acquired = False

    def __enter__(self) -> "_UploaderLock":
        self.root.mkdir(parents=True, exist_ok=True)
        try:
            descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError as exc:
            raise InstantMLError(f"spool uploader is already running for {self.root}") from exc
        try:
            os.write(descriptor, str(os.getpid()).encode("ascii"))
        finally:
            os.close(descriptor)
        self.acquired = True
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.release()

    def release(self) -> None:
        if self.acquired:
            self.path.unlink()
            self.acquired = False


def _run_dirs(root: Path) -> list[Path]:
    return sorted(path for path in root.iterdir() if path.is_dir())


def _load_events(path: Path) -> list[dict[str, Any]]:
    """Load spooled events from a file.

    ``.jsonl`` segments hold one JSON event per line; legacy ``.json`` files
    hold a single JSON object. Both formats are supported for back-compat.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise InstantMLError(f"cannot read spool event {path}: {exc}") from exc
    events: list[dict[str, Any]] = []
    if path.suffix == ".jsonl":
        for line in text.splitlines():
            if not line.strip():
                continue
            events.append(_parse_event(path, line))
    else:
        events.append(_parse_event(path, text))
    return events


def _parse_event(path: Path, raw: str) -> dict[str, Any]:
    try:
        decoded = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise InstantMLError(f"cannot read spool event {path}: {exc}") from exc
    if not isinstance(decoded, dict):
        raise InstantMLError(f"spool event {path} must be a JSON object")
    return decoded


def _rewrite_remainder(path: Path, remainder: list[dict[str, Any]]) -> None:
    """Rewrite ``path`` with only the not-yet-delivered events (atomic replace).

    Used when a segment is partially drained (transient failure or a
    ``max_events`` cutoff) so already-delivered events are never re-sent.
    """
    tmp_path = path.with_name(f".{path.name}.rewrite.tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        for event in remainder:
            handle.write(json.dumps(event, separators=(",", ":")))
            handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp_path, path)


def _send_event(client: Client, event: dict[str, Any]) -> None:
    requests = event.get("requests")
    if not isinstance(requests, list) or len(requests) != 1:
        raise InstantMLError("process spool events must contain exactly one request")
    request = requests[0]
    if not isinstance(request, dict):
        raise InstantMLError("process spool request must be a JSON object")
    method = request.get("method")
    path = request.get("path")
    body = request.get("body")
    if not isinstance(method, str) or not isinstance(path, str) or not isinstance(body, dict):
        raise InstantMLError("process spool request must include method, path, and body")
    _request_with_optional_idempotency(client, method, path, _prepare_body(path, body), event.get("event_id"))


def _prepare_body(path: str, body: dict[str, Any]) -> dict[str, Any]:
    if path.endswith("/artifacts/upload") and "source_path" in body:
        source = Path(str(body["source_path"])).expanduser().resolve()
        try:
            content = base64.b64encode(source.read_bytes()).decode("ascii")
        except OSError as exc:
            raise InstantMLError(f"cannot read upload source {source}: {exc}") from exc
        prepared = dict(body)
        prepared.pop("source_path")
        prepared["content_base64"] = content
        return prepared
    return body


def _request_with_optional_idempotency(
    client: Client,
    method: str,
    path: str,
    body: dict[str, Any],
    event_id: Any,
) -> None:
    if isinstance(event_id, str) and (
        path.endswith("/metrics") or path.endswith("/rank-metrics") or path.endswith("/logs")
    ):
        try:
            client._request(method, path, body, idempotency_key=event_id)
            return
        except TypeError:
            pass
    client._request(method, path, body)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
