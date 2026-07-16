"""Resumable ``instantml sync`` for offline run directories (design §5).

``instantml sync <run_dir | offline_root>`` replays a ``mode="offline"`` run
directory (``run.json`` manifest + spool segments + staged ``files/``) to the
server. It reuses the async-queue drain machinery for delivery, journals a
per-segment cursor so an interrupted sync resumes from where it stopped, and
issues an idempotent ``mode="auto"`` run create that never reopens a terminal
run.

Delivery reuse (not a parallel engine): pending segment events are loaded into a
throwaway per-sync SQLite queue via ``prepare_event``/``enqueue_many_prepared``
— preserving each event's persisted idempotency key — and delivered by
``drain_queue_once``, inheriting its batching, retry classification,
``Retry-After`` handling, and lease recovery. Metric batching is deterministic
within a single segment (fixed ``max_batch_points``), so an interrupted-and-
rerun sync reproduces identical batch membership and the server's batch-level
idempotency key matches.

Exit codes: ``0`` synced and complete; ``3`` partial (retryable remainder —
rerun to continue); ``4`` permanent failures (auth/validation/run-id conflict);
``5`` invalid or unreadable run directory. argparse usage errors exit ``2`` and
``1`` remains the generic-error code.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import _http_pool
from .async_queue import (
    DEFAULT_MAX_BATCH_POINTS,
    AsyncQueueRepository,
    _METRICS_PATH_RE,
    drain_queue_once,
    _utc_timestamp,
)
from .client import _default_base_url
from .credentials import _resolve_api_key
from .uploader import _prepare_body, _promote_recoverable_segments


# Exit codes (design §5). argparse usage errors exit 2 on its own.
EXIT_OK = 0
EXIT_GENERIC = 1
EXIT_USAGE = 2
EXIT_PARTIAL = 3
EXIT_PERMANENT = 4
EXIT_INVALID = 5

# Aggregate severity ordering (higher wins) so a multi-run offline root reports
# the worst outcome across its runs.
_SEVERITY = {EXIT_OK: 0, EXIT_PARTIAL: 1, EXIT_GENERIC: 2, EXIT_PERMANENT: 3, EXIT_INVALID: 4}

_SYNC_STATE_SCHEMA_VERSION = 1
_MANIFEST_SCHEMA_VERSION = 1
# Keep every processed row for the lifetime of a per-segment throwaway queue so
# acknowledged-count accounting is not disturbed by processed-row pruning.
_NO_PRUNE_RETENTION = 2**31
# Total in-process wait budget across a sync for retry backoff (burst 429s,
# transient 5xx). Exhausting the budget exits 3 (rerun to continue) instead of
# blocking forever.
_RETRY_WAIT_CAP_SECONDS = 90.0
_RETRY_POLL_SECONDS = 0.25

_EXIT_REASON = {
    EXIT_OK: "synced and complete",
    EXIT_GENERIC: "unexpected error",
    EXIT_PARTIAL: "partial — retryable remainder, rerun to continue",
    EXIT_PERMANENT: "permanent failure (auth/validation/run-id conflict)",
    EXIT_INVALID: "invalid or unreadable run directory",
}


class _InvalidDir(Exception):
    """A run directory failed local validation (design §5a → exit 5)."""


@dataclass
class _Resp:
    """Minimal HTTP outcome the sync flow branches on."""

    status: int | None
    ok: bool
    retryable: bool
    body: dict[str, Any] | None = None
    code: str | None = None
    message: str = ""


@dataclass
class _RunReport:
    path: str
    action: str
    exit_code: int
    run_id: str | None = None
    classes: dict[str, dict[str, int]] = field(default_factory=dict)
    finish: str | None = None
    synced: bool = False
    notes: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "run_id": self.run_id,
            "action": self.action,
            "exit_code": self.exit_code,
            "exit_reason": _EXIT_REASON.get(self.exit_code, ""),
            "classes": self.classes,
            "finish": self.finish,
            "synced": self.synced,
            "notes": list(self.notes),
        }


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def run_offline_sync(argv: list[str]) -> int:
    """Parse ``sync`` flags for offline directories and return the exit code."""
    parser = argparse.ArgumentParser(
        prog="instantml sync",
        description="Replay an offline run directory (or a root of offline runs) to the server.",
    )
    parser.add_argument("path", help="A single offline run directory or an offline root containing several runs.")
    parser.add_argument("--status", action="store_true", help="Local-only report; performs no network I/O.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Local report plus server validation (auth + run lookup); issues no create and delivers no events.",
    )
    parser.add_argument("--json", dest="as_json", action="store_true", help="Emit a machine-readable JSON report.")
    parser.add_argument("--base-url", default=None, help="Override the API base URL.")
    parser.add_argument("--timeout", type=float, default=10.0, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    base_url = (args.base_url or _default_base_url()).rstrip("/")
    api_key = _resolve_api_key(None)

    run_dirs = _discover_run_dirs(Path(args.path).expanduser())
    if not run_dirs:
        report = _RunReport(path=str(args.path), action="status" if args.status else "sync", exit_code=EXIT_INVALID)
        report.notes.append("no offline run directory found (expected run.json, or offline/<run_id>/run.json)")
        _emit([report], args.as_json)
        return EXIT_INVALID

    reports = [_sync_one_run(run_dir, base_url, api_key, args) for run_dir in run_dirs]
    _emit(reports, args.as_json)
    return _aggregate_exit(reports)


def _discover_run_dirs(path: Path) -> list[Path]:
    """Resolve ``path`` to zero or more offline run directories.

    Accepts a single run directory (``run.json`` present), an offline root that
    directly contains ``<run_id>/`` children, or a data root that contains an
    ``offline/`` directory. Duplicates are removed, order preserved.
    """
    if not path.exists() or not path.is_dir():
        return []
    if (path / "run.json").is_file():
        return [path]
    found: list[Path] = []
    seen: set[Path] = set()

    def _add_children(parent: Path) -> None:
        if not parent.is_dir():
            return
        for child in sorted(parent.iterdir()):
            resolved = child.resolve()
            if child.is_dir() and (child / "run.json").is_file() and resolved not in seen:
                seen.add(resolved)
                found.append(child)

    _add_children(path)
    _add_children(path / "offline")
    return found


def _sync_one_run(run_dir: Path, base_url: str, api_key: str | None, args: argparse.Namespace) -> _RunReport:
    action = "status" if args.status else ("dry-run" if args.dry_run else "sync")
    report = _RunReport(path=str(run_dir), action=action, exit_code=EXIT_OK)
    try:
        manifest = _load_manifest(run_dir)
    except _InvalidDir as exc:
        report.exit_code = EXIT_INVALID
        report.notes.append(str(exc))
        return report

    report.run_id = manifest["run_id"]
    report.finish = _describe_finish(manifest.get("finish"))
    try:
        if args.status:
            _run_status(run_dir, manifest, report)
        elif args.dry_run:
            _run_dry_run(run_dir, manifest, report, base_url, api_key, args.timeout)
        else:
            _run_sync(run_dir, manifest, report, base_url, api_key, args.timeout)
    except Exception as exc:  # noqa: BLE001 — surface as a generic CLI error, keep other runs going
        report.exit_code = EXIT_GENERIC
        report.notes.append(f"unexpected error: {exc}")
    return report


# --------------------------------------------------------------------------- #
# Local validation and scanning
# --------------------------------------------------------------------------- #


def _load_manifest(run_dir: Path) -> dict[str, Any]:
    run_json = run_dir / "run.json"
    if not run_json.is_file():
        raise _InvalidDir("run.json is missing")
    try:
        manifest = json.loads(run_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise _InvalidDir(f"run.json is unreadable: {exc}") from exc
    if not isinstance(manifest, dict):
        raise _InvalidDir("run.json must be a JSON object")
    if manifest.get("schema_version") != _MANIFEST_SCHEMA_VERSION:
        raise _InvalidDir(f"unsupported run.json schema_version {manifest.get('schema_version')!r}")
    for field_name in ("run_id", "session_id", "mode"):
        if not isinstance(manifest.get(field_name), str) or not manifest[field_name]:
            raise _InvalidDir(f"run.json is missing a valid {field_name!r}")
    if not isinstance(manifest.get("producer"), dict):
        raise _InvalidDir("run.json is missing a valid 'producer'")
    if not isinstance(manifest.get("create_request"), dict):
        raise _InvalidDir("run.json is missing a valid 'create_request'")
    segments_dir = run_dir / "segments"
    if not segments_dir.is_dir():
        raise _InvalidDir("segments/ directory is missing")
    try:
        list(segments_dir.iterdir())
    except OSError as exc:
        raise _InvalidDir(f"segments/ is unreadable: {exc}") from exc
    return manifest


@dataclass
class _SegmentEvent:
    line_index: int
    event_class: str
    method: str
    path: str
    body: dict[str, Any]
    idempotency_key: str
    sequence: int


def _scan_segments(segments_dir: Path, *, include_partials: bool) -> list[tuple[str, list[_SegmentEvent]]]:
    """Parse durable segments into ordered per-file event lists.

    Malformed or partial lines are skipped exactly like PR-03 crash recovery so
    a single bad line never fails the sync. ``line_index`` counts only accepted
    events, giving a stable per-segment cursor coordinate.
    """
    paths = sorted(segments_dir.glob("*.jsonl"))
    if include_partials:
        paths = paths + sorted(segments_dir.glob(".*.jsonl.pid-*.tmp")) + sorted(segments_dir.glob(".*.jsonl.tmp"))
    segments: list[tuple[str, list[_SegmentEvent]]] = []
    for path in paths:
        try:
            raw_lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        events: list[_SegmentEvent] = []
        line_index = 0
        for raw in raw_lines:
            parsed = _parse_segment_line(raw)
            if parsed is None:
                continue
            parsed.line_index = line_index
            events.append(parsed)
            line_index += 1
        segments.append((path.name, events))
    return segments


def _parse_segment_line(raw: str) -> _SegmentEvent | None:
    if not raw.strip():
        return None
    try:
        event = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(event, dict):
        return None
    event_class = event.get("class")
    requests = event.get("requests")
    if not isinstance(event_class, str) or not isinstance(requests, list) or len(requests) != 1:
        return None
    request = requests[0]
    if not isinstance(request, dict):
        return None
    method = request.get("method")
    path = request.get("path")
    body = request.get("body")
    key = request.get("idempotency_key")
    if not isinstance(method, str) or not isinstance(path, str) or not isinstance(body, dict) or not isinstance(key, str):
        return None
    sequence = event.get("sequence")
    return _SegmentEvent(
        line_index=0,
        event_class=event_class,
        method=method,
        path=path,
        body=body,
        idempotency_key=key,
        sequence=sequence if isinstance(sequence, int) else 0,
    )


def _local_counts(
    segments: list[tuple[str, list[_SegmentEvent]]],
    manifest: dict[str, Any],
) -> dict[str, dict[str, int]]:
    """Per-class attempted/queued/dropped: queued from the segment scan, dropped
    from the run.json checkpoint (drops are never written to segments)."""
    classes: dict[str, dict[str, int]] = {}
    for _name, events in segments:
        for event in events:
            entry = classes.setdefault(event.event_class, _empty_class_counts())
            entry["queued"] += 1
    manifest_counts = manifest.get("counts")
    if isinstance(manifest_counts, dict):
        for event_class, values in manifest_counts.items():
            if not isinstance(values, dict):
                continue
            dropped = values.get("dropped")
            if isinstance(dropped, int) and dropped > 0:
                classes.setdefault(event_class, _empty_class_counts())["dropped"] += dropped
    for entry in classes.values():
        entry["attempted"] = entry["queued"] + entry["dropped"]
    return classes


def _empty_class_counts() -> dict[str, int]:
    return {"attempted": 0, "queued": 0, "accepted": 0, "pending": 0, "failed": 0, "dropped": 0, "unsupported": 0}


# --------------------------------------------------------------------------- #
# --status
# --------------------------------------------------------------------------- #


def _run_status(run_dir: Path, manifest: dict[str, Any], report: _RunReport) -> None:
    segments = _scan_segments(run_dir / "segments", include_partials=True)
    classes = _local_counts(segments, manifest)
    state = _read_sync_state(run_dir)
    delivered = state["delivered"]
    for name, events in segments:
        cursor = _cursor(delivered, name)
        for event in events:
            if event.line_index <= cursor:
                classes[event.event_class]["accepted"] += 1
    for entry in classes.values():
        entry["pending"] = max(0, entry["queued"] - entry["accepted"])
    report.classes = classes
    if _is_synced(state):
        report.synced = True
        report.notes.append("directory already marked synced")
    else:
        pending_total = sum(entry["pending"] for entry in classes.values())
        if pending_total:
            report.notes.append(f"{pending_total} event(s) pending upload; run `instantml sync {run_dir}`")
    report.notes.append(f"session {manifest['session_id']}")
    report.exit_code = EXIT_OK


# --------------------------------------------------------------------------- #
# --dry-run
# --------------------------------------------------------------------------- #


def _run_dry_run(
    run_dir: Path,
    manifest: dict[str, Any],
    report: _RunReport,
    base_url: str,
    api_key: str | None,
    timeout: float,
) -> None:
    segments = _scan_segments(run_dir / "segments", include_partials=True)
    classes = _local_counts(segments, manifest)
    state = _read_sync_state(run_dir)
    delivered = state["delivered"]
    for name, events in segments:
        cursor = _cursor(delivered, name)
        for event in events:
            if event.line_index <= cursor:
                classes[event.event_class]["accepted"] += 1
    for entry in classes.values():
        entry["pending"] = max(0, entry["queued"] - entry["accepted"])
    report.classes = classes

    run_id = manifest["run_id"]
    resp = _http_request(base_url, api_key, timeout, "GET", f"/runs/{run_id}")
    if resp.status in (401, 403):
        report.exit_code = EXIT_PERMANENT
        report.notes.append("server rejected credentials (would-fail auth); check INSTANTML_API_KEY or `instantml login`")
        return
    if resp.status == 200:
        report.notes.append("server validation: run exists — sync would attach (mode=auto, no reopen)")
    elif resp.status == 404:
        report.notes.append("server validation: run does not exist — sync would create it")
    elif resp.retryable:
        report.exit_code = EXIT_PARTIAL
        report.notes.append(f"server unreachable ({resp.message}); retry `instantml sync --dry-run`")
        return
    else:
        report.exit_code = EXIT_PERMANENT
        report.notes.append(f"server validation failed: {resp.message}")
        return
    report.notes.append("dry run: no create issued, no events delivered")
    report.exit_code = EXIT_OK


# --------------------------------------------------------------------------- #
# real sync
# --------------------------------------------------------------------------- #


def _run_sync(
    run_dir: Path,
    manifest: dict[str, Any],
    report: _RunReport,
    base_url: str,
    api_key: str | None,
    timeout: float,
) -> None:
    state = _read_sync_state(run_dir)
    if _is_synced(state):
        # Already fully synced: a pure local no-op that issues no request.
        segments = _scan_segments(run_dir / "segments", include_partials=False)
        classes = _local_counts(segments, manifest)
        for name, events in segments:
            for event in events:
                classes[event.event_class]["accepted"] += 1
        report.classes = classes
        report.synced = True
        report.action = "noop"
        report.notes.append("directory already marked synced; nothing to do")
        report.exit_code = EXIT_OK
        return

    run_id = manifest["run_id"]
    session_id = manifest["session_id"]
    segments_dir = run_dir / "segments"

    # Promote crash-left partials so a hard-killed run's active segment is
    # delivered too, then scan only the durable rotated segments.
    _promote_recoverable_segments(segments_dir)
    segments = _scan_segments(segments_dir, include_partials=False)
    classes = _local_counts(segments, manifest)
    report.classes = classes

    # 1) Idempotent create with mode=auto (never reopens a terminal run).
    create_body = dict(manifest["create_request"])
    create_body["id"] = run_id
    create_body["mode"] = "auto"
    create_key = f"instantml-{run_id}-{session_id[:8]}-run_meta-create"
    create = _http_request(base_url, api_key, timeout, "POST", "/runs", create_body, idempotency_key=create_key)
    if create.status in (401, 403):
        report.exit_code = EXIT_PERMANENT
        report.notes.append("create failed: server rejected credentials; check INSTANTML_API_KEY or `instantml login`")
        return
    if create.status == 409 or create.code == "run_id_conflict":
        report.exit_code = EXIT_PERMANENT
        report.notes.append(
            f"create failed: run id {run_id} conflicts with an existing run (run_id_conflict); cannot sync into it"
        )
        return
    if not create.ok:
        if create.retryable:
            report.exit_code = EXIT_PARTIAL
            report.notes.append(f"create not delivered ({create.message}); rerun `instantml sync {run_dir}`")
        else:
            report.exit_code = EXIT_PERMANENT
            report.notes.append(f"create failed: {create.message}")
        return
    created = bool(create.body.get("created")) if isinstance(create.body, dict) else False
    report.notes.append("run created" if created else "run attached (existing)")

    # 2) Deliver pending segment events through the async-queue drain.
    totals = _deliver_segments(run_dir, segments, state, base_url, api_key, timeout, classes)

    for name, events in segments:
        cursor = _cursor(state["delivered"], name)
        for event in events:
            if event.line_index <= cursor:
                classes[event.event_class]["accepted"] += 1
    for event_class, entry in classes.items():
        entry["failed"] = totals["failed"].get(event_class, 0)
        entry["pending"] = max(0, entry["queued"] - entry["accepted"] - entry["failed"])

    if totals["failed_total"]:
        report.exit_code = EXIT_PERMANENT
        report.notes.append(f"{totals['failed_total']} event(s) permanently failed (non-retryable); will not retry")
        return
    if totals["pending_total"]:
        report.exit_code = EXIT_PARTIAL
        report.notes.append(
            f"{totals['pending_total']} event(s) awaiting retry; rerun `instantml sync {run_dir}` to continue"
        )
        return

    # 3) All segment events delivered — apply finish, then the session manifest.
    finish = manifest.get("finish")
    if isinstance(finish, dict) and isinstance(finish.get("status"), str):
        if not _finish_already_in_segments(segments, run_id):
            finish_key = f"instantml-{run_id}-{session_id[:8]}-run_meta-finish"
            patch = _http_request(
                base_url,
                api_key,
                timeout,
                "PATCH",
                f"/runs/{run_id}",
                {"status": finish["status"]},
                idempotency_key=finish_key,
            )
            if not patch.ok:
                if patch.retryable:
                    report.exit_code = EXIT_PARTIAL
                    report.notes.append(f"finish status not delivered ({patch.message}); rerun to complete")
                else:
                    report.exit_code = EXIT_PERMANENT
                    report.notes.append(f"finish status failed: {patch.message}")
                return
            report.notes.append(f"run status set to {finish['status']!r}")
    elif finish is None:
        report.notes.append(
            "run finished uncleanly (no finish signature); server run left in its current status (likely running)"
        )

    # 4) Final session manifest (route ships in PR-05 — tolerate its absence).
    _post_session_manifest(run_dir, manifest, segments, base_url, api_key, timeout, report)

    # 5) Mark synced — subsequent sync is a local no-op.
    state["synced"] = {"completed_at": _utc_timestamp()}
    _write_sync_state(run_dir, state)
    report.synced = True
    report.exit_code = EXIT_OK
    if any(entry["dropped"] for entry in classes.values()):
        report.notes.append("some events were dropped locally (disk/write failures) — server data-state will be incomplete")


def _deliver_segments(
    run_dir: Path,
    segments: list[tuple[str, list[_SegmentEvent]]],
    state: dict[str, Any],
    base_url: str,
    api_key: str | None,
    timeout: float,
    classes: dict[str, dict[str, int]],
) -> dict[str, Any]:
    """Drive per-segment, chunk-aligned delivery with fail-stop semantics.

    A throwaway SQLite queue is created per segment so metric batching stays
    within a single segment. Events are fed to the drain in deterministic
    chunks derived purely from segment content (a maximal run of consecutive
    same-run metric events capped at ``DEFAULT_MAX_BATCH_POINTS``, or a single
    non-metric event), and the cursor is journaled only at chunk boundaries.
    Because the cursor always rests on a chunk boundary, a rerun rebuilds the
    exact same chunks — and therefore the exact same batch memberships and
    batch idempotency keys — so a re-sent boundary batch deduplicates on the
    server.

    Delivery stops at the first failed or still-retryable chunk (fail-stop):
    events past a permanently-failed event are never delivered ahead of it,
    which is what keeps reruns duplicate-free after the operator fixes the
    cause (for example a missing API-key scope) — verified live against the
    Rust server in PR-04's E2E.
    """
    failed_by_class: dict[str, int] = {}
    failed_total = 0
    pending_total = 0
    wait_budget = {"remaining": _RETRY_WAIT_CAP_SECONDS}
    with tempfile.TemporaryDirectory(prefix="instantml-sync-") as tmp_root:
        for name, events in segments:
            cursor = _cursor(state["delivered"], name)
            pending = [event for event in events if event.line_index > cursor]
            if not pending:
                continue
            seg_failed, seg_pending = _deliver_one_segment(
                Path(tmp_root) / f"{name}.sqlite3",
                name,
                pending,
                state,
                run_dir,
                base_url,
                api_key,
                timeout,
                failed_by_class,
                wait_budget,
            )
            failed_total += seg_failed
            pending_total += seg_pending
            if seg_failed or seg_pending:
                # Fail-stop: later segments would only be delivered out of
                # order and re-sent on the next rerun anyway.
                pending_total += sum(
                    len([e for e in later_events if e.line_index > _cursor(state["delivered"], later_name)])
                    for later_name, later_events in segments
                    if later_name > name
                )
                break
    return {
        "failed": failed_by_class,
        "failed_total": failed_total,
        "pending_total": pending_total,
    }


def _chunk_pending(pending: list[_SegmentEvent], max_points: int) -> list[list[_SegmentEvent]]:
    """Split pending events into deterministic delivery chunks.

    A chunk is either a maximal run of consecutive plain metric POSTs for the
    same run (capped at ``max_points``) or a single non-metric event. Chunk
    boundaries are a pure function of segment content, and the resume cursor
    only ever rests on a boundary, so reruns rebuild identical chunks.
    """
    chunks: list[list[_SegmentEvent]] = []
    index = 0
    while index < len(pending):
        head = pending[index]
        run_id = _plain_metric_run_id(head)
        if run_id is None:
            chunks.append([head])
            index += 1
            continue
        end = index + 1
        while end < len(pending) and end - index < max_points and _plain_metric_run_id(pending[end]) == run_id:
            end += 1
        chunks.append(pending[index:end])
        index = end
    return chunks


def _plain_metric_run_id(event: _SegmentEvent) -> str | None:
    """Match the async drain's batch-grouping rule (POST /runs/{id}/metrics)."""
    if event.method.upper() != "POST":
        return None
    match = _METRICS_PATH_RE.match(event.path)
    return match.group("run_id") if match else None


