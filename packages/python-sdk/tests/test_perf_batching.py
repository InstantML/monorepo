"""Tests for the SDK performance changes: HTTP connection pool, batched metric
delivery, queue byte accounting, batched acks, spool JSONL segments, and the
system-metrics sampler state."""

from __future__ import annotations

import gzip
import http.client
import io
import json
import time
import urllib.error
import urllib.request

import pytest

import instantml._http_pool as http_pool
import instantml.async_queue as async_queue
import instantml.client as client_module
import instantml.uploader as uploader
from instantml.async_queue import (
    AsyncQueueRepository,
    DeliveryResult,
    QUEUED_BYTES_COUNTER,
    QueuedEvent,
    _batch_idempotency_key,
    _consecutive_metric_group,
    _metric_run_id,
    drain_queue_once,
)


# --------------------------------------------------------------------------- #
# HTTP connection pool (_http_pool)
# --------------------------------------------------------------------------- #


class _FakeHTTPResponse:
    def __init__(self, status=200, reason="OK", body=b"{}", headers=None, will_close=False):
        self.status = status
        self.reason = reason
        self._body = body
        self.headers = headers or {}
        self.will_close = will_close

    def read(self):
        return self._body


class _FakeConnection:
    instances: list["_FakeConnection"] = []

    def __init__(self, host, port, timeout=None):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.sock = type("_Sock", (), {"settimeout": lambda self, t: None})()
        self.requests: list[tuple] = []
        self.closed = False
        self.response = _FakeHTTPResponse()
        self.raise_on_request: Exception | None = None
        _FakeConnection.instances.append(self)

    def request(self, method, selector, body=None, headers=None):
        self.requests.append((method, selector, body, headers))
        if self.raise_on_request is not None:
            raise self.raise_on_request

    def getresponse(self):
        return self.response

    def close(self):
        self.closed = True


@pytest.fixture()
def fake_pool(monkeypatch):
    _FakeConnection.instances = []
    monkeypatch.setattr(http_pool.http.client, "HTTPSConnection", _FakeConnection)
    monkeypatch.setattr(http_pool.http.client, "HTTPConnection", _FakeConnection)
    monkeypatch.setattr(http_pool, "_proxied", lambda scheme, host: False)
    pool = http_pool._ConnectionPool()
    yield pool
    pool.close_all()


def _post(url="https://api.test/runs/run-1/metrics", body=b'{"metrics":{"a":1}}', headers=None):
    return urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers=headers or {"Content-Type": "application/json"},
    )


def test_pool_reuses_connection_across_calls(fake_pool):
    fake_pool.urlopen(_post(), timeout=1.0)
    fake_pool.urlopen(_post(), timeout=1.0)
    # A single connection was opened and reused (released after each call).
    assert len(_FakeConnection.instances) == 1
    assert len(_FakeConnection.instances[0].requests) == 2


def test_pool_maps_http_error(fake_pool):
    _FakeConnection.instances = []
    conn = _FakeConnection("api.test", 443)
    conn.response = _FakeHTTPResponse(status=503, reason="busy", body=b"nope")
    # Prime the idle pool so the next acquire reuses this connection.
    fake_pool._release(("https", "api.test", 443), conn)
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        fake_pool.urlopen(_post(), timeout=1.0)
    assert excinfo.value.code == 503


def test_pool_wraps_httpexception_as_urlerror(fake_pool, monkeypatch):
    # A fresh (non-reused) connection whose request raises HTTPException is
    # surfaced as URLError.
    def make_broken(host, port, timeout=None):
        conn = _FakeConnection(host, port, timeout)
        conn.raise_on_request = http.client.HTTPException("broken")
        return conn

    monkeypatch.setattr(http_pool.http.client, "HTTPSConnection", make_broken)
    with pytest.raises(urllib.error.URLError):
        fake_pool.urlopen(_post(), timeout=1.0)


def test_pool_retries_dead_keepalive_once(fake_pool):
    key = ("https", "api.test", 443)
    dead = _FakeConnection("api.test", 443)
    dead.raise_on_request = ConnectionError("reset by peer")
    fake_pool._release(key, dead)
    # The reused (dead) connection fails once; a fresh connection then succeeds.
    result = fake_pool.urlopen(_post(), timeout=1.0)
    assert result.status == 200
    assert dead.closed


def test_pool_will_close_response_closes_connection(fake_pool):
    _FakeConnection.instances = []
    fake_pool.urlopen(_post(), timeout=1.0)
    conn = _FakeConnection.instances[0]
    conn.response = _FakeHTTPResponse(will_close=True)
    fake_pool.urlopen(_post(), timeout=1.0)
    assert conn.closed


