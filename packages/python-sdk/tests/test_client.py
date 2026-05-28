import json
import os
import stat
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
from io import BytesIO
from types import ModuleType, SimpleNamespace

import pytest

import instantml as ro
import instantml.async_queue as async_queue
import instantml.client as client_module
import instantml.source as source_module
import instantml.uploader as uploader
from instantml.async_queue import AsyncQueueRepository, DeliveryResult, EnqueueBatchResult, drain_queue_once
from instantml.client import (
    Client,
    InstantMLError,
    Run,
    SourceTracking,
    _ConsoleStream,
    _LocalStore,
    _check_credentials_or_raise,
    _classify_log_payload,
    _coerce_numeric_values,
    _collect_system_metrics,
    _environment_metadata,
    _git_metadata,
    _normalize_source_tracking,
    _source_metadata,
    _write_audio_data,
    _write_image_data,
    _write_video_data,
)
from instantml_api.server import create_server


@pytest.fixture()
def api_server(tmp_path):
    server = create_server(tmp_path / "test.sqlite3", port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    try:
        yield base_url
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_client_defaults_to_hosted_api_when_env_unset(monkeypatch):
    monkeypatch.delenv("INSTANTML_API_BASE_URL", raising=False)
    assert ro.Client().base_url == "https://api.instantml.ai"
    assert ro.Api().base_url == "https://api.instantml.ai"


def test_client_base_url_respects_env_override(monkeypatch):
    monkeypatch.setenv("INSTANTML_API_BASE_URL", "http://127.0.0.1:8000")
    assert ro.Client().base_url == "http://127.0.0.1:8000"
    assert ro.Api().base_url == "http://127.0.0.1:8000"


def test_client_default_http_timeout_has_cold_path_headroom():
    # The default must cover the first cold-path request, which can spend
    # multiple seconds on warehouse routing + ClickHouse migrate work.
    # The old 2.0s default timed out real users before warmup finished;
    # 10s is generous for cold start while still failing fast on a
    # genuinely unreachable backend.
    assert ro.Client().timeout >= 10.0
    assert ro.Api().timeout >= 10.0


def test_api_runs_builds_expected_query_string(monkeypatch):
    calls = []

    def fake_request(self, method, path, body=None, idempotency_key=None):
        calls.append((self, method, path, body, idempotency_key))
        return {"runs": [], "total": 0}

    monkeypatch.setattr(Client, "_request", fake_request)
    page = ro.Api(base_url="http://example.test", timeout=3, api_key="secret").runs(
        limit=50,
        offset=0,
        project="demo",
        project_id="",
        status=None,
        q="seed 13",
        sort_by="metric-best",
        metric_key="eval/return_mean",
    )

    parsed = urllib.parse.urlsplit(calls[0][2])
    params = urllib.parse.parse_qs(parsed.query)
    assert page == {"runs": [], "total": 0}
    assert calls[0][0].base_url == "http://example.test"
    assert calls[0][0].timeout == 3
    assert calls[0][0].api_key == "secret"
    assert calls[0][1] == "GET"
    assert parsed.path == "/api/runs/summary"
    assert params == {
        "limit": ["50"],
        "offset": ["0"],
        "project": ["demo"],
        "q": ["seed 13"],
        "sort_by": ["metric-best"],
        "metric_key": ["eval/return_mean"],
    }
    assert calls[0][3] is None
    assert calls[0][4] is None


def test_api_runs_rejects_cursor_with_nonzero_offset():
    with pytest.raises(ValueError, match="nonzero offset"):
        ro.Api(base_url="http://example.test").runs(cursor="page-2", offset=25)


def test_api_runs_reuses_client_request_auth_timeout_and_returns_payload(monkeypatch):
    captured = {}

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def read(self):
            return b'{"runs": [{"id": "run-1"}], "next_cursor": null}'

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["method"] = request.get_method()
        captured["authorization"] = request.get_header("Authorization")
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

    page = ro.Api(base_url="http://example.test", timeout=4, api_key="secret").runs(limit=1)

    assert page == {"runs": [{"id": "run-1"}], "next_cursor": None}
    assert captured == {
        "url": "http://example.test/api/runs/summary?limit=1",
        "method": "GET",
        "authorization": "Bearer secret",
        "timeout": 4,
    }


def test_api_download_artifact_writes_bytes_with_auth(monkeypatch, tmp_path):
    captured = {}

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def read(self):
            return b"checkpoint bytes"

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["method"] = request.get_method()
        captured["authorization"] = request.get_header("Authorization")
        captured["accept"] = request.get_header("Accept")
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    target = tmp_path / "downloads" / "checkpoint.json"

    written = ro.Api(base_url="http://example.test/", timeout=7, api_key="secret").download_artifact("artifact/1", target)

    assert written == str(target)
    assert target.read_bytes() == b"checkpoint bytes"
    assert captured == {
        "url": "http://example.test/api/artifacts/artifact%2F1/download",
        "method": "GET",
        "authorization": "Bearer secret",
        "accept": "application/octet-stream",
        "timeout": 7,
    }


def test_api_download_artifact_accepts_directory_destinations(monkeypatch, tmp_path):
    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def read(self):
            return b"bytes"

    monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: FakeResponse())
    api = ro.Api(base_url="http://example.test")
    existing_dir = tmp_path / "existing"
    existing_dir.mkdir()
    trailing_dir = tmp_path / "trailing"

    existing_target = api.download_artifact("artifact-existing", existing_dir)
    trailing_target = api.download_artifact("artifact-trailing", f"{trailing_dir}/")

    assert existing_target == str(existing_dir / "artifact-existing")
    assert trailing_target == str(trailing_dir / "artifact-trailing")
    assert (existing_dir / "artifact-existing").read_bytes() == b"bytes"
    assert (trailing_dir / "artifact-trailing").read_bytes() == b"bytes"


def test_api_download_artifact_reports_bad_paths_and_network_errors(monkeypatch, tmp_path):
    api = ro.Api(base_url="http://example.test")

    with pytest.raises(TypeError, match="output_path"):
        api.download_artifact("artifact-1", 123)

    def raise_http(*_args, **_kwargs):
        raise urllib.error.HTTPError(
            "http://example.test/api/artifacts/artifact-1/download",
            403,
            "Forbidden",
            {},
            BytesIO(b'{"error":"download denied"}'),
        )

    monkeypatch.setattr("urllib.request.urlopen", raise_http)
    with pytest.raises(InstantMLError, match="download denied"):
        api.download_artifact("artifact-1", tmp_path / "denied.bin")

    def raise_url(*_args, **_kwargs):
        raise urllib.error.URLError("offline")

    monkeypatch.setattr("urllib.request.urlopen", raise_url)
    with pytest.raises(InstantMLError, match="offline"):
        api.download_artifact("artifact-1", tmp_path / "offline.bin")


def test_api_runs_raises_instantml_error_for_invalid_json(monkeypatch):
    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def read(self):
            return b"not-json"

    monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: FakeResponse())
    with pytest.raises(InstantMLError, match="invalid JSON"):
        ro.Api(base_url="http://example.test").runs(limit=1)


def test_sdk_integration_creates_logs_and_finishes_run(api_server, tmp_path):
    run = ro.init(
        project="cartpole",
        name="seed-42",
        config={"seed": 42},
        tags=["rl"],
        notes="initial policy note",
        metadata={"custom": "value"},
        base_url=api_server,
        upload_mode="sync",
        queue_dir=str(tmp_path / "async"),
    )
    run.log({"reward": 10.0}, step=1)
    run.finish()

    client = Client(base_url=api_server)
    fetched = client._request("GET", f"/runs/{run.run_id}")["run"]
    metrics = client._request("GET", f"/runs/{run.run_id}/metrics?key=reward&start_step=1&end_step=1&limit=1")[
        "metrics"
    ]
    assert fetched["status"] == "finished"
    assert fetched["metadata"]["custom"] == "value"
    assert fetched["metadata"]["notes"] == "initial policy note"
    assert "_rlobs" in fetched["metadata"]
    assert "source" in fetched["metadata"]["_rlobs"]
    assert metrics == [{"created_at": metrics[0]["created_at"], "key": "reward", "step": 1, "value": 10.0}]


def test_run_artifact_helpers_call_expected_endpoint(monkeypatch):
    calls = []

    class FakeClient:
        def _request(self, method, path, body):
            calls.append((method, path, body))
            return {"artifact": {"id": "artifact-1", **body}}

    run = ro.Run(client=FakeClient(), run_id="run-1")
    checkpoint = run.log_checkpoint("policy.pt", "demo://policy.pt", step=10, metadata={"score": 1})
    rollout = run.log_rollout("eval.mp4", "demo://eval.mp4", step=10)
    artifact = run.log_artifact("notes.json", "demo://notes.json")
    video = run.log_video("episode.mp4", "demo://episode.mp4", step=11, metadata={"fps": 30})
    table = run.log_table("rollouts.jsonl", "demo://rollouts.jsonl", metadata={"rows": 8})

    assert checkpoint["type"] == "checkpoint"
    assert rollout["type"] == "rollout"
    assert artifact["type"] == "file"
    assert video["type"] == "rollout"
    assert video["metadata"] == {"kind": "video", "fps": 30}
    assert table["type"] == "file"
    assert table["metadata"] == {"kind": "table", "rows": 8}
    assert calls == [
        (
            "POST",
            "/api/runs/run-1/artifacts",
            {
                "type": "checkpoint",
                "name": "policy.pt",
                "uri": "demo://policy.pt",
                "step": 10,
                "size_bytes": None,
                "metadata": {"score": 1},
            },
        ),
        (
            "POST",
            "/api/runs/run-1/artifacts",
            {
                "type": "rollout",
                "name": "eval.mp4",
                "uri": "demo://eval.mp4",
                "step": 10,
                "size_bytes": None,
                "metadata": {},
            },
        ),
        (
            "POST",
            "/api/runs/run-1/artifacts",
            {
                "type": "file",
                "name": "notes.json",
                "uri": "demo://notes.json",
                "step": None,
                "size_bytes": None,
                "metadata": {},
            },
        ),
        (
            "POST",
            "/api/runs/run-1/artifacts",
            {
                "type": "rollout",
                "name": "episode.mp4",
                "uri": "demo://episode.mp4",
                "step": 11,
                "size_bytes": None,
                "metadata": {"kind": "video", "fps": 30},
            },
        ),
        (
            "POST",
            "/api/runs/run-1/artifacts",
            {
                "type": "file",
                "name": "rollouts.jsonl",
                "uri": "demo://rollouts.jsonl",
                "step": None,
                "size_bytes": None,
                "metadata": {"kind": "table", "rows": 8},
            },
        ),
    ]


def test_checkpoint_policy_matches_positive_integer_intervals():
    policy = ro.CheckpointPolicy(every_steps=3)

    assert [step for step in range(8) if policy.should_save(step)] == [3, 6]
    assert policy.should_save(6.0) is True
    assert policy.should_save(4.5) is False
    assert policy.should_save(None) is False
    assert ro.CheckpointPolicy(every_steps=3, include_step_zero=True).should_save(0) is True
    with pytest.raises(TypeError, match="every_steps"):
        ro.CheckpointPolicy(every_steps=3.0)
    with pytest.raises(ValueError, match="positive"):
        ro.CheckpointPolicy(every_steps=0)


def test_log_checkpoint_file_enriches_metadata_and_uploads_bytes(tmp_path):
    calls = []
    source = tmp_path / "checkpoint.json"
    source.write_text('{"step": 6}', encoding="utf-8")

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            return {"artifact": {"id": "artifact-1", **body}}

    artifact = Run(client=FakeClient(), run_id="run-1").log_checkpoint_file(
        str(source),
        step=6,
        metadata={"loss": 0.12, "checkpoint": {"framework": "json"}},
    )

    assert artifact["type"] == "checkpoint"
    assert artifact["name"] == "checkpoint.json"
    assert artifact["metadata"]["kind"] == "checkpoint"
    assert artifact["metadata"]["loss"] == 0.12
    assert artifact["metadata"]["checkpoint"] == {
        "framework": "json",
        "step": 6,
        "source_run_id": "run-1",
    }
    assert calls[0][1] == "/api/runs/run-1/artifacts/upload"
    assert calls[0][2]["type"] == "checkpoint"
    assert calls[0][2]["content_base64"] == "eyJzdGVwIjogNn0="


def test_log_checkpoint_file_requires_explicit_step():
    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            raise AssertionError("network should not be used")

    with pytest.raises(ValueError, match="checkpoint step"):
        Run(client=FakeClient(), run_id="run-1").log_checkpoint_file("missing.pt", step=None)


def test_rich_object_helpers_call_expected_endpoints(tmp_path):
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            if path.endswith("/artifacts/upload"):
                return {"artifact": {"id": "artifact-1", "name": body["name"], "mime_type": body["mime_type"], "size_bytes": 5}}
            return {"object": {"id": 10, **body}}

    source = tmp_path / "sample.mp3"
    source.write_bytes(b"hello")
    run = ro.Run(client=FakeClient(), run_id="run-1")
    table = run.log_table_object("eval/samples", ["prompt", "score"], [["a", 0.9]], step=2)
    histogram = run.log_objects({"eval/scores": ro.Histogram([0, 1, 2], [4, 8])}, step=2)[0]
    media = run.log_audio("audio/sample", str(source), step=2, caption="sample")

    assert table["kind"] == "table"
    assert histogram["kind"] == "histogram"
    assert media["artifact_id"] == "artifact-1"
    assert calls[0] == (
        "POST",
        "/api/runs/run-1/objects",
        {
            "key": "eval/samples",
            "kind": "table",
            "step": 2,
            "metadata": {},
            "summary": {"columns": ["prompt", "score"], "row_count": 1},
            "rows": [{"prompt": "a", "score": 0.9}],
        },
    )
    assert calls[1][1] == "/api/runs/run-1/objects"
    assert calls[1][2]["value"] == {"bins": [0.0, 1.0, 2.0], "counts": [4.0, 8.0]}
    assert calls[2][1] == "/api/runs/run-1/artifacts/upload"
    assert calls[2][2]["metadata"]["kind"] == "audio"
    assert calls[3][1] == "/api/runs/run-1/objects"
    assert calls[3][2]["metadata"]["caption"] == "sample"


def test_rich_object_spool_and_validation(tmp_path):
    class FailingClient:
        offline_dir = None

        def _request(self, method, path, body):
            raise AssertionError("network should not be used in process spool mode")

    source = tmp_path / "sample.mp3"
    source.write_bytes(b"hello")
    run = ro.Run(client=FailingClient(), run_id="run-1", upload_mode="spool", spool_dir=str(tmp_path / "spool"))
    table = run.log_objects({"eval/samples": ro.Table(["prompt"], [{"prompt": "a"}])}, step=1)[0]
    assert table["id"] == "spooled"
    event = json.loads(next((tmp_path / "spool" / "run-1").glob("*.json")).read_text(encoding="utf-8"))
    assert event["requests"][0]["path"] == "/api/runs/run-1/objects"
    assert event["requests"][0]["body"]["kind"] == "table"
    with pytest.raises(InstantMLError, match="rich media"):
        run.log_audio("audio/sample", str(source), step=1)
    with pytest.raises(ValueError, match="row length"):
        ro.Run(client=FailingClient(), run_id="run-1").log_table_object("bad", ["a"], [[1, 2]])
    with pytest.raises(ValueError, match="nonnegative"):
        ro.Run(client=FailingClient(), run_id="run-1").log_objects({"bad": ro.Histogram([0, 1], [-1])}, step=1)


def test_rich_object_helper_edge_cases(tmp_path):
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            if path.endswith("/artifacts/upload"):
                return {"artifact": {"id": f"artifact-{len(calls)}", "name": body["name"], "mime_type": body["mime_type"], "size_bytes": 4}}
            return {"object": {"id": len(calls), **body}}

    image = tmp_path / "frame.png"
    video = tmp_path / "rollout.mp4"
    image.write_bytes(b"fake")
    video.write_bytes(b"fake")
    run = ro.Run(client=FakeClient(), run_id="run-1")
    run.log_histogram("model/weights", ro.Histogram([0, 1], [3], metadata={"layer": 1}), step=1)
    run.log_image("images/frame", str(image), step=1)
    run.log_video_object("videos/rollout", str(video), step=1)
    assert [call[2]["kind"] for call in calls if call[1].endswith("/objects")] == ["histogram", "image", "video"]

    with pytest.raises(TypeError, match="objects"):
        run.log_objects(["bad"], step=1)
    with pytest.raises(TypeError, match="object key"):
        run.log_objects({1: ro.Histogram([0, 1], [1])}, step=1)
    with pytest.raises(ValueError, match="object key"):
        run.log_objects({"": ro.Histogram([0, 1], [1])}, step=1)
    with pytest.raises(ValueError, match="object key"):
        run.log_objects({"x" * 513: ro.Histogram([0, 1], [1])}, step=1)
    with pytest.raises(TypeError, match="metadata"):
        run.log_objects({"x": ro.Histogram([0, 1], [1])}, step=1, metadata=[])
    with pytest.raises(TypeError, match="JSON serializable"):
        run.log_objects({"x": ro.Table(["a"], [{"a": object()}])}, step=1)
    with pytest.raises(ValueError, match="columns"):
        run.log_table_object("x", [], [])
    with pytest.raises(TypeError, match="table rows"):
        run.log_table_object("x", ["a"], "bad")
    with pytest.raises(TypeError, match="dictionaries"):
        run.log_table_object("x", ["a"], [object()])
    with pytest.raises(ValueError, match="not be empty"):
        run.log_objects({"x": ro.Histogram([], [])}, step=1)
    with pytest.raises(ValueError, match="bins length"):
        run.log_objects({"x": ro.Histogram([0, 1, 2, 3], [1, 2])}, step=1)
    with pytest.raises(TypeError, match="must be a list"):
        run.log_objects({"x": ro.Histogram("bad", [1])}, step=1)
    with pytest.raises(TypeError, match="must contain numbers"):
        run.log_objects({"x": ro.Histogram([0, "bad"], [1])}, step=1)
    with pytest.raises(ValueError, match="finite"):
        run.log_objects({"x": ro.Histogram([0, float("inf")], [1])}, step=1)
    with pytest.raises(InstantMLError, match="does not exist"):
        run.log_image("images/missing", str(tmp_path / "missing.png"), step=1)
    with pytest.raises(TypeError, match="unsupported"):
        run._log_rich_object("x", object(), step=1, metadata=None)


def test_context_manager_finishes_successfully():
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            return {}

    with Run(client=FakeClient(), run_id="run-1") as run:
        run.log({"reward": 1}, step=0)

    assert calls[-1] == ("PATCH", "/runs/run-1", {"status": "finished"})