def _deliver_one_segment(
    queue_path: Path,
    segment_name: str,
    pending: list[_SegmentEvent],
    state: dict[str, Any],
    run_dir: Path,
    base_url: str,
    api_key: str | None,
    timeout: float,
    failed_by_class: dict[str, int],
    wait_budget: dict[str, float],
) -> tuple[int, int]:
    """Deliver one segment chunk by chunk. Returns ``(failed, pending)``."""
    repository = AsyncQueueRepository(queue_path, producer=False, processed_retention=_NO_PRUNE_RETENTION)
    repository.init_db()
    try:
        chunks = _chunk_pending(pending, DEFAULT_MAX_BATCH_POINTS)
        delivered_upto = 0  # events (from `pending`) covered by completed chunks
        for chunk in chunks:
            prepared = []
            for event in chunk:
                body = _prepare_body(event.path, event.body)  # base64-encode staged files at delivery time
                prepared.append(
                    repository.prepare_event(event.method, event.path, body, idempotency_key=event.idempotency_key)
                )
            result = repository.enqueue_many_prepared(prepared)
            first_seq = result.first_sequence_id
            if first_seq is None:  # pragma: no cover — defensive; prepared is non-empty here
                return 0, len(pending) - delivered_upto
            failed, pending_left = _drain_chunk(repository, first_seq, len(chunk), base_url, api_key, timeout, wait_budget)
            if failed:
                _attribute_failed(repository, first_seq, chunk, failed_by_class)
                state["last_error"] = "one or more events were rejected as non-retryable"
                _write_sync_state(run_dir, state)
                return failed, len(pending) - delivered_upto - len(chunk) + pending_left
            if pending_left:
                # Retryable remainder: the cursor stays on the previous chunk
                # boundary so the rerun re-sends this chunk with identical
                # batch membership (the server dedupes the boundary batch).
                return 0, len(pending) - delivered_upto
            delivered_upto += len(chunk)
            _set_cursor(state["delivered"], segment_name, chunk[-1].line_index)
            _write_sync_state(run_dir, state)
        return 0, 0
    finally:
        repository.close()