def test_pool_gzips_large_json_body_and_falls_back(fake_pool, monkeypatch):
    monkeypatch.setattr(http_pool, "_gzip_disabled", False)
    big = json.dumps({"metrics": {"k": "v" * 4000}}).encode("utf-8")
    _FakeConnection.instances = []
    conn = _FakeConnection("api.test", 443)
    # First response rejects gzip (415); pool must resend uncompressed.
    responses = [_FakeHTTPResponse(status=415, reason="no gzip"), _FakeHTTPResponse(status=200)]

    def getresponse():
        return responses.pop(0)

    conn.getresponse = getresponse
    fake_pool._release(("https", "api.test", 443), conn)
    result = fake_pool.urlopen(_post(body=big), timeout=1.0)
    assert result.status == 200
    # The first attempt was gzip-compressed, the retry was not.
    first_headers = conn.requests[0][3]
    assert first_headers.get("Content-Encoding") == "gzip"
    assert gzip.decompress(conn.requests[0][2]) == big
    assert "Content-Encoding" not in conn.requests[1][3]
    assert http_pool._gzip_disabled is True


def test_pool_httpexception_during_uncompressed_retry(fake_pool, monkeypatch):
    monkeypatch.setattr(http_pool, "_gzip_disabled", False)
    big = json.dumps({"metrics": {"k": "v" * 4000}}).encode("utf-8")

    def make_conn(host, port, timeout=None):
        conn = _FakeConnection(host, port, timeout)
        # gzip attempt returns 415; the uncompressed retry raises HTTPException.
        responses = iter([_FakeHTTPResponse(status=415)])

        def getresponse():
            return next(responses)

        def request(method, selector, body=None, headers=None):
            conn.requests.append((method, selector, body, headers))
            if headers is not None and "Content-Encoding" not in headers:
                raise http.client.HTTPException("retry blew up")

        conn.getresponse = getresponse
        conn.request = request
        return conn

    monkeypatch.setattr(http_pool.http.client, "HTTPSConnection", make_conn)
    with pytest.raises(urllib.error.URLError):
        fake_pool.urlopen(_post(body=big), timeout=1.0)


def test_pool_read_oserror_closes_connection(fake_pool, monkeypatch):
    def make_conn(host, port, timeout=None):
        conn = _FakeConnection(host, port, timeout)

        class Resp:
            status = 200
            reason = "OK"
            headers = {}
            will_close = False

            def read(self):
                raise OSError("read failed")

        conn.response = Resp()
        return conn

    monkeypatch.setattr(http_pool.http.client, "HTTPSConnection", make_conn)
    with pytest.raises(OSError):
        fake_pool.urlopen(_post(), timeout=1.0)


def test_pool_keepalive_retry_fresh_also_fails(fake_pool, monkeypatch):
    key = ("https", "api.test", 443)
    dead = _FakeConnection("api.test", 443)
    dead.raise_on_request = ConnectionError("reset")
    fake_pool._release(key, dead)

    def make_broken(host, port, timeout=None):
        conn = _FakeConnection(host, port, timeout)
        conn.raise_on_request = ConnectionError("still dead")
        return conn

    monkeypatch.setattr(http_pool.http.client, "HTTPSConnection", make_broken)
    with pytest.raises(ConnectionError):
        fake_pool.urlopen(_post(), timeout=1.0)


def test_pool_skips_gzip_when_content_encoding_present(fake_pool, monkeypatch):
    monkeypatch.setattr(http_pool, "_gzip_disabled", False)
    _FakeConnection.instances = []
    big = json.dumps({"metrics": {"k": "v" * 4000}}).encode("utf-8")
    headers = {"Content-Type": "application/json", "Content-Encoding": "identity"}
    fake_pool.urlopen(_post(body=big, headers=headers), timeout=1.0)
    # Already-encoded bodies are left untouched.
    assert _FakeConnection.instances[0].requests[0][2] == big


def test_pool_skips_gzip_for_small_or_non_json(fake_pool, monkeypatch):
    monkeypatch.setattr(http_pool, "_gzip_disabled", False)
    _FakeConnection.instances = []
    fake_pool.urlopen(_post(body=b"tiny"), timeout=1.0)
    assert "Content-Encoding" not in _FakeConnection.instances[0].requests[0][3]


def test_pool_rejects_unsupported_url(fake_pool):
    with pytest.raises(urllib.error.URLError):
        fake_pool.urlopen(urllib.request.Request("ftp://host/x", method="GET"), timeout=1.0)


def test_pool_proxy_passthrough(monkeypatch):
    monkeypatch.setattr(http_pool, "_proxied", lambda scheme, host: True)

    class _Resp:
        status = 200
        reason = "OK"
        headers = {}

        def read(self):
            return b"{}"

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

    monkeypatch.setattr(http_pool.urllib.request, "urlopen", lambda request, timeout: _Resp())
    pool = http_pool._ConnectionPool()
    result = pool.urlopen(_post(), timeout=1.0)
    assert result.status == 200


def test_pool_idle_cap_closes_surplus(fake_pool):
    key = ("https", "api.test", 443)
    conns = [_FakeConnection("api.test", 443) for _ in range(http_pool._MAX_IDLE_PER_HOST + 1)]
    for conn in conns:
        fake_pool._release(key, conn)
    # The surplus connection beyond the idle cap is closed immediately.
    assert conns[-1].closed


