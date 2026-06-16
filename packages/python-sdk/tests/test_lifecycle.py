"""Tests for SDK process-lifecycle safety: async warn-and-drop validation,
idempotent finish, atexit/signal flushing, and fork-safe connection reset."""

import signal

import pytest

import instantml.client as client_module
from instantml.client import (
    InstantMLError,
    InstantMLStopRequested,
    Run,
    StopRequest,
    _LocalStore,
)


class _RecordingClient:
    base_url = "http://example.test"
    timeout = 1.0
    offline_dir = None

    def __init__(self):
        self.requests = []

    def _resolve_api_key(self):
        return None

    def _request(self, method, path, body=None, **kwargs):
        self.requests.append((method, path, body, kwargs))
        return {"run": {"id": "run-1"}}


class _StopClient(_RecordingClient):
    def __init__(self, requested=True):
        super().__init__()
        self.requested = requested

    def _request(self, method, path, body=None, **kwargs):
        self.requests.append((method, path, body, kwargs))
        if path.endswith("/stop-signal"):
            return {
                "run_id": "run-1",
                "run_status": "running",
                "terminal": False,
                "stop_requested": self.requested,
                "poll_after_seconds": 60,
                "stop_request": {
                    "stop_request_id": "stop-1",
                    "requested_at": "2026-06-08T20:15:00Z",
                    "acknowledged_at": None,
                },
            }
        return {
            "run_id": "run-1",
            "run_control": {"stop_state": body.get("state") if body else "none"},
        }


class _UnsupportedStopClient(_RecordingClient):
    def _request(self, method, path, body=None, **kwargs):
        self.requests.append((method, path, body, kwargs))
        if path.endswith("/stop-signal"):
            raise InstantMLError("GET /api/runs/run-1/stop-signal failed: 404 not found")
        return {
            "run_id": "run-1",
            "run_control": {"stop_state": body.get("state") if body else "none"},
        }


def _request_triplet(request):
    return request[:3]


# --- Async hot path: validation warns-and-drops instead of raising ---------


def test_async_log_warns_and_drops_invalid_payload(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)
    run = Run(
        client=_RecordingClient(),
        run_id="run-1",
        upload_mode="async",
        queue_dir=str(tmp_path),
    )
    try:
        with pytest.warns(RuntimeWarning, match="dropped an invalid payload"):
            run.log({"loss": float("nan")})
        # Subsequent drops are warn-rate-limited but still counted.
        run.log({"weights": object()})
        run.log_metrics({"loss": float("inf")}, step=1)
        run.log_rank_metrics({"x": float("nan")}, step=1, rank=0, world_size=1)
        run.log_console(123)
        assert run.upload_status()["dropped"] >= 5
        # A valid metric still queues normally.
        run.log_metrics({"ok": 1.0}, step=2)
        assert run.upload_status()["pending"] == 1
    finally:
        run.finish("finished", timeout=0)


def test_sync_log_still_raises_invalid_payload():
    run = Run(client=_RecordingClient(), run_id="run-1", upload_mode="sync")
    try:
        with pytest.raises(TypeError):
            run.log({"loss": float("nan")})
        with pytest.raises(TypeError):
            run.log_metrics({"loss": float("nan")}, step=1)
    finally:
        run.finish()


# --- finish() is idempotent ------------------------------------------------


def test_finish_is_idempotent():
    client = _RecordingClient()
    run = Run(client=client, run_id="run-1", upload_mode="sync")
    run.finish("finished")
    run.finish("finished")
    run.finish("failed")
    patches = [
        _request_triplet(request) for request in client.requests if request[0] == "PATCH"
    ]
    assert patches == [("PATCH", "/runs/run-1", {"status": "finished"})]


def test_raise_if_stop_requested_acknowledges_before_raising(monkeypatch):
    client = _RecordingClient()
    stop_client = _StopClient()
    run = Run(client=client, run_id="run-1", upload_mode="sync")
    monkeypatch.setattr(run, "_stop_client", lambda: stop_client)

    with pytest.raises(InstantMLStopRequested) as exc_info:
        run.raise_if_stop_requested()

    assert exc_info.value.stop_request_id == "stop-1"
    assert _request_triplet(stop_client.requests[-1]) == (
        "POST",
        "/api/runs/run-1/stop-ack",
        {"stop_request_id": "stop-1", "state": "acknowledged"},
    )
    assert stop_client.requests[-1][3]["retry_rate_limits"] is False
    run.finish("failed")