def test_typed_helpers_buffer_flush_and_finish():
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            return {"artifact": {"id": "artifact-1", **body}}

    run = Run(client=FakeClient(), run_id="run-1", buffer_size=2)
    run.log_metrics({"reward": 1}, step=0)
    assert calls == []
    run.log_text({"notes/eval": "good"}, step=0)
    assert [call[1] for call in calls] == ["/runs/run-1/metrics", "/api/runs/run-1/attributes"]

    run.log_config({"optimizer": {"lr": 0.001}})
    run.add_tags(["baseline"], group_tags=True)
    run.set_tags(["candidate", "reviewed"])
    run.set_notes("ready for compare")
    run.flush()
    run.log_histogram("model/weights", {"bins": [0, 1], "counts": [3]}, step=1)
    run.finish("failed")

    assert calls[2][2]["attributes"] == [{"path": "config/optimizer/lr", "type": "config", "value": 0.001}]
    assert calls[3][2]["attributes"][0]["path"] == "sys/group_tags"
    assert calls[4] == ("PATCH", "/runs/run-1", {"tags": ["candidate", "reviewed"]})
    assert calls[5] == ("PATCH", "/runs/run-1", {"notes": "ready for compare"})
    assert calls[6][2]["type"] == "histogram_series"
    assert calls[-1] == ("PATCH", "/runs/run-1", {"status": "failed"})


def test_client_init_process_spool_mode_propagates_options(monkeypatch, tmp_path):
    calls = []

    def fake_request(self, method, path, body=None):
        calls.append((method, path, body))
        return {"run": {"id": "run-123"}}

    monkeypatch.setattr(Client, "_request", fake_request)
    run = Client(base_url="http://example.test").init(
        project="demo",
        upload_mode="spool",
        spool_dir=str(tmp_path),
        source_tracking=False,
    )
    run.wait_for_init(timeout=2.0)

    assert run.upload_mode == "spool"
    assert run.spool_dir == str(tmp_path)
    assert calls[0][1] == "/runs"
    with pytest.raises(TypeError, match="notes"):
        Client(base_url="http://example.test").init(project="demo", notes=["bad"])
    with pytest.raises(ValueError, match="notes"):
        Client(base_url="http://example.test").init(project="demo", notes="x" * 513)
    with pytest.raises(ValueError, match="upload_mode"):
        Client(base_url="http://example.test").init(project="demo", upload_mode="background")


def test_client_init_omits_project_and_name_sends_none_for_server_defaulting(monkeypatch, tmp_path):
    # Server fills in "default" + <adj>-<noun>-<seq> when these are absent
    # — the SDK just passes None through. See
    # apps/rust-server/src/store/runs/naming.rs.
    calls = []

    def fake_request(self, method, path, body=None):
        calls.append((method, path, body))
        return {"run": {"id": "run-default-name"}}

    monkeypatch.setattr(Client, "_request", fake_request)
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    Client(base_url="http://example.test").init(
        source_tracking=False,
        queue_dir=str(tmp_path / "async"),
        async_init=False,
    )

    post = next(call for call in calls if call[1] == "/runs")
    body = post[2]
    assert body["project"] is None
    assert body["name"] is None


def test_client_init_defaults_to_async_upload_mode(monkeypatch, tmp_path):
    def fake_request(self, method, path, body=None):
        return {"run": {"id": "run-default-async"}}

    monkeypatch.setattr(Client, "_request", fake_request)
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    run = Client(base_url="http://example.test").init(
        project="demo",
        source_tracking=False,
        queue_dir=str(tmp_path / "async"),
    )

    assert run.wait_for_init(timeout=2.0) == "run-default-async"
    assert run.upload_mode == "async"
    assert run.upload_status()["mode"] == "async"
    assert (tmp_path / "async" / "run-default-async" / "queue.sqlite3").exists()


def test_async_init_returns_run_before_post_completes(monkeypatch):
    gate = threading.Event()
    request_started = threading.Event()

    def slow_request(self, method, path, body=None):
        if method == "POST" and path == "/runs":
            request_started.set()
            assert gate.wait(timeout=2.0), "gate was never released"
            return {"run": {"id": "real-run-id"}}
        return {}

    monkeypatch.setattr(Client, "_request", slow_request)

    started_at = time.monotonic()
    run = Client(base_url="http://example.test").init(
        project="demo",
        source_tracking=False,
        upload_mode="sync",
    )
    elapsed = time.monotonic() - started_at

    # init() returned without waiting on the slow POST.
    assert elapsed < 0.5, f"init blocked for {elapsed:.3f}s; should be near-zero"
    assert request_started.wait(timeout=1.0), "worker thread never called _request"
    assert run._run_id == "__instantml_pending__"

    # Releasing the gate lets the worker finish; run_id access blocks until then.
    gate.set()
    assert run.wait_for_init(timeout=2.0) == "real-run-id"
    assert run.run_id == "real-run-id"


def test_async_init_surfaces_server_error_on_run_id_access(monkeypatch):
    def failing_request(self, method, path, body=None):
        if method == "POST" and path == "/runs":
            raise InstantMLError("POST /runs failed: HTTP 500: boom")
        return {}

    monkeypatch.setattr(Client, "_request", failing_request)

    run = Client(base_url="http://example.test").init(
        project="demo",
        source_tracking=False,
        upload_mode="sync",
    )

    with pytest.raises(InstantMLError, match="boom"):
        run.wait_for_init(timeout=2.0)
    with pytest.raises(InstantMLError, match="boom"):
        _ = run.run_id


def test_sync_init_still_blocks_when_async_init_disabled(monkeypatch):
    calls = []

    def fake_request(self, method, path, body=None):
        calls.append((method, path))
        return {"run": {"id": "run-sync"}}

    monkeypatch.setattr(Client, "_request", fake_request)

    run = Client(base_url="http://example.test").init(
        project="demo",
        source_tracking=False,
        upload_mode="sync",
        async_init=False,
    )

    # In sync mode the POST has already happened by the time init returns.
    assert calls == [("POST", "/runs")]
    assert run._run_id == "run-sync"
    assert run.run_id == "run-sync"


def test_process_spool_mode_writes_events_without_network(tmp_path):
    class FailingClient:
        offline_dir = None

        def _request(self, method, path, body):
            raise AssertionError("network should not be used in process spool mode")

    run = Run(client=FailingClient(), run_id="run/1", upload_mode="spool", spool_dir=str(tmp_path), buffer_size=100)
    run.log_metrics({"reward": 1.5}, step=1)
    run.log_text({"notes/eval": "stable"}, step=1, timestamp="2026-05-07T00:00:00Z")
    run.log_histogram("model/weights", {"bins": [0, 1], "counts": [2]}, step=1)
    run.add_tags(["baseline"])
    run.set_notes("spooled note")
    run.set_tags(["spooled", "tag"])
    run.finish("failed")

    event_files = sorted((tmp_path / "run_1").glob("*.json"))
    assert len(event_files) == 7
    first_event = json.loads(event_files[0].read_text(encoding="utf-8"))
    assert first_event["version"] == 1
    assert first_event["event_id"]
    assert first_event["sequence"] == 1
    assert first_event["data"] == {"metrics": {"reward": 1.5}}
    assert first_event["requests"][0]["path"] == "/runs/run/1/metrics"
    assert first_event["requests"][0]["body"]["timestamp"]
    assert not list((tmp_path / "run_1").glob("*.tmp"))