def test_module_level_urlopen_uses_shared_pool(monkeypatch):
    _FakeConnection.instances = []
    monkeypatch.setattr(http_pool.http.client, "HTTPSConnection", _FakeConnection)
    monkeypatch.setattr(http_pool, "_proxied", lambda scheme, host: False)
    result = http_pool.urlopen(_post(), timeout=1.0)
    assert result.status == 200
    http_pool._POOL.close_all()


def test_proxied_helper(monkeypatch):
    monkeypatch.setattr(http_pool.urllib.request, "getproxies", lambda: {})
    assert http_pool._proxied("https", "api.test") is False
    monkeypatch.setattr(http_pool.urllib.request, "getproxies", lambda: {"https": "http://proxy"})
    monkeypatch.setattr(http_pool.urllib.request, "proxy_bypass", lambda host: True)
    assert http_pool._proxied("https", "api.test") is False
    monkeypatch.setattr(http_pool.urllib.request, "proxy_bypass", lambda host: False)
    assert http_pool._proxied("https", "api.test") is True


# --------------------------------------------------------------------------- #
# Batched metric delivery (D1)
# --------------------------------------------------------------------------- #


@pytest.fixture(autouse=True)
def _reset_batch_flag(monkeypatch):
    monkeypatch.setattr(async_queue, "_batch_unsupported", False)


def _enqueue_metric(repo, run_id, step, key="event"):
    repo.enqueue(
        "POST",
        f"/runs/{run_id}/metrics",
        {"metrics": {"reward": step}, "step": step, "timestamp": "2026-07-04T00:00:00Z"},
        idempotency_key=f"{key}-{step}",
    )


def test_consecutive_same_run_group_is_batched(monkeypatch, tmp_path):
    repo = AsyncQueueRepository(tmp_path / "queue.sqlite3")
    repo.init_db()
    for step in range(3):
        _enqueue_metric(repo, "run-1", step)
    batch_calls = []

    def fake_send_request(**kwargs):
        batch_calls.append(kwargs)
        return DeliveryResult(ok=True, retryable=False)

    monkeypatch.setattr(async_queue, "_send_request", fake_send_request)
    assert drain_queue_once(repo, base_url="http://x.test") == 3
    # Exactly one batch request delivered all three points.
    assert len(batch_calls) == 1
    assert batch_calls[0]["path"] == "/runs/run-1/metrics/batch"
    assert len(batch_calls[0]["body"]["points"]) == 3
    assert [p["step"] for p in batch_calls[0]["body"]["points"]] == [0, 1, 2]
    assert repo.status()["processed"] == 3


def test_cross_run_events_split_into_separate_deliveries(monkeypatch, tmp_path):
    repo = AsyncQueueRepository(tmp_path / "queue.sqlite3")
    repo.init_db()
    _enqueue_metric(repo, "run-1", 1)
    _enqueue_metric(repo, "run-1", 2)
    _enqueue_metric(repo, "run-2", 3)
    paths = []

    def fake_send_request(**kwargs):
        paths.append(kwargs["path"])
        return DeliveryResult(ok=True, retryable=False)

    monkeypatch.setattr(async_queue, "_send_request", fake_send_request)
    assert drain_queue_once(repo, base_url="http://x.test") == 3
    # run-1's two consecutive events batch; run-2's single event goes per-event.
    assert paths == ["/runs/run-1/metrics/batch", "/runs/run-2/metrics"]


def test_batch_respects_max_points_cap(monkeypatch, tmp_path):
    repo = AsyncQueueRepository(tmp_path / "queue.sqlite3")
    repo.init_db()
    for step in range(5):
        _enqueue_metric(repo, "run-1", step)
    sizes = []

    def fake_send_request(**kwargs):
        if kwargs["path"].endswith("/batch"):
            sizes.append(len(kwargs["body"]["points"]))
        else:
            sizes.append(1)
        return DeliveryResult(ok=True, retryable=False)

    monkeypatch.setattr(async_queue, "_send_request", fake_send_request)
    processed = drain_queue_once(repo, base_url="http://x.test", max_batch_points=2)
    assert processed == 5
    # 2 + 2 + 1 (last is a singleton → per-event path).
    assert sizes == [2, 2, 1]


def test_batch_falls_back_to_per_event_on_404(monkeypatch, tmp_path):
    repo = AsyncQueueRepository(tmp_path / "queue.sqlite3")
    repo.init_db()
    for step in range(2):
        _enqueue_metric(repo, "run-1", step)
    calls = []

    def fake_send_request(**kwargs):
        calls.append(kwargs["path"])
        if kwargs["path"].endswith("/batch"):
            return DeliveryResult(ok=False, retryable=False, message="no route", status=404)
        return DeliveryResult(ok=True, retryable=False)

    monkeypatch.setattr(async_queue, "_send_request", fake_send_request)
    assert drain_queue_once(repo, base_url="http://x.test") == 2
    # First a batch attempt (404), then the two members re-delivered per-event.
    assert calls[0] == "/runs/run-1/metrics/batch"
    assert calls[1:] == ["/runs/run-1/metrics", "/runs/run-1/metrics"]
    assert async_queue._batch_unsupported is True
    assert repo.status()["processed"] == 2


