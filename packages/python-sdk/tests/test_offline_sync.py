"""Tests for resumable ``instantml sync`` of offline run directories (PR-04).

Design: docs/design/2026-07-15-offline-lifecycle-upload-completeness.md §5.
"""

from __future__ import annotations

import io
import json
import os
import urllib.error
from pathlib import Path

import pytest

import instantml as im
import instantml._http_pool as http_pool
import instantml.async_queue as async_queue
import instantml.client as client_module
import instantml.cli as cli_module
import instantml.offline_sync as osync


# --------------------------------------------------------------------------- #
# Fake server: one _http_pool.urlopen seam covers create, drain, finish, and PUT.
# --------------------------------------------------------------------------- #


class _FakeResponse:
    def __init__(self, body: bytes = b"{}") -> None:
        self._body = body

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self) -> bytes:
        return self._body


class FakeServer:
    """Records requests and delivers metric/create/finish/session responses.

    Configurable failure hooks let tests drive retryable, permanent, and
    connection-drop paths deterministically.
    """

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.metric_steps: list = []
        self.batch_keys: list[str] = []
        self.created_ids: list[str] = []
        self.statuses: list[str] = []
        self.session_bodies: list[dict] = []
        self.run_exists = True
        self.created_flag = True
        # Hooks
        self.fail_metrics_after: int | None = None  # raise URLError after N metric requests
        self.metric_calls = 0
        self.metric_http_error: tuple[int, str, str] | None = None  # (status, code, message)
        self.metric_error_times: int | None = None  # limit metric_http_error to N occurrences
        self.upload_status = 200  # artifacts/upload outcome (403 = missing scope)
        self.create_error: tuple[int, str, str] | None = None
        self.create_url_error = False
        self.finish_error: tuple[int, str, str] | None = None
        self.finish_url_error = False
        self.session_status = 404  # default: route not present (PR-05)
        self.get_status = 200

    def __call__(self, request, timeout=None):
        method = request.get_method()
        url = request.full_url
        path = "/" + url.split("://", 1)[1].split("/", 1)[1].split("?", 1)[0]
        body = json.loads(request.data.decode("utf-8")) if request.data else None
        self.requests.append(
            {"method": method, "path": path, "idempotency_key": request.get_header("Idempotency-key"), "body": body}
        )

        if method == "POST" and path == "/runs":
            if self.create_url_error:
                raise urllib.error.URLError("create connection refused")
            if self.create_error is not None:
                raise self._http_error(url, self.create_error)
            self.created_ids.append(body["id"])
            return _FakeResponse(json.dumps({"run": {"id": body["id"]}, "created": self.created_flag}).encode())

        if path.endswith("/metrics/batch"):
            self.metric_calls += 1
            self._maybe_fail_metrics(url)
            self.batch_keys.append(request.get_header("Idempotency-key"))
            self.metric_steps.extend(point["step"] for point in body["points"])
            return _FakeResponse()

        if path.endswith("/metrics"):
            self.metric_calls += 1
            self._maybe_fail_metrics(url)
            self.metric_steps.append(body["step"])
            return _FakeResponse()

        if path.endswith("/artifacts/upload"):
            assert "content_base64" in body and "source_path" not in body
            if self.upload_status != 200:
                raise self._http_error(url, (self.upload_status, "forbidden", "artifacts:write scope required"))
            return _FakeResponse(json.dumps({"artifact": {"id": "a"}}).encode())

        if path.endswith("/attributes") or path.endswith("/objects") or path.endswith("/logs") or path.endswith(
            "/rank-metrics"
        ) or "/traces/" in path:
            return _FakeResponse()

        if method == "PATCH" and path.startswith("/runs/"):
            if "status" in (body or {}):
                if self.finish_url_error:
                    raise urllib.error.URLError("finish connection refused")
                if self.finish_error is not None:
                    raise self._http_error(url, self.finish_error)
                self.statuses.append(body["status"])
            return _FakeResponse()

        if method == "PUT" and "/sessions/" in path:
            if self.session_status == 200:
                self.session_bodies.append(body)
                return _FakeResponse()
            raise self._http_error(url, (self.session_status, "err", "session route"))

        if method == "GET":
            if self.get_status == 200:
                return _FakeResponse(json.dumps({"run": {"id": "x"}}).encode())
            raise self._http_error(url, (self.get_status, "err", "get error"))

        return _FakeResponse()

    def _maybe_fail_metrics(self, url: str) -> None:
        if self.metric_http_error is not None:
            if self.metric_error_times is None:
                raise self._http_error(url, self.metric_http_error)
            if self.metric_error_times > 0:
                self.metric_error_times -= 1
                raise self._http_error(url, self.metric_http_error)
        if self.fail_metrics_after is not None and self.metric_calls > self.fail_metrics_after:
            raise urllib.error.URLError("connection reset")

    @staticmethod
    def _http_error(url: str, spec: tuple[int, str, str]) -> urllib.error.HTTPError:
        status, code, message = spec
        payload = json.dumps({"code": code, "error": message}).encode("utf-8")
        return urllib.error.HTTPError(url, status, message, {}, io.BytesIO(payload))