def _drain_chunk(
    repository: AsyncQueueRepository,
    first_seq: int,
    count: int,
    base_url: str,
    api_key: str | None,
    timeout: float,
    wait_budget: dict[str, float],
) -> tuple[int, int]:
    """Drain one enqueued chunk to a settled state. Returns ``(failed, pending)``.

    Retry backoff (burst 429s with ``Retry-After``, transient 5xx) is waited out
    in-process within a bounded budget; when the budget runs out the remainder
    is reported as retryable (exit 3, rerun to continue).
    """
    while True:
        processed = drain_queue_once(
            repository,
            base_url=base_url,
            api_key=api_key,
            timeout=timeout,
            max_batch_points=DEFAULT_MAX_BATCH_POINTS,
        )
        if processed:
            continue
        if repository.has_claimable():
            continue
        failed, pending_left = _chunk_outcome(repository, first_seq, count)
        if failed or not pending_left:
            return failed, pending_left
        # Pending rows are all in retry backoff. Wait them out within budget.
        if wait_budget["remaining"] <= 0:
            return failed, pending_left
        wait = min(_RETRY_POLL_SECONDS, wait_budget["remaining"])
        time.sleep(wait)
        wait_budget["remaining"] -= wait


def _chunk_outcome(repository: AsyncQueueRepository, first_seq: int, count: int) -> tuple[int, int]:
    """Return ``(failed, pending)`` counts over one chunk's contiguous id range."""
    conn = repository._connect()  # single-owner throwaway queue
    rows = conn.execute(
        "select status, count(*) as n from events where sequence_id between ? and ? group by status",
        (first_seq, first_seq + count - 1),
    ).fetchall()
    counts = {str(row["status"]): int(row["n"]) for row in rows}
    return counts.get("failed", 0), counts.get("pending", 0) + counts.get("in_flight", 0)