def test_batch_retry_marks_all_members_pending(monkeypatch, tmp_path):
    repo = AsyncQueueRepository(tmp_path / "queue.sqlite3")
    repo.init_db()
    for step in range(3):
        _enqueue_metric(repo, "run-1", step)
    monkeypatch.setattr(
        async_queue, "_send_request", lambda **kwargs: DeliveryResult(ok=False, retryable=True, message="503", status=503)
    )
    assert drain_queue_once(repo, base_url="http://x.test") == 0
    assert repo.status()["pending"] == 3


def test_batch_terminal_failure_marks_all_members_failed(monkeypatch, tmp_path):
    repo = AsyncQueueRepository(tmp_path / "queue.sqlite3")
    repo.init_db()
    for step in range(2):
        _enqueue_metric(repo, "run-1", step)
    monkeypatch.setattr(
        async_queue,
        "_send_request",
        lambda **kwargs: DeliveryResult(ok=False, retryable=False, message="bad", status=400, code="invalid"),
    )
    assert drain_queue_once(repo, base_url="http://x.test") == 0
    assert repo.status()["failed"] == 2


def test_deterministic_batch_idempotency_key():
    events = [
        QueuedEvent(sequence_id=2, method="POST", path="/runs/r/metrics", body={}, body_size_bytes=1, idempotency_key="b"),
        QueuedEvent(sequence_id=1, method="POST", path="/runs/r/metrics", body={}, body_size_bytes=1, idempotency_key="a"),
    ]
    key1 = _batch_idempotency_key(events)
    key2 = _batch_idempotency_key(list(reversed(events)))
    # Order-independent: same members → same key across retries.
    assert key1 == key2
    assert key1.startswith("instantml-batch-")
    other = _batch_idempotency_key(events[:1])
    assert other != key1


def test_metric_run_id_matching():
    def ev(method, path):
        return QueuedEvent(sequence_id=1, method=method, path=path, body={}, body_size_bytes=1, idempotency_key="k")

    assert _metric_run_id(ev("POST", "/runs/abc/metrics")) == "abc"
    assert _metric_run_id(ev("GET", "/runs/abc/metrics")) is None
    assert _metric_run_id(ev("POST", "/runs/abc/rank-metrics")) is None
    assert _metric_run_id(ev("POST", "/api/runs/abc/logs")) is None


def test_consecutive_group_stops_at_non_metric():
    events = [
        QueuedEvent(sequence_id=1, method="POST", path="/runs/r/metrics", body={}, body_size_bytes=1, idempotency_key="a"),
        QueuedEvent(sequence_id=2, method="POST", path="/api/runs/r/logs", body={}, body_size_bytes=1, idempotency_key="b"),
    ]
    group = _consecutive_metric_group(events, 0, max_points=500)
    assert [e.sequence_id for e in group] == [1]
    # A non-metric head yields no group.
    assert _consecutive_metric_group(list(reversed(events)), 0, max_points=500) == []


def test_oversized_member_in_group_is_skipped(monkeypatch, tmp_path):
    repo = AsyncQueueRepository(tmp_path / "queue.sqlite3", max_event_bytes=1_024)
    repo.init_db()
    repo.enqueue("POST", "/runs/run-1/metrics", {"metrics": {"blob": "x" * 200}, "step": 1}, idempotency_key="big")
    monkeypatch.setattr(async_queue, "_send_request", lambda **kwargs: pytest.fail("oversized event should not send"))
    assert drain_queue_once(repo, base_url="http://x.test", max_event_bytes=16) == 0
    assert repo.status()["failed"] == 1


# --------------------------------------------------------------------------- #
# Queue byte accounting (D3) + batched acks (D4)
# --------------------------------------------------------------------------- #


def test_queued_bytes_counter_tracks_enqueue_and_process(tmp_path):
    repo = AsyncQueueRepository(tmp_path / "queue.sqlite3")
    repo.init_db()
    ids = []
    for step in range(3):
        ids.append(
            repo.enqueue("POST", f"/runs/run-{step}/metrics", {"metrics": {"m": step}, "step": step}, idempotency_key=str(step))
        )
    counted = repo.counter(QUEUED_BYTES_COUNTER)
    assert counted == _actual_queued_bytes(repo)
    assert counted > 0
    repo.mark_processed(ids[0])
    assert repo.counter(QUEUED_BYTES_COUNTER) == _actual_queued_bytes(repo)
    repo.mark_processed_many(ids[1:])
    assert repo.counter(QUEUED_BYTES_COUNTER) == _actual_queued_bytes(repo) == 0


