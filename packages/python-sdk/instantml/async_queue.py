"""SQLite-backed async upload queue for SDK hot-path events."""

from __future__ import annotations

import hashlib
import json
import math
import os
import random
import re
import shutil
import sqlite3
import threading
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import _http_pool
from .errors import InstantMLError


DEFAULT_ASYNC_QUEUE_DIR = ".instantml/async"
DEFAULT_MAX_BATCH_BYTES = 1 * 1024 * 1024
DEFAULT_MAX_EVENT_BYTES = 1 * 1024 * 1024
DEFAULT_MAX_QUEUE_BYTES = 512 * 1024 * 1024
DEFAULT_MIN_FREE_DISK_BYTES = 64 * 1024 * 1024
DEFAULT_PROCESSED_RETENTION = 1_000
DEFAULT_LEASE_SECONDS = 30.0
DEFAULT_BUSY_POLL_SECONDS = 0.25
DEFAULT_IDLE_POLL_SECONDS = 1.0
DEFAULT_HEALTH_INTERVAL_SECONDS = 5.0
DEFAULT_ERROR_RETENTION = 1_000
DEFAULT_SQLITE_JOURNAL_SIZE_LIMIT = 16 * 1024 * 1024
DEFAULT_LOCK_STALE_SECONDS = 24 * 60 * 60
DEFAULT_PRODUCER_BATCH_EVENTS = 64
DEFAULT_PRODUCER_BATCH_BYTES = 64 * 1024
DEFAULT_PRODUCER_FLUSH_SECONDS = 0.020
DEFAULT_PRODUCER_MAX_BUFFER_EVENTS = 4_096
DEFAULT_PRODUCER_MAX_BUFFER_BYTES = 4 * 1024 * 1024
DEFAULT_PRODUCER_RETRY_SECONDS = 0.020
DEFAULT_WAL_CHECKPOINT_INTERVAL_SECONDS = 30.0
ASYNC_HEALTH_PREFIX = "system/instantml/"
DEFAULT_MAX_BATCH_POINTS = 500
QUEUED_BYTES_COUNTER = "queued_bytes"
# Matches the plain metric ingest path (POST /runs/{run_id}/metrics) so its
# events can be grouped into a single POST /runs/{run_id}/metrics/batch request.
# Excludes /rank-metrics and any sub-paths.
_METRICS_PATH_RE = re.compile(r"^/runs/(?P<run_id>[^/]+)/metrics$")
_BATCH_UNSUPPORTED_STATUSES = {404, 405}
_RETRYABLE_HTTP_STATUSES = {408, 409, 500, 502, 503, 504}
_TERMINAL_CODES = {
    "api_request_monthly_limit_exceeded",
    "payment_required",
    "plan_limit_exceeded",
    "unauthorized",
    "forbidden",
}


@dataclass(frozen=True)
class AsyncQueueConfig:
    queue_dir: str | None = None
    max_batch_bytes: int = DEFAULT_MAX_BATCH_BYTES
    max_event_bytes: int = DEFAULT_MAX_EVENT_BYTES
    max_queue_bytes: int = DEFAULT_MAX_QUEUE_BYTES
    min_free_disk_bytes: int = DEFAULT_MIN_FREE_DISK_BYTES
    processed_retention: int = DEFAULT_PROCESSED_RETENTION


@dataclass(frozen=True)
class PreparedQueuedEvent:
    created_at: float
    method: str
    path: str
    body_json: str
    body_size_bytes: int
    idempotency_key: str


@dataclass(frozen=True)
class EnqueueBatchResult:
    inserted: int
    dropped: int
    first_sequence_id: int | None = None
    last_sequence_id: int | None = None
    message: str | None = None


@dataclass(frozen=True)
class QueuedEvent:
    sequence_id: int
    method: str
    path: str
    body: dict[str, Any]
    body_size_bytes: int
    idempotency_key: str
    attempts: int = 0


@dataclass(frozen=True)
class DeliveryResult:
    ok: bool
    retryable: bool
    message: str = ""
    status: int | None = None
    code: str | None = None
    retry_after: float | None = None


def queue_path_for_run(queue_dir: str | None, run_id: str) -> Path:
    root = Path(queue_dir or DEFAULT_ASYNC_QUEUE_DIR).expanduser().resolve()
    return root / _safe_path_segment(run_id) / "queue.sqlite3"


def drain_async_queues(
    queue_dir: str,
    base_url: str,
    api_key: str | None = None,
    timeout: float = 10.0,
    max_events: int | None = None,
) -> int:
    root = Path(queue_dir).expanduser().resolve()
    if not root.exists():
        return 0
    drained = 0
    for queue_path in sorted(root.glob("*/queue.sqlite3")):
        if max_events is not None and drained >= max_events:
            break
        remaining = None if max_events is None else max_events - drained
        drained += drain_queue(queue_path, base_url=base_url, api_key=api_key, timeout=timeout, max_events=remaining)
    return drained