def _attribute_failed(
    repository: AsyncQueueRepository,
    first_seq: int,
    chunk: list[_SegmentEvent],
    failed_by_class: dict[str, int],
) -> None:
    """Attribute each failed row in the chunk to its event class for the report."""
    conn = repository._connect()
    rows = conn.execute(
        "select sequence_id from events where status = 'failed' and sequence_id between ? and ?",
        (first_seq, first_seq + len(chunk) - 1),
    ).fetchall()
    for row in rows:
        event = chunk[int(row["sequence_id"]) - first_seq]
        failed_by_class[event.event_class] = failed_by_class.get(event.event_class, 0) + 1


def _finish_already_in_segments(segments: list[tuple[str, list[_SegmentEvent]]], run_id: str) -> bool:
    target = f"/runs/{run_id}"
    for _name, events in segments:
        for event in events:
            if event.event_class == "run_meta" and event.method == "PATCH" and event.path == target and "status" in event.body:
                return True
    return False


# --------------------------------------------------------------------------- #
# Session manifest (PR-05 route; graceful when absent)
# --------------------------------------------------------------------------- #


def _post_session_manifest(
    run_dir: Path,
    manifest: dict[str, Any],
    segments: list[tuple[str, list[_SegmentEvent]]],
    base_url: str,
    api_key: str | None,
    timeout: float,
    report: _RunReport,
) -> None:
    run_id = manifest["run_id"]
    session_id = manifest["session_id"]
    state = _read_sync_state(run_dir)
    delivered = state["delivered"]

    counts: dict[str, dict[str, int]] = {}
    last_sequences: dict[str, int] = {}
    for name, events in segments:
        cursor = _cursor(delivered, name)
        for event in events:
            entry = counts.setdefault(event.event_class, {"attempted": 0, "queued": 0, "acknowledged": 0, "failed": 0, "dropped": 0})
            entry["queued"] += 1
            if event.line_index <= cursor:
                entry["acknowledged"] += 1
                last_sequences[event.event_class] = max(last_sequences.get(event.event_class, 0), event.sequence)
    manifest_counts = manifest.get("counts")
    if isinstance(manifest_counts, dict):
        for event_class, values in manifest_counts.items():
            if isinstance(values, dict) and isinstance(values.get("dropped"), int) and values["dropped"] > 0:
                counts.setdefault(event_class, {"attempted": 0, "queued": 0, "acknowledged": 0, "failed": 0, "dropped": 0})
                counts[event_class]["dropped"] += values["dropped"]
    for entry in counts.values():
        entry["attempted"] = entry["queued"] + entry["dropped"]

    body = {
        # Keep the producer identity from run.json (kind "sdk"): these are the
        # producer's events, not the sync tool's. Privacy-safe (host is hashed).
        "producer": manifest.get("producer", {"kind": "sdk"}),
        "sdk_version": manifest.get("sdk_version", "unknown"),
        "state": "final",
        "counts": counts,
        "last_sequences": last_sequences,
    }
    resp = _http_request(base_url, api_key, timeout, "PUT", f"/api/runs/{run_id}/sessions/{session_id}", body)
    if resp.ok:
        report.notes.append("final session manifest posted")
    elif resp.status in (404, 405):
        report.notes.append("session manifest route not available yet (ships in PR-05); skipped")
    else:
        report.notes.append(f"session manifest not posted ({resp.message}); delivery already complete")