def test_queued_bytes_counter_unaffected_by_fail_and_retry(tmp_path):
    repo = AsyncQueueRepository(tmp_path / "queue.sqlite3")
    repo.init_db()
    a = repo.enqueue("POST", "/runs/run-1/metrics", {"metrics": {"m": 1}, "step": 1}, idempotency_key="a")
    b = repo.enqueue("POST", "/runs/run-2/metrics", {"metrics": {"m": 2}, "step": 2}, idempotency_key="b")
    before = repo.counter(QUEUED_BYTES_COUNTER)
    # failed / retried rows still count toward queued bytes (status != processed).
    repo.mark_failed(a, "boom")
    repo.mark_retry(b, "later")
    assert repo.counter(QUEUED_BYTES_COUNTER) == before == _actual_queued_bytes(repo)


def test_queued_bytes_reseeds_on_open(tmp_path):
    path = tmp_path / "queue.sqlite3"
    repo = AsyncQueueRepository(path)
    repo.init_db()
    repo.enqueue("POST", "/runs/run-1/metrics", {"metrics": {"m": 1}, "step": 1}, idempotency_key="a")
    # Corrupt the counter as if a crash drifted it, then reopen.
    repo.increment_counter(QUEUED_BYTES_COUNTER, 9999)
    repo.close()
    reopened = AsyncQueueRepository(path)
    reopened.init_db()
    assert reopened.counter(QUEUED_BYTES_COUNTER) == _actual_queued_bytes(reopened)


def test_prune_does_not_change_queued_bytes(tmp_path):
    repo = AsyncQueueRepository(tmp_path / "queue.sqlite3", processed_retention=0)
    repo.init_db()
    seq = repo.enqueue("POST", "/runs/run-1/metrics", {"metrics": {"m": 1}, "step": 1}, idempotency_key="a")
    repo.mark_processed(seq)
    assert repo.counter(QUEUED_BYTES_COUNTER) == 0
    repo.prune_processed()
    assert repo.counter(QUEUED_BYTES_COUNTER) == 0


def test_mark_processed_many_empty_is_noop(tmp_path):
    repo = AsyncQueueRepository(tmp_path / "queue.sqlite3")
    repo.init_db()
    repo.mark_processed_many([])
    repo.mark_retry_many([], "x")
    repo.mark_failed_many([], "x")


def test_mark_retry_reuses_known_attempts(tmp_path, monkeypatch):
    repo = AsyncQueueRepository(tmp_path / "queue.sqlite3")
    repo.init_db()
    seq = repo.enqueue("POST", "/runs/run-1/metrics", {"metrics": {"m": 1}, "step": 1}, idempotency_key="a")
    seen = {}

    real = async_queue._retry_delay

    def spy(attempts, retry_after=None):
        seen["attempts"] = attempts
        return real(attempts, retry_after=retry_after)

    monkeypatch.setattr(async_queue, "_retry_delay", spy)
    repo.mark_retry(seq, "later", known_attempts=4)
    assert seen["attempts"] == 5


def _actual_queued_bytes(repo):
    conn = repo._connect()
    row = conn.execute(
        "select coalesce(sum(body_size_bytes), 0) as bytes from events where status != 'processed'"
    ).fetchone()
    return int(row["bytes"])


# --------------------------------------------------------------------------- #
# WAL checkpoint throttle (D4)
# --------------------------------------------------------------------------- #


def test_wal_checkpoint_throttled(tmp_path, monkeypatch):
    repo = AsyncQueueRepository(tmp_path / "queue.sqlite3")
    repo.init_db()
    calls = {"n": 0}
    monkeypatch.setattr(repo, "_checkpoint_wal", lambda: calls.__setitem__("n", calls["n"] + 1))
    repo._last_checkpoint_at = time.time()
    repo._checkpoint_wal_throttled()  # within interval → skipped
    assert calls["n"] == 0
    repo._last_checkpoint_at = time.time() - 60
    repo._checkpoint_wal_throttled()  # past interval → runs
    assert calls["n"] == 1


# --------------------------------------------------------------------------- #
# Spool JSONL segment writer (D6)
# --------------------------------------------------------------------------- #


def test_spool_segment_writer_appends_and_finalizes(tmp_path):
    writer = client_module._SpoolSegmentWriter(tmp_path / "run-1")
    for step in range(3):
        writer.append({"sequence": step, "event_id": f"e{step}"}, json.dumps({"sequence": step}))
    # Not visible until finalize (active segment is a dotfile temp).
    assert not list((tmp_path / "run-1").glob("*.jsonl"))
    writer.finalize()
    segments = list((tmp_path / "run-1").glob("*.jsonl"))
    assert len(segments) == 1
    lines = segments[0].read_text(encoding="utf-8").splitlines()
    assert len(lines) == 3