@pytest.fixture(autouse=True)
def _no_retry_wait(monkeypatch):
    """Skip the bounded in-process retry wait so retryable tests settle fast.

    Tests that exercise the wait budget itself override the cap explicitly.
    """
    monkeypatch.setattr(osync, "_RETRY_WAIT_CAP_SECONDS", 0.0)


@pytest.fixture()
def server(monkeypatch):
    fake = FakeServer()
    monkeypatch.setattr(http_pool, "urlopen", fake)
    monkeypatch.setenv("INSTANTML_API_KEY", "test")
    return fake


def _make_offline_run(tmp_path, **log):
    run = im.init(
        project="demo",
        name="r",
        mode="offline",
        data_dir=str(tmp_path),
        system_metrics=False,
        source_tracking=False,
        config={"lr": 0.1},
    )
    return run


def _sync(*args) -> int:
    return osync.run_offline_sync(list(args))


# --------------------------------------------------------------------------- #
# End-to-end sync
# --------------------------------------------------------------------------- #


def test_sync_end_to_end(tmp_path, server, capsys):
    run = _make_offline_run(tmp_path)
    for step in range(5):
        run.log_metrics({"loss": 1.0 / (step + 1)}, step=step)
    run.log_config({"batch": 32})
    run.set_tags(["a", "b"])
    run.log_console(["hello"])
    run.log_table_object("preds", ["x"], [[1]], step=1)
    source = tmp_path / "ckpt.bin"
    source.write_bytes(b"weights-123")
    run.upload_file(str(source), artifact_type="checkpoint", step=1)
    run_dir = run._offline.run_dir
    run_id = run.run_id
    run.finish()

    code = _sync(str(run_dir), "--base-url", "http://x.test")
    assert code == 0

    # Exactly one create with id + auto.
    creates = [r for r in server.requests if r["path"] == "/runs"]
    assert len(creates) == 1
    assert creates[0]["body"]["id"] == run_id
    assert creates[0]["body"]["mode"] == "auto"

    # Metrics delivered (batched) and finish applied.
    assert sorted(server.metric_steps) == [0, 1, 2, 3, 4]
    assert server.statuses == ["finished"]

    # Files delivered as base64 (asserted inside the fake), session PUT attempted.
    assert any(r["method"] == "PUT" and "/sessions/" in r["path"] for r in server.requests)

    # Synced marker written.
    state = json.loads((run_dir / "sync-state.json").read_text())
    assert state["synced"]["completed_at"]
    assert state["schema_version"] == 1

    out = capsys.readouterr().out
    assert "synced and complete" in out
    assert "session manifest route not available" in out

    # Second sync: local no-op, zero requests.
    before = len(server.requests)
    code2 = _sync(str(run_dir), "--base-url", "http://x.test")
    assert code2 == 0
    assert len(server.requests) == before  # no network
    assert "nothing to do" in capsys.readouterr().out


def test_sync_batch_membership_and_keys_preserved(tmp_path, server, monkeypatch):
    monkeypatch.setattr(osync, "DEFAULT_MAX_BATCH_POINTS", 3)
    run = _make_offline_run(tmp_path)
    for step in range(10):
        run.log_metrics({"loss": step}, step=step)
    run_dir = run._offline.run_dir
    run.finish()

    code = _sync(str(run_dir), "--base-url", "http://x.test")
    assert code == 0
    assert sorted(server.metric_steps) == list(range(10))
    # Deterministic within-segment batches of 3, 3, 3 (the trailing single event
    # is delivered per-event, not as a >=2 member batch).
    assert len(server.batch_keys) == 3
    assert all(key.startswith("instantml-batch-") for key in server.batch_keys)


# --------------------------------------------------------------------------- #
# Session manifest posted when the route exists
# --------------------------------------------------------------------------- #


def test_sync_posts_session_manifest_when_route_available(tmp_path, server):
    server.session_status = 200
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    session_id = run._offline.session_id
    run.finish()

    assert _sync(str(run_dir), "--base-url", "http://x.test") == 0
    assert len(server.session_bodies) == 1
    manifest = server.session_bodies[0]
    assert manifest["state"] == "final"
    assert manifest["producer"]["kind"] == "sdk"  # producer identity kept, not "sync"
    assert manifest["counts"]["metrics"]["acknowledged"] == 1
    assert manifest["counts"]["metrics"]["attempted"] == 1
    assert manifest["last_sequences"]["metrics"] == 1
    put = next(r for r in server.requests if r["method"] == "PUT")
    assert session_id in put["path"]


def test_sync_session_manifest_other_error_is_nonfatal(tmp_path, server):
    server.session_status = 500
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()
    # Delivery already complete: a session-manifest error does not fail the sync.
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 0


# --------------------------------------------------------------------------- #
# Kill / resume convergence
# --------------------------------------------------------------------------- #