# --------------------------------------------------------------------------- #
# sync-state.json cursor journal
# --------------------------------------------------------------------------- #


def _read_sync_state(run_dir: Path) -> dict[str, Any]:
    path = run_dir / "sync-state.json"
    data: Any = {}
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = {}
    if not isinstance(data, dict):
        data = {}
    data["schema_version"] = _SYNC_STATE_SCHEMA_VERSION
    delivered = data.get("delivered")
    data["delivered"] = delivered if isinstance(delivered, dict) else {}
    data.setdefault("last_error", None)
    return data


def _write_sync_state(run_dir: Path, state: dict[str, Any]) -> None:
    state["schema_version"] = _SYNC_STATE_SCHEMA_VERSION
    state["updated_at"] = _utc_timestamp()
    path = run_dir / "sync-state.json"
    tmp = path.with_name(f".sync-state.json.tmp-{os.getpid()}-{uuid.uuid4().hex}")
    tmp.write_text(json.dumps(state, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, path)


def _is_synced(state: dict[str, Any]) -> bool:
    marker = state.get("synced")
    return isinstance(marker, dict) and bool(marker.get("completed_at"))


def _cursor(delivered: dict[str, Any], name: str) -> int:
    value = delivered.get(name)
    return value if isinstance(value, int) else -1


def _set_cursor(delivered: dict[str, Any], name: str, line_index: int) -> None:
    delivered[name] = max(line_index, _cursor(delivered, name))


# --------------------------------------------------------------------------- #
# HTTP helper (single _http_pool.urlopen seam, like the async drain)
# --------------------------------------------------------------------------- #


def _http_request(
    base_url: str,
    api_key: str | None,
    timeout: float,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    idempotency_key: str | None = None,
) -> _Resp:
    url = base_url.rstrip("/") + path
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, separators=(",", ":")).encode("utf-8")
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with _http_pool.urlopen(request, timeout=timeout) as response:
            payload = response.read().decode("utf-8")
        return _Resp(status=200, ok=True, retryable=False, body=_safe_json(payload))
    except urllib.error.HTTPError as exc:
        status = int(exc.code)
        message, code = _decode_error(exc)
        retryable = status in (408, 429) or status >= 500
        return _Resp(status=status, ok=False, retryable=retryable, code=code, message=message)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return _Resp(status=None, ok=False, retryable=True, code="network_error", message=str(exc))


