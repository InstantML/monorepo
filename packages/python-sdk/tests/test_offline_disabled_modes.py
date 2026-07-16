"""Tests for native offline and disabled SDK modes (PR-03).

Design: docs/design/2026-07-15-offline-lifecycle-upload-completeness.md (§3, §4).
"""

from __future__ import annotations

import json
import os
import socket
import uuid
import warnings
from pathlib import Path

import pytest

import instantml as im
import instantml.client as client_module
from instantml import UnsupportedOfflineOperation
from instantml.client import (
    Run,
    _classify_event_class,
    _DisabledRun,
    _chmod_quietly,
    _fsync_dir,
    _host_hash,
    _resolve_data_root,
    _resolve_mode,
    _resolve_resume,
    _validate_run_id,
    deterministic_session_id,
)


@pytest.fixture()
def no_network(monkeypatch):
    """Prove offline mode never touches the network: any socket or HTTP use raises."""

    def _blocked_socket(*args, **kwargs):
        raise AssertionError("offline mode attempted to open a socket")

    def _blocked_urlopen(*args, **kwargs):
        raise AssertionError("offline mode attempted an HTTP request")

    monkeypatch.setattr(socket, "socket", _blocked_socket)
    monkeypatch.setattr(client_module._http_pool, "urlopen", _blocked_urlopen)
    monkeypatch.setattr(client_module.urllib.request, "urlopen", _blocked_urlopen)