def test_sync_resume_after_connection_drop_converges(tmp_path, server, monkeypatch):
    monkeypatch.setattr(osync, "DEFAULT_MAX_BATCH_POINTS", 3)
    run = _make_offline_run(tmp_path)
    for step in range(12):
        run.log_metrics({"loss": step}, step=step)
    run_dir = run._offline.run_dir
    run.finish()

    # Run 1: connection drops after 2 metric batches (steps 0-5 delivered).
    server.fail_metrics_after = 2
    code1 = _sync(str(run_dir), "--base-url", "http://x.test")
    assert code1 == 3  # partial, retryable remainder
    delivered_run1 = sorted(server.metric_steps)
    assert delivered_run1 == [0, 1, 2, 3, 4, 5]
    state = json.loads((run_dir / "sync-state.json").read_text())
    (cursor,) = state["delivered"].values()
    assert cursor == 5  # line index of last delivered event

    # The boundary batch (steps 6,7,8) key computed deterministically.
    segments = osync._scan_segments(run_dir / "segments", include_partials=False)
    (_name, events) = segments[0]
    boundary_keys = sorted(e.idempotency_key for e in events if e.event_class == "metrics" and e.sequence in (7, 8, 9))
    import hashlib

    expected_boundary = "instantml-batch-" + hashlib.sha256("\n".join(boundary_keys).encode()).hexdigest()

    # Run 2: resume — delivers ONLY the remainder (steps 6-11), converging.
    server2 = FakeServer()
    monkeypatch.setattr(http_pool, "urlopen", server2)
    code2 = _sync(str(run_dir), "--base-url", "http://x.test")
    assert code2 == 0
    assert sorted(server2.metric_steps) == [6, 7, 8, 9, 10, 11]
    # Deterministic re-batching: the boundary batch key matches across runs.
    assert server2.batch_keys[0] == expected_boundary
    # Exactly one create on resume (attach), and finish applied once.
    assert len([r for r in server2.requests if r["path"] == "/runs"]) == 1
    assert server2.statuses == ["finished"]


def test_sync_resume_skips_fully_delivered_earlier_segment(tmp_path, server, monkeypatch):
    # Two segments; the first fully delivers, the second drops mid-flight, then
    # a resume skips the delivered segment and finishes the second.
    monkeypatch.setattr(client_module, "_SPOOL_SEGMENT_ROTATE_EVENTS", 4)
    monkeypatch.setattr(osync, "DEFAULT_MAX_BATCH_POINTS", 2)
    run = _make_offline_run(tmp_path)
    for step in range(8):
        run.log_metrics({"loss": step}, step=step)
    run_dir = run._offline.run_dir
    run.finish()
    segments = sorted((run_dir / "segments").glob("*.jsonl"))
    assert len(segments) >= 2

    server.fail_metrics_after = 3  # deliver segment 1 (2 batches) + 1 batch of seg 2
    code1 = _sync(str(run_dir), "--base-url", "http://x.test")
    assert code1 == 3
    state = json.loads((run_dir / "sync-state.json").read_text())
    assert len(state["delivered"]) >= 1

    server2 = FakeServer()
    monkeypatch.setattr(http_pool, "urlopen", server2)
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 0
    # Union across both runs is the full set with no gaps.
    assert sorted(set(server.metric_steps) | set(server2.metric_steps)) == list(range(8))


# --------------------------------------------------------------------------- #
# --status (no network)
# --------------------------------------------------------------------------- #


def test_status_is_local_only(tmp_path, monkeypatch):
    monkeypatch.setenv("INSTANTML_API_KEY", "test")

    def _blocked(*args, **kwargs):
        raise AssertionError("--status must not touch the network")

    monkeypatch.setattr(http_pool, "urlopen", _blocked)
    run = _make_offline_run(tmp_path)
    for step in range(3):
        run.log_metrics({"loss": step}, step=step)
    run_dir = run._offline.run_dir
    run.finish()

    code = osync.run_offline_sync([str(run_dir), "--status", "--json"])
    assert code == 0


def test_status_reports_pending_and_synced(tmp_path, server, capsys):
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()

    # Before sync: pending reported.
    assert osync.run_offline_sync([str(run_dir), "--status"]) == 0
    out = capsys.readouterr().out
    assert "pending upload" in out
    assert "session " in out

    # After sync: status reports the synced marker.
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 0
    assert osync.run_offline_sync([str(run_dir), "--status"]) == 0
    assert "already marked synced" in capsys.readouterr().out


# --------------------------------------------------------------------------- #
# --dry-run (server validation, no writes)
# --------------------------------------------------------------------------- #


def test_dry_run_attach_no_mutation(tmp_path, server):
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()

    assert osync.run_offline_sync([str(run_dir), "--dry-run"]) == 0
    # Only a GET happened — no create, no metric POSTs.
    assert all(r["method"] == "GET" for r in server.requests)
    assert not any(r["path"] == "/runs" for r in server.requests)
    assert not (run_dir / "sync-state.json").exists()