def test_finish_stopped_completes_stop_and_legacy_failed(monkeypatch):
    client = _RecordingClient()
    stop_client = _StopClient()
    run = Run(client=client, run_id="run-1", upload_mode="sync")
    monkeypatch.setattr(run, "_stop_client", lambda: stop_client)

    run.finish_stopped(message="safe checkpoint")

    assert (
        "POST",
        "/api/runs/run-1/stop-ack",
        {"stop_request_id": "stop-1", "state": "completed", "message": "safe checkpoint"},
    ) in [_request_triplet(request) for request in stop_client.requests]
    completed_ack = next(request for request in stop_client.requests if request[2] and request[2].get("state") == "completed")
    assert completed_ack[3]["retry_rate_limits"] is False
    assert ("PATCH", "/runs/run-1", {"status": "failed"}) in [
        _request_triplet(request) for request in client.requests
    ]


def test_finish_stopped_does_not_raise_when_legacy_patch_fails(monkeypatch):
    class _PatchFailClient(_RecordingClient):
        def _request(self, method, path, body=None, **kwargs):
            self.requests.append((method, path, body, kwargs))
            if method == "PATCH":
                raise InstantMLError("PATCH /runs/run-1 failed: HTTP 402: billing required")
            return {"run": {"id": "run-1"}}

    client = _PatchFailClient()
    stop_client = _StopClient()
    run = Run(client=client, run_id="run-1", upload_mode="sync")
    monkeypatch.setattr(run, "_stop_client", lambda: stop_client)

    run.finish_stopped(message="safe checkpoint")

    assert run._is_finished()
    assert (
        "POST",
        "/api/runs/run-1/stop-ack",
        {"stop_request_id": "stop-1", "state": "completed", "message": "safe checkpoint"},
    ) in [_request_triplet(request) for request in stop_client.requests]
    assert ("PATCH", "/runs/run-1", {"status": "failed"}) in [
        _request_triplet(request) for request in client.requests
    ]


def test_lifecycle_finishes_stopped_after_stop_request(monkeypatch):
    client = _RecordingClient()
    stop_client = _StopClient()
    run = Run(client=client, run_id="run-1", upload_mode="sync")
    monkeypatch.setattr(run, "_stop_client", lambda: stop_client)
    run._stop_request = StopRequest("run-1", "stop-1")

    run._finish_from_lifecycle("finished")

    assert (
        "POST",
        "/api/runs/run-1/stop-ack",
        {"stop_request_id": "stop-1", "state": "completed"},
    ) in [_request_triplet(request) for request in stop_client.requests]
    assert ("PATCH", "/runs/run-1", {"status": "failed"}) in [
        _request_triplet(request) for request in client.requests
    ]


def test_top_level_init_forwards_stop_interval(monkeypatch):
    captured = {}

    def fake_init(self, **kwargs):
        captured.update(kwargs)
        return "run"

    monkeypatch.setattr(client_module.Client, "init", fake_init)

    assert (
        client_module.init(
            project="p",
            api_key="instantml_test",
            stop_check_interval_seconds=0,
        )
        == "run"
    )
    assert captured["stop_check_interval_seconds"] == 0


def test_top_level_attach_run_forwards_stop_interval(monkeypatch):
    captured = {}

    def fake_attach(self, run_id, **kwargs):
        captured["run_id"] = run_id
        captured.update(kwargs)
        return "run"

    monkeypatch.setattr(client_module.Client, "attach_run", fake_attach)

    assert (
        client_module.attach_run(
            "run-1",
            api_key="instantml_test",
            stop_check_interval_seconds=2.5,
        )
        == "run"
    )
    assert captured["run_id"] == "run-1"
    assert captured["stop_check_interval_seconds"] == 2.5


def test_raise_if_stop_requested_respects_poll_interval(monkeypatch):
    client = _RecordingClient()
    stop_client = _StopClient(requested=False)
    run = Run(
        client=client,
        run_id="run-1",
        upload_mode="sync",
        stop_check_interval_seconds=60,
    )
    monkeypatch.setattr(run, "_stop_client", lambda: stop_client)

    assert run.should_stop() is False
    run.raise_if_stop_requested()

    stop_signal_requests = [
        request for request in stop_client.requests if request[1].endswith("/stop-signal")
    ]
    assert len(stop_signal_requests) == 1
    assert stop_signal_requests[0][3]["retry_rate_limits"] is False
    run.finish("failed")