def test_spool_segment_writer_rotates_on_event_threshold(tmp_path, monkeypatch):
    monkeypatch.setattr(client_module, "_SPOOL_SEGMENT_ROTATE_EVENTS", 2)
    writer = client_module._SpoolSegmentWriter(tmp_path / "run-1")
    for step in range(5):
        writer.append({"sequence": step, "event_id": f"e{step}"}, json.dumps({"sequence": step}))
    writer.finalize()
    segments = sorted((tmp_path / "run-1").glob("*.jsonl"))
    # 2 + 2 rotated segments + 1 finalized remainder.
    assert len(segments) == 3


def test_spool_segment_writer_fsyncs_on_time(tmp_path, monkeypatch):
    monkeypatch.setattr(client_module, "_SPOOL_SEGMENT_FSYNC_SECONDS", 0.0)
    writer = client_module._SpoolSegmentWriter(tmp_path / "run-1")
    fsyncs = {"n": 0}
    real_fsync = client_module.os.fsync
    monkeypatch.setattr(client_module.os, "fsync", lambda fd: fsyncs.__setitem__("n", fsyncs["n"] + 1) or real_fsync(fd))
    writer.append({"sequence": 0, "event_id": "e0"}, "{}")
    assert fsyncs["n"] >= 1
    writer.finalize()


def test_spool_finalize_noop_when_no_segment(tmp_path):
    writer = client_module._SpoolSegmentWriter(tmp_path / "run-1")
    writer.finalize()  # nothing opened yet
    assert not list((tmp_path / "run-1").glob("*.jsonl"))


def test_spool_segment_fsync_noop_without_handle(tmp_path):
    writer = client_module._SpoolSegmentWriter(tmp_path / "run-1")
    writer._fsync()  # no active handle → early return, does not raise


# --------------------------------------------------------------------------- #
# Uploader consumer: JSONL + remainder rewrite (D6)
# --------------------------------------------------------------------------- #


def test_uploader_reads_jsonl_segment(tmp_path):
    calls = []

    class FakeClient:
        def _request(self, method, path, body):
            calls.append(path)
            return {}

    run_dir = tmp_path / "run-1"
    run_dir.mkdir(parents=True)
    events = [
        {"event_id": f"e{i}", "requests": [{"method": "POST", "path": "/runs/run-1/metrics", "body": {"metrics": {}, "step": i}}]}
        for i in range(3)
    ]
    # A blank line between events is tolerated by the reader.
    (run_dir / "segment-0000000001-x.jsonl").write_text(
        "\n".join(json.dumps(e) for e in events) + "\n\n", encoding="utf-8"
    )
    assert uploader.drain_spool(str(tmp_path), client=FakeClient()) == 3
    assert calls == ["/runs/run-1/metrics"] * 3
    assert not list(run_dir.glob("*.jsonl"))


def test_uploader_max_events_returns_between_segments(tmp_path):
    class FakeClient:
        def _request(self, method, path, body):
            return {}

    run_dir = tmp_path / "run-1"
    run_dir.mkdir(parents=True)
    for idx in (1, 2):
        event = {"event_id": f"e{idx}", "requests": [{"method": "POST", "path": "/runs/run-1/metrics", "body": {}}]}
        (run_dir / f"segment-000000000{idx}-x.jsonl").write_text(json.dumps(event) + "\n", encoding="utf-8")
    # First segment fully drains (1 event) → the cap is hit before the 2nd file.
    assert uploader.drain_spool(str(tmp_path), client=FakeClient(), max_events=1) == 1
    assert len(list(run_dir.glob("*.jsonl"))) == 1


def test_uploader_rewrites_remainder_on_failure(tmp_path):
    class FakeClient:
        def __init__(self):
            self.count = 0

        def _request(self, method, path, body):
            self.count += 1
            if self.count == 2:
                raise client_module.InstantMLError("mid-segment failure")
            return {}

    run_dir = tmp_path / "run-1"
    run_dir.mkdir(parents=True)
    events = [
        {"event_id": f"e{i}", "requests": [{"method": "POST", "path": "/runs/run-1/metrics", "body": {"metrics": {}, "step": i}}]}
        for i in range(3)
    ]
    (run_dir / "segment-0000000001-x.jsonl").write_text("\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")
    assert uploader.drain_spool(str(tmp_path), client=FakeClient()) == 1
    remaining = uploader._load_events(next(run_dir.glob("*.jsonl")))
    assert len(remaining) == 2
    assert remaining[0]["event_id"] == "e1"


def test_uploader_max_events_rewrites_remainder(tmp_path):
    class FakeClient:
        def _request(self, method, path, body):
            return {}

    run_dir = tmp_path / "run-1"
    run_dir.mkdir(parents=True)
    events = [
        {"event_id": f"e{i}", "requests": [{"method": "POST", "path": "/runs/run-1/metrics", "body": {"metrics": {}, "step": i}}]}
        for i in range(3)
    ]
    (run_dir / "segment-0000000001-x.jsonl").write_text("\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")
    assert uploader.drain_spool(str(tmp_path), client=FakeClient(), max_events=1) == 1
    assert len(uploader._load_events(next(run_dir.glob("*.jsonl")))) == 2