def _safe_json(payload: str) -> dict[str, Any] | None:
    try:
        decoded = json.loads(payload)
    except json.JSONDecodeError:
        return None
    return decoded if isinstance(decoded, dict) else None


def _decode_error(exc: urllib.error.HTTPError) -> tuple[str, str | None]:
    try:
        decoded = json.loads(exc.read().decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, OSError):
        return str(exc), None
    if isinstance(decoded, dict):
        message = decoded.get("error") if isinstance(decoded.get("error"), str) else str(exc)
        code = decoded.get("code") if isinstance(decoded.get("code"), str) else None
        return message, code
    return str(exc), None


# --------------------------------------------------------------------------- #
# Reporting
# --------------------------------------------------------------------------- #


def _describe_finish(finish: Any) -> str | None:
    if not isinstance(finish, dict):
        return "none (unclean — no finish signature)"
    status = finish.get("status")
    clean = finish.get("clean")
    if not isinstance(status, str):
        return "none (unclean — no finish signature)"
    return f"{status} ({'clean' if clean else 'unclean'})"


def _aggregate_exit(reports: list[_RunReport]) -> int:
    worst = EXIT_OK
    for report in reports:
        if _SEVERITY.get(report.exit_code, 0) > _SEVERITY.get(worst, 0):
            worst = report.exit_code
    return worst