def test_dry_run_would_create_when_run_absent(tmp_path, server, capsys):
    server.get_status = 404
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()
    assert osync.run_offline_sync([str(run_dir), "--dry-run"]) == 0
    assert "would create it" in capsys.readouterr().out


def test_dry_run_auth_failure_is_permanent(tmp_path, server):
    server.get_status = 401
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()
    assert osync.run_offline_sync([str(run_dir), "--dry-run"]) == 4


def test_dry_run_unreachable_is_partial(tmp_path, server):
    server.get_status = 503
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()
    assert osync.run_offline_sync([str(run_dir), "--dry-run"]) == 3


def test_dry_run_permanent_server_error(tmp_path, server):
    server.get_status = 400
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()
    assert osync.run_offline_sync([str(run_dir), "--dry-run"]) == 4


# --------------------------------------------------------------------------- #
# Create-path exit codes
# --------------------------------------------------------------------------- #


def test_sync_create_auth_failure(tmp_path, server):
    server.create_error = (401, "unauthorized", "bad key")
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 4


def test_sync_create_run_id_conflict(tmp_path, server, capsys):
    server.create_error = (409, "run_id_conflict", "already used")
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 4
    assert "run_id_conflict" in capsys.readouterr().out


def test_sync_create_retryable(tmp_path, server):
    server.create_url_error = True
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 3


def test_sync_create_permanent_validation(tmp_path, server):
    server.create_error = (400, "invalid_run_id", "bad id")
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 4


def test_sync_attach_existing_run(tmp_path, server, capsys):
    server.created_flag = False
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 0
    assert "run attached (existing)" in capsys.readouterr().out


# --------------------------------------------------------------------------- #
# Delivery exit codes
# --------------------------------------------------------------------------- #


def test_sync_retryable_remainder_exit_3(tmp_path, server, capsys):
    server.metric_http_error = (503, "unavailable", "server busy")
    run = _make_offline_run(tmp_path)
    for step in range(3):
        run.log_metrics({"loss": step}, step=step)
    run_dir = run._offline.run_dir
    run.finish()
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 3
    assert "awaiting retry" in capsys.readouterr().out


def test_sync_rate_limit_is_retryable(tmp_path, server):
    # A 429 must be classified retryable by the delivery path (live burst limit).
    server.metric_http_error = (429, "rate_limit_exceeded", "slow down")
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 3


def test_sync_waits_out_transient_rate_limit_in_process(tmp_path, server, monkeypatch):
    # A burst 429 that clears is waited out within the in-process budget so a
    # single invocation still completes (live server burst-limit behavior).
    monkeypatch.setattr(osync, "_RETRY_WAIT_CAP_SECONDS", 10.0)
    monkeypatch.setattr(osync, "_RETRY_POLL_SECONDS", 0.02)
    monkeypatch.setattr(async_queue, "_retry_delay", lambda attempts, retry_after=None: 0.01)
    server.metric_http_error = (429, "rate_limit_exceeded", "slow down")
    server.metric_error_times = 2
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 0
    assert server.metric_steps == [0]  # delivered exactly once after the 429s cleared


def test_sync_fail_stop_blocks_later_events_and_rerun_converges(tmp_path, server, monkeypatch):
    """The live-E2E lesson: a permanently-failed event mid-segment must STOP
    delivery (no events past it), so that after the operator fixes the cause a
    rerun delivers the remainder exactly once with unchanged batch keys."""
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 0.0}, step=0)
    run.log_metrics({"loss": 1.0}, step=1)
    source = tmp_path / "blocked.bin"
    source.write_bytes(b"x")
    run.upload_file(str(source), step=1)  # will 403 (missing scope)
    run.log_metrics({"loss": 2.0}, step=2)
    run.log_metrics({"loss": 3.0}, step=3)
    run_dir = run._offline.run_dir
    run.finish()

    server.upload_status = 403
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 4
    # Chunks before the failed files event delivered; nothing after it did.
    assert sorted(server.metric_steps) == [0, 1]
    state = json.loads((run_dir / "sync-state.json").read_text())
    assert state["last_error"]

    # Operator fixes the scope; the rerun delivers only the remainder.
    server2 = FakeServer()
    monkeypatch.setattr(http_pool, "urlopen", server2)
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 0
    assert sorted(server2.metric_steps) == [2, 3]  # steps 0-1 never re-sent
    assert sorted(set(server.metric_steps) | set(server2.metric_steps)) == [0, 1, 2, 3]


def test_sync_permanent_event_failure_exit_4(tmp_path, server, capsys):
    server.metric_http_error = (400, "invalid_metric", "bad payload")
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 4
    out = capsys.readouterr().out
    assert "permanently failed" in out


# --------------------------------------------------------------------------- #
# Finish handling
# --------------------------------------------------------------------------- #


def test_sync_finish_patch_retryable(tmp_path, server):
    server.finish_url_error = True
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 3