def test_uploader_load_events_reports_read_oserror(tmp_path, monkeypatch):
    seg = tmp_path / "segment-0000000001-x.jsonl"
    seg.write_text("{}\n", encoding="utf-8")

    def boom(self, encoding="utf-8"):
        raise OSError("disk gone")

    monkeypatch.setattr(uploader.Path, "read_text", boom)
    with pytest.raises(client_module.InstantMLError, match="cannot read spool event"):
        uploader._load_events(seg)


def test_uploader_load_events_rejects_malformed_jsonl(tmp_path):
    run_dir = tmp_path / "run-1"
    run_dir.mkdir(parents=True)
    seg = run_dir / "segment-0000000001-x.jsonl"
    seg.write_text("{bad}\n", encoding="utf-8")
    with pytest.raises(client_module.InstantMLError, match="cannot read spool event"):
        uploader._load_events(seg)
    seg.write_text("[]\n", encoding="utf-8")
    with pytest.raises(client_module.InstantMLError, match="must be a JSON object"):
        uploader._load_events(seg)


# --------------------------------------------------------------------------- #
# System-metrics sampler state hoisting (D7b)
# --------------------------------------------------------------------------- #


class _FakePsutil:
    class Process:
        created = 0

        def __init__(self, pid):
            _FakePsutil.Process.created += 1

        def memory_info(self):
            from types import SimpleNamespace

            return SimpleNamespace(rss=2048)

    @staticmethod
    def cpu_percent(interval=None):
        return 5.0

    @staticmethod
    def virtual_memory():
        from types import SimpleNamespace

        return SimpleNamespace(percent=10, used=1)

    @staticmethod
    def disk_usage(path):
        from types import SimpleNamespace

        return SimpleNamespace(percent=20)

    @staticmethod
    def net_io_counters():
        from types import SimpleNamespace

        return SimpleNamespace(bytes_sent=1, bytes_recv=2)


def test_system_metrics_state_reuses_process(monkeypatch):
    _FakePsutil.Process.created = 0
    monkeypatch.setattr(client_module, "_load_psutil", lambda: _FakePsutil)
    state = client_module._SystemMetricsState()
    m1 = client_module._sample_system_metrics(state)
    m2 = client_module._sample_system_metrics(state)
    assert m1["system/cpu_percent"] == 5.0 and m2["system/process_rss_bytes"] == 2048.0
    # Process handle created once and reused across samples.
    assert _FakePsutil.Process.created == 1
    state.close()


def test_system_metrics_state_nvml_init_once_and_shutdown(monkeypatch):
    counts = {"init": 0, "shutdown": 0}

    class FakeNvml:
        @staticmethod
        def nvmlInit():
            counts["init"] += 1

        @staticmethod
        def nvmlDeviceGetCount():
            return 1

        @staticmethod
        def nvmlDeviceGetHandleByIndex(index):
            return f"gpu{index}"

        @staticmethod
        def nvmlDeviceGetUtilizationRates(handle):
            from types import SimpleNamespace

            return SimpleNamespace(gpu=50)

        @staticmethod
        def nvmlDeviceGetMemoryInfo(handle):
            from types import SimpleNamespace

            return SimpleNamespace(used=4, total=8)

        @staticmethod
        def nvmlDeviceGetPowerUsage(handle):
            return 60000

        @staticmethod
        def nvmlShutdown():
            counts["shutdown"] += 1

    monkeypatch.setattr(client_module, "_load_psutil", lambda: None)
    import sys

    monkeypatch.setitem(sys.modules, "pynvml", FakeNvml)
    state = client_module._SystemMetricsState()
    m1 = client_module._sample_system_metrics(state)
    m2 = client_module._sample_system_metrics(state)
    assert m1["system/gpu/0/utilization_percent"] == 50.0
    assert m2["system/gpu/0/power_watts"] == 60.0
    assert counts["init"] == 1  # NVML initialized once, not per sample
    state.close()
    state.close()  # idempotent
    assert counts["shutdown"] == 1


def test_system_metrics_state_close_swallows_shutdown_error(monkeypatch):
    class FakeNvml:
        @staticmethod
        def nvmlInit():
            pass

        @staticmethod
        def nvmlDeviceGetCount():
            return 0

        @staticmethod
        def nvmlShutdown():
            raise RuntimeError("shutdown failed")

    monkeypatch.setattr(client_module, "_load_psutil", lambda: None)
    import sys

    monkeypatch.setitem(sys.modules, "pynvml", FakeNvml)
    state = client_module._SystemMetricsState()
    client_module._sample_system_metrics(state)
    state.close()  # must not raise despite nvmlShutdown failing


def test_system_metrics_state_process_none_without_psutil(monkeypatch):
    monkeypatch.setattr(client_module, "_load_psutil", lambda: None)
    state = client_module._SystemMetricsState()
    assert state.process() is None


