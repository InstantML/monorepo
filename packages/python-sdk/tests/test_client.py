import json
import subprocess
import threading
import urllib.error
import urllib.parse
from io import BytesIO

import pytest

import rl_observability as ro
import rl_observability.uploader as uploader
from rl_observability.client import Client, RlobsError, Run, _environment_metadata, _git_metadata, _source_metadata
from rlobs_api.server import create_server


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


def test_api_runs_raises_rlobs_error_for_invalid_json(monkeypatch):
    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def read(self):
            return b"not-json"

    monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: FakeResponse())
    with pytest.raises(RlobsError, match="invalid JSON"):
        ro.Api(base_url="http://example.test").runs(limit=1)


def test_sdk_integration_creates_logs_and_finishes_run(api_server):
    run = ro.init(
        project="cartpole",
        name="seed-42",
        config={"seed": 42},
        tags=["rl"],
        notes="initial policy note",
        metadata={"custom": "value"},
        base_url=api_server,
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
    with pytest.raises(RlobsError, match="rich media"):
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
    with pytest.raises(RlobsError, match="does not exist"):
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

    assert run.upload_mode == "spool"
    assert run.spool_dir == str(tmp_path)
    assert calls[0][1] == "/runs"
    with pytest.raises(TypeError, match="notes"):
        Client(base_url="http://example.test").init(project="demo", notes=["bad"])
    with pytest.raises(ValueError, match="notes"):
        Client(base_url="http://example.test").init(project="demo", notes="x" * 513)
    with pytest.raises(ValueError, match="upload_mode"):
        Client(base_url="http://example.test").init(project="demo", upload_mode="background")


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
    online = ro.init(project="offline", name="replay-me", base_url=api_server, source_tracking=False)
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
                raise RlobsError("run-a is blocked")
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
    with pytest.raises(RlobsError, match="already running"):
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

    with pytest.raises(RlobsError, match="exactly one request"):
        uploader._send_event(FakeClient(), {"requests": []})
    with pytest.raises(RlobsError, match="JSON object"):
        uploader._send_event(FakeClient(), {"requests": ["bad"]})
    with pytest.raises(RlobsError, match="method, path, and body"):
        uploader._send_event(FakeClient(), {"requests": [{"method": "POST", "path": "/runs/run-1/metrics"}]})
    with pytest.raises(RlobsError, match="cannot read upload source"):
        uploader._prepare_body("/api/runs/run-1/artifacts/upload", {"source_path": str(tmp_path / "missing.pt")})


def test_request_or_spool_reraises_without_offline_dir():
    class FailingClient:
        offline_dir = None

        def _request(self, method, path, body):
            raise RlobsError("network down")

    with pytest.raises(RlobsError, match="network down"):
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
    )

    assert run.run_id == "run-123"
    assert run.buffer_size == 3
    assert run.client.offline_dir == "/run-offline"
    assert calls[0][2]["metadata"]["source"] == {"user": "owned"}
    assert "source" in calls[0][2]["metadata"]["_rlobs"]
    with pytest.raises(ValueError, match="reserved"):
        Client(base_url="http://example.test").init(project="demo", metadata={"_rlobs": {"source": "nope"}})


def test_client_init_can_disable_source_tracking(monkeypatch):
    calls = []

    def fake_request(self, method, path, body=None):
        calls.append((method, path, body))
        return {"run": {"id": "run-123"}}

    monkeypatch.setattr(Client, "_request", fake_request)
    Client(base_url="http://example.test").init(project="demo", source_tracking=False)

    assert "_rlobs" not in calls[0][2]["metadata"]


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


def test_environment_metadata_contains_expected_keys():
    metadata = _environment_metadata()
    assert {"python", "platform", "hostname", "pid"} <= set(metadata)


def test_source_metadata_handles_missing_git(monkeypatch):
    def fail(*args, **kwargs):
        raise subprocess.CalledProcessError(1, "git")

    monkeypatch.setattr("subprocess.check_output", fail)

    assert _git_metadata() == {"available": False}
    assert _source_metadata()["git"] == {"available": False}


def test_sdk_raises_clear_error_for_http_error(api_server):
    client = Client(base_url=api_server)
    with pytest.raises(RlobsError, match="project name"):
        client.init(project="")


def test_sdk_raises_clear_error_for_network_error():
    client = Client(base_url="http://127.0.0.1:9", timeout=0.01)
    with pytest.raises(RlobsError):
        client.init(project="cartpole")


def test_sdk_rejects_invalid_json_response(monkeypatch):
    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def read(self):
            return b"not-json"

    monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: FakeResponse())
    with pytest.raises(RlobsError, match="invalid JSON"):
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
    with pytest.raises(RlobsError, match="non-object"):
        Client()._request("GET", "/health")


def test_sdk_http_error_fallback_message(monkeypatch):
    def fail(*args, **kwargs):
        raise urllib.error.HTTPError("url", 500, "boom", {}, BytesIO(b"not-json"))

    monkeypatch.setattr("urllib.request.urlopen", fail)
    with pytest.raises(RlobsError, match="HTTP Error 500"):
        Client()._request("GET", "/health")


def test_sdk_http_error_non_error_object_message(monkeypatch):
    def fail(*args, **kwargs):
        body = BytesIO(json.dumps({"message": "not the standard shape"}).encode("utf-8"))
        raise urllib.error.HTTPError("url", 500, "boom", {}, body)

    monkeypatch.setattr("urllib.request.urlopen", fail)
    with pytest.raises(RlobsError, match="HTTP Error 500"):
        Client()._request("GET", "/health")