def test_sync_finish_patch_permanent(tmp_path, server):
    server.finish_error = (400, "bad_status", "nope")
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 4


def test_sync_hard_kill_no_finish_signature(tmp_path, server, capsys):
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run.flush()  # durable but never finished (finish stays null)
    run_dir = run._offline.run_dir
    manifest = json.loads((run_dir / "run.json").read_text())
    assert manifest["finish"] is None

    assert _sync(str(run_dir), "--base-url", "http://x.test") == 0
    # No status PATCH applied; unclean shutdown reported; still marked synced.
    assert server.statuses == []
    out = capsys.readouterr().out
    assert "unclean" in out
    state = json.loads((run_dir / "sync-state.json").read_text())
    assert state["synced"]["completed_at"]


def test_sync_finish_already_in_segments_is_not_resent(tmp_path, server):
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    # Simulate a future writer that records the finish PATCH as a run_meta event.
    run._offline.record("PATCH", f"/runs/{run.run_id}", {"status": "finished"}, {"status": "finished"}, None, "t")
    run.finish()
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 0
    # The finish came through the drain (one status PATCH), not a synthesized one.
    assert server.statuses == ["finished"]


def test_sync_reports_local_drops(tmp_path, server, monkeypatch, capsys):
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    # Force a drop on the next write.
    monkeypatch.setattr(run._offline._writer, "append", lambda *a, **k: (_ for _ in ()).throw(OSError("ENOSPC")))
    run.log_metrics({"loss": 2.0}, step=1)
    run_dir = run._offline.run_dir
    run.finish()
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 0
    out = capsys.readouterr().out
    assert "1 dropped event(s) reported as incomplete" in out


# --------------------------------------------------------------------------- #
# Oversized events (review finding 1: never silently skipped)
# --------------------------------------------------------------------------- #


def test_oversized_single_event_is_permanent_failure_not_skip(tmp_path, server, monkeypatch, capsys):
    run = _make_offline_run(tmp_path)
    run.log_config({"a": 1})  # attributes event — will exceed the patched cap
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()

    monkeypatch.setattr(osync, "_SYNC_MAX_EVENT_BYTES", 10)
    code = osync.run_offline_sync([str(run_dir), "--base-url", "http://x.test", "--json"])
    assert code == 4
    payload = json.loads(capsys.readouterr().out)
    run_report = payload["runs"][0]
    assert run_report["classes"]["attributes"]["failed"] == 1
    # Fail-stop: nothing was delivered past the refused event, cursor never
    # advanced, directory NOT marked synced.
    assert server.metric_steps == []
    assert run_report["synced"] is False
    state = json.loads((run_dir / "sync-state.json").read_text())
    assert state["delivered"] == {}
    assert "could not be staged" in state["last_error"]


def test_oversized_event_inside_metric_chunk_fail_stops(tmp_path, server, monkeypatch, capsys):
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run.log_metrics({"loss": 2.0}, step=1)
    # A visibly larger metric event in the middle of the chunk.
    run.log_metrics({f"metric/{i}": float(i) for i in range(40)}, step=2)
    run.log_metrics({"loss": 3.0}, step=3)
    run_dir = run._offline.run_dir
    run.finish()

    # Cap between the small (~150 B) and big (~900 B) event sizes.
    monkeypatch.setattr(osync, "_SYNC_MAX_EVENT_BYTES", 400)
    code = osync.run_offline_sync([str(run_dir), "--base-url", "http://x.test", "--json"])
    assert code == 4
    payload = json.loads(capsys.readouterr().out)
    run_report = payload["runs"][0]
    assert run_report["classes"]["metrics"]["failed"] == 1
    # The whole chunk fail-stops before enqueue: no partial chunk delivery, no
    # cursor advance past the refused event → no silent loss on a rerun.
    assert server.metric_steps == []
    state = json.loads((run_dir / "sync-state.json").read_text())
    assert state["delivered"] == {}


def test_enqueue_refusal_is_permanent_failure(tmp_path, server, monkeypatch):
    # Disk-space refusal at enqueue (inserted < prepared) must also fail-stop.
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()

    monkeypatch.setattr(async_queue.AsyncQueueRepository, "_has_disk_space", lambda self: False)
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 4
    assert server.metric_steps == []
    state = json.loads((run_dir / "sync-state.json").read_text())
    assert state["delivered"] == {}


# --------------------------------------------------------------------------- #
# Live/unpromotable partials (review finding 2: never mark synced past them)
# --------------------------------------------------------------------------- #


def _abandon_with_live_partial(run):
    """Leave a durable active partial owned by a LIVE pid (this process)."""
    run._offline._writer._fsync()
    run._offline._closed = True
    run._finished = True
    client_module._unregister_active_run(run)