def test_sample_warns_when_psutil_call_raises(monkeypatch):
    class BrokenPsutil:
        @staticmethod
        def cpu_percent(interval=None):
            raise RuntimeError("psutil exploded")

    monkeypatch.setattr(client_module, "_load_psutil", lambda: BrokenPsutil)
    state = client_module._SystemMetricsState()
    with pytest.warns(RuntimeWarning, match="system metrics collection failed"):
        client_module._sample_system_metrics(state)


def test_collect_nvml_metrics_warns_on_sample_error(monkeypatch):
    class FlakyNvml:
        @staticmethod
        def nvmlInit():
            pass

        @staticmethod
        def nvmlDeviceGetCount():
            return 1

        @staticmethod
        def nvmlDeviceGetHandleByIndex(index):
            return f"gpu{index}"

        @staticmethod
        def nvmlDeviceGetUtilizationRates(handle):
            raise RuntimeError("gpu read failed")

        @staticmethod
        def nvmlShutdown():
            pass

    monkeypatch.setattr(client_module, "_load_psutil", lambda: None)
    import sys

    monkeypatch.setitem(sys.modules, "pynvml", FlakyNvml)
    state = client_module._SystemMetricsState()
    with pytest.warns(RuntimeWarning, match="NVML"):
        client_module._sample_system_metrics(state)
    state.close()


def test_system_metrics_state_handles_missing_pynvml(monkeypatch):
    monkeypatch.setattr(client_module, "_load_psutil", lambda: None)
    import builtins

    real_import = builtins.__import__

    def no_pynvml(name, *args, **kwargs):
        if name == "pynvml":
            raise ImportError("no gpu")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_pynvml)
    state = client_module._SystemMetricsState()
    metrics = client_module._sample_system_metrics(state)
    assert not any(k.startswith("system/gpu") for k in metrics)
    state.close()


def test_system_metrics_state_nvml_init_failure_warns(monkeypatch):
    class FakeNvml:
        @staticmethod
        def nvmlInit():
            raise RuntimeError("driver missing")

        @staticmethod
        def nvmlShutdown():
            pass

    monkeypatch.setattr(client_module, "_load_psutil", lambda: None)
    import sys

    monkeypatch.setitem(sys.modules, "pynvml", FakeNvml)
    state = client_module._SystemMetricsState()
    with pytest.warns(RuntimeWarning, match="NVML"):
        client_module._sample_system_metrics(state)


# --------------------------------------------------------------------------- #
# Credential caching (D7a) + idempotency key derivation (D7d)
# --------------------------------------------------------------------------- #


def test_client_caches_and_invalidates_credentials(monkeypatch):
    resolves = {"n": 0}

    def fake_resolve(api_key, base_url=None):
        resolves["n"] += 1
        return "cached-key"

    monkeypatch.setattr(client_module, "_resolve_api_key_from_env", fake_resolve)
    client = client_module.Client(base_url="http://x.test")
    assert client._resolve_api_key() == "cached-key"
    assert client._resolve_api_key() == "cached-key"
    assert resolves["n"] == 1  # cached
    client._invalidate_credentials()
    assert client._resolve_api_key() == "cached-key"
    assert resolves["n"] == 2  # re-resolved after invalidation


def test_client_invalidates_credentials_on_401(monkeypatch):
    resolves = {"n": 0}

    def fake_resolve(api_key, base_url=None):
        resolves["n"] += 1
        return "k"

    monkeypatch.setattr(client_module, "_resolve_api_key_from_env", fake_resolve)

    def raise_401(request, timeout):
        raise urllib.error.HTTPError("http://x.test/health", 401, "unauthorized", {}, io.BytesIO(b"{}"))

    monkeypatch.setattr(http_pool, "urlopen", raise_401)
    client = client_module.Client(base_url="http://x.test")
    with pytest.raises(client_module.InstantMLError):
        client._request("GET", "/health")
    # The 401 invalidated the cache, so the next resolve re-reads credentials.
    assert resolves["n"] == 1
    client._resolve_api_key()
    assert resolves["n"] == 2


def test_idempotency_keys_are_prefixed_and_monotonic():
    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            return {}

    run = client_module.Run(client=FakeClient(), run_id="run-1")
    k1 = run._next_idempotency_key()
    k2 = run._next_idempotency_key()
    assert k1 != k2
    assert k1.startswith("instantml-") and k1.endswith("-1")
    assert k2.endswith("-2")


def test_prepare_event_encodes_without_sort_keys(tmp_path):
    repo = AsyncQueueRepository(tmp_path / "queue.sqlite3")
    repo.init_db()
    event = repo.prepare_event("POST", "/runs/run-1/metrics", {"b": 1, "a": 2}, idempotency_key="k")
    # Insertion order preserved (no canonical sort); size matches encoded bytes.
    assert event.body_json == '{"b":1,"a":2}'
    assert event.body_size_bytes == len(event.body_json.encode("utf-8"))