def test_async_upload_mode_queues_metric_hot_path_without_network(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    class FailingClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            raise AssertionError("metric hot path should enqueue instead of using network")

    run = Run(client=FailingClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    run.log_metrics({"reward": 1.5}, step=1)
    run.log_rank_metrics({"candidate": 2}, step=1, rank=0, world_size=1)
    run.log_stdout("queued")

    status = run.upload_status()
    assert status["pending"] == 3
    assert status["processed"] == 0
    assert (tmp_path / "run-1" / "queue.sqlite3").exists()
    with pytest.warns(RuntimeWarning, match="async upload did not finish"):
        run.finish("failed", timeout=0)
    assert run.upload_status()["pending"] == 4


def test_async_producer_buffer_force_flushes_for_status(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    class FakeClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            raise AssertionError("async metric hot path should not use network")

    run = Run(client=FakeClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    run._async_buffer = client_module._AsyncProducerBuffer(run, max_events=64, max_bytes=64 * 1024, max_age_seconds=60)
    started = []
    monkeypatch.setattr(run, "_start_async_uploader", lambda: started.append(True))
    run.log_metrics({"reward": 1.5}, step=1)

    assert run._async_buffer.status()["buffered_events"] == 1
    assert run._require_async_queue().status()["pending"] == 0
    assert started == []
    run.flush()
    assert run._require_async_queue().status()["pending"] == 1
    assert started == [True]
    status = run.upload_status()
    assert status["pending"] == 1
    assert status["buffered_events"] == 0


def test_async_producer_buffer_hard_cap_drops_newest(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    class FakeClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            return {}

    run = Run(client=FakeClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    run._async_buffer = client_module._AsyncProducerBuffer(run, hard_max_events=1, max_age_seconds=60)
    run.log_metrics({"first": 1.0}, step=1)
    with pytest.warns(RuntimeWarning, match="hard limit"):
        run.log_metrics({"second": 2.0}, step=2)

    status = run.upload_status()
    assert status["pending"] == 1
    assert status["dropped"] == 1


def test_async_producer_buffer_retries_locked_flush(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    class FakeClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            return {}

    run = Run(client=FakeClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    run._async_buffer = client_module._AsyncProducerBuffer(run, max_events=1, retry_seconds=0.001)
    queue = run._require_async_queue()
    original = queue.enqueue_many_prepared
    calls = {"count": 0}

    def flaky_enqueue(events):
        calls["count"] += 1
        if calls["count"] == 1:
            raise InstantMLError("async queue enqueue failed: database is locked")
        return original(events)

    monkeypatch.setattr(queue, "enqueue_many_prepared", flaky_enqueue)

    run.log_metrics({"reward": 1.0}, step=1)

    assert run._force_async_buffer_flush(timeout=1.0)
    assert calls["count"] >= 2
    assert run.upload_status()["pending"] == 1


def test_async_producer_buffer_edge_paths(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    class FakeClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            return {}

    run = Run(client=FakeClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    queue = run._require_async_queue()
    event = queue.prepare_event("POST", "/runs/run-1/metrics", {"metrics": {"reward": 1}, "step": 1})

    closed_buffer = client_module._AsyncProducerBuffer(run)
    with closed_buffer._condition:
        closed_buffer._closed = True
    with pytest.warns(RuntimeWarning, match="producer buffer is closed"):
        assert not closed_buffer.append(event)
    closed_buffer._ensure_worker_locked()
    assert closed_buffer._worker is None

    no_timestamp_buffer = client_module._AsyncProducerBuffer(run, max_age_seconds=60)
    with no_timestamp_buffer._condition:
        no_timestamp_buffer._buffer = [(1, event)]
        no_timestamp_buffer._buffer_bytes = event.body_size_bytes
        no_timestamp_buffer._oldest_buffered_at = None
        assert not no_timestamp_buffer._flush_due_locked()

    dead_buffer = client_module._AsyncProducerBuffer(run)

    class DeadWorker:
        def is_alive(self):
            return False

    ensure_calls = []
    with dead_buffer._condition:
        dead_buffer._worker = DeadWorker()  # type: ignore[assignment]
        dead_buffer._buffer = [(1, event)]
        dead_buffer._buffer_bytes = event.body_size_bytes
        dead_buffer._next_sequence = 2
    monkeypatch.setattr(dead_buffer, "_ensure_worker_locked", lambda: ensure_calls.append("ensure"))
    assert not dead_buffer.force_flush(timeout=0)
    assert len(ensure_calls) >= 2

    waiting_buffer = client_module._AsyncProducerBuffer(run, max_age_seconds=60)
    write_started = threading.Event()

    def slow_write(batch):
        write_started.set()
        time.sleep(0.02)
        return True, False, None, batch[-1][0]

    monkeypatch.setattr(waiting_buffer, "_write_batch", slow_write)
    assert waiting_buffer.append(event)
    flush_result = []
    flush_thread = threading.Thread(target=lambda: flush_result.append(waiting_buffer.force_flush(timeout=None)))
    flush_thread.start()
    assert write_started.wait(timeout=1.0)
    flush_thread.join(timeout=1.0)
    assert flush_result == [True]
    waiting_buffer.stop(timeout=1.0)

    empty_continue_buffer = client_module._AsyncProducerBuffer(run, max_age_seconds=60)
    calls = {"flush_due": 0}
    worker_reentered = threading.Event()

    def fake_flush_due():
        calls["flush_due"] += 1
        if calls["flush_due"] == 1:
            return True
        worker_reentered.set()
        return False

    monkeypatch.setattr(empty_continue_buffer, "_flush_due_locked", fake_flush_due)
    worker = threading.Thread(target=empty_continue_buffer._worker_loop)
    worker.start()
    assert worker_reentered.wait(timeout=1.0)
    with empty_continue_buffer._condition:
        empty_continue_buffer._closed = True
        empty_continue_buffer._condition.notify_all()
    worker.join(timeout=1.0)
    assert not worker.is_alive()


def test_async_producer_buffer_write_batch_outcomes(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    class FakeClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            return {}

    run = Run(client=FakeClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    queue = run._require_async_queue()
    event = queue.prepare_event("POST", "/runs/run-1/metrics", {"metrics": {"reward": 1}, "step": 1})
    buffer = client_module._AsyncProducerBuffer(run)

    assert buffer._write_batch([]) == (True, False, None, None)

    monkeypatch.setattr(
        queue,
        "enqueue_many_prepared",
        lambda events: EnqueueBatchResult(inserted=0, dropped=len(events), message="queue limit reached"),
    )
    run._last_async_warning_at = 0
    with pytest.warns(RuntimeWarning, match="queue limit reached"):
        assert buffer._write_batch([(1, event)]) == (True, False, "queue limit reached", 1)

    monkeypatch.setattr(queue, "enqueue_many_prepared", lambda events: (_ for _ in ()).throw(ValueError("broken batch")))
    run._last_async_warning_at = 0
    with pytest.warns(RuntimeWarning, match="producer flush failed"):
        ok, retryable, message, completed = buffer._write_batch([(2, event)])
    assert not ok
    assert not retryable
    assert "broken batch" in str(message)
    assert completed == 2
    assert run._async_local_dropped == 1


def test_async_producer_buffer_rolls_back_append_when_worker_start_fails(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    class FakeClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            return {}

    run = Run(client=FakeClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    queue = run._require_async_queue()
    event = queue.prepare_event("POST", "/runs/run-1/metrics", {"metrics": {"reward": 1}, "step": 1})
    buffer = client_module._AsyncProducerBuffer(run)
    monkeypatch.setattr(buffer, "_ensure_worker_locked", lambda: (_ for _ in ()).throw(RuntimeError("no thread")))

    with pytest.raises(RuntimeError, match="no thread"):
        buffer.append(event)

    assert buffer.status()["buffered_events"] == 0
    assert buffer.status()["buffered_bytes"] == 0
    assert buffer._next_sequence == 1


def test_async_producer_buffer_handles_concurrent_loggers(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    class FakeClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            raise AssertionError("async metric hot path should not use network")

    run = Run(client=FakeClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    run._async_buffer = client_module._AsyncProducerBuffer(run, max_events=8, max_age_seconds=60)
    total_threads = 4
    events_per_thread = 25

    def log_many(thread_index):
        key = f"reward/{thread_index}"
        for index in range(events_per_thread):
            run.log_metrics({key: index}, step=index)

    threads = [threading.Thread(target=log_many, args=(thread_index,)) for thread_index in range(total_threads)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5.0)
        assert not thread.is_alive()

    assert run._force_async_buffer_flush(timeout=1.0)
    status = run.upload_status()
    assert status["pending"] == total_threads * events_per_thread
    assert status["dropped"] == 0


def test_async_status_and_wait_reflect_buffer_errors_and_local_drops(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    class FakeClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            return {}

    run = Run(client=FakeClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path / "status"))
    assert run._force_async_buffer_flush(timeout=0)
    run._async_buffer._last_flush_error = "buffer failed"  # type: ignore[union-attr]
    monkeypatch.setattr(run, "_force_async_buffer_flush", lambda timeout=None: True)
    assert run.upload_status()["last_error"] == "buffer failed"

    blocked = Run(client=FakeClient(), run_id="run-2", upload_mode="async", queue_dir=str(tmp_path / "blocked"))
    monkeypatch.setattr(blocked, "_force_async_buffer_flush", lambda timeout=None: False)
    assert not blocked.wait_for_submission(timeout=0)

    dropped = Run(client=FakeClient(), run_id="run-3", upload_mode="async", queue_dir=str(tmp_path / "dropped"))
    dropped._async_local_dropped = 1
    assert not dropped.wait_for_processing(timeout=0)

    sync_run = Run(client=FakeClient(), run_id="run-4", upload_mode="sync")
    assert sync_run._force_async_buffer_flush(timeout=0)
    unbuffered = Run(client=FakeClient(), run_id="run-5", upload_mode="async", queue_dir=str(tmp_path / "unbuffered"))
    unbuffered._async_buffer = None
    assert unbuffered._force_async_buffer_flush(timeout=0)


def test_async_unbuffered_enqueue_starts_uploader(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    class FakeClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            return {}

    run = Run(client=FakeClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    run._async_buffer = None
    started = []
    monkeypatch.setattr(run, "_start_async_uploader", lambda: started.append(True))

    run.log_metrics({"reward": 1}, step=1)

    assert started == [True]
    assert run.upload_status()["pending"] == 1


def test_async_start_uploader_serializes_concurrent_calls(monkeypatch, tmp_path):
    class FakeClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            return {}

    class FakeProcess:
        def poll(self):
            return None

        def wait(self, timeout=None):
            return 0

    popen_calls = []

    def fake_popen(*args, **kwargs):
        time.sleep(0.01)
        popen_calls.append((args, kwargs))
        return FakeProcess()

    monkeypatch.setattr(client_module.subprocess, "Popen", fake_popen)
    run = Run(client=FakeClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    run._async_process = None
    popen_calls.clear()

    threads = [threading.Thread(target=run._start_async_uploader) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=1.0)
        assert not thread.is_alive()

    assert len(popen_calls) == 1


def test_async_finish_does_not_close_queue_when_producer_writer_is_alive(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    class FakeClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            return {}

    run = Run(client=FakeClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    queue = run._require_async_queue()
    closed = []
    monkeypatch.setattr(run, "_submit", lambda *args, **kwargs: None)
    monkeypatch.setattr(run, "_force_async_buffer_flush", lambda timeout=None: True)
    monkeypatch.setattr(run, "wait_for_processing", lambda timeout=None: True)
    monkeypatch.setattr(run._async_buffer, "stop", lambda timeout=None: False)
    monkeypatch.setattr(queue, "close", lambda: closed.append(True))

    with pytest.warns(RuntimeWarning, match="producer writer did not stop"):
        run.finish(timeout=0.01)

    assert closed == []


def test_async_wait_fails_on_repository_drops(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    class FakeClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            return {}

    run = Run(client=FakeClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    run._require_async_queue().increment_counter("dropped", 1)

    assert not run.wait_for_processing(timeout=0)


def test_async_queue_open_failure_warns_and_drops_hot_path(monkeypatch, tmp_path):
    class FailingClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            raise AssertionError("failed async queue should not fall back to network")

    def fail_init_db(self):
        raise sqlite3.OperationalError("readonly database")

    monkeypatch.setattr(AsyncQueueRepository, "init_db", fail_init_db)

    with pytest.warns(RuntimeWarning, match="local queue could not start"):
        run = Run(client=FailingClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))

    status = run.upload_status()
    assert status["queue_available"] is False
    assert "readonly database" in status["last_error"]
    assert not run.wait_for_processing(timeout=0)

    with pytest.warns(RuntimeWarning, match="async queue unavailable"):
        run.log_metrics({"reward": 1.5}, step=1)
    assert run.upload_status()["dropped"] == 1

    with pytest.warns(RuntimeWarning, match="finish status was not delivered"):
        run.finish(timeout=0)
    assert run.upload_status()["dropped"] == 2
    assert run._open_async_queue_or_warn("run-2") is False
    run._start_async_uploader()


def test_async_upload_mode_keeps_metadata_updates_sync(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)
    calls = []

    class RecordingClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            return {}

    run = Run(client=RecordingClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    run.set_tags(["baseline"])
    run.set_notes("still sync")

    assert calls == [
        ("PATCH", "/runs/run-1", {"tags": ["baseline"]}),
        ("PATCH", "/runs/run-1", {"notes": "still sync"}),
    ]
    assert run.upload_status()["pending"] == 0


def test_async_uploader_uses_subprocess_without_importing_user_main(monkeypatch, tmp_path):
    calls = []

    class FakeProcess:
        def __init__(self, args, **kwargs):
            calls.append((args, kwargs))

        def poll(self):
            return None

    class FakeClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return "secret-key"

        def _request(self, method, path, body):
            return {}

    monkeypatch.setattr(client_module.subprocess, "Popen", FakeProcess)

    run = Run(client=FakeClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    run.log_metrics({"reward": 1.5}, step=1)

    assert len(calls) == 1
    assert calls[0][0][1] == "-c"
    assert "run_async_uploader" in calls[0][0][2]
    assert "secret-key" not in " ".join(calls[0][0])
    assert json.loads(calls[0][0][3])["api_key"] is None
    assert calls[0][1]["env"]["INSTANTML_API_KEY"] == "secret-key"
    assert calls[0][1]["stdin"] == client_module.subprocess.DEVNULL
    assert calls[0][1]["stderr"] != client_module.subprocess.DEVNULL
    assert run.upload_status()["pending"] == 1


def test_async_queue_drains_with_stable_idempotency(monkeypatch, tmp_path):
    repository = AsyncQueueRepository(tmp_path / "queue.sqlite3")
    repository.init_db()
    repository.enqueue("POST", "/runs/run-1/metrics", {"metrics": {"reward": 1.0}, "step": 1}, idempotency_key="event-1")
    calls = []

    def fake_send_request(**kwargs):
        calls.append(kwargs)
        return DeliveryResult(ok=True, retryable=False)

    monkeypatch.setattr(async_queue, "_send_request", fake_send_request)

    assert drain_queue_once(repository, base_url="http://example.test", api_key="secret") == 1
    assert repository.status()["processed"] == 1
    assert repository.status()["pending"] == 0
    assert calls[0]["idempotency_key"] == "event-1"


def test_async_queue_marks_oversized_first_event_failed(monkeypatch, tmp_path):
    repository = AsyncQueueRepository(tmp_path / "queue.sqlite3", max_event_bytes=1_024)
    repository.init_db()
    repository.enqueue("POST", "/runs/run-1/metrics", {"metrics": {"blob": "x" * 64}, "step": 1}, idempotency_key="event-1")
    monkeypatch.setattr(async_queue, "_send_request", lambda **kwargs: pytest.fail("oversized event should not be sent"))

    assert drain_queue_once(repository, base_url="http://example.test", max_event_bytes=16) == 0
    assert repository.status()["failed"] == 1


def test_async_queue_retry_and_failed_statuses(monkeypatch, tmp_path):
    repository = AsyncQueueRepository(tmp_path / "queue.sqlite3")
    repository.init_db()
    repository.enqueue("POST", "/runs/run-1/metrics", {"metrics": {"reward": 1.0}, "step": 1}, idempotency_key="event-1")
    repository.enqueue("POST", "/runs/run-1/metrics", {"metrics": {"loss": 2.0}, "step": 1}, idempotency_key="event-2")
    results = [
        DeliveryResult(ok=False, retryable=False, message="quota", status=429, code="api_request_monthly_limit_exceeded"),
        DeliveryResult(ok=False, retryable=True, message="try later", status=503, code="unavailable"),
    ]

    def fake_send_request(**kwargs):
        return results.pop(0)

    monkeypatch.setattr(async_queue, "_send_request", fake_send_request)

    assert drain_queue_once(repository, base_url="http://example.test") == 0
    status = repository.status()
    assert status["pending"] == 1
    assert status["failed"] == 1


def test_async_queue_retry_blocks_later_delivery_until_backoff(monkeypatch, tmp_path):
    repository = AsyncQueueRepository(tmp_path / "queue.sqlite3")
    repository.init_db()
    for index in range(3):
        repository.enqueue(
            "POST",
            "/runs/run-1/metrics",
            {"metrics": {f"m{index}": index}, "step": index},
            idempotency_key=f"event-{index}",
        )
    sent = []

    def fake_send_request(**kwargs):
        sent.append(kwargs["idempotency_key"])
        if kwargs["idempotency_key"] == "event-1":
            return DeliveryResult(ok=False, retryable=True, message="try later", status=503)
        return DeliveryResult(ok=True, retryable=False)

    monkeypatch.setattr(async_queue, "_retry_delay", lambda attempts, retry_after=None: 60.0)
    monkeypatch.setattr(async_queue, "_send_request", fake_send_request)

    assert drain_queue_once(repository, base_url="http://example.test") == 1
    assert sent == ["event-0", "event-1"]
    assert repository.status()["pending"] == 2

    sent.clear()
    assert drain_queue_once(repository, base_url="http://example.test") == 0
    assert sent == []


def test_async_queue_directory_drain_continues_after_terminal_failure(monkeypatch, tmp_path):
    path = tmp_path / "run" / "queue.sqlite3"
    repository = AsyncQueueRepository(path)
    repository.init_db()
    repository.enqueue("POST", "/runs/run-1/metrics", {"metrics": {"bad": 1}}, idempotency_key="event-1")
    repository.enqueue("POST", "/runs/run-1/metrics", {"metrics": {"ok": 2}}, idempotency_key="event-2")
    repository.close()
    results = [
        DeliveryResult(ok=False, retryable=False, message="bad payload", status=400),
        DeliveryResult(ok=True, retryable=False),
    ]
    monkeypatch.setattr(async_queue, "_send_request", lambda **kwargs: results.pop(0))

    assert async_queue.drain_queue(path, base_url="http://example.test") == 1
    reopened = AsyncQueueRepository(path)
    reopened.init_db()
    assert reopened.status()["failed"] == 1
    assert reopened.status()["processed"] == 1


def test_async_queue_directory_drain_retries_same_pass_when_head_can_advance(monkeypatch, tmp_path):
    path = tmp_path / "run" / "queue.sqlite3"
    repository = AsyncQueueRepository(path)
    repository.init_db()
    repository.close()
    calls = {"drain": 0, "claimable": 0}

    def fake_drain_queue_once(*args, **kwargs):
        calls["drain"] += 1
        return 0 if calls["drain"] == 1 else 1

    def fake_has_claimable(self):
        calls["claimable"] += 1
        return True

    monkeypatch.setattr(async_queue, "drain_queue_once", fake_drain_queue_once)
    monkeypatch.setattr(AsyncQueueRepository, "has_claimable", fake_has_claimable)

    assert async_queue.drain_queue(path, base_url="http://example.test", max_events=1) == 1
    assert calls == {"drain": 2, "claimable": 1}


def test_async_wait_methods_and_finish_signature(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    class FakeClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            return {}

    run = Run(client=FakeClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    assert run.wait_for_submission(timeout=0.01)
    assert run.wait_for_processing(timeout=0.01)
    run.log_metrics({"reward": 1}, step=1)
    assert not run.wait_for_processing(timeout=0.01)
    # Existing positional status remains valid and delivery errors do not raise.
    with pytest.warns(RuntimeWarning, match="async upload did not finish"):
        run.finish("failed", timeout=0.01)


def test_async_finish_default_timeout_is_bounded(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    class FakeClient:
        base_url = "http://example.test"
        timeout = 0.01
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            raise AssertionError("async finish status should enqueue instead of using network")

    run = Run(client=FakeClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    run.log_metrics({"reward": 1}, step=1)
    started = time.monotonic()
    with pytest.warns(RuntimeWarning, match="async upload did not finish"):
        run.finish("failed")
    assert time.monotonic() - started < 1.0


def test_async_finish_stops_uploader_after_successful_wait(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    class FakeClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            return {}

    stopped = []
    run = Run(client=FakeClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    monkeypatch.setattr(run, "wait_for_processing", lambda timeout=None: True)
    monkeypatch.setattr(run, "_stop_async_uploader", lambda timeout=None: stopped.append(timeout))

    run.finish("finished", timeout=0.5)

    assert stopped == [0.5]


def test_uploader_cli_drains_async_queue_dir(monkeypatch, tmp_path):
    captured = {}

    def fake_drain_async_queues(**kwargs):
        captured.update(kwargs)
        return 3

    monkeypatch.setattr(uploader, "_resolve_api_key", lambda api_key: "login-key")
    monkeypatch.setattr(uploader, "drain_async_queues", fake_drain_async_queues)

    assert uploader.main(["--queue-dir", str(tmp_path), "--base-url", "http://example.test", "--timeout", "2", "--max-events", "5"]) == 0
    assert captured == {
        "queue_dir": str(tmp_path),
        "base_url": "http://example.test",
        "api_key": "login-key",
        "timeout": 2.0,
        "max_events": 5,
    }


def test_async_queue_directory_drain_and_lock_paths(monkeypatch, tmp_path):
    missing = tmp_path / "missing"
    assert async_queue.drain_async_queues(str(missing), base_url="http://example.test") == 0

    queue_root = tmp_path / "queues"
    for run_id in ("run/a", "run/b"):
        path = async_queue.queue_path_for_run(str(queue_root), run_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("", encoding="utf-8")

    calls = []

    def fake_drain_queue(queue_path, **kwargs):
        calls.append((queue_path, kwargs))
        return 1

    monkeypatch.setattr(async_queue, "drain_queue", fake_drain_queue)
    assert async_queue.drain_async_queues(str(queue_root), base_url="http://example.test", max_events=1) == 1
    assert len(calls) == 1

    lock = async_queue.QueueLock(tmp_path / "queue.sqlite3")
    with lock:
        assert lock.path.exists()
        lock.path.unlink()

    stale_lock = async_queue.QueueLock(tmp_path / "stale.sqlite3")
    stale_lock.path.parent.mkdir(parents=True, exist_ok=True)
    stale_lock.path.write_text("0", encoding="ascii")
    with stale_lock:
        assert stale_lock.path.exists()

    invalid_lock = async_queue.QueueLock(tmp_path / "invalid.sqlite3")
    invalid_lock.path.write_text("not-a-pid", encoding="ascii")
    assert not invalid_lock._remove_stale_lock()

    old_invalid_lock = async_queue.QueueLock(tmp_path / "old-invalid.sqlite3")
    old_invalid_lock.path.write_text("", encoding="ascii")
    stale_time = time.time() - async_queue.DEFAULT_LOCK_STALE_SECONDS - 1
    os.utime(old_invalid_lock.path, (stale_time, stale_time))
    assert old_invalid_lock._remove_stale_lock()

    stat_error_lock = async_queue.QueueLock(tmp_path / "stat-error.sqlite3")
    stat_error_lock.path.write_text("", encoding="ascii")
    original_stat = async_queue.Path.stat

    def broken_stat(path, *args, **kwargs):
        if path == stat_error_lock.path:
            raise OSError("missing")
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(async_queue.Path, "stat", broken_stat)
    assert not stat_error_lock._remove_stale_lock()

    live_lock = async_queue.QueueLock(tmp_path / "live.sqlite3")
    live_lock.path.write_text(str(os.getpid()), encoding="ascii")
    monkeypatch.setattr(async_queue, "_pid_is_running", lambda pid: True)
    assert not live_lock._remove_stale_lock()
    with pytest.raises(InstantMLError, match="already running"):
        with live_lock:
            pass

    flaky_lock = async_queue.QueueLock(tmp_path / "flaky.sqlite3")
    flaky_lock.path.write_text("0", encoding="ascii")
    original_unlink = async_queue.Path.unlink

    def flaky_unlink(path, *args, **kwargs):
        if path == flaky_lock.path:
            raise OSError("stuck")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(async_queue.Path, "unlink", flaky_unlink)
    monkeypatch.setattr(async_queue, "_pid_is_running", lambda pid: False)
    assert not flaky_lock._remove_stale_lock()


def test_async_queue_repository_edge_cases(monkeypatch, tmp_path):
    repository = AsyncQueueRepository(tmp_path / "queue.sqlite3", max_event_bytes=16, max_queue_bytes=256 * 1024)
    repository.init_db()
    assert stat.S_IMODE(repository.path.parent.stat().st_mode) == 0o700
    assert stat.S_IMODE(repository.path.stat().st_mode) == 0o600
    original_chmod = async_queue.Path.chmod

    def broken_chmod(path, mode):
        if path in {repository.path.parent, repository.path}:
            raise OSError("chmod denied")
        return original_chmod(path, mode)

    monkeypatch.setattr(async_queue.Path, "chmod", broken_chmod)
    repository._harden_file_permissions()
    monkeypatch.setattr(async_queue.Path, "chmod", original_chmod)

    empty_result = repository.enqueue_many_prepared([])
    assert empty_result.inserted == 0
    assert empty_result.dropped == 0

    assert repository.enqueue("POST", "/runs/run-1/metrics", {"blob": "x" * 64}) is None
    assert repository.counter("dropped") == 1
    assert not repository.has_pending()
    assert not repository.has_failed()

    assert repository.enqueue("POST", "/runs/run-1/metrics", {"m": 1}, idempotency_key="a") is not None
    assert repository.has_pending()
    assert repository.has_claimable()
    repository.release_events([])
    assert repository.enqueue("POST", "/runs/run-1/metrics", {"m": 2}, idempotency_key="b") is not None
    first = repository.claim_batch("lease", max_batch_bytes=1, max_event_bytes=128, lease_seconds=-1)
    assert len(first) == 1
    assert repository.recover_stale_leases() == 1
    assert repository.claim_batch("lease", max_batch_bytes=128, max_event_bytes=128, lease_seconds=1)
    assert repository.claim_batch("lease", max_batch_bytes=128, max_event_bytes=128, lease_seconds=1) == []
    repository.mark_failed(first[0].sequence_id, "failed")
    assert repository.has_failed()

    repository.increment_counter("custom", amount=4)
    assert repository.counter("custom") == 4
    repository.prune_processed()

    monkeypatch.setattr(async_queue.os, "statvfs", lambda path: (_ for _ in ()).throw(OSError("missing")))
    assert repository._has_disk_space()
    monkeypatch.delattr(async_queue.os, "statvfs", raising=False)
    monkeypatch.setattr(async_queue.shutil, "disk_usage", lambda path: SimpleNamespace(free=repository.min_free_disk_bytes))
    assert repository._has_disk_space()

    missing_repository = AsyncQueueRepository(tmp_path / "missing" / "queue.sqlite3")
    assert missing_repository._queue_file_size_bytes() == 0
    missing_repository._checkpoint_wal()

    monkeypatch.setattr(repository, "_queue_file_size_bytes", lambda: repository.max_queue_bytes)
    assert repository._queue_is_full(1)
    assert repository.enqueue("POST", "/runs/run-1/metrics", {"m": 3}, idempotency_key="c") is None

    class BrokenRepository(AsyncQueueRepository):
        def _connect(self):
            raise sqlite3.Error("nope")

    assert not BrokenRepository(tmp_path / "broken.sqlite3")._queue_is_full(1)

    class BadRollback:
        def rollback(self):
            raise sqlite3.Error("rollback failed")

        def close(self):
            pass

    repository._connection = BadRollback()  # type: ignore[assignment]
    repository._rollback_quietly()
    repository.close()


def test_async_queue_prepared_batch_preserves_order_and_counts(monkeypatch, tmp_path):
    repository = AsyncQueueRepository(tmp_path / "queue.sqlite3", max_event_bytes=128, max_queue_bytes=10_000)
    repository.init_db()
    monkeypatch.setattr(repository, "_queue_file_size_bytes", lambda: 0)
    events = [
        repository.prepare_event("POST", "/runs/run-1/metrics", {"m": index}, idempotency_key=f"event-{index}", created_at=100.0 + index)
        for index in range(3)
    ]

    result = repository.enqueue_many_prepared(events)

    assert result.inserted == 3
    assert result.dropped == 0
    assert result.first_sequence_id == 1
    assert result.last_sequence_id == 3
    claimed = repository.claim_batch("lease", max_batch_bytes=10_000, max_event_bytes=128, lease_seconds=1)
    assert [event.idempotency_key for event in claimed] == ["event-0", "event-1", "event-2"]
    assert [event.body["m"] for event in claimed] == [0, 1, 2]


def test_async_queue_prepared_batch_drops_oversized_and_queue_suffix(monkeypatch, tmp_path):
    repository = AsyncQueueRepository(tmp_path / "queue.sqlite3", max_event_bytes=64, max_queue_bytes=10)
    repository.init_db()
    monkeypatch.setattr(repository, "_queue_file_size_bytes", lambda: 0)
    first = repository.prepare_event("POST", "/runs/run-1/metrics", {"m": 1}, idempotency_key="first", created_at=1.0)
    second = repository.prepare_event("POST", "/runs/run-1/metrics", {"m": 2}, idempotency_key="second", created_at=2.0)
    oversized = repository.prepare_event("POST", "/runs/run-1/metrics", {"blob": "x" * 128}, idempotency_key="big", created_at=3.0)

    result = repository.enqueue_many_prepared([first, second, oversized])

    assert result.inserted == 1
    assert result.dropped == 2
    assert repository.counter("dropped") == 2
    claimed = repository.claim_batch("lease", max_batch_bytes=10_000, max_event_bytes=128, lease_seconds=1)
    assert [event.idempotency_key for event in claimed] == ["first"]


def test_async_queue_prepared_batch_drops_when_disk_space_missing(monkeypatch, tmp_path):
    repository = AsyncQueueRepository(tmp_path / "queue.sqlite3")
    repository.init_db()
    monkeypatch.setattr(repository, "_has_disk_space", lambda: False)
    event = repository.prepare_event("POST", "/runs/run-1/metrics", {"m": 1})

    result = repository.enqueue_many_prepared([event])

    assert result.inserted == 0
    assert result.dropped == 1
    assert repository.counter("dropped") == 1


def test_async_queue_enqueue_error_records_drop(monkeypatch, tmp_path):
    repository = AsyncQueueRepository(tmp_path / "queue.sqlite3")

    class BadConnection:
        def execute(self, *args, **kwargs):
            raise sqlite3.Error("write failed")

        def commit(self):
            raise AssertionError("commit should not run")

    monkeypatch.setattr(repository, "_connect", lambda: BadConnection())
    monkeypatch.setattr(repository, "increment_counter", lambda key: (_ for _ in ()).throw(sqlite3.Error("counter failed")))

    with pytest.raises(InstantMLError, match="async queue enqueue failed"):
        repository.enqueue("POST", "/runs/run-1/metrics", {"m": 1})


def test_async_queue_prepared_batch_rolls_back_on_insert_error(monkeypatch, tmp_path):
    repository = AsyncQueueRepository(tmp_path / "queue.sqlite3")
    repository.init_db()
    event = repository.prepare_event("POST", "/runs/run-1/metrics", {"m": 1})

    class BadInsertConnection:
        def __init__(self):
            self.rolled_back = False

        def executemany(self, *args, **kwargs):
            raise sqlite3.Error("insert failed")

        def execute(self, *args, **kwargs):
            raise AssertionError("execute should not run after executemany fails")

        def rollback(self):
            self.rolled_back = True

        def close(self):
            pass

    bad_connection = BadInsertConnection()
    repository._connection = bad_connection  # type: ignore[assignment]
    monkeypatch.setattr(repository, "_available_queue_bytes", lambda: event.body_size_bytes)

    with pytest.raises(InstantMLError, match="insert failed"):
        repository.enqueue_many_prepared([event])
    assert bad_connection.rolled_back


def test_async_queue_real_drain_and_uploader_loop(monkeypatch, tmp_path):
    path = tmp_path / "run" / "queue.sqlite3"
    repository = AsyncQueueRepository(path)
    repository.init_db()
    repository.enqueue("POST", "/runs/run-1/metrics", {"metrics": {"reward": 1.0}, "step": 1}, idempotency_key="event-1")
    sent = []
    monkeypatch.setattr(async_queue, "_send_request", lambda **kwargs: sent.append(kwargs) or DeliveryResult(ok=True, retryable=False))

    assert async_queue.drain_queue(path, base_url="http://example.test", max_events=2) == 1
    assert sent[0]["idempotency_key"] == "event-1"

    loop_calls = {"parent": 0, "drain": 0, "health": 0}

    def fake_parent_is_running(parent_pid):
        loop_calls["parent"] += 1
        return loop_calls["parent"] == 1

    def fake_drain_queue_once(*args, **kwargs):
        loop_calls["drain"] += 1
        return 1

    monkeypatch.setattr(async_queue, "_parent_is_running", fake_parent_is_running)
    monkeypatch.setattr(async_queue, "drain_queue_once", fake_drain_queue_once)
    monkeypatch.setattr(async_queue, "_send_health", lambda *args, **kwargs: loop_calls.__setitem__("health", loop_calls["health"] + 1))
    monkeypatch.setattr(async_queue.time, "sleep", lambda seconds: None)

    async_queue.run_async_uploader(
        queue_path=str(path),
        base_url="http://example.test",
        api_key=None,
        timeout=1,
        run_id="run-1",
        parent_pid=123,
    )
    assert loop_calls == {"parent": 2, "drain": 1, "health": 1}


def test_async_uploader_does_not_emit_idle_health(monkeypatch, tmp_path):
    path = tmp_path / "run" / "queue.sqlite3"
    repository = AsyncQueueRepository(path)
    repository.init_db()
    repository.close()
    loop_calls = {"parent": 0, "drain": 0, "health": 0}

    def fake_parent_is_running(parent_pid):
        loop_calls["parent"] += 1
        return loop_calls["parent"] == 1

    def fake_drain_queue_once(*args, **kwargs):
        loop_calls["drain"] += 1
        return 0

    monkeypatch.setattr(async_queue, "_parent_is_running", fake_parent_is_running)
    monkeypatch.setattr(async_queue, "drain_queue_once", fake_drain_queue_once)
    monkeypatch.setattr(async_queue, "_send_health", lambda *args, **kwargs: loop_calls.__setitem__("health", loop_calls["health"] + 1))
    monkeypatch.setattr(async_queue.time, "sleep", lambda seconds: None)

    async_queue.run_async_uploader(
        queue_path=str(path),
        base_url="http://example.test",
        api_key=None,
        timeout=1,
        run_id="run-1",
        parent_pid=123,
    )

    assert loop_calls == {"parent": 2, "drain": 1, "health": 0}


def test_async_uploader_emits_health_for_outstanding_queue(monkeypatch, tmp_path):
    path = tmp_path / "run" / "queue.sqlite3"
    repository = AsyncQueueRepository(path)
    repository.init_db()
    repository.close()
    loop_calls = {"parent": 0, "drain": 0, "health": 0}

    status = {
        "pending": 1,
        "in_flight": 0,
        "failed": 0,
        "dropped": 0,
        "processed": 0,
        "oldest_pending_age_seconds": 0,
        "last_error": None,
        "disk_usage_bytes": 0,
    }

    def fake_parent_is_running(parent_pid):
        loop_calls["parent"] += 1
        return loop_calls["parent"] == 1

    def fake_drain_queue_once(*args, **kwargs):
        loop_calls["drain"] += 1
        return 0

    monkeypatch.setattr(async_queue, "_parent_is_running", fake_parent_is_running)
    monkeypatch.setattr(async_queue, "drain_queue_once", fake_drain_queue_once)
    monkeypatch.setattr(AsyncQueueRepository, "status", lambda self: status)
    monkeypatch.setattr(
        async_queue,
        "_send_health",
        lambda *args, **kwargs: loop_calls.__setitem__("health", loop_calls["health"] + 1),
    )
    monkeypatch.setattr(async_queue.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(async_queue.time, "time", lambda: 10.0)

    async_queue.run_async_uploader(
        queue_path=str(path),
        base_url="http://example.test",
        api_key=None,
        timeout=1,
        run_id="run-1",
        parent_pid=123,
        health_interval_seconds=5,
    )

    assert loop_calls == {"parent": 2, "drain": 1, "health": 1}


def test_async_uploader_emits_final_health_when_queue_becomes_idle(monkeypatch, tmp_path):
    path = tmp_path / "run" / "queue.sqlite3"
    repository = AsyncQueueRepository(path)
    repository.init_db()
    repository.close()
    loop_calls = {"parent": 0, "drain": 0, "health": 0, "status": 0, "time": 0}

    statuses = [
        {
            "pending": 1,
            "in_flight": 0,
            "failed": 0,
            "dropped": 0,
            "processed": 0,
            "oldest_pending_age_seconds": 0,
            "last_error": None,
            "disk_usage_bytes": 0,
        },
        {
            "pending": 0,
            "in_flight": 0,
            "failed": 0,
            "dropped": 0,
            "processed": 1,
            "oldest_pending_age_seconds": None,
            "last_error": None,
            "disk_usage_bytes": 0,
        },
    ]

    def fake_parent_is_running(parent_pid):
        loop_calls["parent"] += 1
        return loop_calls["parent"] <= 2

    def fake_drain_queue_once(*args, **kwargs):
        loop_calls["drain"] += 1
        return 0

    def fake_status(self):
        index = min(loop_calls["status"], len(statuses) - 1)
        loop_calls["status"] += 1
        return statuses[index]

    def fake_time():
        loop_calls["time"] += 1
        return float(loop_calls["time"])

    monkeypatch.setattr(async_queue, "_parent_is_running", fake_parent_is_running)
    monkeypatch.setattr(async_queue, "drain_queue_once", fake_drain_queue_once)
    monkeypatch.setattr(AsyncQueueRepository, "status", fake_status)
    monkeypatch.setattr(
        async_queue,
        "_send_health",
        lambda *args, **kwargs: loop_calls.__setitem__("health", loop_calls["health"] + 1),
    )
    monkeypatch.setattr(async_queue.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(async_queue.time, "time", fake_time)

    async_queue.run_async_uploader(
        queue_path=str(path),
        base_url="http://example.test",
        api_key=None,
        timeout=1,
        run_id="run-1",
        parent_pid=123,
        health_interval_seconds=5,
    )

    assert loop_calls == {"parent": 3, "drain": 2, "health": 1, "status": 2, "time": 2}


def test_async_queue_http_helpers(monkeypatch):
    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return None

        def read(self):
            return b"ok"

    opened = []
    monkeypatch.setattr(async_queue.urllib.request, "urlopen", lambda request, timeout: opened.append((request, timeout)) or FakeResponse())
    assert async_queue._send_request(
        base_url="http://example.test/",
        api_key="secret",
        timeout=3,
        method="POST",
        path="/runs/run-1/metrics",
        body={"metrics": {"reward": 1}},
        idempotency_key="event-1",
    ).ok
    assert opened[0][0].get_header("Idempotency-key") == "event-1"

    error = urllib.error.HTTPError(
        "http://example.test",
        429,
        "rate limited",
        {"Retry-After": "2"},
        BytesIO(b'{"error":"slow down","code":"rate_limit_exceeded"}'),
    )
    monkeypatch.setattr(async_queue.urllib.request, "urlopen", lambda request, timeout: (_ for _ in ()).throw(error))
    result = async_queue._send_request("http://example.test", None, 1, "POST", "/x", {})
    assert result.retryable
    assert result.retry_after == 2
    assert result.message == "slow down"

    malformed = urllib.error.HTTPError("http://example.test", 400, "bad", {}, BytesIO(b"{"))
    assert async_queue._decode_http_error(malformed) == ("HTTP Error 400: bad", None)
    non_object = urllib.error.HTTPError("http://example.test", 400, "bad", {}, BytesIO(b"[]"))
    assert async_queue._decode_http_error(non_object) == ("HTTP Error 400: bad", None)

    monkeypatch.setattr(
        async_queue.urllib.request,
        "urlopen",
        lambda request, timeout: (_ for _ in ()).throw(urllib.error.URLError("offline")),
    )
    assert async_queue._send_request("http://example.test", None, 1, "POST", "/x", {}).retryable

    assert not async_queue._is_retryable_response(403, None)
    assert not async_queue._is_retryable_response(429, "api_request_monthly_limit_exceeded")
    assert async_queue._is_retryable_response(503, None)
    assert async_queue._retry_after(urllib.error.HTTPError("u", 503, "x", {}, BytesIO())) is None
    assert async_queue._retry_after(urllib.error.HTTPError("u", 503, "x", {"Retry-After": "later"}, BytesIO())) is None
    assert async_queue._retry_after(urllib.error.HTTPError("u", 503, "x", {"Retry-After": "-1"}, BytesIO())) is None
    assert async_queue._retry_delay(1, retry_after=120) == 60
    assert async_queue._parent_is_running(0)
    monkeypatch.setattr(async_queue.os, "getppid", lambda: 99)
    assert async_queue._parent_is_running(99)
    assert not async_queue._parent_is_running(100)

    assert not async_queue._pid_is_running(0)
    monkeypatch.setattr(async_queue.os, "kill", lambda pid, sig: None)
    assert async_queue._pid_is_running(123)
    monkeypatch.setattr(async_queue.os, "kill", lambda pid, sig: (_ for _ in ()).throw(ProcessLookupError()))
    assert not async_queue._pid_is_running(123)
    monkeypatch.setattr(async_queue.os, "kill", lambda pid, sig: (_ for _ in ()).throw(PermissionError()))
    assert async_queue._pid_is_running(123)
    assert "T" in async_queue._utc_timestamp()


def test_async_health_heartbeat_payload(monkeypatch, tmp_path):
    repository = AsyncQueueRepository(tmp_path / "queue.sqlite3")
    repository.init_db()
    repository.enqueue("POST", "/runs/run-1/metrics", {"metrics": {"reward": 1.0}, "step": 1})
    sent = {}
    monkeypatch.setattr(async_queue, "_utc_timestamp", lambda: "2026-05-25T00:00:00+00:00")
    monkeypatch.setattr(async_queue, "_send_request", lambda **kwargs: sent.update(kwargs) or DeliveryResult(ok=True, retryable=False))

    async_queue._send_health(repository, "http://example.test", "secret", 1.0, "run-1")

    assert sent["path"] == "/runs/run-1/metrics"
    metrics = sent["body"]["metrics"]
    assert metrics["system/instantml/queued_events"] == 1.0
    assert metrics["system/instantml/failed_events"] == 0.0
    assert sent["idempotency_key"].startswith("instantml-health-run-1-")


def test_async_run_non_async_status_and_open_paths(tmp_path):
    class FakeClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            return {}

    sync_run = Run(client=FakeClient(), run_id="run-1", upload_mode="sync")
    assert sync_run.upload_status()["mode"] == "sync"
    assert sync_run.wait_for_submission(timeout=0.01)

    async_run = Run(client=FakeClient(), run_id=client_module._PENDING_RUN_ID, upload_mode="async", queue_dir=str(tmp_path))
    async_run._start_async_uploader()
    async_run.run_id = "run-2"
    first_queue = async_run._require_async_queue()
    async_run._open_async_queue("run-2")
    assert async_run._require_async_queue() is first_queue
    async_run._async_queue = None
    assert async_run._require_async_queue().path.name == "queue.sqlite3"
    async_run._stop_async_uploader(timeout=0)

    sync_run = Run(client=FakeClient(), run_id="run-3", upload_mode="sync")
    sync_run._stop_async_uploader(timeout=0)


def test_async_run_wait_failure_and_dead_process(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    class FakeClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            return {}

    run = Run(client=FakeClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    run.log_metrics({"reward": 1}, step=1)

    class DeadProcess:
        def poll(self):
            return 1

    run._async_process = DeadProcess()  # type: ignore[assignment]
    assert not run.wait_for_submission(timeout=1)

    failed_run = Run(client=FakeClient(), run_id="run-2", upload_mode="async", queue_dir=str(tmp_path))
    failed_run.log_metrics({"reward": 1}, step=1)
    failed_run._require_async_queue().mark_failed(1, "bad")
    assert not failed_run.wait_for_processing(timeout=1)


def test_async_start_and_stop_error_paths(monkeypatch, tmp_path):
    class FakeClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            return {}

    monkeypatch.setattr(client_module.subprocess, "Popen", lambda *args, **kwargs: (_ for _ in ()).throw(OSError("no fork")))
    with pytest.warns(RuntimeWarning, match="could not start"):
        run = Run(client=FakeClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    run._start_async_uploader()

    class SlowProcess:
        def __init__(self):
            self.terminated = False
            self.killed = False

        def wait(self, timeout=None):
            if not self.terminated:
                raise subprocess.TimeoutExpired("cmd", timeout)
            if not self.killed:
                raise subprocess.TimeoutExpired("cmd", timeout)
            return 0

        def terminate(self):
            self.terminated = True

        def kill(self):
            self.killed = True

    run._async_process = SlowProcess()  # type: ignore[assignment]
    run._stop_async_uploader(timeout=10)
    assert run._async_process is None


def test_async_submit_drop_and_warning_rate_limit(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    class FakeClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            return {}

    run = Run(client=FakeClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    run._async_buffer = None
    monkeypatch.setattr(
        run._require_async_queue(),
        "enqueue_many_prepared",
        lambda events: EnqueueBatchResult(inserted=0, dropped=len(events), message="dropped an event"),
    )
    with pytest.warns(RuntimeWarning, match="dropped an event"):
        run.log_metrics({"reward": 1}, step=1)
    with pytest.warns(RuntimeWarning, match="manual warning"):
        run._last_async_warning_at = 0
        run._warn_async_drop("manual warning")
    run._warn_async_drop("manual warning")

    monkeypatch.setattr(run._require_async_queue(), "enqueue_many_prepared", lambda events: (_ for _ in ()).throw(sqlite3.Error("broken")))
    run._last_async_warning_at = 0
    with pytest.warns(RuntimeWarning, match="could not record"):
        run.log_metrics({"reward": 2}, step=2)


def test_run_id_setter_marks_pending_spool_run_ready(tmp_path):
    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            return {}

    run = Run(client=FakeClient(), run_id=client_module._PENDING_RUN_ID, upload_mode="spool", spool_dir=str(tmp_path))
    run.run_id = "run/ready"

    assert run.wait_for_init(timeout=0.01) == "run/ready"
    assert (tmp_path / "run_ready").is_dir()


def test_process_spool_writer_requires_ready_directory():
    with pytest.raises(InstantMLError, match="process spool directory is not ready"):
        client_module._write_process_event(None, {"sequence": 1, "event_id": "event"}, "{}")


def test_console_logging_posts_streams_and_line_numbers():
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            return {}

    run = Run(client=FakeClient(), run_id="run-1")
    run.log_stdout(["first", "second"], timestamp="2026-05-14T00:00:00Z")
    run.log_stderr("warn", timestamp="2026-05-14T00:00:01Z")
    run.log_stdout("third")

    assert calls[0] == (
        "POST",
        "/api/runs/run-1/logs",
        {
            "stream": "stdout",
            "lines": [
                {"line_number": 1, "message": "first", "timestamp": "2026-05-14T00:00:00Z"},
                {"line_number": 2, "message": "second", "timestamp": "2026-05-14T00:00:00Z"},
            ],
        },
    )
    assert calls[1][2]["stream"] == "stderr"
    assert calls[1][2]["lines"][0]["line_number"] == 1
    assert calls[2][2]["lines"][0]["line_number"] == 3


def test_console_logging_buffers_and_validates_inputs():
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            return {}

    run = Run(client=FakeClient(), run_id="run-1", buffer_size=2)
    run.log_console("queued")
    assert calls == []
    run.flush()
    assert calls[0][1] == "/api/runs/run-1/logs"

    with pytest.raises(ValueError, match="stdout or stderr"):
        run.log_console("bad", stream="debug")
    with pytest.raises(TypeError, match="stream"):
        run.log_console("bad", stream=3)
    with pytest.raises(ValueError, match="at least one"):
        run.log_stdout([])
    with pytest.raises(TypeError, match="string or a list"):
        run.log_stdout(object())
    with pytest.raises(TypeError, match="strings"):
        run.log_stdout(["ok", 3])
    with pytest.raises(ValueError, match="at most"):
        run.log_stdout(["x"] * 51)
    with pytest.raises(ValueError, match="too large"):
        run.log_stdout("x" * (16 * 1024 + 1))


def test_console_logging_spool_writes_replayable_log_events(tmp_path):
    class FailingClient:
        offline_dir = None

        def _request(self, method, path, body):
            raise AssertionError("network should not be used in process spool mode")

    run = Run(client=FailingClient(), run_id="run-1", upload_mode="spool", spool_dir=str(tmp_path))
    run.log_stdout(["spooled"])

    event = json.loads(next((tmp_path / "run-1").glob("*.json")).read_text(encoding="utf-8"))
    assert event["data"] == {"logs": {"stdout": ["spooled"]}}
    assert event["requests"][0]["path"] == "/api/runs/run-1/logs"
    assert event["requests"][0]["body"]["lines"][0]["line_number"] == 1
    assert event["requests"][0]["body"]["lines"][0]["message"] == "spooled"
    assert event["requests"][0]["body"]["lines"][0]["timestamp"]


def test_log_snapshot_accepts_defined_dictionary_and_rejects_unknown_shapes(tmp_path):
    class FailingClient:
        offline_dir = None

        def _request(self, method, path, body):
            raise AssertionError("network should not be used in process spool mode")

    run = Run(client=FailingClient(), run_id="run-1", upload_mode="spool", spool_dir=str(tmp_path))
    run.log_snapshot(
        {"metrics": {"reward": 2.0}, "metadata": {"phase": "train"}},
        step=2,
        timestamp="2026-05-07T00:00:00Z",
    )

    event = json.loads(next((tmp_path / "run-1").glob("*.json")).read_text(encoding="utf-8"))
    assert event["step"] == 2
    assert event["timestamp"] == "2026-05-07T00:00:00Z"
    assert event["data"]["metadata"] == {"phase": "train"}
    assert event["requests"][0]["body"]["metrics"] == {"reward": 2.0}
    with pytest.raises(TypeError, match="dictionary"):
        run.log_snapshot(["not", "a", "dict"])
    with pytest.raises(ValueError, match="unknown snapshot keys"):
        run.log_snapshot({"metrics": {}, "config": {}})
    with pytest.raises(TypeError, match="metrics"):
        run.log_snapshot({"metrics": []})
    with pytest.raises(TypeError, match="metadata"):
        run.log_snapshot({"metrics": {}, "metadata": []})
    with pytest.raises(ValueError, match="upload_mode"):
        Run(client=FailingClient(), run_id="run-1", upload_mode="thread")


def test_log_snapshot_defaults_to_step_zero_for_strict_servers(tmp_path):
    class FailingClient:
        offline_dir = None

        def _request(self, method, path, body):
            raise AssertionError("network should not be used in process spool mode")

    run = Run(client=FailingClient(), run_id="run-1", upload_mode="spool", spool_dir=str(tmp_path))
    run.log_snapshot({"metrics": {"reward": 2.0}})
    event = json.loads(next((tmp_path / "run-1").glob("*.json")).read_text(encoding="utf-8"))
    assert event["step"] == 0
    assert event["requests"][0]["body"]["step"] == 0


def test_spool_mode_artifacts_and_upload_file_use_placeholder_events(tmp_path):
    class FailingClient:
        offline_dir = None

        def _request(self, method, path, body):
            raise AssertionError("network should not be used in process spool mode")

    source = tmp_path / "policy.txt"
    source.write_text("weights", encoding="utf-8")
    run = Run(client=FailingClient(), run_id="run-1", upload_mode="spool", spool_dir=str(tmp_path / "spool"))
    artifact = run.log_artifact("notes.json", "demo://notes.json", metadata={"kind": "note"})
    upload = run.upload_file(str(source), artifact_type="checkpoint", step=3)

    assert artifact["id"] == "spooled"
    assert artifact["metadata"] == {"kind": "note"}
    assert upload["id"] == "spooled"
    assert upload["source_path"] == str(source.resolve())
    events = [json.loads(path.read_text(encoding="utf-8")) for path in sorted((tmp_path / "spool" / "run-1").glob("*.json"))]
    assert events[0]["data"]["artifacts"][0]["name"] == "notes.json"
    assert events[1]["data"]["upload_file"]["source_path"] == str(source.resolve())


def test_log_config_can_preserve_nested_values():
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            return {}

    run = Run(client=FakeClient(), run_id="run-1")
    run.log_config({"optimizer": {"lr": 0.001}}, flatten=False)

    assert calls[0][2]["attributes"] == [{"path": "config/optimizer", "type": "config", "value": {"lr": 0.001}}]


def test_metric_validation_warns_for_non_increasing_steps():
    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            return {}

    run = Run(client=FakeClient(), run_id="run-1")
    run.log_metrics({"reward": 10}, step=10)
    with pytest.warns(RuntimeWarning, match="non-increasing"):
        run.log_metrics({"reward": 9}, step=9)
    run.log_metrics({"reward": 8}, step=8, preview=True)


def test_upload_file_encodes_bytes_and_mime_type(tmp_path):
    calls = []
    source = tmp_path / "metrics.txt"
    source.write_text("hello", encoding="utf-8")

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            return {"artifact": {"id": "artifact-1", **body}}

    artifact = Run(client=FakeClient(), run_id="run-1").upload_file(str(source), step=2, metadata={"kind": "sample"})

    assert artifact["name"] == "metrics.txt"
    assert artifact["mime_type"] == "text/plain"
    assert artifact["metadata"] == {"kind": "sample"}
    assert calls[0][1] == "/api/runs/run-1/artifacts/upload"
    assert calls[0][2]["content_base64"] == "aGVsbG8="


def test_file_aliases_and_replay_without_offline_dir():
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            return {"artifact": {"id": "artifact-1", **body}}

    run = Run(client=FakeClient(), run_id="run-1")
    assert run.log_file("config.json", "demo://config.json")["type"] == "file"
    assert [artifact["name"] for artifact in run.log_files({"a.txt": "demo://a", "b.txt": "demo://b"}, step=1)] == ["a.txt", "b.txt"]
    assert run.replay_offline() == 0
    assert [call[2]["name"] for call in calls] == ["config.json", "a.txt", "b.txt"]


def test_offline_spool_and_replay(api_server, tmp_path):
    online = ro.init(project="offline", name="replay-me", base_url=api_server, source_tracking=False, upload_mode="sync")
    offline = Run(
        client=Client(base_url="http://127.0.0.1:9", timeout=0.01, offline_dir=str(tmp_path)),
        run_id=online.run_id,
    )
    offline.log_metrics({"reward": 12}, step=1)
    assert (tmp_path / f"{online.run_id}.jsonl").exists()

    replay = Run(client=Client(base_url=api_server, offline_dir=str(tmp_path)), run_id=online.run_id)
    assert replay.replay_offline() == 1
    assert replay.replay_offline() == 0
    metrics = Client(base_url=api_server)._request("GET", f"/runs/{online.run_id}/metrics?key=reward")["metrics"]
    assert metrics[0]["value"] == 12.0


def test_process_uploader_drains_spool_and_cli(monkeypatch, tmp_path):
    calls = []

    class FakeClient:
        def __init__(self, base_url="http://example.test", timeout=2.0, api_key=None):
            self.base_url = base_url
            self.timeout = timeout
            self.api_key = api_key

        def _request(self, method, path, body):
            calls.append((method, path, body, self.base_url, self.timeout))
            return {}

    run = Run(client=FakeClient(), run_id="run-1", upload_mode="spool", spool_dir=str(tmp_path))
    run.log_metrics({"reward": 3}, step=3, timestamp="2026-05-07T00:00:03Z")
    assert uploader.drain_spool(str(tmp_path), client=FakeClient()) == 1
    assert calls[0][:3] == (
        "POST",
        "/runs/run-1/metrics",
        {
            "metrics": {"reward": 3},
            "step": 3,
            "timestamp": "2026-05-07T00:00:03Z",
            "preview": False,
            "preview_completion": 0.0,
        },
    )
    assert not list((tmp_path / "run-1").glob("*.json"))

    run.log_config({"optimizer": {"lr": 0.001}})
    monkeypatch.setattr(uploader, "Client", FakeClient)
    assert uploader.main(["--spool-dir", str(tmp_path), "--base-url", "http://cli.test", "--timeout", "0.5"]) == 0
    assert calls[-1][3:] == ("http://cli.test", 0.5)


def test_log_rank_metrics_posts_rank_context_and_validates() -> None:
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            return {"inserted": len(body["metrics"])}

    run = Run(client=FakeClient(), run_id="run-1")
    run.log_rank_metrics({"loss": 0.5}, step=3, rank=1, world_size=4, local_rank=1, weight=8)
    assert calls == [(
        "POST",
        "/runs/run-1/rank-metrics",
        {
            "metrics": {"loss": 0.5},
            "step": 3,
            "rank": 1,
            "world_size": 4,
            "local_rank": 1,
            "weight": 8.0,
            "timestamp": None,
        },
    )]
    with pytest.raises(ValueError, match="world_size"):
        run.log_rank_metrics({"loss": 0.5}, step=3, rank=0, world_size=0)
    with pytest.raises(TypeError, match="world_size"):
        run.log_rank_metrics({"loss": 0.5}, step=3, rank=0, world_size=1.5)
    with pytest.raises(ValueError, match="world_size"):
        run.log_rank_metrics({"loss": 0.5}, step=3, rank=0, world_size=513)
    with pytest.raises(TypeError, match="rank"):
        run.log_rank_metrics({"loss": 0.5}, step=3, rank=True, world_size=4)
    with pytest.raises(ValueError, match="rank"):
        run.log_rank_metrics({"loss": 0.5}, step=3, rank=4, world_size=4)
    with pytest.raises(TypeError, match="local_rank"):
        run.log_rank_metrics({"loss": 0.5}, step=3, rank=0, world_size=4, local_rank=False)
    with pytest.raises(ValueError, match="local_rank"):
        run.log_rank_metrics({"loss": 0.5}, step=3, rank=0, world_size=4, local_rank=4)
    with pytest.raises(TypeError, match="weight"):
        run.log_rank_metrics({"loss": 0.5}, step=3, rank=0, world_size=4, weight="heavy")
    with pytest.raises(ValueError, match="weight"):
        run.log_rank_metrics({"loss": 0.5}, step=3, rank=0, world_size=4, weight=0)
    with pytest.raises(ValueError, match="step"):
        run.log_rank_metrics({"loss": 0.5}, step=None, rank=0, world_size=4)
    with pytest.raises(ValueError, match="at least one key"):
        run.log_rank_metrics({}, step=3, rank=0, world_size=4)


def test_process_uploader_sends_event_id_as_metric_idempotency_key(tmp_path):
    calls = []

    class IdempotentClient:
        def _request(self, method, path, body, idempotency_key=None):
            calls.append((method, path, body, idempotency_key))
            return {}

    run = Run(client=IdempotentClient(), run_id="run-1", upload_mode="spool", spool_dir=str(tmp_path))
    run.log_metrics({"reward": 4}, step=4, timestamp="2026-05-09T00:00:04Z")
    event_id = json.loads(next((tmp_path / "run-1").glob("*.json")).read_text(encoding="utf-8"))["event_id"]

    assert uploader.drain_spool(str(tmp_path), client=IdempotentClient()) == 1
    assert calls[0][3] == event_id


def test_process_uploader_sends_event_id_as_rank_metric_idempotency_key(tmp_path):
    calls = []

    class IdempotentClient:
        def _request(self, method, path, body, idempotency_key=None):
            calls.append((method, path, body, idempotency_key))
            return {}

    run = Run(client=IdempotentClient(), run_id="run-1", upload_mode="spool", spool_dir=str(tmp_path))
    run.log_rank_metrics(
        {"loss": 0.5},
        step=4,
        rank=1,
        world_size=2,
    )
    event = json.loads(next((tmp_path / "run-1").glob("*.json")).read_text(encoding="utf-8"))
    event_id = event["event_id"]
    assert event["requests"][0]["body"]["timestamp"]

    assert uploader.drain_spool(str(tmp_path), client=IdempotentClient()) == 1
    assert calls[0][1] == "/runs/run-1/rank-metrics"
    assert calls[0][3] == event_id


def test_process_uploader_sends_event_id_as_log_idempotency_key(tmp_path):
    calls = []

    class IdempotentClient:
        def _request(self, method, path, body, idempotency_key=None):
            calls.append((method, path, body, idempotency_key))
            return {}

    run = Run(client=IdempotentClient(), run_id="run-1", upload_mode="spool", spool_dir=str(tmp_path))
    run.log_stdout("hello", timestamp="2026-05-14T00:00:00Z")
    event_id = json.loads(next((tmp_path / "run-1").glob("*.json")).read_text(encoding="utf-8"))["event_id"]

    assert uploader.drain_spool(str(tmp_path), client=IdempotentClient()) == 1
    assert calls[0][1] == "/api/runs/run-1/logs"
    assert calls[0][3] == event_id


def test_package_level_drain_spool_wrapper(tmp_path):
    assert ro.drain_spool(str(tmp_path)) == 0


def test_process_spool_integration_drains_to_api_server(api_server, tmp_path):
    run = ro.init(
        project="process-spool",
        name="worker-drained",
        base_url=api_server,
        source_tracking=False,
        upload_mode="spool",
        spool_dir=str(tmp_path),
    )
    run.log_snapshot({"metrics": {"reward": 7.0}, "metadata": {"phase": "eval"}}, step=7)
    run.finish()

    assert uploader.drain_spool(str(tmp_path), client=Client(base_url=api_server)) == 2
    client = Client(base_url=api_server)
    metrics = client._request("GET", f"/runs/{run.run_id}/metrics?key=reward")["metrics"]
    fetched = client._request("GET", f"/runs/{run.run_id}")["run"]
    assert metrics[0]["value"] == 7.0
    assert fetched["status"] == "finished"


def test_process_uploader_prepares_file_uploads(tmp_path):
    calls = []
    source = tmp_path / "artifact.txt"
    source.write_text("hello", encoding="utf-8")

    class FakeClient:
        def _request(self, method, path, body):
            calls.append((method, path, body))
            return {}

    run = Run(client=FakeClient(), run_id="run-1", upload_mode="spool", spool_dir=str(tmp_path / "spool"))
    run.upload_file(str(source), step=5)

    assert uploader.drain_spool(str(tmp_path / "spool"), client=FakeClient()) == 1
    assert calls[0][1] == "/api/runs/run-1/artifacts/upload"
    assert calls[0][2]["content_base64"] == "aGVsbG8="
    assert "source_path" not in calls[0][2]


def test_process_uploader_failure_preserves_order_per_run(tmp_path):
    calls = []

    class SometimesFailingClient:
        def _request(self, method, path, body):
            if "/run-a/" in path:
                raise InstantMLError("run-a is blocked")
            calls.append((method, path, body))
            return {}

    run_a = Run(client=SometimesFailingClient(), run_id="run-a", upload_mode="spool", spool_dir=str(tmp_path))
    run_b = Run(client=SometimesFailingClient(), run_id="run-b", upload_mode="spool", spool_dir=str(tmp_path))
    run_a.log_metrics({"reward": 1}, step=1)
    run_a.log_metrics({"reward": 2}, step=2)
    run_b.log_metrics({"reward": 9}, step=9)

    assert uploader.drain_spool(str(tmp_path), client=SometimesFailingClient()) == 1
    assert len(list((tmp_path / "run-a").glob("*.json"))) == 2
    assert not list((tmp_path / "run-b").glob("*.json"))
    assert calls[0][1] == "/runs/run-b/metrics"


def test_process_uploader_lock_conflict_and_max_events(tmp_path):
    calls = []

    class FakeClient:
        def _request(self, method, path, body):
            calls.append((method, path, body))
            return {}

    run = Run(client=FakeClient(), run_id="run-1", upload_mode="spool", spool_dir=str(tmp_path))
    run.log_metrics({"reward": 1}, step=1)
    run.log_metrics({"reward": 2}, step=2)
    assert uploader.drain_spool(str(tmp_path), client=FakeClient(), max_events=1) == 1
    assert len(list((tmp_path / "run-1").glob("*.json"))) == 1

    lock_path = tmp_path / uploader.LOCK_FILE
    lock_path.write_text("123", encoding="utf-8")
    with pytest.raises(InstantMLError, match="already running"):
        uploader.drain_spool(str(tmp_path), client=FakeClient())
    lock_path.unlink()
    assert uploader.drain_spool(str(tmp_path), client=FakeClient()) == 1
    assert len(calls) == 2


def test_process_uploader_rejects_malformed_events_and_missing_upload_sources(tmp_path):
    class FakeClient:
        def _request(self, method, path, body):
            return {}

    invalid_json = tmp_path / "run-1" / "0001.json"
    invalid_json.parent.mkdir(parents=True)
    invalid_json.write_text("{", encoding="utf-8")
    assert uploader.drain_spool(str(tmp_path), client=FakeClient()) == 0
    invalid_json.unlink()

    non_object = tmp_path / "run-1" / "0002.json"
    non_object.write_text("[]", encoding="utf-8")
    assert uploader.drain_spool(str(tmp_path), client=FakeClient()) == 0
    non_object.unlink()

    with pytest.raises(InstantMLError, match="exactly one request"):
        uploader._send_event(FakeClient(), {"requests": []})
    with pytest.raises(InstantMLError, match="JSON object"):
        uploader._send_event(FakeClient(), {"requests": ["bad"]})
    with pytest.raises(InstantMLError, match="method, path, and body"):
        uploader._send_event(FakeClient(), {"requests": [{"method": "POST", "path": "/runs/run-1/metrics"}]})
    with pytest.raises(InstantMLError, match="cannot read upload source"):
        uploader._prepare_body("/api/runs/run-1/artifacts/upload", {"source_path": str(tmp_path / "missing.pt")})


def test_request_or_spool_reraises_without_offline_dir():
    class FailingClient:
        offline_dir = None

        def _request(self, method, path, body):
            raise InstantMLError("network down")

    with pytest.raises(InstantMLError, match="network down"):
        Run(client=FailingClient(), run_id="run-1").log_metrics({"reward": 1}, step=0)


def test_client_init_reserves_sdk_source_metadata(monkeypatch):
    calls = []

    def fake_request(self, method, path, body=None):
        calls.append((method, path, body))
        return {"run": {"id": "run-123"}}

    monkeypatch.setattr(Client, "_request", fake_request)
    run = Client(base_url="http://example.test", offline_dir="/client-offline").init(
        project="demo",
        buffer_size=3,
        offline_dir="/run-offline",
        metadata={"source": {"user": "owned"}},
        upload_mode="sync",
    )

    assert run.run_id == "run-123"
    assert run.buffer_size == 3
    assert run.client.offline_dir == "/run-offline"
    assert calls[0][2]["metadata"]["source"] == {"user": "owned"}
    assert "source" in calls[0][2]["metadata"]["_rlobs"]
    source_metadata = calls[0][2]["metadata"]["_rlobs"]["source"]
    assert "argv" not in source_metadata
    assert "cwd" not in source_metadata
    assert "root" not in source_metadata.get("git", {})
    assert "branch" not in source_metadata.get("git", {})
    assert "hostname" not in calls[0][2]["metadata"]
    assert "pid" not in calls[0][2]["metadata"]
    with pytest.raises(ValueError, match="reserved"):
        Client(base_url="http://example.test").init(project="demo", metadata={"_rlobs": {"source": "nope"}})


def test_client_init_can_disable_source_tracking(monkeypatch):
    calls = []

    def fake_request(self, method, path, body=None):
        calls.append((method, path, body))
        return {"run": {"id": "run-123"}}

    monkeypatch.setattr(Client, "_request", fake_request)
    Client(base_url="http://example.test").init(project="demo", source_tracking=False, upload_mode="sync")

    assert "_rlobs" not in calls[0][2]["metadata"]


def test_client_init_applies_opt_in_source_tracking_at_payload_boundary(monkeypatch):
    calls = []

    def fake_request(self, method, path, body=None):
        calls.append((method, path, body))
        return {"run": {"id": "run-123"}}

    def fake_check_output(args, **kwargs):
        command = tuple(args[1:])
        if command == ("rev-parse", "--show-toplevel"):
            return "/workspace/project\n"
        if command == ("rev-parse", "HEAD"):
            return "abc123\n"
        if command == ("status", "--porcelain"):
            return ""
        if command == ("branch", "--show-current"):
            return "main\n"
        raise subprocess.CalledProcessError(1, args)

    monkeypatch.setattr(Client, "_request", fake_request)
    monkeypatch.setattr("subprocess.check_output", fake_check_output)
    monkeypatch.setattr(os, "getcwd", lambda: "/workspace/project")
    monkeypatch.setattr(os, "getpid", lambda: 12345)
    monkeypatch.setattr("socket.gethostname", lambda: "trainer-host")
    monkeypatch.setattr(sys, "argv", ["/workspace/project/train.py", "--epochs", "2"])

    Client(base_url="http://example.test").init(
        project="demo",
        source_tracking=SourceTracking(command=True, paths=True, branch=True, hostname=True, pid=True),
        upload_mode="sync",
    )

    metadata = calls[0][2]["metadata"]
    source_metadata = metadata["_rlobs"]["source"]
    assert metadata["hostname"] == "trainer-host"
    assert metadata["pid"] == 12345
    assert source_metadata["argv"] == ["/workspace/project/train.py", "--epochs", "2"]
    assert source_metadata["cwd"] == "/workspace/project"
    assert source_metadata["git"]["root"] == "/workspace/project"
    assert source_metadata["git"]["branch"] == "main"


def test_client_sends_api_key_and_idempotency_headers(monkeypatch):
    captured = {}

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def read(self):
            return b'{"ok": true}'

    def fake_urlopen(request, timeout):
        captured["authorization"] = request.get_header("Authorization")
        captured["idempotency"] = request.get_header("Idempotency-key")
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

    assert Client(base_url="http://example.test", timeout=3, api_key="secret")._request(
        "POST",
        "/runs/run-1/metrics",
        {"metrics": {"reward": 1}, "step": 1},
        idempotency_key="event-1",
    ) == {"ok": True}
    assert captured == {"authorization": "Bearer secret", "idempotency": "event-1", "timeout": 3}


def test_api_fork_run_returns_child_and_sends_idempotency(monkeypatch):
    calls = []

    def fake_request(self, method, path, body=None, idempotency_key=None):
        calls.append((method, path, body, idempotency_key))
        return {"run": {"id": "child-run"}}

    monkeypatch.setattr(Client, "_request", fake_request)

    child = ro.Api(base_url="http://example.test").fork_run(
        "source-run",
        step=120,
        checkpoint_artifact_id="artifact-1",
        inherit_config=True,
        config_overrides={"lr": 0.001},
        tags=["retry"],
        notes="try again",
        metadata={"reason": "nan"},
        idempotency_key="fork-1",
    )

    assert child == {"id": "child-run"}
    assert calls == [
        (
            "POST",
            "/api/runs/source-run/forks",
            {
                "inherit_config": True,
                "step": 120,
                "checkpoint_artifact_id": "artifact-1",
                "config_overrides": {"lr": 0.001},
                "tags": ["retry"],
                "notes": "try again",
                "metadata": {"reason": "nan"},
            },
            "fork-1",
        )
    ]


def test_api_fork_run_uses_stable_default_idempotency(monkeypatch):
    calls = []

    def fake_request(self, method, path, body=None, idempotency_key=None):
        calls.append((method, path, body, idempotency_key))
        return {"run": {"id": f"child-{len(calls)}"}}

    monkeypatch.setattr(Client, "_request", fake_request)

    api = ro.Api(base_url="http://example.test")
    assert api.fork_run("source-run", step=120, tags=["retry"]) == {"id": "child-1"}
    assert api.fork_run("source-run", step=120, tags=["retry"]) == {"id": "child-2"}

    assert calls[0][3] == calls[1][3]
    assert calls[0][3].startswith("instantml-fork-")


def test_api_fork_run_validates_inputs_and_response(monkeypatch):
    with pytest.raises(TypeError, match="inherit_config"):
        ro.Api(base_url="http://example.test").fork_run("source-run", inherit_config="yes")
    with pytest.raises(TypeError, match="tags"):
        ro.Api(base_url="http://example.test").fork_run("source-run", tags="retry")
    with pytest.raises(ValueError, match="notes"):
        ro.Api(base_url="http://example.test").fork_run("source-run", notes="")

    def invalid_response(self, method, path, body=None, idempotency_key=None):
        return {"run": "not-a-dict"}

    monkeypatch.setattr(Client, "_request", invalid_response)
    with pytest.raises(InstantMLError, match="invalid fork response"):
        ro.Api(base_url="http://example.test").fork_run("source-run", name="child")


def test_attach_run_returns_existing_run_handle(monkeypatch, tmp_path):
    calls = []

    def fake_request(self, method, path, body=None, idempotency_key=None):
        calls.append((method, path, body, idempotency_key))
        return {"run": {"id": "run-123"}}

    monkeypatch.setattr(Client, "_request", fake_request)
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    run = Client(base_url="http://example.test", api_key="key").attach_run(
        "run-123",
        queue_dir=str(tmp_path / "async"),
    )

    assert run.run_id == "run-123"
    assert run.client.base_url == "http://example.test"
    assert run.upload_mode == "async"
    assert (tmp_path / "async" / "run-123" / "queue.sqlite3").exists()
    assert calls == [("GET", "/runs/run-123", None, None)]


def test_attach_run_optional_local_features(monkeypatch):
    events = []

    def fake_request(self, method, path, body=None, idempotency_key=None):
        return {"run": {"id": "run-123"}}

    monkeypatch.setattr(Client, "_request", fake_request)
    monkeypatch.setattr(Run, "start_system_metrics", lambda self, interval=15.0: events.append(("system", interval)))
    monkeypatch.setattr(Run, "capture_console", lambda self: events.append(("console", self.run_id)))

    run = ro.attach_run(
        "run-123",
        api_key="key",
        base_url="http://example.test",
        system_metrics=True,
        system_metrics_interval=3.0,
        capture_console=True,
        upload_mode="sync",
    )

    assert run.run_id == "run-123"
    assert events == [("system", 3.0), ("console", "run-123")]


def test_top_level_attach_run_defaults_to_async(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    def fake_request(self, method, path, body=None, idempotency_key=None):
        return {"run": {"id": "run-top-async"}}

    monkeypatch.setattr(Client, "_request", fake_request)

    run = ro.attach_run(
        "run-top-async",
        api_key="key",
        base_url="http://example.test",
        queue_dir=str(tmp_path / "async"),
    )

    assert run.run_id == "run-top-async"
    assert run.upload_mode == "async"
    assert (tmp_path / "async" / "run-top-async" / "queue.sqlite3").exists()


def test_attach_run_can_skip_validation(monkeypatch):
    calls = []

    def fail_request(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("attach_run(validate=False) should not fetch the run")

    monkeypatch.setattr(Client, "_request", fail_request)

    run = Client(base_url="http://example.test", api_key="key").attach_run(
        "run-123",
        upload_mode="sync",
        validate=False,
    )

    assert run.run_id == "run-123"
    assert calls == []


def test_attach_run_validation_rejects_missing_or_unexpected_run(monkeypatch):
    def fake_request(self, method, path, body=None, idempotency_key=None):
        return {"run": {"id": "other"}}

    monkeypatch.setattr(Client, "_request", fake_request)
    with pytest.raises(InstantMLError, match="invalid run response"):
        Client(base_url="http://example.test", api_key="key").attach_run("run-123", upload_mode="sync")

    with pytest.raises(TypeError, match="validate"):
        Client(base_url="http://example.test", api_key="key").attach_run("run-123", validate="no")


def test_client_retries_429_with_retry_after(monkeypatch):
    sleeps = []
    attempts = {"count": 0}

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def read(self):
            return b'{"ok": true}'

    def fake_urlopen(request, timeout):
        attempts["count"] += 1
        if attempts["count"] == 1:
            body = BytesIO(json.dumps({"error": "rate limit exceeded"}).encode("utf-8"))
            raise urllib.error.HTTPError(
                request.full_url,
                429,
                "Too Many Requests",
                {"Retry-After": "0.01"},
                body,
            )
        return FakeResponse()

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    monkeypatch.setattr(time, "sleep", lambda delay: sleeps.append(delay))

    assert Client(base_url="http://example.test")._request("GET", "/api/usage") == {"ok": True}
    assert attempts["count"] == 2
    assert sleeps == [0.01]


def test_rate_limit_retry_delay_falls_back_for_invalid_retry_after():
    exc = urllib.error.HTTPError(
        "http://example.test/api/usage",
        429,
        "Too Many Requests",
        {"Retry-After": "not-a-number"},
        BytesIO(b"{}"),
    )

    assert client_module._rate_limit_retry_delay(exc, 1) == 0.5


def test_client_does_not_retry_monthly_429(monkeypatch):
    attempts = {"count": 0}

    def fake_urlopen(request, timeout):
        attempts["count"] += 1
        body = BytesIO(json.dumps({"error": "monthly limit exceeded"}).encode("utf-8"))
        raise urllib.error.HTTPError(
            request.full_url,
            429,
            "Too Many Requests",
            {"X-InstantML-RateLimit-Scope": "monthly", "Retry-After": "1000"},
            body,
        )

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    monkeypatch.setattr(time, "sleep", lambda delay: (_ for _ in ()).throw(AssertionError(delay)))

    with pytest.raises(InstantMLError, match="monthly limit exceeded"):
        Client(base_url="http://example.test")._request("GET", "/projects")

    assert attempts["count"] == 1


def test_environment_metadata_contains_expected_keys():
    metadata = _environment_metadata()
    assert {"python", "platform"} <= set(metadata)
    assert "hostname" not in metadata
    assert "pid" not in metadata

    expanded = _environment_metadata(SourceTracking(hostname=True, pid=True))
    assert {"python", "platform", "hostname", "pid"} <= set(expanded)


def test_source_metadata_handles_missing_git(monkeypatch):
    def fail(*args, **kwargs):
        raise subprocess.CalledProcessError(1, "git")

    monkeypatch.setattr("subprocess.check_output", fail)

    assert _git_metadata() == {"available": False}
    assert _source_metadata()["git"] == {"available": False}


def test_source_tracking_normalization_and_empty_entrypoint(monkeypatch):
    settings = SourceTracking(branch=True)
    assert _normalize_source_tracking(settings) is settings
    assert _normalize_source_tracking(True) == SourceTracking.privacy_safe()
    assert _normalize_source_tracking(False) is None
    with pytest.raises(TypeError, match="source_tracking"):
        _normalize_source_tracking("yes")
    with pytest.raises(TypeError, match="command"):
        SourceTracking(command="false")
    with pytest.raises(TypeError, match="git_timeout"):
        SourceTracking(git_timeout=True)
    with pytest.raises(ValueError, match="git_timeout"):
        SourceTracking(git_timeout=float("inf"))
    with pytest.raises(TypeError, match="diff_bytes"):
        SourceTracking(diff_bytes=False)
    with pytest.raises(ValueError, match="diff_bytes"):
        SourceTracking(diff_bytes=-1)

    monkeypatch.setattr("subprocess.check_output", lambda *args, **kwargs: (_ for _ in ()).throw(subprocess.CalledProcessError(1, "git")))
    monkeypatch.setattr(sys, "argv", [])
    assert "entrypoint" not in _source_metadata(SourceTracking.privacy_safe())
    monkeypatch.setattr(sys, "argv", [""])
    assert "entrypoint" not in _source_metadata(SourceTracking.privacy_safe())


def test_git_diff_metadata_tolerates_diff_command_failures(monkeypatch):
    def fake_check_output(args, **kwargs):
        command = tuple(args[1:])
        if command == ("rev-parse", "--show-toplevel"):
            return "/repo\n"
        if command == ("rev-parse", "HEAD"):
            return "abc123\n"
        if command == ("status", "--porcelain"):
            return " M train.py\n"
        raise subprocess.CalledProcessError(1, args)

    monkeypatch.setattr("subprocess.check_output", fake_check_output)
    monkeypatch.setattr(
        source_module,
        "_git_patch_prefix",
        lambda args, timeout, max_bytes: (None, False),
    )
    monkeypatch.setattr(
        source_module,
        "_git_bounded_text",
        lambda args, timeout, max_bytes: (None, False),
    )

    metadata = _git_metadata(SourceTracking(git_diff=True))

    assert metadata["available"] is True
    assert metadata["dirty"] is True
    assert metadata["diff"]["patch_sha256"] is None


def test_git_metadata_marks_dirty_status_unknown(monkeypatch):
    def fake_check_output(args, **kwargs):
        command = tuple(args[1:])
        if command == ("rev-parse", "--show-toplevel"):
            return "/repo\n"
        if command == ("rev-parse", "HEAD"):
            return "abc123\n"
        if command == ("status", "--porcelain"):
            raise subprocess.TimeoutExpired(args, 0.1)
        raise subprocess.CalledProcessError(1, args)

    monkeypatch.setattr("subprocess.check_output", fake_check_output)

    metadata = _git_metadata(SourceTracking())

    assert metadata["available"] is True
    assert metadata["dirty"] is None
    assert metadata["dirty_unknown"] is True


def test_git_patch_prefix_caps_output_and_handles_failures(tmp_path, monkeypatch):
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    (tmp_path / "train.py").write_text("print('hello')\n", encoding="utf-8")
    subprocess.run(["git", "add", "train.py"], cwd=tmp_path, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    monkeypatch.chdir(tmp_path)

    assert source_module._git_patch_prefix(("diff", "--cached"), 1.0, 0) == (b"", True)
    data, truncated = source_module._git_patch_prefix(("diff", "--cached"), 1.0, 3)
    assert data == b"dif"
    assert truncated is True
    full_data, full_truncated = source_module._git_patch_prefix(("diff", "--cached"), 1.0, 10000)
    assert b"train.py" in full_data
    assert full_truncated is False
    stat_text, stat_truncated = source_module._git_bounded_text(("diff", "--cached", "--stat"), 1.0, 10000)
    assert "train.py" in stat_text
    assert stat_truncated is False
    assert source_module._git_patch_prefix(("not-a-real-command",), 1.0, 3) == (None, False)
    assert source_module._git_bounded_text(("not-a-real-command",), 1.0, 3) == (None, False)

    monkeypatch.setattr(
        source_module.subprocess,
        "Popen",
        lambda *args, **kwargs: (_ for _ in ()).throw(OSError("no git")),
    )
    assert source_module._git_patch_prefix(("diff",), 1.0, 3) == (None, False)


def test_git_output_prefix_handles_timeout_and_process_edge_cases(monkeypatch):
    class FakeStdout:
        def fileno(self):
            return 0

        def close(self):
            return None

    class HangingProcess:
        stdout = FakeStdout()
        killed = False

        def poll(self):
            return None

        def kill(self):
            self.killed = True

        def wait(self, timeout=None):
            return 0

    class EmptySelector:
        def register(self, *args, **kwargs):
            return None

        def select(self, timeout=None):
            return []

        def close(self):
            return None

    process = HangingProcess()
    monkeypatch.setattr(source_module.subprocess, "Popen", lambda *args, **kwargs: process)
    monkeypatch.setattr(source_module.selectors, "DefaultSelector", EmptySelector)

    assert source_module._git_patch_prefix(("diff",), 1.0, 3) == (None, False)
    assert process.killed is True
    process = HangingProcess()
    monkeypatch.setattr(source_module.subprocess, "Popen", lambda *args, **kwargs: process)
    assert source_module._git_patch_prefix(("diff",), -1.0, 3) == (None, False)
    assert process.killed is True

    class FinishedNoEventsProcess:
        stdout = FakeStdout()

        def poll(self):
            return 0

        def wait(self, timeout=None):
            return 0

    monkeypatch.setattr(source_module.subprocess, "Popen", lambda *args, **kwargs: FinishedNoEventsProcess())
    assert source_module._git_patch_prefix(("diff",), 1.0, 3) == (b"", False)

    class TimeoutWaitProcess:
        stdout = FakeStdout()

        def poll(self):
            return None

        def kill(self):
            return None

        def wait(self, timeout=None):
            raise subprocess.TimeoutExpired("git diff", timeout)

    class ReadySelector:
        def register(self, *args, **kwargs):
            return None

        def select(self, timeout=None):
            return [object()]

        def close(self):
            return None

    monkeypatch.setattr(source_module.subprocess, "Popen", lambda *args, **kwargs: TimeoutWaitProcess())
    monkeypatch.setattr(source_module.selectors, "DefaultSelector", ReadySelector)
    monkeypatch.setattr(source_module.os, "read", lambda fd, size: b"")
    assert source_module._git_patch_prefix(("diff",), 1.0, 3) == (None, False)

    class NoStdoutProcess:
        stdout = None

    monkeypatch.setattr(source_module.subprocess, "Popen", lambda *args, **kwargs: NoStdoutProcess())
    assert source_module._git_patch_prefix(("diff",), 1.0, 3) == (None, False)

    class FinishedProcess:
        def poll(self):
            return 0

        def kill(self):
            raise AssertionError("finished processes should not be killed")

    source_module._kill_process(FinishedProcess())


def test_source_tracking_knobs_are_explicit(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["/tmp/train.py", "--lr", "0.1"])
    monkeypatch.setattr(os, "getcwd", lambda: "/workspace/project")

    def fake_check_output(args, **kwargs):
        command = tuple(args[1:])
        if command == ("rev-parse", "--show-toplevel"):
            return "/workspace/project\n"
        if command == ("rev-parse", "HEAD"):
            return "abc123\n"
        if command == ("status", "--porcelain"):
            return ""
        if command == ("branch", "--show-current"):
            return "main\n"
        if command[:2] == ("diff", "--cached") and "--stat" in command:
            return " staged.py | 1 +\n"
        if command[0] == "diff" and "--stat" in command:
            return " train.py | 2 +-\n"
        raise AssertionError(command)

    monkeypatch.setattr("subprocess.check_output", fake_check_output)
    monkeypatch.setattr(
        source_module,
        "_git_patch_prefix",
        lambda args, timeout, max_bytes: (b"diff --git a/train.py b/train.py\n", False),
    )
    monkeypatch.setattr(
        source_module,
        "_git_bounded_text",
        lambda args, timeout, max_bytes: (" staged.py | 1 +", False)
        if args[:2] == ("diff", "--cached")
        else (" train.py | 2 +-", False),
    )

    default = _source_metadata(SourceTracking.privacy_safe())
    assert default["entrypoint"] == "train.py"
    assert "argv" not in default
    assert "cwd" not in default
    assert "branch" not in default["git"]
    assert "root" not in default["git"]
    assert "diff" not in default["git"]

    expanded = _source_metadata(SourceTracking(command=True, paths=True, branch=True, git_diff=True))
    assert expanded["argv"] == ["/tmp/train.py", "--lr", "0.1"]
    assert expanded["cwd"] == "/workspace/project"
    assert expanded["git"]["root"] == "/workspace/project"
    assert expanded["git"]["branch"] == "main"
    assert expanded["git"]["diff"]["patch_sha256"]
    assert expanded["git"]["diff"]["patch_digest_scope"] == "full"
    assert "diff --git" not in json.dumps(expanded)


def test_sdk_raises_clear_error_for_http_error(api_server):
    client = Client(base_url=api_server)
    run = client.init(project="")
    with pytest.raises(InstantMLError, match="project name"):
        run.wait_for_init(timeout=2.0)


def test_sdk_raises_clear_error_for_network_error():
    client = Client(base_url="http://127.0.0.1:9", timeout=0.01)
    run = client.init(project="cartpole")
    with pytest.raises(InstantMLError):
        run.wait_for_init(timeout=2.0)


def test_sdk_rejects_invalid_json_response(monkeypatch):
    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def read(self):
            return b"not-json"

    monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: FakeResponse())
    with pytest.raises(InstantMLError, match="invalid JSON"):
        Client()._request("GET", "/health")


def test_sdk_rejects_non_object_json_response(monkeypatch):
    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def read(self):
            return b"[]"

    monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: FakeResponse())
    with pytest.raises(InstantMLError, match="non-object"):
        Client()._request("GET", "/health")


def test_sdk_http_error_fallback_message(monkeypatch):
    def fail(*args, **kwargs):
        raise urllib.error.HTTPError("url", 500, "boom", {}, BytesIO(b"not-json"))

    monkeypatch.setattr("urllib.request.urlopen", fail)
    with pytest.raises(InstantMLError, match="HTTP Error 500"):
        Client()._request("GET", "/health")


def test_sdk_http_error_non_error_object_message(monkeypatch):
    def fail(*args, **kwargs):
        body = BytesIO(json.dumps({"message": "not the standard shape"}).encode("utf-8"))
        raise urllib.error.HTTPError("url", 500, "boom", {}, body)

    monkeypatch.setattr("urllib.request.urlopen", fail)
    with pytest.raises(InstantMLError, match="HTTP Error 500"):
        Client()._request("GET", "/health")


def test_log_auto_step_classifies_metrics_text_objects_and_files(tmp_path):
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            if path.endswith("/artifacts/upload"):
                return {"artifact": {"id": f"artifact-{len(calls)}", "name": body["name"], "mime_type": body["mime_type"], "size_bytes": body["size_bytes"]}}
            return {"object": {"id": len(calls), **body}}

    sample = tmp_path / "sample.txt"
    sample.write_text("hello", encoding="utf-8")
    run = Run(client=FakeClient(), run_id="run-1")

    run.log(
        {
            "loss": 0.25,
            "note": "stable",
            "explicit_text": ro.Text("kept"),
            "table": ro.Table.from_data([{"epoch": 1, "score": 0.9}]),
            "hist": ro.Histogram.from_values([0.0, 1.0, 2.0], bins=2),
            "file": ro.File(str(sample), artifact_type="checkpoint", metadata={"phase": "train"}),
        }
    )
    run.log({"loss": 0.2}, step=5)
    run.log({"loss": 0.1})

    assert [call[1] for call in calls[:5]] == [
        "/runs/run-1/metrics",
        "/api/runs/run-1/attributes",
        "/api/runs/run-1/objects",
        "/api/runs/run-1/objects",
        "/api/runs/run-1/artifacts/upload",
    ]
    assert calls[0][2]["step"] == 1
    assert calls[0][2]["metrics"] == {"loss": 0.25}
    assert calls[1][2]["attributes"] == [
        {"path": "note", "type": "string_series", "step": 1, "timestamp": None, "value": "stable"},
        {"path": "explicit_text", "type": "string_series", "step": 1, "timestamp": None, "value": "kept"},
    ]
    assert calls[2][2]["summary"] == {"columns": ["epoch", "score"], "row_count": 1}
    assert calls[3][2]["kind"] == "histogram"
    assert calls[4][2]["name"] == "sample.txt"
    assert calls[4][2]["type"] == "checkpoint"
    assert calls[4][2]["metadata"] == {"phase": "train", "log_key": "file"}
    assert calls[-2][2]["step"] == 5
    assert calls[-1][2]["step"] == 6


def test_log_validation_rejects_before_submit_and_expands_supported_lists(tmp_path):
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            if path.endswith("/artifacts/upload"):
                return {"artifact": {"id": f"artifact-{len(calls)}", **body}}
            return {"object": {"id": len(calls), **body}}

    first = tmp_path / "first.txt"
    second = tmp_path / "second.txt"
    first.write_text("one", encoding="utf-8")
    second.write_text("two", encoding="utf-8")
    run = Run(client=FakeClient(), run_id="run-1")

    with pytest.raises(TypeError, match="numeric"):
        run.log({"values": [1, 2, 3]})
    with pytest.raises(TypeError, match="unsupported"):
        run.log({"bad": object()})
    with pytest.raises(ValueError, match="log key"):
        run.log({"": 1})
    with pytest.raises(ValueError, match="finite"):
        run.log({"loss": 1.0}, step=float("inf"))
    with pytest.raises(ValueError, match="nonnegative"):
        run.log({"loss": 1.0}, step=-1)
    with pytest.raises(TypeError, match="step"):
        run.log({"loss": 1.0}, step=True)
    assert calls == []

    run.log({"tables": [ro.Table(["a"], [[1]]), ro.Table(["a"], [[2]])], "files": [ro.File(str(first)), ro.File(str(second))]})

    assert [call[2]["key"] for call in calls if call[1].endswith("/objects")] == ["tables/0", "tables/1"]
    assert [call[2]["step"] for call in calls if call[1].endswith("/objects")] == [1, 1]
    assert [call[2]["name"] for call in calls if call[1].endswith("/artifacts/upload")] == ["first.txt", "second.txt"]


def test_wrappers_conversions_and_missing_optional_dependencies(monkeypatch, tmp_path):
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            if path.endswith("/artifacts/upload"):
                return {"artifact": {"id": "artifact-1", "name": body["name"], "mime_type": body["mime_type"], "size_bytes": body["size_bytes"]}}
            return {"object": {"id": 10, **body}}

    class FakeDataFrame:
        columns = ["name", "score"]

        def to_dict(self, orient):
            assert orient == "records"
            return [{"name": "a", "score": 1}]

    run = Run(client=FakeClient(), run_id="run-1")
    run.log_objects({"frame": ro.Table.from_dataframe(FakeDataFrame())}, step=1)
    run.log_objects({"image": ro.Image.from_data([[[255, 0, 0]]])}, step=1)
    run.log_objects({"scaled_image": ro.Image.from_data([[[0.5, 0.0, 0.0]]])}, step=1)

    assert calls[0][2]["rows"] == [{"name": "a", "score": 1}]
    upload = next(call for call in calls if call[1].endswith("/artifacts/upload"))
    assert upload[2]["mime_type"] == "image/png"

    real_import = __import__

    def fail_soundfile(name, *args, **kwargs):
        if name == "soundfile":
            raise ImportError("no soundfile")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fail_soundfile)
    with pytest.raises(InstantMLError, match="soundfile"):
        run.log_objects({"audio": ro.Audio.from_data([0.0, 0.1])}, step=1)

    def fail_video_imports(name, *args, **kwargs):
        if name.startswith("imageio") or name.startswith("moviepy"):
            raise ImportError("no video dependency")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fail_video_imports)
    with pytest.raises(InstantMLError, match="moviepy or imageio"):
        run.log_objects({"video": ro.Video.from_data([[[[0, 0, 0]]]])}, step=1)


def test_local_store_records_attempted_metrics_events_and_files(tmp_path):
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            if path.endswith("/artifacts/upload"):
                return {"artifact": {"id": "artifact-1", **body}}
            return {"object": {"id": "object-1", **body}}

    source = tmp_path / "weights.bin"
    source.write_bytes(b"weights")
    store = _LocalStore(str(tmp_path / "local"), "run-1")
    run = Run(client=FakeClient(), run_id="run-1", _local_store=store)
    run.log({"loss": 1.0, "note": "ok", "table": ro.Table(["a"], [[1]]), "weights": ro.File(str(source))})
    run.finish()

    database = sqlite3.connect(tmp_path / "local" / "store.sqlite3")
    metric_rows = database.execute("select key, value, status from metrics").fetchall()
    event_rows = database.execute("select kind, key, status from events where kind != 'run' order by id").fetchall()
    file_rows = database.execute("select key, sha256, size_bytes, artifact_type from files").fetchall()

    assert metric_rows == [("loss", 1.0, "attempted")]
    assert event_rows == [("text", "note", "attempted"), ("object", "table", "attempted")]
    assert file_rows == [("weights.bin", "9a129038d9a00aed0cf6a7ea059ca50a813449061ab87848cf1a13eafdf33b2c", 7, "file")]


def test_system_metrics_collection_and_sampler_lifecycle(monkeypatch):
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            return {}

    class FakePsutil:
        @staticmethod
        def cpu_percent(interval=None):
            assert interval is None
            return 12.5

        @staticmethod
        def virtual_memory():
            return SimpleNamespace(percent=50, used=1024)

        class Process:
            def __init__(self, pid):
                assert pid

            def memory_info(self):
                return SimpleNamespace(rss=2048)

        @staticmethod
        def disk_usage(path):
            assert path
            return SimpleNamespace(percent=60)

        @staticmethod
        def net_io_counters():
            return SimpleNamespace(bytes_sent=10, bytes_recv=20)

    class FakeNvml:
        initialized = False
        shutdown = False

        @staticmethod
        def nvmlInit():
            FakeNvml.initialized = True

        @staticmethod
        def nvmlDeviceGetCount():
            return 1

        @staticmethod
        def nvmlDeviceGetHandleByIndex(index):
            assert index == 0
            return "gpu0"

        @staticmethod
        def nvmlDeviceGetUtilizationRates(handle):
            assert handle == "gpu0"
            return SimpleNamespace(gpu=70)

        @staticmethod
        def nvmlDeviceGetMemoryInfo(handle):
            assert handle == "gpu0"
            return SimpleNamespace(used=4, total=8)

        @staticmethod
        def nvmlDeviceGetPowerUsage(handle):
            assert handle == "gpu0"
            return 125000

        @staticmethod
        def nvmlShutdown():
            FakeNvml.shutdown = True

    metrics = _collect_system_metrics(psutil_module=FakePsutil, pynvml_module=FakeNvml)
    assert metrics["system/cpu_percent"] == 12.5
    assert metrics["system/gpu/0/memory_percent"] == 50.0
    assert metrics["system/gpu/0/power_watts"] == 125.0
    assert FakeNvml.initialized
    assert FakeNvml.shutdown

    monkeypatch.setattr(client_module, "_collect_system_metrics", lambda: {"system/cpu_percent": 1.0})
    run = Run(client=FakeClient(), run_id="run-1")
    run.start_system_metrics(interval=0.01)
    with pytest.raises(InstantMLError, match="already running"):
        run.start_system_metrics(interval=0.01)
    time.sleep(0.03)
    run.finish()
    assert any(call[2]["metrics"] == {"system/cpu_percent": 1.0} for call in calls)
    with pytest.raises(ValueError, match="positive"):
        Run(client=FakeClient(), run_id="run-2").start_system_metrics(interval=0)


def test_async_init_with_system_metrics_does_not_deadlock_on_run_id_property(monkeypatch):
    """Regression: _SystemMetricsSampler.__init__ must not read run.run_id (the
    property), which blocks on _init_done. _resolve_init() calls
    start_system_metrics before setting _init_done, so any access to the
    property from inside the sampler constructor deadlocks the init thread.
    """

    def fake_request(self, method, path, body=None):
        return {"run": {"id": "run-async-sys"}}

    monkeypatch.setattr(Client, "_request", fake_request)
    monkeypatch.setattr(client_module, "_collect_system_metrics", lambda: {})

    run = Client(base_url="http://example.test").init(
        project="demo",
        system_metrics=True,
        system_metrics_interval=60.0,
        upload_mode="sync",
    )
    assert run.wait_for_init(timeout=2.0) == "run-async-sys"
    assert run._system_sampler is not None
    run.finish()


def test_console_capture_writes_through_logs_and_restores(monkeypatch):
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            return {}

    stream = BytesIO()

    class TextStream:
        def write(self, text):
            stream.write(text.encode("utf-8"))
            return len(text)

        def flush(self):
            return None

        def isatty(self):
            return False

    monkeypatch.setattr(sys, "stdout", TextStream())
    run = Run(client=FakeClient(), run_id="run-1")
    run.capture_console()
    with pytest.raises(InstantMLError, match="already enabled"):
        run.capture_console()
    sys.stdout.write("hello\n")
    sys.stdout.flush()
    run.finish()

    assert stream.getvalue() == b"hello\n"
    assert calls[0][1] == "/api/runs/run-1/attributes"
    assert calls[0][2]["attributes"][0]["path"] == "console/stdout"
    assert calls[0][2]["attributes"][0]["value"] == "hello"
    assert calls[-1] == ("PATCH", "/runs/run-1", {"status": "finished"})


def test_torch_watch_transformers_callback_and_lightning_logger(monkeypatch):
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            return {"object": {"id": "object-1", **body}}

    class Handle:
        def __init__(self):
            self.removed = False

        def remove(self):
            self.removed = True

    class Parameter:
        def __init__(self, values):
            self.values = values
            self.hook = None
            self.handle = Handle()

        def register_hook(self, hook):
            self.hook = hook
            return self.handle

        def detach(self):
            return self

        def cpu(self):
            return self

        def numpy(self):
            return self

        def tolist(self):
            return self.values

    parameter = Parameter([0.0, 1.0, 2.0])
    model = SimpleNamespace(named_parameters=lambda: [("layer.weight", parameter)])
    run = Run(client=FakeClient(), run_id="run-1")

    handle = run.watch(model, log="all", log_freq=2, bins=2)
    parameter.hook([0.0, 0.5])
    parameter.hook([0.0, 0.5])
    with pytest.warns(RuntimeWarning, match="gradient logging failed"):
        parameter.hook(object())
        parameter.hook(object())
    handle.remove()

    object_keys = [call[2]["key"] for call in calls if call[1].endswith("/objects")]
    assert object_keys == ["parameters/layer.weight", "gradients/layer.weight"]
    assert parameter.handle.removed
    with pytest.raises(ValueError, match="log_freq"):
        run.watch(model, log_freq=0)
    with pytest.raises(ValueError, match="log must"):
        run.watch(model, log="activations")
    with pytest.raises(TypeError, match="named_parameters"):
        run.watch(object())

    class FakeRun:
        run_id = "fake-run"

        def __init__(self):
            self.logged = []
            self.configs = []
            self.finished = []

        def log(self, metrics, step=None):
            self.logged.append((metrics, step))

        def log_config(self, params):
            self.configs.append(params)

        def finish(self, status="finished"):
            self.finished.append(status)

    fake_run = FakeRun()
    monkeypatch.setattr(client_module, "init", lambda **kwargs: fake_run)
    callback = ro.TransformersCallback(project="hf-demo")
    callback.on_log(SimpleNamespace(project="ignored"), SimpleNamespace(global_step=9), object(), logs={"loss": 1.0, "epoch": "1"})
    assert fake_run.logged == [({"loss": 1.0}, 9)]

    logger = ro.LightningLogger(project="lightning-demo", run=fake_run)
    assert logger.name == "lightning-demo"
    assert logger.version == "fake-run"
    logger.log_metrics({"acc": 0.8}, step=2)
    logger.log_hyperparams({"lr": 0.01})
    logger.finalize("success")
    assert fake_run.logged[-1] == ({"acc": 0.8}, 2)
    assert fake_run.configs == [{"lr": 0.01}]
    assert fake_run.finished == ["success"]


def test_wrapper_constructor_edge_cases_and_client_init_options(monkeypatch, tmp_path):
    calls = []

    def fake_request(self, method, path, body=None):
        calls.append((method, path, body))
        return {"run": {"id": "run-123"}}

    monkeypatch.setattr(Client, "_request", fake_request)
    monkeypatch.setattr(Run, "start_system_metrics", lambda self, interval: setattr(self, "_started_interval", interval))
    monkeypatch.setattr(Run, "capture_console", lambda self: setattr(self, "_captured_console", True))

    run = Client(base_url="http://example.test").init(
        project="demo",
        local_store=True,
        local_store_dir=str(tmp_path / "local"),
        system_metrics=True,
        system_metrics_interval=3.0,
        capture_console=True,
        upload_mode="sync",
        async_init=False,
    )
    run.wait_for_init(timeout=2.0)

    assert run._started_interval == 3.0
    assert run._captured_console is True
    assert (tmp_path / "local" / "store.sqlite3").exists()
    run._local_store.close()
    assert calls[0][1] == "/runs"

    with pytest.raises(ValueError, match="dataframe or data"):
        ro.Table(dataframe=object(), data=[])
    assert ro.Table(columns=("a",), rows=({"a": 1},)).rows == [{"a": 1}]
    assert ro.Table.from_data([{"auto": 1}]).columns == ["auto"]
    with pytest.raises(TypeError, match="bin count"):
        ro.Histogram.from_values([1], bins=True)
    with pytest.raises(ValueError, match="positive"):
        ro.Histogram.from_values([1], bins=0)
    with pytest.raises(ValueError, match="at least two"):
        ro.Histogram.from_values([1], bins=[0])
    assert ro.Histogram.from_values([1, 1], bins=1).counts == [2.0]
    assert sum(ro.Histogram.from_values([1, 1], bins=2).counts) == 2.0
    assert ro.Histogram.from_values([0, 2], bins=[0, 1, 2]).counts == [1.0, 1.0]
    assert ro.Histogram.from_values([-1, 0, 3], bins=[0, 1, 2]).counts == [1.0, 0.0]

    with pytest.raises(ValueError, match="either path or data"):
        ro.Image("x.png", data=object())
    with pytest.raises(ValueError, match="either path or data"):
        ro.Audio("x.wav", data=object())
    with pytest.raises(ValueError, match="either path or data"):
        ro.Video("x.mp4", data=object())
    assert ro.Image(object()).path is None
    assert ro.Audio(object()).path is None
    assert ro.Video(object()).path is None


def test_async_init_ignores_optional_system_and_console_failures(monkeypatch, tmp_path):
    calls = []

    def fake_request(self, method, path, body=None):
        return {"run": {"id": "run-optional"}}

    def fail_start_system_metrics(self, interval):
        calls.append(("system", interval))
        raise RuntimeError("sampler failed")

    def fail_capture_console(self):
        calls.append(("console", None))
        raise RuntimeError("console failed")

    monkeypatch.setattr(Client, "_request", fake_request)
    monkeypatch.setattr(Run, "start_system_metrics", fail_start_system_metrics)
    monkeypatch.setattr(Run, "capture_console", fail_capture_console)

    run = Client(base_url="http://example.test").init(
        project="demo",
        source_tracking=False,
        local_store=True,
        local_store_dir=str(tmp_path / "async-local"),
        system_metrics=True,
        system_metrics_interval=4.0,
        capture_console=True,
        upload_mode="sync",
    )

    assert run.wait_for_init(timeout=2.0) == "run-optional"
    assert calls == [("system", 4.0), ("console", None)]
    assert (tmp_path / "async-local" / "store.sqlite3").exists()
    run._local_store.close()


def test_wait_for_init_times_out_for_pending_run():
    run = Run(client=Client(base_url="http://example.test"), run_id="__instantml_pending__")

    with pytest.raises(InstantMLError, match="did not complete"):
        run.wait_for_init(timeout=0)


def test_log_helpers_error_paths_and_media_roots(tmp_path):
    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            return {}

    run = Run(client=FakeClient(), run_id="run-1")
    assert run._media_root().name == "run-1"
    assert Run(client=FakeClient(), run_id="run-1", media_dir=str(tmp_path / "media"))._media_root() == (tmp_path / "media").resolve()
    assert Run(client=FakeClient(), run_id="run-1", upload_mode="spool", spool_dir=str(tmp_path / "spool"))._media_root() == (
        tmp_path / "spool" / "_media" / "run-1"
    ).resolve()
    run._log_system_metrics({})
    run.finish()
    run._log_system_metrics({"system/cpu_percent": 1.0})

    with pytest.raises(TypeError, match="dictionary"):
        _classify_log_payload([])
    with pytest.raises(ValueError, match="must not be empty"):
        _classify_log_payload({"items": []})
    with pytest.raises(TypeError, match="homogeneous"):
        _classify_log_payload({"items": [ro.File("a"), ro.Table(["a"], [[1]])]})
    with pytest.raises(TypeError, match="metrics"):
        run.log_metrics([], step=1)
    with pytest.raises(TypeError, match="finite numbers"):
        run.log_metrics({"bad": object()}, step=1)
    with pytest.raises(TypeError, match="text values"):
        run.log_text([])
    with pytest.raises(TypeError, match="text value"):
        run.log_text({"bad": object()})
    with pytest.raises(ValueError, match="must not be empty"):
        ro.Histogram.from_values([])
    with pytest.raises(InstantMLError, match="upload source"):
        Run(client=FakeClient(), run_id="run-2").upload_file(str(tmp_path / "missing.txt"))


def test_conversion_helpers_with_fakes_and_import_failures(monkeypatch, tmp_path):
    class Figure:
        def savefig(self, target):
            target.write_bytes(b"figure")

    class SavedImage:
        def save(self, target):
            target.write_bytes(b"image")

    figure = tmp_path / "figure.png"
    saved = tmp_path / "saved.png"
    _write_image_data(Figure(), figure)
    _write_image_data(SavedImage(), saved)
    assert figure.read_bytes() == b"figure"
    assert saved.read_bytes() == b"image"
    with pytest.raises(InstantMLError, match="image data"):
        _write_image_data(None, tmp_path / "none.png")

    real_import = __import__

    def fail_pillow(name, *args, **kwargs):
        if name == "PIL":
            raise ImportError("no pillow")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fail_pillow)
    with pytest.raises(InstantMLError, match="Pillow"):
        _write_image_data([[[0, 0, 0]]], tmp_path / "missing-pillow.png")

    def fail_numpy(name, *args, **kwargs):
        if name == "numpy":
            raise ImportError("no numpy")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fail_numpy)
    with pytest.raises(InstantMLError, match="numpy"):
        _write_image_data([[[0, 0, 0]]], tmp_path / "missing-numpy.png")
    monkeypatch.setattr("builtins.__import__", real_import)

    writes = []

    class FakeSoundFile:
        @staticmethod
        def write(target, data, sample_rate):
            writes.append((target, data, sample_rate))

    def soundfile_import(name, *args, **kwargs):
        if name == "soundfile":
            return FakeSoundFile
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", soundfile_import)
    _write_audio_data([0.0, 0.1], tmp_path / "audio.wav", 16000)
    assert writes == [(tmp_path / "audio.wav", [0.0, 0.1], 16000)]
    with pytest.raises(InstantMLError, match="audio data"):
        _write_audio_data(None, tmp_path / "none.wav", 16000)

    imageio_module = ModuleType("imageio.v3")
    imageio_calls = []
    imageio_module.imwrite = lambda target, data, fps: imageio_calls.append((target, data, fps))
    monkeypatch.setitem(sys.modules, "imageio", ModuleType("imageio"))
    monkeypatch.setitem(sys.modules, "imageio.v3", imageio_module)
    monkeypatch.setattr("builtins.__import__", real_import)
    _write_video_data([[[[0, 0, 0]]]], tmp_path / "video.mp4", 24)
    assert imageio_calls == [(tmp_path / "video.mp4", [[[[0, 0, 0]]]], 24)]
    with pytest.raises(InstantMLError, match="video data"):
        _write_video_data(None, tmp_path / "none.mp4", 24)

    class FakeClip:
        def __init__(self, data, fps):
            self.data = data
            self.fps = fps

        def write_videofile(self, target, logger=None):
            moviepy_calls.append((target, logger, self.data, self.fps))

    moviepy_calls = []
    moviepy_module = SimpleNamespace(ImageSequenceClip=FakeClip)

    def moviepy_import(name, *args, **kwargs):
        if name == "imageio.v3":
            raise ImportError("no imageio")
        if name == "moviepy.video.io.ImageSequenceClip":
            return moviepy_module
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", moviepy_import)
    _write_video_data([[[[1, 1, 1]]]], tmp_path / "moviepy.mp4", 12)
    assert moviepy_calls == [(str(tmp_path / "moviepy.mp4"), None, [[[[1, 1, 1]]]], 12)]

    broken_imageio = ModuleType("imageio.v3")
    broken_imageio.imwrite = lambda target, data, fps: (_ for _ in ()).throw(TypeError("bad video"))
    monkeypatch.setitem(sys.modules, "imageio.v3", broken_imageio)
    monkeypatch.setattr("builtins.__import__", real_import)
    with pytest.raises(InstantMLError, match="moviepy or imageio"):
        _write_video_data([[[[0, 0, 0]]]], tmp_path / "bad-video.mp4", 24)


def test_run_media_materialization_audio_and_video_branches(monkeypatch, tmp_path):
    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            return {}

    written = []
    monkeypatch.setattr(client_module, "_write_audio_data", lambda data, target, sample_rate: (written.append(("audio", data, target, sample_rate)), target.write_bytes(b"a")))
    monkeypatch.setattr(client_module, "_write_video_data", lambda data, target, fps: (written.append(("video", data, target, fps)), target.write_bytes(b"v")))
    run = Run(client=FakeClient(), run_id="run-1", media_dir=str(tmp_path / "media"))

    audio_path = run._materialize_media_source(ro.Audio.from_data([0.1], sample_rate=8000))
    video_path = run._materialize_media_source(ro.Video.from_data([[[[0, 0, 0]]]], fps=12, format="mov"))

    assert audio_path.suffix == ".wav"
    assert video_path.suffix == ".mov"
    assert written[0][0] == "audio"
    assert written[0][3] == 8000
    assert written[1][0] == "video"
    assert written[1][3] == 12


def test_numeric_coercion_and_system_metric_error_branches(monkeypatch):
    class TypeErrorTensor:
        def detach(self):
            return self

        def cpu(self):
            raise TypeError("not available")

        def numpy(self):
            return self

        def tolist(self):
            return {"a": [1, 2], "b": "ignored"}

    assert _coerce_numeric_values(TypeErrorTensor(), "values") == [1.0, 2.0]
    assert _coerce_numeric_values(3, "values") == [3.0]
    with pytest.raises(ValueError, match="must not be empty"):
        _coerce_numeric_values(object(), "values")

    real_import = __import__

    def fail_psutil(name, *args, **kwargs):
        if name == "psutil":
            raise ImportError("no psutil")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fail_psutil)
    assert _collect_system_metrics() == {}

    class GoodPsutil:
        @staticmethod
        def cpu_percent(interval=None):
            return 1

        @staticmethod
        def virtual_memory():
            return SimpleNamespace(percent=2, used=3)

        class Process:
            def __init__(self, pid):
                return None

            def memory_info(self):
                return SimpleNamespace(rss=4)

        @staticmethod
        def disk_usage(path):
            return SimpleNamespace(percent=5)

        @staticmethod
        def net_io_counters():
            return SimpleNamespace(bytes_sent=6, bytes_recv=7)

    def fail_nvml(name, *args, **kwargs):
        if name == "pynvml":
            raise ImportError("no nvml")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fail_nvml)
    assert _collect_system_metrics(psutil_module=GoodPsutil)["system/network_bytes_recv"] == 7.0

    class BrokenPsutil:
        @staticmethod
        def cpu_percent(interval=None):
            raise RuntimeError("broken")

    class NoPowerNvml:
        @staticmethod
        def nvmlInit():
            return None

        @staticmethod
        def nvmlDeviceGetCount():
            return 1

        @staticmethod
        def nvmlDeviceGetHandleByIndex(index):
            return index

        @staticmethod
        def nvmlDeviceGetUtilizationRates(handle):
            return SimpleNamespace(gpu=1)

        @staticmethod
        def nvmlDeviceGetMemoryInfo(handle):
            return SimpleNamespace(used=0, total=0)

    with pytest.warns(RuntimeWarning, match="system metrics"):
        broken = _collect_system_metrics(psutil_module=BrokenPsutil, pynvml_module=NoPowerNvml)
    assert broken["system/gpu/0/memory_percent"] == 0.0

    class BrokenNvml(NoPowerNvml):
        @staticmethod
        def nvmlDeviceGetCount():
            raise RuntimeError("nvml broken")

    with pytest.warns(RuntimeWarning, match="NVML"):
        _collect_system_metrics(psutil_module=GoodPsutil, pynvml_module=BrokenNvml)


def test_console_stream_and_sampler_error_branches(monkeypatch):
    class FailingRun:
        def __init__(self):
            self.finished = False

        def _is_finished(self):
            return self.finished

        def _current_log_step(self):
            return 0

        def log_text(self, data, step=None):
            raise InstantMLError("text failed")

    class Stream:
        def __init__(self):
            self.values = []

        def write(self, text):
            self.values.append(text)
            return len(text)

        def flush(self):
            return None

        def isatty(self):
            return True

    stream = Stream()
    console = _ConsoleStream(FailingRun(), stream, "console/stdout")
    console.write("partial")
    assert stream.values == ["partial"]
    assert console.isatty() is True
    with pytest.warns(RuntimeWarning, match="console capture failed"):
        console.flush()
    console._run.finished = True
    console.write("ignored\n")

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            return {}

    run = Run(client=FakeClient(), run_id="run-1")
    monkeypatch.setattr(client_module, "_collect_system_metrics", lambda: (_ for _ in ()).throw(RuntimeError("boom")))
    run.start_system_metrics(interval=0.01)
    with pytest.warns(RuntimeWarning, match="sampler stopped"):
        time.sleep(0.03)
    run.finish()


def test_framework_adapter_warning_and_lazy_logger_paths(monkeypatch):
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            return {"object": {"id": "object-1", **body}}

    class BadParameter:
        def register_hook(self, hook):
            return object()

        def __iter__(self):
            raise TypeError("not iterable")

    model = SimpleNamespace(named_parameters=lambda: [("bad", BadParameter())])
    run = Run(client=FakeClient(), run_id="run-1")
    with pytest.warns(RuntimeWarning, match="log_graph"):
        with pytest.warns(RuntimeWarning, match="parameter logging failed"):
            handle = run.watch(model, log="all", log_graph=True)
    handle.remove()
    hook = model.named_parameters()[0][1].register_hook(lambda gradient: None)
    assert hook is not None

    class FakeRun:
        run_id = "lazy-run"

        def __init__(self):
            self.logged = []
            self.finished = []

        def log(self, metrics, step=None):
            self.logged.append((metrics, step))

        def log_config(self, params):
            return None

        def finish(self, status="finished"):
            self.finished.append(status)

    fake_run = FakeRun()
    monkeypatch.setattr(client_module, "init", lambda **kwargs: fake_run)
    logger = ro.LightningLogger(project="lazy")
    logger.log_image("images", ["image"], step=1, caption="x")
    logger.log_audio("audios", ["audio"], step=2)
    logger.log_video("videos", ["video"], step=3)
    logger.finalize()
    assert logger.version == "lazy-run"
    assert [entry[1] for entry in fake_run.logged] == [1, 2, 3]
    assert fake_run.finished == ["finished"]


# ---------------------------------------------------------------------------
# _check_credentials_or_raise — unit tests
# ---------------------------------------------------------------------------


def test_check_credentials_raises_when_no_creds(monkeypatch, tmp_path):
    monkeypatch.delenv("INSTANTML_API_KEY", raising=False)
    monkeypatch.setattr("instantml.cli._CREDENTIALS_PATH", tmp_path / "no_such_file")
    with pytest.raises(InstantMLError, match="instantml login"):
        _check_credentials_or_raise(None)


def test_check_credentials_ok_with_kwarg(monkeypatch, tmp_path):
    monkeypatch.delenv("INSTANTML_API_KEY", raising=False)
    monkeypatch.setattr("instantml.cli._CREDENTIALS_PATH", tmp_path / "no_such_file")
    _check_credentials_or_raise("explicit-key")  # must not raise


def test_check_credentials_ok_with_env_var(monkeypatch, tmp_path):
    monkeypatch.setenv("INSTANTML_API_KEY", "env-key")
    monkeypatch.setattr("instantml.cli._CREDENTIALS_PATH", tmp_path / "no_such_file")
    _check_credentials_or_raise(None)  # must not raise


def test_check_credentials_ok_with_credentials_file(monkeypatch, tmp_path):
    monkeypatch.delenv("INSTANTML_API_KEY", raising=False)
    creds = tmp_path / "credentials"
    creds.write_text('api_key = "file-key"\n')
    monkeypatch.setattr("instantml.cli._CREDENTIALS_PATH", creds)
    _check_credentials_or_raise(None)  # must not raise


def test_check_credentials_error_message_mentions_env_var(monkeypatch, tmp_path):
    monkeypatch.delenv("INSTANTML_API_KEY", raising=False)
    monkeypatch.setattr("instantml.cli._CREDENTIALS_PATH", tmp_path / "no_such_file")
    with pytest.raises(InstantMLError, match="INSTANTML_API_KEY"):
        _check_credentials_or_raise(None)


def test_check_credentials_handles_cli_import_failure(monkeypatch):
    import sys
    monkeypatch.delenv("INSTANTML_API_KEY", raising=False)
    saved = sys.modules.get("instantml.cli")
    sys.modules["instantml.cli"] = None  # type: ignore[assignment]
    try:
        with pytest.raises(InstantMLError, match="INSTANTML_API_KEY"):
            _check_credentials_or_raise(None)
    finally:
        if saved is not None:
            sys.modules["instantml.cli"] = saved
        else:
            del sys.modules["instantml.cli"]


# ---------------------------------------------------------------------------
# init() fail-fast credential checks
# ---------------------------------------------------------------------------


def test_init_raises_when_no_credentials(monkeypatch, tmp_path):
    monkeypatch.delenv("INSTANTML_API_KEY", raising=False)
    monkeypatch.setattr("instantml.cli._CREDENTIALS_PATH", tmp_path / "no_such_file")
    with pytest.raises(InstantMLError, match="instantml login"):
        ro.init(project="test")


def test_top_level_init_defaults_to_async_upload_mode(monkeypatch, tmp_path):
    def fake_request(self, method, path, body=None):
        return {"run": {"id": "run-top-default-async"}}

    monkeypatch.setenv("INSTANTML_API_KEY", "env-key")
    monkeypatch.setattr(Client, "_request", fake_request)
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    run = ro.init(project="test", base_url="http://example.test", queue_dir=str(tmp_path / "async"))

    assert run.wait_for_init(timeout=2.0) == "run-top-default-async"
    assert run.upload_mode == "async"
    assert (tmp_path / "async" / "run-top-default-async" / "queue.sqlite3").exists()


def test_init_succeeds_with_explicit_api_key(monkeypatch):
    calls = []

    def fake_request(self, method, path, body=None):
        calls.append((method, path))
        return {"run": {"id": "run-1"}}

    monkeypatch.setattr(Client, "_request", fake_request)
    run = ro.init(project="test", api_key="my-key", base_url="http://example.test", upload_mode="sync")
    assert run.run_id == "run-1"


def test_init_succeeds_with_env_var(monkeypatch):
    calls = []

    def fake_request(self, method, path, body=None):
        calls.append((method, path))
        return {"run": {"id": "run-2"}}

    monkeypatch.setenv("INSTANTML_API_KEY", "env-key")
    monkeypatch.setattr(Client, "_request", fake_request)
    run = ro.init(project="test", base_url="http://example.test", upload_mode="sync")
    assert run.run_id == "run-2"


def test_init_succeeds_with_credentials_file(monkeypatch, tmp_path):
    calls = []

    def fake_request(self, method, path, body=None):
        calls.append((method, path))
        return {"run": {"id": "run-3"}}

    monkeypatch.delenv("INSTANTML_API_KEY", raising=False)
    creds = tmp_path / "credentials"
    creds.write_text('api_key = "file-key"\n')
    monkeypatch.setattr("instantml.cli._CREDENTIALS_PATH", creds)
    monkeypatch.setattr(Client, "_request", fake_request)
    run = ro.init(project="test", base_url="http://example.test", upload_mode="sync")
    assert run.run_id == "run-3"