def test_stop_poll_uses_server_poll_after_seconds(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(client_module.time, "monotonic", lambda: now[0])
    jitter_calls = []

    def fake_jitter(lower, upper):
        jitter_calls.append((lower, upper))
        return 6.0

    monkeypatch.setattr(client_module.random, "uniform", fake_jitter)
    client = _RecordingClient()
    stop_client = _StopClient(requested=False)
    run = Run(
        client=client,
        run_id="run-1",
        upload_mode="sync",
        stop_check_interval_seconds=0.01,
    )
    monkeypatch.setattr(run, "_stop_client", lambda: stop_client)

    assert run.should_stop() is False
    now[0] += 1.0
    run.raise_if_stop_requested()

    stop_signal_requests = [
        request for request in stop_client.requests if request[1].endswith("/stop-signal")
    ]
    assert len(stop_signal_requests) == 1
    assert jitter_calls == [(-6.0, 6.0)]
    assert run._next_stop_check_at == 166.0
    run.finish("failed")


def test_raise_if_stop_requested_caches_unsupported_old_server(monkeypatch):
    client = _RecordingClient()
    stop_client = _UnsupportedStopClient()
    run = Run(
        client=client,
        run_id="run-1",
        upload_mode="sync",
        stop_check_interval_seconds=0.01,
    )
    monkeypatch.setattr(run, "_stop_client", lambda: stop_client)

    run.raise_if_stop_requested()
    run.raise_if_stop_requested()

    stop_signal_requests = [
        request for request in stop_client.requests if request[1].endswith("/stop-signal")
    ]
    assert len(stop_signal_requests) == 1
    run.finish("failed")


def test_stop_check_interval_zero_disables_raise_polling(monkeypatch):
    client = _RecordingClient()
    stop_client = _StopClient()
    run = Run(
        client=client,
        run_id="run-1",
        upload_mode="sync",
        stop_check_interval_seconds=0,
    )
    monkeypatch.setattr(run, "_stop_client", lambda: stop_client)

    run.raise_if_stop_requested()

    assert stop_client.requests == []
    run.finish("failed")


# --- atexit / signal lifecycle flushing ------------------------------------


def test_atexit_flush_finishes_and_unregisters_active_runs():
    client = _RecordingClient()
    run = Run(client=client, run_id="run-1", upload_mode="sync")
    assert run in client_module._active_runs_snapshot()
    client_module._atexit_flush()
    patches = [
        _request_triplet(request) for request in client.requests if request[0] == "PATCH"
    ]
    assert patches[-1] == ("PATCH", "/runs/run-1", {"status": "finished"})
    assert run not in client_module._active_runs_snapshot()


def test_finish_from_lifecycle_handles_all_states(monkeypatch):
    client = _RecordingClient()

    # Success path then early-return when already finished.
    run = Run(client=client, run_id="run-1", upload_mode="sync")
    run._finish_from_lifecycle("finished")
    assert run._is_finished()
    assert ("PATCH", "/runs/run-1", {"status": "finished"}) in [
        _request_triplet(request) for request in client.requests
    ]
    run._finish_from_lifecycle("failed")  # no-op, already finished

    # Init resolved with an error -> skipped without finishing.
    errored = Run(client=client, run_id=client_module._PENDING_RUN_ID, upload_mode="sync")
    errored._init_done.set()
    errored._init_error = RuntimeError("boom")
    errored._finish_from_lifecycle("finished")
    assert not errored._is_finished()
    client_module._unregister_active_run(errored)

    # Init never resolves -> skipped after the grace period.
    pending = Run(client=client, run_id=client_module._PENDING_RUN_ID, upload_mode="sync")
    monkeypatch.setattr(pending._init_done, "wait", lambda timeout=None: False)
    pending._finish_from_lifecycle("finished")
    assert not pending._is_finished()
    client_module._unregister_active_run(pending)

    # finish() raising is swallowed so shutdown stays best-effort.
    class _BoomClient(_RecordingClient):
        def _request(self, method, path, body=None):
            raise client_module.InstantMLError("network down")

    boom = Run(client=_BoomClient(), run_id="run-2", upload_mode="sync")
    boom._finish_from_lifecycle("failed")


def test_flush_active_runs_swallows_errors(monkeypatch):
    class _Boom:
        def _finish_from_lifecycle(self, status):
            raise RuntimeError("nope")

    monkeypatch.setattr(client_module, "_active_runs_snapshot", lambda: [_Boom()])
    client_module._flush_active_runs("finished")  # must not raise


def test_termination_signal_chains_to_previous_handler(monkeypatch):
    called = []
    monkeypatch.setitem(
        client_module._PREVIOUS_SIGNAL_HANDLERS,
        signal.SIGTERM,
        lambda signum, frame: called.append((signum, frame)),
    )
    client_module._handle_termination_signal(signal.SIGTERM, None)
    assert called == [(signal.SIGTERM, None)]


def test_termination_signal_respects_sig_ign(monkeypatch):
    monkeypatch.setitem(client_module._PREVIOUS_SIGNAL_HANDLERS, signal.SIGTERM, signal.SIG_IGN)
    client_module._handle_termination_signal(signal.SIGTERM, None)  # returns without raising


def test_termination_signal_reraises_on_default(monkeypatch):
    monkeypatch.setitem(client_module._PREVIOUS_SIGNAL_HANDLERS, signal.SIGTERM, signal.SIG_DFL)
    reset = []
    killed = []
    monkeypatch.setattr(client_module.signal, "signal", lambda sig, handler: reset.append((sig, handler)))
    monkeypatch.setattr(client_module.os, "kill", lambda pid, sig: killed.append((pid, sig)))
    client_module._handle_termination_signal(signal.SIGTERM, None)
    assert reset == [(signal.SIGTERM, signal.SIG_DFL)]
    assert killed and killed[0][1] == signal.SIGTERM


def test_install_lifecycle_handlers_is_idempotent():
    client_module._install_lifecycle_handlers()  # already installed -> early return


def test_install_lifecycle_handlers_survives_signal_errors(monkeypatch):
    monkeypatch.setattr(client_module, "_LIFECYCLE_INSTALLED", False)
    monkeypatch.setattr(client_module.atexit, "register", lambda fn: None)
    monkeypatch.setattr(client_module.os, "register_at_fork", lambda **kwargs: None)

    def _boom(signum, handler):
        raise ValueError("signal only works in the main thread")

    monkeypatch.setattr(client_module.signal, "signal", _boom)
    client_module._install_lifecycle_handlers()
    assert client_module._LIFECYCLE_INSTALLED is True


# --- Fork safety: reset inherited connections / locks in the child ---------


def test_reset_after_fork_resets_connections(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)
    store = _LocalStore(str(tmp_path / "local"), "run-1")
    run = Run(
        client=_RecordingClient(),
        run_id="run-1",
        upload_mode="async",
        queue_dir=str(tmp_path / "q"),
        _local_store=store,
    )
    try:
        queue = run._async_queue
        assert queue._connection is not None
        old_lock = run._lock
        old_buffer = run._async_buffer
        # The parent's connections are dropped (not closed) on purpose; capture
        # them so this in-process test can close the orphaned handles itself.
        orphaned_queue_conn = queue._connection
        orphaned_store_conn = store._connection
        run._async_process = object()  # pretend we hold the parent's uploader handle

        run._reset_after_fork()

        assert run._lock is not old_lock
        assert run._async_process is None
        assert queue._connection is None
        assert run._async_buffer is not old_buffer
        # The local store is reopened with a fresh per-process connection.
        store.record_metrics("run-1", 2, {"y": 2.0}, "2026-01-01T00:00:00Z")
        orphaned_queue_conn.close()
        orphaned_store_conn.close()
    finally:
        run.finish("finished", timeout=0)


def test_after_fork_child_resets_registered_runs(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)
    run = Run(client=_RecordingClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path / "q"))
    try:
        queue = run._async_queue
        assert queue._connection is not None
        orphaned_conn = queue._connection
        client_module._before_fork()
        client_module._after_fork_child()
        assert queue._connection is None
        orphaned_conn.close()
    finally:
        run.finish("finished", timeout=0)


def test_after_fork_child_swallows_reset_errors(monkeypatch):
    run = Run(client=_RecordingClient(), run_id="run-1", upload_mode="sync")

    def _raise():
        raise RuntimeError("boom")

    monkeypatch.setattr(run, "_reset_after_fork", _raise)
    try:
        client_module._before_fork()
        client_module._after_fork_child()  # must not raise
    finally:
        run.finish()


def test_after_fork_parent_releases_lock():
    client_module._before_fork()
    client_module._after_fork_parent()
    assert client_module._ACTIVE_RUNS_LOCK.acquire(blocking=False)
    client_module._ACTIVE_RUNS_LOCK.release()