def test_live_pid_partial_blocks_synced_marker(tmp_path, server, capsys):
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    _abandon_with_live_partial(run)  # partial owned by this (live) process

    server.session_status = 200
    code = _sync(str(run_dir), "--base-url", "http://x.test")
    assert code == 3
    out = capsys.readouterr().out
    assert "partial segment remains" in out
    assert "--assume-dead" in out
    # No synced marker; the partial's events are not stranded.
    state = json.loads((run_dir / "sync-state.json").read_text()) if (run_dir / "sync-state.json").exists() else {}
    assert not state.get("synced")
    # Honest session manifest: still uploading, not final.
    assert server.session_bodies[-1]["state"] == "active"


def test_assume_dead_promotes_and_converges(tmp_path, server, capsys):
    run = _make_offline_run(tmp_path)
    for step in range(3):
        run.log_metrics({"loss": step}, step=step)
    run_dir = run._offline.run_dir
    _abandon_with_live_partial(run)

    code = _sync(str(run_dir), "--assume-dead", "--base-url", "http://x.test")
    assert code == 0
    out = capsys.readouterr().out
    assert "force-promoted 1 partial segment(s)" in out
    assert sorted(server.metric_steps) == [0, 1, 2]
    state = json.loads((run_dir / "sync-state.json").read_text())
    assert state["synced"]["completed_at"]
    # No partial dotfiles remain.
    assert osync._remaining_partials(run_dir / "segments") == []


def test_force_promote_handles_unparseable_and_legacy_names(tmp_path):
    seg = tmp_path / "segments"
    seg.mkdir()
    # Matches the pid glob but the pid token is not decimal: left alone.
    (seg / ".foo.jsonl.pid-abc.tmp").write_text("")
    # Legacy (pid-less) active partial: promoted.
    (seg / ".bar.jsonl.tmp").write_text("")
    assert osync._force_promote_partials(seg) == 1
    assert (seg / "bar.jsonl").exists()
    assert (seg / ".foo.jsonl.pid-abc.tmp").exists()


# --------------------------------------------------------------------------- #
# Session manifests on failure paths (review finding 3: honesty over unknown)
# --------------------------------------------------------------------------- #


def test_exit_4_posts_final_manifest_with_failed_counts(tmp_path, server):
    server.session_status = 200
    server.metric_http_error = (400, "invalid_metric", "bad payload")
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()

    assert _sync(str(run_dir), "--base-url", "http://x.test") == 4
    manifest = server.session_bodies[-1]
    assert manifest["state"] == "final"
    counts = manifest["counts"]["metrics"]
    assert counts["failed"] == 1
    assert counts["acknowledged"] == 0
    # Server invariants hold.
    for entry in manifest["counts"].values():
        assert entry["attempted"] == entry["queued"] + entry["dropped"]
        assert entry["acknowledged"] + entry["failed"] <= entry["queued"]


def test_exit_3_posts_active_manifest(tmp_path, server):
    server.session_status = 200
    server.metric_http_error = (503, "unavailable", "busy")
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()

    assert _sync(str(run_dir), "--base-url", "http://x.test") == 3
    manifest = server.session_bodies[-1]
    assert manifest["state"] == "active"
    counts = manifest["counts"]["metrics"]
    assert counts["failed"] == 0 and counts["acknowledged"] == 0 and counts["queued"] == 1


def test_finish_patch_failures_post_manifests(tmp_path, server):
    server.session_status = 200
    server.finish_error = (400, "bad_status", "nope")
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 4
    assert server.session_bodies[-1]["state"] == "final"

    server2 = FakeServer()
    server2.session_status = 200
    server2.finish_url_error = True
    run2 = _make_offline_run(tmp_path)
    run2.log_metrics({"loss": 1.0}, step=0)
    run_dir2 = run2._offline.run_dir
    run2.finish()
    import instantml._http_pool as pool

    original = pool.urlopen
    try:
        pool.urlopen = server2
        assert _sync(str(run_dir2), "--base-url", "http://x.test") == 3
    finally:
        pool.urlopen = original
    assert server2.session_bodies[-1]["state"] == "active"


# --------------------------------------------------------------------------- #
# Discovery / invalid directories
# --------------------------------------------------------------------------- #


def test_invalid_dir_missing_run_json(tmp_path, server, capsys):
    (tmp_path / "empty").mkdir()
    assert osync.run_offline_sync([str(tmp_path / "empty")]) == 5
    assert "no offline run directory found" in capsys.readouterr().out


def test_invalid_dir_nonexistent_path(server):
    assert osync.run_offline_sync(["/no/such/path/exists"]) == 5


def test_invalid_dir_bad_manifest(tmp_path, server, capsys):
    run_dir = tmp_path / "offline" / "run-1"
    (run_dir / "segments").mkdir(parents=True)
    (run_dir / "run.json").write_text("{ not json")
    assert osync.run_offline_sync([str(run_dir)]) == 5
    assert "unreadable" in capsys.readouterr().out