def _segments(run_dir: Path) -> list[dict]:
    events: list[dict] = []
    for path in sorted((run_dir / "segments").glob("*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                events.append(json.loads(line))
    return events


def _offline_init(tmp_path, **kwargs):
    kwargs.setdefault("project", "demo")
    kwargs.setdefault("mode", "offline")
    kwargs.setdefault("data_dir", str(tmp_path))
    kwargs.setdefault("system_metrics", False)
    kwargs.setdefault("source_tracking", False)
    return im.init(**kwargs)


# --------------------------------------------------------------------------- #
# Mode / helper resolution
# --------------------------------------------------------------------------- #


def test_resolve_mode_precedence(monkeypatch):
    monkeypatch.delenv("INSTANTML_MODE", raising=False)
    assert _resolve_mode(None) == "online"
    assert _resolve_mode("offline") == "offline"
    monkeypatch.setenv("INSTANTML_MODE", "offline")
    assert _resolve_mode(None) == "offline"
    # explicit kwarg wins over env
    assert _resolve_mode("disabled") == "disabled"
    monkeypatch.setenv("INSTANTML_MODE", "")
    assert _resolve_mode(None) == "online"


def test_resolve_mode_rejects_unknown():
    with pytest.raises(ValueError, match="mode must be one of"):
        _resolve_mode("mirror")


def test_resolve_resume_mapping():
    assert _resolve_resume(None) == "create"
    assert _resolve_resume("never") == "create"
    assert _resolve_resume("must") == "resume"
    assert _resolve_resume("allow") == "auto"
    with pytest.raises(ValueError, match="resume must be one of"):
        _resolve_resume("sometimes")


def test_validate_run_id_canonicalizes_and_rejects():
    rid = "11111111-2222-3333-4444-555555555555"
    assert _validate_run_id(rid) == rid
    # uppercase is accepted and lowercased
    assert _validate_run_id(rid.upper()) == rid
    with pytest.raises(ValueError):
        _validate_run_id("not-a-uuid")
    with pytest.raises(ValueError):
        _validate_run_id("11111111222233334444555555555555")  # no dashes
    with pytest.raises(ValueError):
        _validate_run_id("")
    with pytest.raises(ValueError):
        _validate_run_id(None)  # type: ignore[arg-type]


def test_resolve_data_root(monkeypatch):
    monkeypatch.delenv("INSTANTML_DATA_DIR", raising=False)
    assert _resolve_data_root(None) == ".instantml"
    assert _resolve_data_root("/custom") == "/custom"
    monkeypatch.setenv("INSTANTML_DATA_DIR", "/from/env")
    assert _resolve_data_root(None) == "/from/env"
    assert _resolve_data_root("/arg/wins") == "/arg/wins"


def test_host_hash_handles_failure(monkeypatch):
    assert len(_host_hash()) == 16

    def _raise():
        raise OSError("no hostname")

    monkeypatch.setattr(client_module.socket, "gethostname", _raise)
    assert len(_host_hash()) == 16  # falls back to hashing ""


def test_classify_event_class_covers_all_routes():
    assert _classify_event_class("POST", "/runs/x/rank-metrics") == "rank_metrics"
    assert _classify_event_class("POST", "/runs/x/metrics") == "metrics"
    assert _classify_event_class("POST", "/api/runs/x/logs") == "logs"
    assert _classify_event_class("POST", "/api/runs/x/attributes") == "attributes"
    assert _classify_event_class("POST", "/api/runs/x/objects") == "objects"
    assert _classify_event_class("POST", "/api/runs/x/traces/events") == "traces"
    assert _classify_event_class("POST", "/api/runs/x/artifacts/upload") == "files"
    assert _classify_event_class("PATCH", "/runs/x") == "run_meta"
    assert _classify_event_class("POST", "/runs") == "run_meta"
    assert _classify_event_class("GET", "/health") == "run_meta"


def test_deterministic_session_id_stable_and_distinct(tmp_path):
    a = deterministic_session_id("run-1", "sdk", None, str(tmp_path))
    b = deterministic_session_id("run-1", "sdk", None, str(tmp_path))
    assert a == b
    assert uuid.UUID(a)  # valid UUID
    # A different rank, kind, run, or root yields a different session.
    assert deterministic_session_id("run-1", "sdk", 1, str(tmp_path)) != a
    assert deterministic_session_id("run-1", "uploader", None, str(tmp_path)) != a
    assert deterministic_session_id("run-2", "sdk", None, str(tmp_path)) != a
    assert deterministic_session_id("run-1", "sdk", None, str(tmp_path / "other")) != a


# --------------------------------------------------------------------------- #
# Offline end-to-end
# --------------------------------------------------------------------------- #


def test_offline_end_to_end_directory_and_envelopes(tmp_path, no_network):
    run = _offline_init(tmp_path, name="r", config={"lr": 0.1})
    for step in range(3):
        run.log_metrics({"loss": 1.0 / (step + 1)}, step=step)
    run.log_config({"batch": 32})
    run.set_tags(["a", "b"])
    run.log_console(["hello", "world"])
    run.log_histogram("grad", {"bins": [0, 1, 2], "counts": [3, 4]}, step=1)
    run.log_table_object("preds", ["x", "y"], [[1, 2], [3, 4]], step=1)
    source = tmp_path / "ckpt.bin"
    source.write_bytes(b"weights-123")
    run.upload_file(str(source), artifact_type="checkpoint", step=1)
    session_id = run._offline.session_id
    run_dir = run._offline.run_dir
    run.finish()

    # run.json schema
    manifest = json.loads((run_dir / "run.json").read_text())
    assert manifest["schema_version"] == 1
    assert manifest["run_id"] == run.run_id
    assert manifest["session_id"] == session_id
    assert manifest["producer"]["kind"] == "sdk"
    assert manifest["mode"] == "create"
    assert manifest["create_request"]["project"] == "demo"
    assert manifest["create_request"]["name"] == "r"
    assert manifest["finish"] == {
        "status": "finished",
        "at": manifest["finish"]["at"],
        "clean": True,
    }

    # counts match what was logged, per class
    counts = manifest["counts"]
    assert counts["metrics"] == {"attempted": 3, "queued": 3, "dropped": 0}
    assert counts["attributes"]["queued"] == 2  # config + histogram-series
    assert counts["run_meta"]["queued"] == 1  # set_tags (PATCH /runs)
    assert counts["logs"]["queued"] == 1
    assert counts["objects"]["queued"] == 1
    assert counts["files"]["queued"] == 1

    # segments parse; envelope carries session_id + class + persisted key
    events = _segments(run_dir)
    per_class_seq: dict[str, list[int]] = {}
    for event in events:
        assert event["session_id"] == session_id
        assert event["class"] in client_module.EVENT_CLASSES
        request = event["requests"][0]
        expected = f"instantml-{run.run_id}-{session_id[:8]}-{event['class']}-{event['sequence']}"
        assert request["idempotency_key"] == expected
        per_class_seq.setdefault(event["class"], []).append(event["sequence"])

    # sequences are per-class, starting at 1, contiguous
    for event_class, seqs in per_class_seq.items():
        assert seqs == list(range(1, len(seqs) + 1)), event_class

    # staged file bytes are readable and referenced by source_path
    file_event = next(e for e in events if e["class"] == "files")
    staged = Path(file_event["requests"][0]["body"]["source_path"])
    assert staged.parent == run_dir / "files"
    assert staged.read_bytes() == b"weights-123"


def test_offline_directory_permissions(tmp_path, no_network):
    if os.name == "nt":
        pytest.skip("chmod is a no-op on Windows")
    run = _offline_init(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run.finish()
    run_dir = run._offline.run_dir
    assert (os.stat(run_dir).st_mode & 0o777) == 0o700
    assert (os.stat(run_dir / "run.json").st_mode & 0o777) == 0o600


def test_offline_staged_file_deduplicates(tmp_path, no_network):
    run = _offline_init(tmp_path)
    source = tmp_path / "same.bin"
    source.write_bytes(b"identical")
    run.upload_file(str(source), step=1)
    run.upload_file(str(source), step=2)  # exercises the already-staged branch
    run.finish()
    staged = list((run._offline.run_dir / "files").glob("*"))
    assert len(staged) == 1


def test_offline_upload_status_reports_counts(tmp_path, no_network):
    run = _offline_init(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    status = run.upload_status()
    assert status["mode"] == "offline"
    assert status["counts"]["metrics"]["attempted"] == 1
    assert status["dropped"] == 0
    assert status["session_id"] == run._offline.session_id
    run.finish()


def test_offline_stop_request_is_noop(tmp_path, no_network):
    run = _offline_init(tmp_path)
    assert run.stop_request() is None
    assert run.should_stop() is False
    run.finish()


def test_offline_trace_events_recorded(tmp_path, no_network):
    run = _offline_init(tmp_path)
    run._submit_trace_event_batch([{"name": "span-a"}, {"name": "span-b"}])
    run.finish()
    events = _segments(run._offline.run_dir)
    trace_events = [e for e in events if e["class"] == "traces"]
    assert len(trace_events) == 1
    assert trace_events[0]["data"] == {"trace_events": 2}


def test_offline_request_or_spool_records_without_network(tmp_path, no_network):
    run = _offline_init(tmp_path)
    result = run._request_or_spool("POST", f"/api/runs/{run.run_id}/objects", {"key": "k"})
    assert result["offline"] is True
    run.finish()
    events = _segments(run._offline.run_dir)
    assert any(e["class"] == "objects" for e in events)


# --------------------------------------------------------------------------- #
# Restart continuation
# --------------------------------------------------------------------------- #


def test_offline_restart_continues_sequences(tmp_path, no_network):
    rid = "11111111-2222-3333-4444-555555555555"
    run1 = _offline_init(tmp_path, run_id=rid)
    for step in range(3):
        run1.log_metrics({"loss": step}, step=step)
    run1.flush()  # simulate a crash: segments flushed but no finish()
    session1 = run1._offline.session_id

    run2 = _offline_init(tmp_path, run_id=rid)
    session2 = run2._offline.session_id
    assert session1 == session2  # deterministic across restarts
    for step in range(3, 6):
        run2.log_metrics({"loss": step}, step=step)
    run2.finish()

    seqs = [e["sequence"] for e in _segments(run2._offline.run_dir) if e["class"] == "metrics"]
    keys = [
        e["requests"][0]["idempotency_key"]
        for e in _segments(run2._offline.run_dir)
        if e["class"] == "metrics"
    ]
    assert seqs == [1, 2, 3, 4, 5, 6]  # continued, no reuse
    assert len(set(keys)) == len(keys)  # no key reuse across restart


def test_offline_recovers_dropped_counts_from_prior_manifest(tmp_path, no_network):
    rid = "22222222-3333-4444-5555-666666666666"
    run1 = _offline_init(tmp_path, run_id=rid)
    run1.log_metrics({"loss": 1.0}, step=0)
    # Inject a prior dropped count into the manifest checkpoint.
    run1._offline._counts["metrics"]["dropped"] = 2
    run1._offline._counts["metrics"]["attempted"] = 3
    run1._offline._checkpoint()
    run1.flush()

    run2 = _offline_init(tmp_path, run_id=rid)
    counts = run2._offline.counts_snapshot()["metrics"]
    assert counts["dropped"] == 2
    assert counts["queued"] == 1  # recovered from the persisted segment
    assert counts["attempted"] == 3
    run2.finish()


def test_offline_recover_skips_corrupt_segment_lines(tmp_path, no_network):
    rid = "33333333-4444-5555-6666-777777777777"
    run1 = _offline_init(tmp_path, run_id=rid)
    run1.log_metrics({"loss": 1.0}, step=0)
    run1.flush()
    seg_dir = run1._offline.run_dir / "segments"
    # A blank line, a garbage line, a line without class/sequence, and a
    # directory named *.jsonl (read_text raises OSError).
    (seg_dir / "corrupt.jsonl").write_text("\nnot json\n{}\n", encoding="utf-8")
    (seg_dir / "isdir.jsonl").mkdir()
    # A corrupt prior manifest must not break restart recovery.
    (run1._offline.run_dir / "run.json").write_text("{not json", encoding="utf-8")

    run2 = _offline_init(tmp_path, run_id=rid)
    # Recovery tolerated the bad inputs and still saw the one real metric event.
    assert run2._offline.counts_snapshot()["metrics"]["queued"] == 1
    run2.finish()


def test_offline_directory_is_inert_after_finish(tmp_path, no_network):
    run = _offline_init(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run.finish()
    offline = run._offline
    # Post-close calls are inert no-ops (idempotent finish, late records).
    offline.record("POST", f"/runs/{run.run_id}/metrics", {}, {}, 0, "t")
    offline.flush()
    offline.finish("failed", clean=False)
    manifest = json.loads((offline.run_dir / "run.json").read_text())
    # Still the original clean finish; no late event was recorded.
    assert manifest["finish"]["status"] == "finished"
    assert manifest["counts"]["metrics"]["queued"] == 1


def test_offline_checkpoint_tmp_cleanup_failure_is_swallowed(tmp_path, no_network, monkeypatch):
    run = _offline_init(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    real_replace = os.replace

    def failing_replace(src, dst):
        if str(dst).endswith("run.json"):
            raise OSError("simulated disk full on manifest")
        return real_replace(src, dst)

    real_unlink = Path.unlink

    def failing_unlink(self, *args, **kwargs):
        if ".run.json.tmp" in self.name:
            raise OSError("cannot remove temp")
        return real_unlink(self, *args, **kwargs)

    monkeypatch.setattr(client_module.os, "replace", failing_replace)
    monkeypatch.setattr(Path, "unlink", failing_unlink)
    with pytest.warns(RuntimeWarning):
        run.finish()  # both the checkpoint and its temp cleanup fail, swallowed


# --------------------------------------------------------------------------- #
# Atomic run.json rewrite / rotation checkpoint
# --------------------------------------------------------------------------- #


def test_offline_checkpoints_counts_at_rotation(tmp_path, no_network, monkeypatch):
    monkeypatch.setattr(client_module, "_SPOOL_SEGMENT_ROTATE_EVENTS", 3)
    run = _offline_init(tmp_path)
    for step in range(7):
        run.log_metrics({"loss": step}, step=step)
    # No finish() yet: run.json reflects the rotation checkpoints, not a rescan.
    manifest = json.loads((run._offline.run_dir / "run.json").read_text())
    assert manifest["finish"] is None
    assert manifest["counts"]["metrics"]["queued"] >= 3
    run.finish()


def test_offline_run_json_rewrite_is_atomic(tmp_path, no_network):
    run = _offline_init(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run.finish()
    # No temp files left behind after atomic replace.
    leftovers = list(run._offline.run_dir.glob(".run.json.tmp*"))
    assert leftovers == []
    # run.json is valid JSON.
    json.loads((run._offline.run_dir / "run.json").read_text())


def test_offline_checkpoint_failure_warns_and_survives(tmp_path, no_network, monkeypatch):
    run = _offline_init(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    real_replace = os.replace

    def failing_replace(src, dst):
        if str(dst).endswith("run.json"):
            raise OSError("simulated disk full on manifest")
        return real_replace(src, dst)

    monkeypatch.setattr(client_module.os, "replace", failing_replace)
    with pytest.warns(RuntimeWarning):
        run.finish()  # segments still finalized; manifest checkpoint degraded


# --------------------------------------------------------------------------- #
# Disk-full / write-failure drop path
# --------------------------------------------------------------------------- #


def test_offline_drop_on_write_failure(tmp_path, no_network, monkeypatch):
    run = _offline_init(tmp_path)

    def failing_append(event, serialized):
        raise OSError("ENOSPC")

    monkeypatch.setattr(run._offline._writer, "append", failing_append)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        for step in range(5):
            run.log_metrics({"loss": step}, step=step)  # training loop stays alive
    counts = run._offline.counts_snapshot()["metrics"]
    assert counts == {"attempted": 5, "queued": 0, "dropped": 5}
    # Warning is rate-limited: not one per dropped event.
    drop_warnings = [w for w in caught if "dropped a metrics event" in str(w.message)]
    assert 1 <= len(drop_warnings) < 5
    assert run.upload_status()["dropped"] == 5
    run.finish()
    manifest = json.loads((run._offline.run_dir / "run.json").read_text())
    assert manifest["counts"]["metrics"]["dropped"] == 5


# --------------------------------------------------------------------------- #
# Finish / SIGTERM signatures
# --------------------------------------------------------------------------- #


def test_offline_finish_clean_true(tmp_path, no_network):
    run = _offline_init(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run.finish("finished")
    manifest = json.loads((run._offline.run_dir / "run.json").read_text())
    assert manifest["finish"]["status"] == "finished"
    assert manifest["finish"]["clean"] is True


def test_offline_lifecycle_flush_writes_clean_false(tmp_path, no_network):
    run = _offline_init(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    # Simulate the SIGTERM/SIGINT lifecycle flush signature.
    client_module._flush_active_runs("failed", clean=False)
    manifest = json.loads((run._offline.run_dir / "run.json").read_text())
    assert manifest["finish"]["status"] == "failed"
    assert manifest["finish"]["clean"] is False
    # A subsequent explicit finish() is a no-op (already finished).
    run.finish()


def test_offline_hard_kill_leaves_finish_null(tmp_path, no_network):
    run = _offline_init(tmp_path)
    run.log_metrics({"loss": 1.0}, step=0)
    run.flush()  # bytes durable, but the process never finished
    manifest = json.loads((run._offline.run_dir / "run.json").read_text())
    assert manifest["finish"] is None
    run.finish()


# --------------------------------------------------------------------------- #
# Unsupported offline operations
# --------------------------------------------------------------------------- #


def test_offline_unsupported_operations_raise(tmp_path, no_network):
    run = _offline_init(tmp_path)
    img = tmp_path / "img.png"
    img.write_bytes(b"\x89PNG\r\n")
    with pytest.raises(UnsupportedOfflineOperation, match="media"):
        run.log_image("pic", str(img), step=1)
    with pytest.raises(UnsupportedOfflineOperation, match="versioned"):
        run.log_versioned_artifact(im.VersionedArtifact(name="model", type="model"))
    with pytest.raises(UnsupportedOfflineOperation, match="use_artifact"):
        run.use_artifact("model:latest")
    run.finish()


# --------------------------------------------------------------------------- #
# System metrics / console capture wiring in offline init
# --------------------------------------------------------------------------- #


def test_offline_init_with_system_metrics_and_console(tmp_path, no_network):
    run = im.init(
        project="demo",
        mode="offline",
        data_dir=str(tmp_path),
        system_metrics=True,
        system_metrics_interval=3600.0,
        capture_console=True,
        source_tracking=False,
    )
    assert run._system_sampler is not None
    assert run._console_capture is not None
    run.finish()


def test_offline_init_survives_optional_setup_failures(tmp_path, no_network, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("sampler unavailable")

    monkeypatch.setattr(Run, "start_system_metrics", boom)
    monkeypatch.setattr(Run, "capture_console", boom)
    with pytest.warns(RuntimeWarning):
        run = im.init(
            project="demo",
            mode="offline",
            data_dir=str(tmp_path),
            system_metrics=True,
            capture_console=True,
            source_tracking=False,
        )
    run.finish()


def test_offline_upload_mode_ignored_logs_debug(tmp_path, no_network, caplog):
    import logging

    with caplog.at_level(logging.DEBUG, logger="instantml"):
        run = _offline_init(tmp_path, upload_mode="sync")
    assert any("is ignored in mode" in record.message for record in caplog.records)
    run.finish()


# --------------------------------------------------------------------------- #
# Disabled mode
# --------------------------------------------------------------------------- #


def test_disabled_mode_no_network_disk_or_handlers(tmp_path, monkeypatch):
    signal_calls: list = []
    monkeypatch.setattr(client_module.signal, "signal", lambda *a, **k: signal_calls.append(a))

    def _blocked_socket(*args, **kwargs):
        raise AssertionError("disabled mode opened a socket")

    monkeypatch.setattr(socket, "socket", _blocked_socket)

    open_calls: list = []
    real_makedirs = os.makedirs
    monkeypatch.setattr(os, "makedirs", lambda *a, **k: (open_calls.append(a), real_makedirs(*a, **k)))

    run = im.init(project="demo", mode="disabled")
    assert isinstance(run, _DisabledRun)
    assert isinstance(run, Run)
    assert run.run_id  # generated for API-shape parity
    assert signal_calls == []  # no lifecycle handlers installed
    assert run not in client_module._active_runs_snapshot()
    assert open_calls == []  # no directories created


def test_disabled_mode_env_precedence(monkeypatch):
    monkeypatch.setenv("INSTANTML_MODE", "disabled")
    monkeypatch.delenv("INSTANTML_API_KEY", raising=False)  # no credentials needed
    run = im.init(project="demo")
    assert isinstance(run, _DisabledRun)


def test_disabled_mode_run_id_from_env(monkeypatch):
    rid = "44444444-5555-6666-7777-888888888888"
    monkeypatch.setenv("INSTANTML_RUN_ID", rid)
    run = im.init(project="demo", mode="disabled")
    assert run.run_id == rid


def test_disabled_mode_full_surface_is_inert(tmp_path):
    run = im.init(project="demo", mode="disabled")
    # Scalars / metrics
    assert run.log({"a": 1}) is None
    assert run.log_metrics({"loss": 1.0}, step=1) is None
    assert run.log_rank_metrics({"loss": 1.0}, step=1, rank=0, world_size=1) is None
    assert run.log_snapshot({"metrics": {"a": 1}}) is None
    assert run.log_config({"lr": 0.1}) is None
    assert run.log_text({"k": "v"}) is None
    assert run.log_histogram("h", {"bins": [0, 1], "counts": [1]}, step=1) is None
    assert run.log_console(["l"]) is None
    assert run.log_stdout(["l"]) is None
    assert run.log_stderr(["l"]) is None
    # Tags / notes
    assert run.add_tags(["t"]) is None
    assert run.set_tags(["t"]) is None
    assert run.set_notes("n") is None
    # Rich objects
    assert run.log_objects({}) == []
    assert run.log_classification_eval("k", y_true=[0], y_score=[0.1]) == {}
    assert run.log_table_object("k", ["c"], [[1]]) == {}
    assert run.log_image("k", "p") == {}
    assert run.log_audio("k", "p") == {}
    assert run.log_video_object("k", "p") == {}
    # Artifacts / files
    assert run.log_artifact("n", "file://x") == {}
    assert run.log_versioned_artifact(object()) is None
    assert run.use_artifact("x") is None
    assert run.upload_file("p") == {}
    assert run.log_checkpoint("n", "file://x", 1) == {}
    assert run.log_checkpoint_file("p", 1) == {}
    assert run.log_rollout("n", "file://x", 1) == {}
    assert run.log_video("n", "file://x", 1) == {}
    assert run.log_table("n", "file://x") == {}
    assert run.log_file("n", "file://x") == {}
    assert run.log_files({"n": "file://x"}, step=1) == []
    # Model / system / console
    handle = run.watch(object())
    handle.remove()
    assert run.start_system_metrics() is None
    assert run.capture_console() is None
    # Status / waits
    assert run.upload_status() == {"mode": "disabled"}
    assert run.wait_for_init() == run.run_id
    assert run.wait_for_submission() is True
    assert run.wait_for_processing() is True
    assert run.replay_offline() == 0
    # Cooperative stop
    assert run.stop_request() is None
    assert run.should_stop() is False
    assert run.raise_if_stop_requested() is None
    # Lifecycle internals
    assert run._finish_from_lifecycle("finished") is None
    assert run._reset_after_fork() is None
    assert run.flush() is None
    assert run.finish() is None
    assert run.finish_stopped() is None


def test_disabled_mode_tracing_is_inert(tmp_path):
    run = im.init(project="demo", mode="disabled")
    with run.trace("span") as span:
        span.set_attributes({"k": "v"})
        span.anything_at_all(1, 2)
        span()  # callable no-op
    with run.start_span("span2") as span2:
        span2.end()
    ctx = run.attach_trace_context({})
    with ctx:
        pass

    @run.trace_op(name="op")
    def add(a, b):
        return a + b

    assert add(2, 3) == 5


def test_disabled_mode_context_manager(tmp_path):
    with im.init(project="demo", mode="disabled") as run:
        run.log_metrics({"loss": 1.0}, step=1)
    assert run._finished is True


# --------------------------------------------------------------------------- #
# Online mode: client run id / resume propagation (server support lands in PR-02)
# --------------------------------------------------------------------------- #


def test_online_passes_id_and_mode_in_create_body(monkeypatch):
    captured = {}

    def fake_request(self, method, path, body=None, idempotency_key=None, retry_rate_limits=True):
        captured["method"] = method
        captured["path"] = path
        captured["body"] = body
        return {"run": {"id": body["id"]}}

    monkeypatch.setattr(client_module.Client, "_request", fake_request)
    rid = "55555555-6666-7777-8888-999999999999"
    run = im.init(
        project="demo",
        run_id=rid,
        resume="allow",
        upload_mode="sync",
        async_init=False,
        system_metrics=False,
        source_tracking=False,
    )
    assert captured["path"] == "/runs"
    assert captured["body"]["id"] == rid
    assert captured["body"]["mode"] == "auto"
    run._finished = True


def test_online_resume_without_run_id_sets_mode_only(monkeypatch):
    captured = {}

    def fake_request(self, method, path, body=None, idempotency_key=None, retry_rate_limits=True):
        captured["body"] = body
        return {"run": {"id": "server-generated"}}

    monkeypatch.setattr(client_module.Client, "_request", fake_request)
    run = im.init(
        project="demo",
        resume="must",
        upload_mode="sync",
        async_init=False,
        system_metrics=False,
        source_tracking=False,
    )
    assert "id" not in captured["body"]
    assert captured["body"]["mode"] == "resume"
    run._finished = True


def test_online_run_id_from_env_is_validated(monkeypatch):
    monkeypatch.setenv("INSTANTML_RUN_ID", "not-a-uuid")
    with pytest.raises(ValueError, match="canonical"):
        im.init(project="demo", upload_mode="sync", async_init=False, system_metrics=False)


# --------------------------------------------------------------------------- #
# _fsync_dir / _chmod_quietly hardening (design nit #12)
# --------------------------------------------------------------------------- #


def test_fsync_dir_tolerates_open_failure(monkeypatch):
    monkeypatch.setattr(client_module, "_FSYNC_DIR_WARNED", False)
    with pytest.warns(RuntimeWarning, match="durability"):
        _fsync_dir(Path("/nonexistent/path/for/fsync"))


def test_fsync_dir_tolerates_fsync_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(client_module, "_FSYNC_DIR_WARNED", False)

    def failing_fsync(fd):
        raise OSError("fsync not supported")

    monkeypatch.setattr(client_module.os, "fsync", failing_fsync)
    with pytest.warns(RuntimeWarning, match="durability"):
        _fsync_dir(tmp_path)


def test_chmod_quietly_ignores_errors(tmp_path, monkeypatch):
    def failing_chmod(path, mode):
        raise OSError("no chmod")

    monkeypatch.setattr(client_module.os, "chmod", failing_chmod)
    _chmod_quietly(tmp_path, 0o700)  # must not raise
