"""Process uploader for SDK spool events."""

from __future__ import annotations

import argparse
import base64
import json
import os
import time
from pathlib import Path
from typing import Any

from .client import Client, DEFAULT_PROCESS_SPOOL_DIR, RlobsError


LOCK_FILE = ".uploader.lock"


def drain_spool(
    spool_dir: str,
    client: Client | None = None,
    base_url: str = "http://127.0.0.1:8000",
    timeout: float = 2.0,
    max_events: int | None = None,
) -> int:
    root = Path(spool_dir).expanduser().resolve()
    active_client = client or Client(base_url=base_url, timeout=timeout, api_key=os.environ.get("RLOBS_API_KEY"))
    uploaded = 0
    with _UploaderLock(root):
        for run_dir in _run_dirs(root):
            for event_path in sorted(run_dir.glob("*.json")):
                if max_events is not None and uploaded >= max_events:
                    return uploaded
                try:
                    _send_event(active_client, _load_event(event_path))
                except RlobsError:
                    break
                event_path.unlink()
                uploaded += 1
    return uploaded


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Drain Training Observability SDK spool events.")
    parser.add_argument("--spool-dir", default=DEFAULT_PROCESS_SPOOL_DIR)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--timeout", type=float, default=2.0)
    parser.add_argument("--max-events", type=int, default=None)
    parser.add_argument("--follow", action="store_true")
    parser.add_argument("--poll-interval", type=float, default=1.0)
    args = parser.parse_args(argv)
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
            raise RlobsError(f"spool uploader is already running for {self.root}") from exc
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


def _load_event(path: Path) -> dict[str, Any]:
    try:
        decoded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RlobsError(f"cannot read spool event {path}: {exc}") from exc
    if not isinstance(decoded, dict):
        raise RlobsError(f"spool event {path} must be a JSON object")
    return decoded


def _send_event(client: Client, event: dict[str, Any]) -> None:
    requests = event.get("requests")
    if not isinstance(requests, list) or len(requests) != 1:
        raise RlobsError("process spool events must contain exactly one request")
    request = requests[0]
    if not isinstance(request, dict):
        raise RlobsError("process spool request must be a JSON object")
    method = request.get("method")
    path = request.get("path")
    body = request.get("body")
    if not isinstance(method, str) or not isinstance(path, str) or not isinstance(body, dict):
        raise RlobsError("process spool request must include method, path, and body")
    _request_with_optional_idempotency(client, method, path, _prepare_body(path, body), event.get("event_id"))


def _prepare_body(path: str, body: dict[str, Any]) -> dict[str, Any]:
    if path.endswith("/artifacts/upload") and "source_path" in body:
        source = Path(str(body["source_path"])).expanduser().resolve()
        try:
            content = base64.b64encode(source.read_bytes()).decode("ascii")
        except OSError as exc:
            raise RlobsError(f"cannot read upload source {source}: {exc}") from exc
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
    if isinstance(event_id, str) and path.endswith("/metrics"):
        try:
            client._request(method, path, body, idempotency_key=event_id)
            return
        except TypeError:
            pass
    client._request(method, path, body)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