def test_invalid_dir_manifest_variants(tmp_path, server):
    run_dir = tmp_path / "run"
    (run_dir / "segments").mkdir(parents=True)

    def _write(manifest):
        (run_dir / "run.json").write_text(json.dumps(manifest))

    base = {
        "schema_version": 1,
        "run_id": "r",
        "session_id": "s",
        "mode": "create",
        "producer": {"kind": "sdk"},
        "create_request": {"project": "p"},
    }
    _write({**base, "schema_version": 2})
    assert osync.run_offline_sync([str(run_dir)]) == 5
    _write({**base, "run_id": ""})
    assert osync.run_offline_sync([str(run_dir)]) == 5
    _write({**base, "producer": "x"})
    assert osync.run_offline_sync([str(run_dir)]) == 5
    _write({**base, "create_request": "x"})
    assert osync.run_offline_sync([str(run_dir)]) == 5
    # A JSON array (not an object) manifest.
    (run_dir / "run.json").write_text("[]")
    assert osync.run_offline_sync([str(run_dir)]) == 5


def test_invalid_dir_missing_segments(tmp_path, server):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "run.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "run_id": "r",
                "session_id": "s",
                "mode": "create",
                "producer": {"kind": "sdk"},
                "create_request": {"project": "p"},
            }
        )
    )
    assert osync.run_offline_sync([str(run_dir)]) == 5


def test_offline_root_aggregates_multiple_runs(tmp_path, server, capsys):
    # Two offline runs under one data root; one syncs clean, one hits a 400.
    run_a = _make_offline_run(tmp_path)
    run_a.log_metrics({"loss": 1.0}, step=0)
    run_a.finish()
    run_b = _make_offline_run(tmp_path)
    run_b.log_metrics({"loss": 2.0}, step=0)
    run_b.finish()

    # Both runs deliver cleanly → aggregate exit 0 across two runs.
    code = osync.run_offline_sync([str(tmp_path), "--base-url", "http://x.test"])
    assert code == 0
    out = capsys.readouterr().out
    assert "Aggregate exit: 0" in out


def test_offline_root_aggregates_worst_exit(tmp_path, server):
    run_a = _make_offline_run(tmp_path)
    run_a.log_metrics({"loss": 1.0}, step=0)
    run_a.finish()
    run_b = _make_offline_run(tmp_path)
    run_b.log_metrics({"loss": 2.0}, step=0)
    run_b.finish()
    # All metric requests fail retryably → both runs exit 3 → aggregate 3.
    server.metric_http_error = (503, "unavailable", "busy")
    code = osync.run_offline_sync([str(tmp_path), "--base-url", "http://x.test"])
    assert code == 3


def test_discover_dedupes_offline_and_direct_children(tmp_path, server):
    # A data root whose direct child IS the offline/<run_id> dir would otherwise
    # be discovered twice; ensure de-duplication.
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run.finish()
    dirs = osync._discover_run_dirs(tmp_path)
    assert len(dirs) == 1


# --------------------------------------------------------------------------- #
# Unexpected error path
# --------------------------------------------------------------------------- #


def test_unexpected_error_is_exit_1(tmp_path, server, monkeypatch, capsys):
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()

    def boom(*args, **kwargs):
        raise RuntimeError("kaboom")

    monkeypatch.setattr(osync, "_promote_recoverable_segments", boom)
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 1
    assert "unexpected error" in capsys.readouterr().out


def test_scan_skips_unreadable_and_malformed(tmp_path, server):
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()
    seg_dir = run_dir / "segments"
    (seg_dir / "corrupt.jsonl").write_text("\nnot json\n{}\n[]\n" + json.dumps({"class": "metrics"}) + "\n")
    (seg_dir / "isdir.jsonl").mkdir()
    # A run_meta event missing a body type still parses to nothing bad.
    segments = osync._scan_segments(seg_dir, include_partials=True)
    # The real metric event survives; junk lines are skipped.
    total = sum(len(events) for _n, events in segments)
    assert total == 1


# --------------------------------------------------------------------------- #
# Helper units
# --------------------------------------------------------------------------- #


def test_load_manifest_defensive_branches(tmp_path, monkeypatch):
    # run.json missing (would be caught by discovery, but _load_manifest guards it).
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(osync._InvalidDir, match="run.json is missing"):
        osync._load_manifest(empty)

    # segments dir present but unreadable (iterdir raises OSError).
    run_dir = tmp_path / "run"
    (run_dir / "segments").mkdir(parents=True)
    (run_dir / "run.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "run_id": "r",
                "session_id": "s",
                "mode": "create",
                "producer": {"kind": "sdk"},
                "create_request": {"project": "p"},
            }
        )
    )
    real_iterdir = Path.iterdir

    def boom_iterdir(self):
        if self.name == "segments":
            raise OSError("permission denied")
        return real_iterdir(self)

    monkeypatch.setattr(Path, "iterdir", boom_iterdir)
    with pytest.raises(osync._InvalidDir, match="segments/ is unreadable"):
        osync._load_manifest(run_dir)


def test_parse_segment_line_rejects_bad_shapes():
    assert osync._parse_segment_line(json.dumps({"class": "metrics", "requests": ["not-a-dict"]})) is None
    assert (
        osync._parse_segment_line(
            json.dumps({"class": "metrics", "requests": [{"method": 1, "path": "p", "body": {}, "idempotency_key": "k"}]})
        )
        is None
    )