def drain_queue(
    queue_path: str | os.PathLike[str],
    base_url: str,
    api_key: str | None = None,
    timeout: float = 10.0,
    max_events: int | None = None,
) -> int:
    repository = AsyncQueueRepository(Path(queue_path), producer=False)
    repository.init_db()
    lock = QueueLock(repository.path)
    uploaded = 0
    with lock:
        while max_events is None or uploaded < max_events:
            processed = drain_queue_once(repository, base_url=base_url, api_key=api_key, timeout=timeout)
            if processed == 0:
                if not repository.has_claimable():
                    break
                continue
            uploaded += processed
    repository.close()
    return uploaded


def run_async_uploader(
    queue_path: str,
    base_url: str,
    api_key: str | None,
    timeout: float,
    run_id: str,
    parent_pid: int,
    max_batch_bytes: int = DEFAULT_MAX_BATCH_BYTES,
    max_event_bytes: int = DEFAULT_MAX_EVENT_BYTES,
    idle_poll_seconds: float = DEFAULT_IDLE_POLL_SECONDS,
    busy_poll_seconds: float = DEFAULT_BUSY_POLL_SECONDS,
    health_interval_seconds: float = DEFAULT_HEALTH_INTERVAL_SECONDS,
) -> None:
    repository = AsyncQueueRepository(Path(queue_path), producer=False, max_event_bytes=max_event_bytes)
    repository.init_db()
    lock = QueueLock(repository.path)
    last_health_at = 0.0
    had_outstanding_health = False
    with lock:
        while _parent_is_running(parent_pid):
            processed = drain_queue_once(
                repository,
                base_url=base_url,
                api_key=api_key,
                timeout=timeout,
                max_batch_bytes=max_batch_bytes,
                max_event_bytes=max_event_bytes,
            )
            now = time.time()
            status = repository.status()
            outstanding = status["pending"] + status["in_flight"] + status["failed"] + status["dropped"]
            should_emit_health = False
            if outstanding and now - last_health_at >= health_interval_seconds:
                should_emit_health = True
            elif processed and now - last_health_at >= health_interval_seconds:
                should_emit_health = True
            elif had_outstanding_health and outstanding == 0:
                should_emit_health = True
            if should_emit_health:
                _send_health(repository, base_url, api_key, timeout, run_id)
                last_health_at = now
            had_outstanding_health = outstanding > 0
            time.sleep(busy_poll_seconds if processed else idle_poll_seconds)
    repository.close()


# Process-lifetime flag: once the server rejects the batch route with 404/405
# (an older server without it), permanently fall back to per-event delivery so
# nothing is lost. Mirrors ``_http_pool``'s gzip-fallback posture.
_batch_unsupported = False


def _batch_route_supported() -> bool:
    return not _batch_unsupported


def _mark_batch_unsupported() -> None:
    global _batch_unsupported
    _batch_unsupported = True


def drain_queue_once(
    repository: "AsyncQueueRepository",
    base_url: str,
    api_key: str | None = None,
    timeout: float = 10.0,
    max_batch_bytes: int = DEFAULT_MAX_BATCH_BYTES,
    max_event_bytes: int = DEFAULT_MAX_EVENT_BYTES,
    max_batch_points: int = DEFAULT_MAX_BATCH_POINTS,
) -> int:
    repository.recover_stale_leases()
    lease_token = uuid.uuid4().hex
    events = repository.claim_batch(
        lease_token=lease_token,
        max_batch_bytes=max_batch_bytes,
        max_event_bytes=max_event_bytes,
        lease_seconds=DEFAULT_LEASE_SECONDS,
    )
    processed = 0
    index = 0
    retry_pending = False
    while index < len(events):
        event = events[index]
        if event.body_size_bytes > max_event_bytes:
            repository.mark_failed(event.sequence_id, "event exceeds async queue max_event_bytes", code="event_too_large")
            index += 1
            continue
        group = _consecutive_metric_group(events, index, max_batch_points) if _batch_route_supported() else []
        if len(group) >= 2:
            outcome = _deliver_metric_batch(repository, base_url, api_key, timeout, group)
            if outcome is None:
                # Batch route is unsupported on this server; retry the same
                # members individually on the next loop iteration.
                continue
            delivered, retry_pending = outcome
            processed += delivered
            if retry_pending:
                break
            index += len(group)
            continue
        result = _send_request(
            base_url=base_url,
            api_key=api_key,
            timeout=timeout,
            method=event.method,
            path=event.path,
            body=event.body,
            idempotency_key=event.idempotency_key,
        )
        if result.ok:
            repository.mark_processed(event.sequence_id)
            processed += 1
        elif result.retryable:
            repository.mark_retry(
                event.sequence_id,
                message=result.message,
                code=result.code,
                http_status=result.status,
                retry_after=result.retry_after,
                known_attempts=event.attempts,
            )
            retry_pending = True
            index += 1
            break
        else:
            repository.mark_failed(event.sequence_id, result.message, code=result.code, http_status=result.status)
        index += 1
    if retry_pending and index < len(events):
        repository.release_events([remaining.sequence_id for remaining in events[index:]])
    if processed:
        repository.prune_processed()
    return processed