def _emit(reports: list[_RunReport], as_json: bool) -> None:
    if as_json:
        payload = {"runs": [report.to_json() for report in reports], "exit_code": _aggregate_exit(reports)}
        print(json.dumps(payload, indent=2, sort_keys=True))
        return
    for report in reports:
        _print_human(report)
    if len(reports) > 1:
        code = _aggregate_exit(reports)
        print(f"\nAggregate exit: {code} ({_EXIT_REASON.get(code, '')})")


def _print_human(report: _RunReport) -> None:
    print(f"Run {report.run_id or '(invalid)'}  [{report.path}]")
    print(f"  action: {report.action}")
    if report.classes:
        for event_class in sorted(report.classes):
            counts = report.classes[event_class]
            print(
                f"  {event_class:<13} "
                f"attempted={counts['attempted']} queued={counts['queued']} "
                f"accepted={counts['accepted']} pending={counts['pending']} "
                f"failed={counts['failed']} dropped={counts['dropped']} unsupported={counts['unsupported']}"
            )
    if report.finish is not None:
        print(f"  finish: {report.finish}")
    print(f"  synced: {'yes' if report.synced else 'no'}")
    for note in report.notes:
        print(f"  note: {note}")
    print(f"  exit: {report.exit_code} ({_EXIT_REASON.get(report.exit_code, '')})")