def test_local_counts_skips_non_dict_class_values():
    counts = osync._local_counts([], {"counts": {"metrics": "not-a-dict", "logs": {"dropped": 2}}})
    assert counts["logs"]["dropped"] == 2
    assert "metrics" not in counts


def test_dry_run_after_partial_reports_accepted(tmp_path, server):
    # A partial sync leaves a cursor; a later --dry-run counts delivered events.
    server.metric_http_error = (503, "unavailable", "busy")
    run = _make_offline_run(tmp_path)
    for step in range(2):
        run.log_metrics({"loss": step}, step=step)
    run_dir = run._offline.run_dir
    run.finish()
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 3  # nothing delivered
    # Now allow delivery and let a cursor form, then dry-run over it.
    server.metric_http_error = None
    assert _sync(str(run_dir), "--base-url", "http://x.test") == 0
    assert osync.run_offline_sync([str(run_dir), "--dry-run"]) == 0


def test_read_sync_state_tolerates_garbage(tmp_path):
    run_dir = tmp_path
    (run_dir / "sync-state.json").write_text("not json")
    state = osync._read_sync_state(run_dir)
    assert state["delivered"] == {}
    # Non-dict JSON.
    (run_dir / "sync-state.json").write_text("[]")
    assert osync._read_sync_state(run_dir)["delivered"] == {}
    # Wrong delivered type.
    (run_dir / "sync-state.json").write_text(json.dumps({"delivered": "x"}))
    assert osync._read_sync_state(run_dir)["delivered"] == {}


def test_describe_finish_variants():
    assert "unclean" in osync._describe_finish(None)
    assert "unclean" in osync._describe_finish({"status": 1})
    assert osync._describe_finish({"status": "finished", "clean": True}) == "finished (clean)"
    assert osync._describe_finish({"status": "failed", "clean": False}) == "failed (unclean)"


def test_safe_json_and_decode_error():
    assert osync._safe_json("nope") is None
    assert osync._safe_json("[]") is None
    assert osync._safe_json('{"a": 1}') == {"a": 1}
    err = urllib.error.HTTPError("http://x", 500, "boom", {}, io.BytesIO(b"not json"))
    assert osync._decode_error(err) == ("HTTP Error 500: boom", None)
    err2 = urllib.error.HTTPError("http://x", 400, "bad", {}, io.BytesIO(b"[]"))
    message, code = osync._decode_error(err2)
    assert code is None


def test_drain_chunk_loops_when_claimable_but_unprocessed(tmp_path, monkeypatch):
    # drain_queue_once can return 0 while a claimable row remains (e.g. the
    # batch route was just marked unsupported); the loop must retry, not stall.
    repository = async_queue.AsyncQueueRepository(tmp_path / "queue.sqlite3", producer=False)
    repository.init_db()
    event = repository.prepare_event("POST", "/runs/r/metrics", {"metrics": {"m": 1}, "step": 1}, idempotency_key="k")
    repository.enqueue_many_prepared([event])
    calls = {"n": 0}

    def fake_drain(repo, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            return 0  # nothing processed, row still claimable
        if repo.has_pending():
            repo.mark_processed(1)
            return 1
        return 0

    monkeypatch.setattr(osync, "drain_queue_once", fake_drain)
    failed, pending = osync._drain_chunk(repository, 1, 1, "http://x.test", None, 1.0, {"remaining": 0.0})
    assert (failed, pending) == (0, 0)
    assert calls["n"] >= 2
    repository.close()


def test_cursor_helpers():
    delivered: dict = {}
    assert osync._cursor(delivered, "a") == -1
    osync._set_cursor(delivered, "a", 5)
    assert osync._cursor(delivered, "a") == 5
    osync._set_cursor(delivered, "a", 2)  # never regresses
    assert osync._cursor(delivered, "a") == 5
    delivered["b"] = "bad"
    assert osync._cursor(delivered, "b") == -1


# --------------------------------------------------------------------------- #
# CLI dispatch
# --------------------------------------------------------------------------- #


def test_cli_dispatch_offline_path(tmp_path, server, monkeypatch):
    run = _make_offline_run(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run_dir = run._offline.run_dir
    run.finish()
    with pytest.raises(SystemExit) as exc:
        cli_module.cmd_sync([str(run_dir), "--base-url", "http://x.test"])
    assert exc.value.code == 0


def test_cli_dispatch_offline_invalid(server):
    with pytest.raises(SystemExit) as exc:
        cli_module.cmd_sync(["/no/such/offline/dir"])
    assert exc.value.code == 5


def test_cli_sync_help_lists_offline_directory():
    from instantml.cli import _print_help
    import io as _io
    import contextlib

    buffer = _io.StringIO()
    with contextlib.redirect_stdout(buffer):
        _print_help()
    assert "RUN_DIR" in buffer.getvalue()