def _consecutive_metric_group(events: list["QueuedEvent"], start: int, max_points: int) -> list["QueuedEvent"]:
    """Return the maximal run of consecutive same-run metric POSTs from ``start``.

    Capped at ``max_points`` events so a single batch request never exceeds the
    server's per-batch limit.
    """
    head = events[start]
    run_id = _metric_run_id(head)
    if run_id is None:
        return []
    group = [head]
    for event in events[start + 1 :]:
        if len(group) >= max_points:
            break
        if _metric_run_id(event) != run_id:
            break
        group.append(event)
    return group


def _metric_run_id(event: "QueuedEvent") -> str | None:
    if event.method.upper() != "POST":
        return None
    match = _METRICS_PATH_RE.match(event.path)
    return match.group("run_id") if match else None


def _deliver_metric_batch(
    repository: "AsyncQueueRepository",
    base_url: str,
    api_key: str | None,
    timeout: float,
    group: list["QueuedEvent"],
) -> tuple[int, bool] | None:
    """Deliver a group of same-run metric events as one batch request.

    Returns ``(delivered, retry_pending)`` on a real response, or ``None`` when
    the server does not support the batch route (caller falls back per-event).
    """
    run_id = _metric_run_id(group[0])
    result = _send_batch_request(
        base_url=base_url,
        api_key=api_key,
        timeout=timeout,
        run_id=str(run_id),
        events=group,
    )
    if result.ok:
        repository.mark_processed_many([event.sequence_id for event in group])
        return len(group), False
    if result.status in _BATCH_UNSUPPORTED_STATUSES:
        _mark_batch_unsupported()
        return None
    sequence_ids = [event.sequence_id for event in group]
    if result.retryable:
        repository.mark_retry_many(
            sequence_ids,
            message=result.message,
            code=result.code,
            http_status=result.status,
            retry_after=result.retry_after,
            known_attempts=max(event.attempts for event in group),
        )
        return 0, True
    repository.mark_failed_many(sequence_ids, result.message, code=result.code, http_status=result.status)
    return 0, False


class AsyncQueueRepository:
    def __init__(
        self,
        path: Path,
        *,
        producer: bool = True,
        max_queue_bytes: int = DEFAULT_MAX_QUEUE_BYTES,
        min_free_disk_bytes: int = DEFAULT_MIN_FREE_DISK_BYTES,
        max_event_bytes: int = DEFAULT_MAX_EVENT_BYTES,
        processed_retention: int = DEFAULT_PROCESSED_RETENTION,
        error_retention: int = DEFAULT_ERROR_RETENTION,
    ) -> None:
        self.path = path.expanduser().resolve()
        self.max_queue_bytes = max_queue_bytes
        self.min_free_disk_bytes = min_free_disk_bytes
        self.max_event_bytes = max_event_bytes
        self.processed_retention = processed_retention
        self.error_retention = error_retention
        self._connection: sqlite3.Connection | None = None
        self._timeout = 0.1 if producer else 1.0
        self._lock = threading.RLock()
        self._last_checkpoint_at = 0.0

    def init_db(self) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._harden_file_permissions()
            conn = self._connect()
            conn.executescript(
                """
                create table if not exists queue_meta (
                  key text primary key,
                  value text not null
                );
                create table if not exists events (
                  sequence_id integer primary key autoincrement,
                  created_at real not null,
                  updated_at real not null,
                  method text not null,
                  path text not null,
                  body_json text not null,
                  body_size_bytes integer not null,
                  idempotency_key text,
                  status text not null,
                  attempts integer not null default 0,
                  last_attempt_at real,
                  next_attempt_at real not null default 0,
                  lease_token text,
                  leased_until real,
                  last_error text,
                  last_error_code text,
                  last_http_status integer
                );
                create index if not exists events_status_attempt_sequence_idx
                  on events (status, next_attempt_at, sequence_id);
                create table if not exists errors (
                  id integer primary key autoincrement,
                  sequence_id integer,
                  created_at real not null,
                  error_type text not null,
                  message text not null
                );
                create table if not exists counters (
                  key text primary key,
                  value integer not null
                );
                """
            )
            conn.execute("insert or ignore into queue_meta (key, value) values (?, ?)", ("version", "1"))
            self._reseed_queued_bytes(conn)
            conn.commit()
            self._harden_file_permissions()

    def prepare_event(
        self,
        method: str,
        path: str,
        body: dict[str, Any],
        idempotency_key: str | None = None,
        created_at: float | None = None,
    ) -> PreparedQueuedEvent:
        # The server hashes the raw per-event body and idempotency keys are
        # per-event, so canonical producer ordering is not needed for dedup;
        # drop sort_keys (D7c). json.dumps defaults to ensure_ascii=True, so
        # the payload is pure ASCII and len(str) IS the UTF-8 byte size — no
        # encode/decode round-trip on the training thread per event.
        payload = json.dumps(body, separators=(",", ":"))
        size_bytes = len(payload)
        return PreparedQueuedEvent(
            created_at=time.time() if created_at is None else created_at,
            method=method,
            path=path,
            body_json=payload,
            body_size_bytes=size_bytes,
            idempotency_key=idempotency_key or f"instantml-{uuid.uuid4().hex}",
        )

    def enqueue(self, method: str, path: str, body: dict[str, Any], idempotency_key: str | None = None) -> int | None:
        event = self.prepare_event(method, path, body, idempotency_key=idempotency_key)
        result = self.enqueue_many_prepared([event])
        return result.first_sequence_id

    def enqueue_many_prepared(self, events: list[PreparedQueuedEvent]) -> EnqueueBatchResult:
        if not events:
            return EnqueueBatchResult(inserted=0, dropped=0)
        with self._lock:
            oversized = [event for event in events if event.body_size_bytes > self.max_event_bytes]
            eligible = [event for event in events if event.body_size_bytes <= self.max_event_bytes]
            dropped = len(oversized)
            message = "event exceeds async queue max_event_bytes" if oversized else None
            if eligible and not self._has_disk_space():
                dropped += len(eligible)
                eligible = []
                message = "insufficient free disk space for async queue"
            if eligible:
                try:
                    available_bytes = self._available_queue_bytes()
                except sqlite3.Error as exc:
                    raise InstantMLError(f"async queue enqueue failed: {exc}") from exc
                selected = []
                selected_bytes = 0
                for event in eligible:
                    if selected_bytes + event.body_size_bytes <= available_bytes:
                        selected.append(event)
                        selected_bytes += event.body_size_bytes
                    else:
                        dropped += len(eligible) - len(selected)
                        message = "async queue byte limit reached"
                        break
                eligible = selected
            if not eligible:
                if dropped:
                    self.increment_counter("dropped", dropped)
                return EnqueueBatchResult(inserted=0, dropped=dropped, message=message)
            try:
                conn = self._connect()
                conn.executemany(
                    """
                    insert into events (
                      created_at, updated_at, method, path, body_json, body_size_bytes,
                      idempotency_key, status, next_attempt_at
                    ) values (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
                    """,
                    [
                        (
                            event.created_at,
                            event.created_at,
                            event.method,
                            event.path,
                            event.body_json,
                            event.body_size_bytes,
                            event.idempotency_key,
                            event.created_at,
                        )
                        for event in eligible
                    ],
                )
                if dropped:
                    self._increment_counter_uncommitted(conn, "dropped", dropped)
                inserted_bytes = sum(event.body_size_bytes for event in eligible)
                self._increment_counter_uncommitted(conn, QUEUED_BYTES_COUNTER, inserted_bytes)
                last_row = conn.execute("select last_insert_rowid()").fetchone()
                conn.commit()
                last_sequence_id = int(last_row[0]) if last_row and last_row[0] is not None else None
                first_sequence_id = None
                if last_sequence_id is not None:
                    first_sequence_id = last_sequence_id - len(eligible) + 1
                return EnqueueBatchResult(
                    inserted=len(eligible),
                    dropped=dropped,
                    first_sequence_id=first_sequence_id,
                    last_sequence_id=last_sequence_id,
                    message=message,
                )
            except sqlite3.Error as exc:
                self._rollback_quietly()
                raise InstantMLError(f"async queue enqueue failed: {exc}") from exc

    def claim_batch(
        self,
        lease_token: str,
        max_batch_bytes: int,
        max_event_bytes: int,
        lease_seconds: float,
    ) -> list[QueuedEvent]:
        with self._lock:
            now = time.time()
            conn = self._connect()
            rows = conn.execute(
                """
                select sequence_id, method, path, body_json, body_size_bytes, idempotency_key, status, next_attempt_at, attempts
                from events
                where status in ('pending', 'in_flight')
                order by sequence_id asc
                limit 256
                """
            ).fetchall()
            selected = []
            total = 0
            for row in rows:
                if str(row["status"]) != "pending" or float(row["next_attempt_at"]) > now:
                    break
                size = int(row["body_size_bytes"])
                if not selected:
                    selected.append(row)
                    total += size
                    continue
                if total + size <= max_batch_bytes:
                    selected.append(row)
                    total += size
                    continue
                break
            if not selected:
                return []
            sequence_ids = [int(row["sequence_id"]) for row in selected]
            placeholders = ",".join("?" for _ in sequence_ids)
            conn.execute(
                f"""
                update events
                set status = 'in_flight',
                    lease_token = ?,
                    leased_until = ?,
                    updated_at = ?
                where sequence_id in ({placeholders})
                """,
                (lease_token, now + lease_seconds, now, *sequence_ids),
            )
            conn.commit()
            return [
                QueuedEvent(
                    sequence_id=int(row["sequence_id"]),
                    method=str(row["method"]),
                    path=str(row["path"]),
                    body=json.loads(str(row["body_json"])),
                    body_size_bytes=int(row["body_size_bytes"]),
                    idempotency_key=str(row["idempotency_key"] or ""),
                    attempts=int(row["attempts"] or 0),
                )
                for row in selected
            ]

    def recover_stale_leases(self) -> int:
        with self._lock:
            now = time.time()
            conn = self._connect()
            cursor = conn.execute(
                """
                update events
                set status = 'pending',
                    lease_token = null,
                    leased_until = null,
                    updated_at = ?
                where status = 'in_flight' and leased_until is not null and leased_until < ?
                """,
                (now, now),
            )
            conn.commit()
            return int(cursor.rowcount or 0)

    def mark_processed(self, sequence_id: int) -> None:
        self.mark_processed_many([sequence_id])

    def mark_processed_many(self, sequence_ids: list[int]) -> None:
        """Mark many events processed in a single UPDATE + commit (D1/D4)."""
        if not sequence_ids:
            return
        with self._lock:
            now = time.time()
            conn = self._connect()
            placeholders = ",".join("?" for _ in sequence_ids)
            freed = self._non_processed_bytes(conn, sequence_ids)
            conn.execute(
                f"""
                update events
                set status = 'processed',
                    updated_at = ?,
                    lease_token = null,
                    leased_until = null,
                    last_error = null,
                    last_error_code = null,
                    last_http_status = null
                where sequence_id in ({placeholders})
                """,
                (now, *sequence_ids),
            )
            if freed:
                self._increment_counter_uncommitted(conn, QUEUED_BYTES_COUNTER, -freed)
            conn.commit()

    def release_events(self, sequence_ids: list[int]) -> None:
        if not sequence_ids:
            return
        with self._lock:
            now = time.time()
            placeholders = ",".join("?" for _ in sequence_ids)
            conn = self._connect()
            conn.execute(
                f"""
                update events
                set status = 'pending',
                    lease_token = null,
                    leased_until = null,
                    updated_at = ?
                where sequence_id in ({placeholders}) and status = 'in_flight'
                """,
                (now, *sequence_ids),
            )
            conn.commit()

    def mark_retry(
        self,
        sequence_id: int,
        message: str,
        code: str | None = None,
        http_status: int | None = None,
        retry_after: float | None = None,
        known_attempts: int | None = None,
    ) -> None:
        # Reuse the ``attempts`` value already fetched by ``claim_batch`` when
        # the caller has it (D4); only SELECT as a fallback.
        if known_attempts is None:
            row = self._connect().execute("select attempts from events where sequence_id = ?", (sequence_id,)).fetchone()
            known_attempts = int(row["attempts"] if row else 0)
        self._apply_retry([sequence_id], message, code, http_status, retry_after, known_attempts)

    def mark_retry_many(
        self,
        sequence_ids: list[int],
        message: str,
        code: str | None = None,
        http_status: int | None = None,
        retry_after: float | None = None,
        known_attempts: int = 0,
    ) -> None:
        """Retry a whole batch of events with one UPDATE + commit (D1)."""
        if not sequence_ids:
            return
        self._apply_retry(sequence_ids, message, code, http_status, retry_after, known_attempts)

    def _apply_retry(
        self,
        sequence_ids: list[int],
        message: str,
        code: str | None,
        http_status: int | None,
        retry_after: float | None,
        known_attempts: int,
    ) -> None:
        with self._lock:
            attempts = known_attempts + 1
            delay = _retry_delay(attempts, retry_after=retry_after)
            now = time.time()
            conn = self._connect()
            placeholders = ",".join("?" for _ in sequence_ids)
            conn.execute(
                f"""
                update events
                set status = 'pending',
                    attempts = ?,
                    last_attempt_at = ?,
                    next_attempt_at = ?,
                    lease_token = null,
                    leased_until = null,
                    updated_at = ?,
                    last_error = ?,
                    last_error_code = ?,
                    last_http_status = ?
                where sequence_id in ({placeholders})
                """,
                (attempts, now, now + delay, now, message, code, http_status, *sequence_ids),
            )
            self._save_error(conn, sequence_ids[0], "retryable", message)
            conn.commit()

    def mark_failed(self, sequence_id: int, message: str, code: str | None = None, http_status: int | None = None) -> None:
        self.mark_failed_many([sequence_id], message, code=code, http_status=http_status)

    def mark_failed_many(
        self, sequence_ids: list[int], message: str, code: str | None = None, http_status: int | None = None
    ) -> None:
        if not sequence_ids:
            return
        with self._lock:
            now = time.time()
            conn = self._connect()
            placeholders = ",".join("?" for _ in sequence_ids)
            conn.execute(
                f"""
                update events
                set status = 'failed',
                    last_attempt_at = ?,
                    lease_token = null,
                    leased_until = null,
                    updated_at = ?,
                    last_error = ?,
                    last_error_code = ?,
                    last_http_status = ?
                where sequence_id in ({placeholders})
                """,
                (now, now, message, code, http_status, *sequence_ids),
            )
            self._save_error(conn, sequence_ids[0], "failed", message)
            conn.commit()

    def status(self) -> dict[str, Any]:
        with self._lock:
            conn = self._connect()
            rows = conn.execute("select status, count(*) as count from events group by status").fetchall()
            counts = {str(row["status"]): int(row["count"]) for row in rows}
            oldest = conn.execute(
                "select created_at from events where status in ('pending', 'in_flight') order by sequence_id asc limit 1"
            ).fetchone()
            last_error = conn.execute("select message from errors order by id desc limit 1").fetchone()
            dropped = self.counter("dropped")
            age = None
            if oldest:
                age = max(0.0, time.time() - float(oldest["created_at"]))
            return {
                "pending": counts.get("pending", 0),
                "in_flight": counts.get("in_flight", 0),
                "processed": counts.get("processed", 0),
                "failed": counts.get("failed", 0),
                "dropped": dropped,
                "oldest_pending_age_seconds": age,
                "last_error": str(last_error["message"]) if last_error else None,
                "disk_usage_bytes": self._queue_file_size_bytes(),
            }

    def has_pending(self) -> bool:
        with self._lock:
            row = self._connect().execute(
                "select 1 from events where status in ('pending', 'in_flight') limit 1"
            ).fetchone()
            return row is not None

    def has_failed(self) -> bool:
        with self._lock:
            row = self._connect().execute("select 1 from events where status = 'failed' limit 1").fetchone()
            return row is not None

    def has_claimable(self) -> bool:
        with self._lock:
            now = time.time()
            row = self._connect().execute(
                """
                select status, next_attempt_at
                from events
                where status in ('pending', 'in_flight')
                order by sequence_id asc
                limit 1
                """
            ).fetchone()
            if row is None:
                return False
            return str(row["status"]) == "pending" and float(row["next_attempt_at"]) <= now

    def increment_counter(self, key: str, amount: int = 1) -> None:
        with self._lock:
            conn = self._connect()
            self._increment_counter_uncommitted(conn, key, amount)
            conn.commit()

    def counter(self, key: str) -> int:
        with self._lock:
            row = self._connect().execute("select value from counters where key = ?", (key,)).fetchone()
            return int(row["value"]) if row else 0

    def prune_processed(self) -> None:
        with self._lock:
            conn = self._connect()
            conn.execute(
                """
                delete from events
                where status = 'processed'
                  and sequence_id not in (
                    select sequence_id from events
                    where status = 'processed'
                    order by sequence_id desc
                    limit ?
                  )
                """,
                (self.processed_retention,),
            )
            self._prune_errors(conn)
            conn.commit()
            self._checkpoint_wal_throttled()

    def close(self) -> None:
        with self._lock:
            if self._connection is not None:
                self._checkpoint_wal()
                self._connection.close()
                self._connection = None

    def _reset_after_fork(self) -> None:
        # In a forked child, drop the inherited connection reference without
        # closing it — the underlying fd is shared with the parent and closing
        # it (or writing through it) corrupts the WAL. A fresh connection is
        # opened lazily on next use via ``_connect``.
        self._lock = threading.RLock()
        self._connection = None

    def _connect(self) -> sqlite3.Connection:
        with self._lock:
            if self._connection is None:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                self._harden_file_permissions()
                if not self.path.exists():
                    fd = os.open(self.path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
                    os.close(fd)
                self._connection = sqlite3.connect(self.path, timeout=self._timeout, check_same_thread=False)
                self._connection.row_factory = sqlite3.Row
                self._connection.execute("pragma journal_mode=wal")
                self._connection.execute("pragma synchronous=normal")
                self._connection.execute(f"pragma busy_timeout={int(self._timeout * 1000)}")
                self._connection.execute(f"pragma journal_size_limit={DEFAULT_SQLITE_JOURNAL_SIZE_LIMIT}")
                self._harden_file_permissions()
            return self._connection

    def _queue_is_full(self, next_bytes: int) -> bool:
        with self._lock:
            try:
                available = self._available_queue_bytes()
                return next_bytes > available
            except sqlite3.Error:
                return False

    def _available_queue_bytes(self) -> int:
        # Read the maintained running counter instead of a full-table SUM on
        # every producer flush. The counter tracks bytes over non-processed
        # events and is reseeded from a real SUM at queue open (crash recovery).
        queued = self._queued_bytes()
        logical_available = self.max_queue_bytes - queued
        physical_available = self.max_queue_bytes - self._queue_file_size_bytes()
        return max(0, min(logical_available, physical_available))

    def _queued_bytes(self) -> int:
        conn = self._connect()
        row = conn.execute("select value from counters where key = ?", (QUEUED_BYTES_COUNTER,)).fetchone()
        return max(0, int(row["value"])) if row else 0

    def _reseed_queued_bytes(self, conn: sqlite3.Connection) -> None:
        """Recompute ``queued_bytes`` from a real SUM (once, at queue open).

        A crash between an insert/ack and its counter update would drift the
        running counter; reseeding on open re-establishes truth.
        """
        row = conn.execute(
            "select coalesce(sum(body_size_bytes), 0) as bytes from events where status != 'processed'"
        ).fetchone()
        actual = int(row["bytes"] if row else 0)
        conn.execute(
            """
            insert into counters (key, value) values (?, ?)
            on conflict(key) do update set value = excluded.value
            """,
            (QUEUED_BYTES_COUNTER, actual),
        )

    def _non_processed_bytes(self, conn: sqlite3.Connection, sequence_ids: list[int]) -> int:
        """Sum of body bytes for the given ids that still count toward queued_bytes.

        Used to compute the exact decrement when events transition into
        ``processed`` (already-processed rows contribute nothing, keeping the
        counter aligned with ``SUM(... where status != 'processed')``).
        Callers pass a non-empty id list.
        """
        placeholders = ",".join("?" for _ in sequence_ids)
        row = conn.execute(
            f"""
            select coalesce(sum(body_size_bytes), 0) as bytes
            from events
            where status != 'processed' and sequence_id in ({placeholders})
            """,
            tuple(sequence_ids),
        ).fetchone()
        return int(row["bytes"] if row else 0)

    def _increment_counter_uncommitted(self, conn: sqlite3.Connection, key: str, amount: int = 1) -> None:
        conn.execute(
            """
            insert into counters (key, value) values (?, ?)
            on conflict(key) do update set value = value + excluded.value
            """,
            (key, amount),
        )

    def _has_disk_space(self) -> bool:
        try:
            if hasattr(os, "statvfs"):
                usage = os.statvfs(self.path.parent)
                return usage.f_bavail * usage.f_frsize >= self.min_free_disk_bytes
            usage = shutil.disk_usage(self.path.parent)
            return usage.free >= self.min_free_disk_bytes
        except (AttributeError, OSError):
            return True

    def _save_error(self, conn: sqlite3.Connection, sequence_id: int, error_type: str, message: str) -> None:
        conn.execute(
            "insert into errors (sequence_id, created_at, error_type, message) values (?, ?, ?, ?)",
            (sequence_id, time.time(), error_type, message[:1000]),
        )
        self._prune_errors(conn)

    def _prune_errors(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            delete from errors
            where id not in (
              select id from errors
              order by id desc
              limit ?
            )
            """,
            (self.error_retention,),
        )

    def _queue_file_size_bytes(self) -> int:
        total = 0
        for path in (self.path, self.path.with_name(self.path.name + "-wal"), self.path.with_name(self.path.name + "-shm")):
            try:
                total += path.stat().st_size
            except OSError:
                pass
        return total

    def _harden_file_permissions(self) -> None:
        try:
            self.path.parent.chmod(0o700)
        except OSError:
            pass
        for path in (self.path, self.path.with_name(self.path.name + "-wal"), self.path.with_name(self.path.name + "-shm")):
            try:
                if path.exists():
                    path.chmod(0o600)
            except OSError:
                pass

    def _checkpoint_wal(self) -> None:
        if self._connection is None:
            return
        try:
            self._connection.execute("pragma wal_checkpoint(truncate)")
        except (AttributeError, sqlite3.Error):
            pass
        self._last_checkpoint_at = time.time()

    def _checkpoint_wal_throttled(self) -> None:
        # Truncating the WAL on every productive drain cycle bounds throughput
        # to the checkpoint rate; run it at most once per interval (D4).
        if time.time() - self._last_checkpoint_at < DEFAULT_WAL_CHECKPOINT_INTERVAL_SECONDS:
            return
        self._checkpoint_wal()

    def _rollback_quietly(self) -> None:
        with self._lock:
            try:
                if self._connection is not None:
                    self._connection.rollback()
            except sqlite3.Error:
                pass


class QueueLock:
    def __init__(self, queue_path: Path) -> None:
        self.path = queue_path.with_suffix(queue_path.suffix + ".lock")
        self._fd: int | None = None

    def __enter__(self) -> "QueueLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self._fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(self._fd, str(os.getpid()).encode("ascii"))
        except FileExistsError as exc:
            if self._remove_stale_lock():
                return self.__enter__()
            raise InstantMLError(f"async queue uploader is already running for {self.path.parent}") from exc
        finally:
            if self._fd is not None:
                os.close(self._fd)
                self._fd = None
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass

    def _remove_stale_lock(self) -> bool:
        try:
            raw = self.path.read_text(encoding="ascii").strip()
            pid = int(raw)
        except (OSError, ValueError):
            return self._remove_invalid_stale_lock()
        if _pid_is_running(pid):
            return False
        return self._unlink_lock()

    def _remove_invalid_stale_lock(self) -> bool:
        try:
            age_seconds = time.time() - self.path.stat().st_mtime
        except OSError:
            return False
        if age_seconds < DEFAULT_LOCK_STALE_SECONDS:
            return False
        return self._unlink_lock()

    def _unlink_lock(self) -> bool:
        try:
            self.path.unlink()
            return True
        except OSError:
            return False


def _send_health(repository: AsyncQueueRepository, base_url: str, api_key: str | None, timeout: float, run_id: str) -> None:
    status = repository.status()
    now = time.time()
    lag = status["oldest_pending_age_seconds"] or 0.0
    metrics = {
        f"{ASYNC_HEALTH_PREFIX}upload_health_unix_seconds": now,
        f"{ASYNC_HEALTH_PREFIX}upload_lag_seconds": lag,
        f"{ASYNC_HEALTH_PREFIX}queued_events": float(status["pending"] + status["in_flight"]),
        f"{ASYNC_HEALTH_PREFIX}processed_events": float(status["processed"]),
        f"{ASYNC_HEALTH_PREFIX}failed_events": float(status["failed"]),
        f"{ASYNC_HEALTH_PREFIX}dropped_events": float(status["dropped"]),
    }
    _send_request(
        base_url=base_url,
        api_key=api_key,
        timeout=timeout,
        method="POST",
        path=f"/runs/{run_id}/metrics",
        body={"metrics": metrics, "step": now, "timestamp": _utc_timestamp()},
        idempotency_key=f"instantml-health-{run_id}-{int(now // DEFAULT_HEALTH_INTERVAL_SECONDS)}",
    )


def _send_request(
    base_url: str,
    api_key: str | None,
    timeout: float,
    method: str,
    path: str,
    body: dict[str, Any],
    idempotency_key: str | None = None,
) -> DeliveryResult:
    url = base_url.rstrip("/") + path
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    request = urllib.request.Request(
        url,
        data=json.dumps(body, separators=(",", ":")).encode("utf-8"),
        method=method,
        headers=headers,
    )
    try:
        with _http_pool.urlopen(request, timeout=timeout) as response:
            response.read()
        return DeliveryResult(ok=True, retryable=False)
    except urllib.error.HTTPError as exc:
        message, code = _decode_http_error(exc)
        status = int(exc.code)
        retry_after = _retry_after(exc)
        retryable = _is_retryable_response(status, code)
        return DeliveryResult(ok=False, retryable=retryable, message=message, status=status, code=code, retry_after=retry_after)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return DeliveryResult(ok=False, retryable=True, message=str(exc), code="network_error")


def _send_batch_request(
    base_url: str,
    api_key: str | None,
    timeout: float,
    run_id: str,
    events: list["QueuedEvent"],
) -> DeliveryResult:
    """POST a group of metric events to ``/runs/{run_id}/metrics/batch``.

    Wire format: ``{"points": [{"metrics": {...}, "step": <number>,
    "timestamp": "<ISO8601, optional>"}, ...]}`` with one deterministic
    ``Idempotency-Key`` derived from the member event keys so retried batches
    reuse the key.
    """
    points = [_batch_point(event.body) for event in events]
    idempotency_key = _batch_idempotency_key(events)
    return _send_request(
        base_url=base_url,
        api_key=api_key,
        timeout=timeout,
        method="POST",
        path=f"/runs/{run_id}/metrics/batch",
        body={"points": points},
        idempotency_key=idempotency_key,
    )


def _batch_point(body: dict[str, Any]) -> dict[str, Any]:
    point: dict[str, Any] = {"metrics": body.get("metrics", {}), "step": body.get("step")}
    timestamp = body.get("timestamp")
    if timestamp is not None:
        point["timestamp"] = timestamp
    return point


def _batch_idempotency_key(events: list["QueuedEvent"]) -> str:
    """Deterministic per-batch key: sha256 over the sorted member keys.

    Retried batches with the same members produce the same key so the server
    dedups them.
    """
    member_keys = sorted(event.idempotency_key for event in events)
    digest = hashlib.sha256("\n".join(member_keys).encode("utf-8")).hexdigest()
    return f"instantml-batch-{digest}"


def _decode_http_error(exc: urllib.error.HTTPError) -> tuple[str, str | None]:
    try:
        payload = exc.read().decode("utf-8")
        decoded = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return str(exc), None
    if isinstance(decoded, dict):
        message = decoded.get("error") if isinstance(decoded.get("error"), str) else str(exc)
        code = decoded.get("code") if isinstance(decoded.get("code"), str) else None
        return message, code
    return str(exc), None


def _is_retryable_response(status: int, code: str | None) -> bool:
    if code in _TERMINAL_CODES:
        return False
    if status in {401, 403, 400, 402}:
        return False
    if status == 429:
        return code in {None, "rate_limit_exceeded"}
    return status in _RETRYABLE_HTTP_STATUSES


def _retry_after(exc: urllib.error.HTTPError) -> float | None:
    raw = exc.headers.get("Retry-After") if exc.headers else None
    if not raw:
        return None
    try:
        seconds = float(raw)
    except (TypeError, ValueError):
        return None
    return seconds if math.isfinite(seconds) and seconds > 0 else None


def _retry_delay(attempts: int, retry_after: float | None = None) -> float:
    if retry_after is not None:
        return min(retry_after, 60.0)
    base = min(60.0, 0.5 * (2 ** max(0, attempts - 1)))
    jitter = random.uniform(0.0, min(1.0, base * 0.2))
    return base + jitter


def _parent_is_running(parent_pid: int) -> bool:
    if parent_pid <= 0:
        return True
    return os.getppid() == parent_pid


def _pid_is_running(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _safe_path_segment(value: str) -> str:
    safe = "".join(char if char.isalnum() or char in {"-", "_", "."} else "_" for char in value)
    return (safe or "run")[:120]


def _utc_timestamp() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()
