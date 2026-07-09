import asyncio
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
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

import instantml as im
import instantml._http_pool as http_pool
import instantml.async_queue as async_queue
import instantml.client as client_module
import instantml.serialization as serialization_module
import instantml.source as source_module
import instantml.trace_payload as trace_payload
import instantml.tracing as tracing_module
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
    _collect_system_metrics_fallback,
    _load_psutil,
    _resolve_system_metrics,
    _environment_metadata,
    _finish_drain_seconds,
    _git_metadata,
    _normalize_source_tracking,
    _sdk_version,
    _source_metadata,
    _write_audio_data,
    _write_image_data,
    _write_video_data,
)
from instantml_api.server import create_server


def _spool_events(run_dir: Path) -> list[dict]:
    """Read spooled events from both legacy ``.json`` files and new ``.jsonl``
    segments, in filename order. Callers should ``run.flush()`` or
    ``run.finish()`` first so the active segment is finalized."""
    events: list[dict] = []
    for path in sorted(list(run_dir.glob("*.json")) + list(run_dir.glob("*.jsonl"))):
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                events.append(json.loads(line))
    return events


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
    assert im.Client().base_url == "https://api.instantml.ai"
    assert im.Api().base_url == "https://api.instantml.ai"


def test_client_base_url_respects_env_override(monkeypatch):
    monkeypatch.setenv("INSTANTML_API_BASE_URL", "http://127.0.0.1:8000")
    assert im.Client().base_url == "http://127.0.0.1:8000"
    assert im.Api().base_url == "http://127.0.0.1:8000"


def test_client_default_http_timeout_has_cold_path_headroom():
    # The default must cover the first cold-path request, which can spend
    # multiple seconds on warehouse routing + ClickHouse migrate work.
    # The old 2.0s default timed out real users before warmup finished;
    # 10s is generous for cold start while still failing fast on a
    # genuinely unreachable backend.
    assert im.Client().timeout >= 10.0
    assert im.Api().timeout >= 10.0


def test_sdk_version_falls_back_when_package_metadata_is_unavailable(monkeypatch):
    def missing_version(package):
        assert package == "instantml"
        raise client_module.importlib.metadata.PackageNotFoundError

    monkeypatch.setattr(client_module.importlib.metadata, "version", missing_version)

    assert _sdk_version() == "unknown"


def test_api_runs_builds_expected_query_string(monkeypatch):
    calls = []

    def fake_request(self, method, path, body=None, idempotency_key=None):
        calls.append((self, method, path, body, idempotency_key))
        return {"runs": [], "total": 0}

    monkeypatch.setattr(Client, "_request", fake_request)
    page = im.Api(base_url="http://example.test", timeout=3, api_key="secret").runs(
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
        im.Api(base_url="http://example.test").runs(cursor="page-2", offset=25)


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

    monkeypatch.setattr(http_pool, "urlopen", fake_urlopen)

    page = im.Api(base_url="http://example.test", timeout=4, api_key="secret").runs(limit=1)

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

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    target = tmp_path / "downloads" / "checkpoint.json"

    written = im.Api(base_url="http://example.test/", timeout=7, api_key="secret").download_artifact("artifact/1", target)

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

    monkeypatch.setattr(urllib.request, "urlopen", lambda *args, **kwargs: FakeResponse())
    api = im.Api(base_url="http://example.test")
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
    api = im.Api(base_url="http://example.test")

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

    monkeypatch.setattr(urllib.request, "urlopen", raise_http)
    with pytest.raises(InstantMLError, match="download denied"):
        api.download_artifact("artifact-1", tmp_path / "denied.bin")

    def raise_url(*_args, **_kwargs):
        raise urllib.error.URLError("offline")

    monkeypatch.setattr(urllib.request, "urlopen", raise_url)
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

    monkeypatch.setattr(http_pool, "urlopen", lambda *args, **kwargs: FakeResponse())
    with pytest.raises(InstantMLError, match="invalid JSON"):
        im.Api(base_url="http://example.test").runs(limit=1)


def test_sdk_integration_creates_logs_and_finishes_run(api_server, tmp_path):
    run = im.init(
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

    run = im.Run(client=FakeClient(), run_id="run-1")
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


def test_run_log_versioned_artifact_uses_manifest_upload_session(monkeypatch, tmp_path):
    calls = []
    uploads = []
    source = tmp_path / "weights.bin"
    source.write_bytes(b"weights")

    def fake_put(url, payload, timeout):
        uploads.append((url, payload, timeout))
        return "etag-1"

    monkeypatch.setattr(client_module, "_put_presigned_url", fake_put)

    class FakeClient:
        base_url = "http://example.test"
        timeout = 7
        api_key = "secret"
        offline_dir = None

        def _request(self, method, path, body, idempotency_key=None):
            calls.append((method, path, body, idempotency_key))
            if path == "/api/runs/run-1/artifact-uploads":
                return {
                    "upload_session": {"id": "session-1", "artifact_version_id": "version-1"},
                    "files": [
                        {
                            "entry_id": body["manifest"]["entries"][0].get("entry_id", "entry-1"),
                            "path": "weights.bin",
                            "upload_kind": "put",
                            "part_size_bytes": 7,
                            "part_count": 1,
                            "parts": [{"part_number": 1, "url": "https://upload.test/weights"}],
                        }
                    ],
                }
            if path == "/api/artifact-uploads/session-1/complete":
                return {
                    "artifact_version": {
                        "id": "version-1",
                        "collection_id": "collection-1",
                        "name": "policy",
                        "version": "v0",
                        "aliases": ["latest", "best"],
                    }
                }
            raise AssertionError(path)

    artifact = im.VersionedArtifact(
        "policy",
        type="model",
        aliases=["best"],
        metadata={"framework": "torch"},
    ).add_file(source)

    logged = Run(client=FakeClient(), run_id="run-1").log_artifact(artifact, step=12)

    assert isinstance(logged, im.LoggedArtifact)
    assert logged.id == "version-1"
    assert calls[0][0] == "POST"
    assert calls[0][1] == "/api/runs/run-1/artifact-uploads"
    assert calls[0][2]["collection"] == {
        "name": "policy",
        "type": "model",
        "description": None,
        "metadata": {"framework": "torch"},
    }
    assert calls[0][2]["aliases"] == ["best"]
    assert calls[0][2]["source_step"] == 12
    assert calls[0][2]["manifest"]["entries"][0]["path"] == "weights.bin"
    assert calls[0][2]["manifest"]["entries"][0]["size_bytes"] == 7
    assert calls[0][3].startswith("instantml-artifact-")
    assert uploads == [("https://upload.test/weights", b"weights", 7)]
    assert calls[1][:3] == (
        "POST",
        "/api/artifact-uploads/session-1/complete",
        {"files": [{"entry_id": "entry-1"}]},
    )
    assert calls[1][3].startswith("instantml-artifact-")


def test_run_log_versioned_artifact_returns_deduplicated_version_without_upload(monkeypatch, tmp_path):
    source = tmp_path / "weights.bin"
    source.write_bytes(b"weights")
    uploads = []

    monkeypatch.setattr(client_module, "_put_presigned_url", lambda *args: uploads.append(args))

    class FakeClient:
        base_url = "http://example.test"
        timeout = 7
        api_key = "secret"
        offline_dir = None

        def _request(self, method, path, body, idempotency_key=None):
            assert path == "/api/runs/run-1/artifact-uploads"
            return {
                "deduplicated": True,
                "artifact_version": {
                    "id": "version-existing",
                    "collection_id": "collection-1",
                    "name": "policy",
                    "version": "v3",
                    "aliases": ["best", "latest"],
                },
            }

    logged = Run(client=FakeClient(), run_id="run-1").log_versioned_artifact(
        im.VersionedArtifact("policy").add_file(source),
        aliases=["best"],
    )

    assert logged.id == "version-existing"
    assert logged.aliases == ["best", "latest"]
    assert uploads == []


def test_run_log_versioned_artifact_renews_multipart_urls(monkeypatch, tmp_path):
    calls = []
    uploads = []
    source = tmp_path / "weights.bin"
    source.write_bytes(b"abcdefghi")

    def fake_put(url, payload, timeout):
        uploads.append((url, payload, timeout))
        return f"etag-{len(uploads)}"

    monkeypatch.setattr(client_module, "_put_presigned_url", fake_put)

    class FakeClient:
        base_url = "http://example.test"
        timeout = 7
        api_key = "secret"
        offline_dir = None

        def _request(self, method, path, body, idempotency_key=None):
            calls.append((method, path, body, idempotency_key))
            if path == "/api/runs/run-1/artifact-uploads":
                return {
                    "upload_session": {"id": "session-1"},
                    "files": [
                        {
                            "entry_id": "entry-1",
                            "path": "weights.bin",
                            "upload_kind": "multipart",
                            "part_size_bytes": 3,
                            "part_count": 3,
                            "parts": [{"part_number": 1, "url": "https://upload.test/part-1"}],
                        }
                    ],
                }
            if path == "/api/artifact-uploads/session-1/renew":
                return {
                    "parts": [
                        {"part_number": 2, "url": "https://upload.test/part-2"},
                        {"part_number": 3, "url": "https://upload.test/part-3"},
                    ]
                }
            if path == "/api/artifact-uploads/session-1/complete":
                return {"artifact_version": {"id": "version-1", "name": "policy", "version": "v0"}}
            raise AssertionError(path)

    logged = Run(client=FakeClient(), run_id="run-1").log_versioned_artifact(
        im.VersionedArtifact("policy").add_file(source)
    )

    assert logged.id == "version-1"
    assert uploads == [
        ("https://upload.test/part-1", b"abc", 7),
        ("https://upload.test/part-2", b"def", 7),
        ("https://upload.test/part-3", b"ghi", 7),
    ]
    assert calls[1] == (
        "POST",
        "/api/artifact-uploads/session-1/renew",
        {"entry_id": "entry-1", "start_part_number": 2, "part_count": 2},
        None,
    )
    assert calls[2][:3] == (
        "POST",
        "/api/artifact-uploads/session-1/complete",
        {
            "files": [
                {
                    "entry_id": "entry-1",
                    "parts": [
                        {"part_number": 1, "etag": "etag-1"},
                        {"part_number": 2, "etag": "etag-2"},
                        {"part_number": 3, "etag": "etag-3"},
                    ],
                }
            ]
        },
    )
    assert calls[2][3].startswith("instantml-artifact-")


def test_run_log_versioned_artifact_inline_complete_and_path_validation(tmp_path):
    calls = []
    source = tmp_path / "config.json"
    source.write_text("{}", encoding="utf-8")

    class FakeClient:
        base_url = "http://example.test"
        timeout = 7
        api_key = None
        offline_dir = None

        def _request(self, method, path, body, idempotency_key=None):
            calls.append((method, path, body, idempotency_key))
            if path.endswith("/artifact-uploads"):
                return {
                    "upload_session": {"id": "session-inline"},
                    "files": [
                        {
                            "entry_id": "entry-inline",
                            "upload_kind": "inline",
                            "part_size_bytes": 2,
                            "part_count": 1,
                            "parts": [],
                        }
                    ],
                }
            return {
                "artifact_version": {
                    "id": "version-inline",
                    "collection_id": "collection-inline",
                    "name": "dataset",
                    "version": "v0",
                    "aliases": ["latest"],
                }
            }

    logged = Run(client=FakeClient(), run_id="run-1").log_versioned_artifact(
        im.VersionedArtifact("dataset", type="dataset", files={"nested/config.json": source})
    )

    assert logged.version == "v0"
    assert calls[1][2] == {"files": [{"entry_id": "entry-inline", "content_base64": "e30="}]}
    with pytest.raises(ValueError, match="cannot contain"):
        Run(client=FakeClient(), run_id="run-1").log_versioned_artifact(im.VersionedArtifact("bad", files={"../secret.json": source}))


def test_versioned_artifact_constructor_and_file_validation(tmp_path):
    source = tmp_path / "weights.bin"
    source.write_bytes(b"weights")

    with pytest.raises(ValueError, match="artifact name"):
        im.VersionedArtifact(" ")
    with pytest.raises(ValueError, match="artifact type"):
        im.VersionedArtifact("weights", type=" ")

    listed = im.VersionedArtifact("weights", files=[source])
    assert listed.files == [{"path": str(source), "name": "weights.bin"}]

    with pytest.raises(ValueError, match="file name"):
        im.VersionedArtifact("weights").add_file("")


def test_versioned_artifact_helper_validation_errors(tmp_path):
    source = tmp_path / "weights.bin"
    source.write_bytes(b"weights")
    other = tmp_path / "other.bin"
    other.write_bytes(b"other")

    with pytest.raises(TypeError, match="must be a string"):
        client_module._validate_artifact_manifest_path(123)
    with pytest.raises(ValueError, match="non-empty"):
        client_module._validate_artifact_manifest_path(" ")
    with pytest.raises(ValueError, match="relative"):
        client_module._validate_artifact_manifest_path("/absolute.bin")
    with pytest.raises(ValueError, match="relative"):
        client_module._validate_artifact_manifest_path("nested\\bad.bin")
    with pytest.raises(ValueError, match="at least one file"):
        client_module._prepare_versioned_artifact_files(im.VersionedArtifact("empty"))
    with pytest.raises(InstantMLError, match="does not exist"):
        client_module._prepare_versioned_artifact_files(im.VersionedArtifact("missing").add_file(tmp_path / "missing.bin"))
    with pytest.raises(ValueError, match="duplicate"):
        client_module._prepare_versioned_artifact_files(
            im.VersionedArtifact("dupe").add_file(source, name="dup.bin").add_file(other, name="dup.bin")
        )


def test_versioned_artifact_upload_helpers_cover_multipart_and_errors(monkeypatch, tmp_path):
    source = tmp_path / "payload.bin"
    source.write_bytes(b"abcdef")
    uploads = []

    def fake_put(url, payload, timeout):
        uploads.append((url, payload, timeout))
        return f"etag-{len(uploads)}"

    monkeypatch.setattr(client_module, "_put_presigned_url", fake_put)

    completed = client_module._upload_versioned_artifact_file(
        source,
        {
            "entry_id": "entry-1",
            "upload_kind": "multipart",
            "part_size_bytes": 3,
            "part_count": 2,
            "parts": [
                {"part_number": 2, "url": "https://upload.test/part-2"},
                {"part_number": 1, "url": "https://upload.test/part-1"},
            ],
        },
        timeout=9,
    )

    assert completed == {
        "entry_id": "entry-1",
        "parts": [{"part_number": 1, "etag": "etag-1"}, {"part_number": 2, "etag": "etag-2"}],
    }
    assert uploads == [
        ("https://upload.test/part-1", b"abc", 9),
        ("https://upload.test/part-2", b"def", 9),
    ]

    uploads.clear()
    source.write_bytes(b"abcdefghijkl")
    renew_calls = []

    def renew_parts(entry_id, start_part_number, part_count):
        renew_calls.append((entry_id, start_part_number, part_count))
        return [
            {"part_number": 3, "url": "https://upload.test/part-3"},
            {"part_number": 4, "url": "https://upload.test/part-4"},
        ]

    completed = client_module._upload_versioned_artifact_file(
        source,
        {
            "entry_id": "entry-1",
            "upload_kind": "multipart",
            "part_size_bytes": 3,
            "part_count": 4,
            "parts": [
                {"part_number": 1, "url": "https://upload.test/part-1"},
                {"part_number": 2, "url": "https://upload.test/part-2"},
            ],
        },
        timeout=9,
        renew_parts=renew_parts,
    )
    assert completed == {
        "entry_id": "entry-1",
        "parts": [
            {"part_number": 1, "etag": "etag-1"},
            {"part_number": 2, "etag": "etag-2"},
            {"part_number": 3, "etag": "etag-3"},
            {"part_number": 4, "etag": "etag-4"},
        ],
    }
    assert renew_calls == [("entry-1", 3, 2)]
    assert uploads == [
        ("https://upload.test/part-1", b"abc", 9),
        ("https://upload.test/part-2", b"def", 9),
        ("https://upload.test/part-3", b"ghi", 9),
        ("https://upload.test/part-4", b"jkl", 9),
    ]

    uploads.clear()
    renew_calls.clear()

    def renew_expired_parts(entry_id, start_part_number, part_count):
        renew_calls.append((entry_id, start_part_number, part_count))
        return [
            {"part_number": part_number, "url": f"https://upload.test/fresh-{part_number}", "expires_at": "2999-01-01T00:00:00Z"}
            for part_number in range(start_part_number, start_part_number + part_count)
        ]

    completed = client_module._upload_versioned_artifact_file(
        source,
        {
            "entry_id": "entry-1",
            "upload_kind": "multipart",
            "part_size_bytes": 3,
            "part_count": 4,
            "parts": [
                {"part_number": 1, "url": "https://upload.test/expired-1", "expires_at": "2000-01-01T00:00:00Z"},
                {"part_number": 2, "url": "https://upload.test/expired-2", "expires_at": "2000-01-01T00:00:00Z"},
            ],
        },
        timeout=9,
        renew_parts=renew_expired_parts,
    )
    assert completed["parts"][0]["part_number"] == 1
    assert renew_calls == [("entry-1", 1, 4)]
    assert uploads == [
        ("https://upload.test/fresh-1", b"abc", 9),
        ("https://upload.test/fresh-2", b"def", 9),
        ("https://upload.test/fresh-3", b"ghi", 9),
        ("https://upload.test/fresh-4", b"jkl", 9),
    ]

    with pytest.raises(InstantMLError, match="upload URLs"):
        client_module._upload_versioned_artifact_file(source, {"entry_id": "entry-1", "upload_kind": "put", "parts": []}, 1)
    with pytest.raises(InstantMLError, match="expired before upload"):
        client_module._upload_versioned_artifact_file(
            source,
            {
                "entry_id": "entry-1",
                "upload_kind": "put",
                "parts": [{"part_number": 1, "url": "https://upload.test/expired", "expires_at": "2000-01-01T00:00:00Z"}],
            },
            1,
        )
    with pytest.raises(InstantMLError, match="did not renew artifact upload URL"):
        client_module._upload_versioned_artifact_file(
            source,
            {
                "entry_id": "entry-1",
                "upload_kind": "put",
                "parts": [{"part_number": 1, "url": "https://upload.test/expired", "expires_at": "2000-01-01T00:00:00Z"}],
            },
            1,
            renew_parts=lambda entry_id, start, count: [],
        )
    with pytest.raises(InstantMLError, match="expired artifact upload URL"):
        client_module._upload_versioned_artifact_file(
            source,
            {
                "entry_id": "entry-1",
                "upload_kind": "put",
                "parts": [{"part_number": 1, "url": "https://upload.test/expired", "expires_at": "2000-01-01T00:00:00Z"}],
            },
            1,
            renew_parts=lambda entry_id, start, count: [
                {"part_number": 1, "url": "https://upload.test/still-expired", "expires_at": "2000-01-01T00:00:00Z"}
            ],
        )
    with pytest.raises(InstantMLError, match="unsupported"):
        client_module._upload_versioned_artifact_file(
            source,
            {"entry_id": "entry-1", "upload_kind": "other", "parts": [{"url": "https://upload.test"}]},
            1,
        )
    with pytest.raises(InstantMLError, match="multipart size"):
        client_module._upload_versioned_artifact_file(
            source,
            {"entry_id": "entry-1", "upload_kind": "multipart", "part_size_bytes": 0, "parts": [{"url": "https://upload.test"}]},
            1,
        )
    with pytest.raises(InstantMLError, match="part count"):
        client_module._upload_versioned_artifact_file(
            source,
            {
                "entry_id": "entry-1",
                "upload_kind": "multipart",
                "part_size_bytes": 3,
                "part_count": "0",
                "parts": [{"part_number": 1, "url": "https://upload.test"}],
            },
            1,
        )
    with pytest.raises(InstantMLError, match="enough"):
        client_module._upload_versioned_artifact_file(
            source,
            {
                "entry_id": "entry-1",
                "upload_kind": "multipart",
                "part_size_bytes": 3,
                "part_count": 3,
                "parts": [{"part_number": 1, "url": "https://upload.test/part-1"}],
            },
            1,
        )
    with pytest.raises(InstantMLError, match="renew artifact multipart"):
        client_module._upload_versioned_artifact_file(
            source,
            {
                "entry_id": "entry-1",
                "upload_kind": "multipart",
                "part_size_bytes": 3,
                "part_count": 2,
                "parts": [{"part_number": 1, "url": "https://upload.test/part-1"}],
            },
            1,
            renew_parts=lambda entry_id, start, count: [],
        )
    with pytest.raises(InstantMLError, match="requested"):
        client_module._upload_versioned_artifact_file(
            source,
            {
                "entry_id": "entry-1",
                "upload_kind": "multipart",
                "part_size_bytes": 3,
                "part_count": 2,
                "parts": [{"part_number": 1, "url": "https://upload.test/part-1"}],
            },
            1,
            renew_parts=lambda entry_id, start, count: [{"part_number": 3, "url": "https://upload.test/part-3"}],
        )
    with pytest.raises(InstantMLError, match="expired artifact multipart"):
        client_module._upload_versioned_artifact_file(
            source,
            {
                "entry_id": "entry-1",
                "upload_kind": "multipart",
                "part_size_bytes": 3,
                "part_count": 1,
                "parts": [{"part_number": 1, "url": "https://upload.test/expired", "expires_at": "2000-01-01T00:00:00Z"}],
            },
            1,
            renew_parts=lambda entry_id, start, count: [
                {"part_number": 1, "url": "https://upload.test/still-expired", "expires_at": "2000-01-01T00:00:00Z"}
            ],
        )
    assert client_module._artifact_part_expires_soon({"expires_at": "not-a-date"})
    assert not client_module._artifact_part_expires_soon({"expires_at": "2999-01-01T00:00:00"})
    short_source = tmp_path / "short.bin"
    short_source.write_bytes(b"abcdef")
    with pytest.raises(InstantMLError, match="ended"):
        client_module._upload_versioned_artifact_file(
            short_source,
            {
                "entry_id": "entry-1",
                "upload_kind": "multipart",
                "part_size_bytes": 3,
                "part_count": 3,
                "parts": [
                    {"part_number": 1, "url": "https://upload.test/part-1"},
                    {"part_number": 2, "url": "https://upload.test/part-2"},
                    {"part_number": 3, "url": "https://upload.test/part-3"},
                ],
            },
            1,
        )
    long_source = tmp_path / "long.bin"
    long_source.write_bytes(b"abcdefg")
    with pytest.raises(InstantMLError, match="changed"):
        client_module._upload_versioned_artifact_file(
            long_source,
            {
                "entry_id": "entry-1",
                "upload_kind": "multipart",
                "part_size_bytes": 3,
                "part_count": 2,
                "parts": [
                    {"part_number": 1, "url": "https://upload.test/part-1"},
                    {"part_number": 2, "url": "https://upload.test/part-2"},
                ],
            },
            1,
        )


def test_put_presigned_url_success_and_error_redaction(monkeypatch):
    class FakeResponse:
        headers = {"ETag": '"etag-success"'}

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def read(self):
            return b""

    monkeypatch.setattr(urllib.request, "urlopen", lambda request, timeout: FakeResponse())
    assert client_module._put_presigned_url("https://upload.test/ok", b"payload", 2) == "etag-success"

    with pytest.raises(InstantMLError, match="URL is missing"):
        client_module._put_presigned_url("", b"payload", 2)

    def raise_http(request, timeout):
        raise urllib.error.HTTPError("https://upload.test/secret?token=x", 500, "boom", {}, BytesIO(b"bad"))

    monkeypatch.setattr(urllib.request, "urlopen", raise_http)
    with pytest.raises(InstantMLError, match="artifact upload PUT failed"):
        client_module._put_presigned_url("https://upload.test/secret?token=x", b"payload", 2)

    def raise_url(request, timeout):
        raise urllib.error.URLError("offline")

    monkeypatch.setattr(urllib.request, "urlopen", raise_url)
    with pytest.raises(InstantMLError, match="offline"):
        client_module._put_presigned_url("https://upload.test/offline", b"payload", 2)


def test_presigned_upload_required_headers_and_legacy_monkeypatch(monkeypatch):
    assert client_module._artifact_required_headers({"required_headers": {"content-length": 3, "x-test": True}}) == {
        "content-length": "3",
        "x-test": "True",
    }

    calls = []

    def legacy_put(url, payload, timeout):
        calls.append((url, payload, timeout))
        return "etag-legacy"

    monkeypatch.setattr(client_module, "_put_presigned_url", legacy_put)
    assert client_module._put_presigned_url_with_headers("https://upload.test/legacy", b"abc", 2, {}) == "etag-legacy"
    assert calls == [("https://upload.test/legacy", b"abc", 2)]

    with pytest.raises(TypeError):
        client_module._put_presigned_url_with_headers(
            "https://upload.test/signed",
            b"abc",
            2,
            {"content-length": "3"},
        )


def test_api_artifact_resolve_use_promote_and_download(monkeypatch, tmp_path):
    calls = []

    def fake_request(self, method, path, body=None, idempotency_key=None):
        calls.append((method, path, body, idempotency_key))
        if path.startswith("/api/artifact-versions/resolve"):
            return {
                "artifact_version": {
                    "id": "version-1",
                    "collection_id": "collection-1",
                    "name": "policy",
                    "version": "v1",
                    "aliases": ["latest"],
                }
            }
        if path == "/api/artifact-collections/collection-1/aliases/best":
            return {
                "artifact_version": {
                    "id": "version-1",
                    "collection_id": "collection-1",
                    "name": "policy",
                    "version": "v1",
                    "aliases": ["best", "latest"],
                }
            }
        if path == "/api/runs/run-2/artifact-inputs":
            return {
                "artifact_version": {
                    "id": "version-1",
                    "collection_id": "collection-1",
                    "name": "policy",
                    "version": "v1",
                    "aliases": ["best", "latest"],
                }
            }
        if path == "/api/artifact-versions/version-1":
            return {
                "artifact_version": {
                    "id": "version-1",
                    "collection_id": "collection-1",
                    "name": "policy",
                    "version": "v1",
                    "aliases": [],
                    "state": "soft_deleted",
                }
            }
        raise AssertionError(path)

    monkeypatch.setattr(Client, "_request", fake_request)

    artifact = im.Api(base_url="http://example.test", api_key="secret").artifact("models/policy:latest", type="model")
    assert artifact.id == "version-1"
    assert artifact.name == "policy"
    artifact.promote("best")
    assert artifact.aliases == ["best", "latest"]
    assert artifact.delete(delete_aliases=True, reason="cleanup")["artifact_version"]["id"] == "version-1"

    class FakeClient:
        base_url = "http://example.test"
        timeout = 10
        api_key = "secret"
        offline_dir = None

        def _request(self, method, path, body, idempotency_key=None):
            return fake_request(self, method, path, body, idempotency_key)

    used = Run(client=FakeClient(), run_id="run-2").use_artifact(artifact)
    assert used.id == "version-1"
    assert calls[0][1] == "/api/artifact-versions/resolve?ref=models%2Fpolicy%3Alatest&type=model"
    assert calls[-1][2] == {"artifact_version_id": "version-1"}

    downloads = []

    class DownloadApi:
        def _manifest_entries(self, artifact_version_id):
            assert artifact_version_id == "version-1"
            return [
                {"id": "entry-1", "path": "nested/weights.bin", "downloadable": True},
                {"id": "entry-2", "path": "remote.txt", "downloadable": False},
            ]

        def _download_artifact_entry(self, entry_id, output_path):
            downloads.append((entry_id, Path(output_path).relative_to(tmp_path)))
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            Path(output_path).write_text("ok", encoding="utf-8")
            return str(output_path)

    written = client_module.LoggedArtifact(DownloadApi(), {"id": "version-1"}).download(tmp_path)
    assert [Path(path).relative_to(tmp_path) for path in written] == [Path("nested/weights.bin")]
    assert downloads == [("entry-1", Path("nested/weights.bin"))]

    class BadDownloadApi(DownloadApi):
        def _manifest_entries(self, artifact_version_id):
            return [{"id": "entry-1", "path": "../secret.txt", "downloadable": True}]

    with pytest.raises(ValueError, match="cannot contain"):
        client_module.LoggedArtifact(BadDownloadApi(), {"id": "version-1"}).download(tmp_path)


def test_artifact_api_and_download_error_paths(monkeypatch, tmp_path):
    def invalid_resolve(self, method, path, body=None, idempotency_key=None):
        return {"artifact_version": "bad"}

    monkeypatch.setattr(Client, "_request", invalid_resolve)
    with pytest.raises(InstantMLError, match="invalid artifact response"):
        im.Api(base_url="http://example.test").artifact("policy:latest")

    def invalid_manifest(self, method, path, body=None, idempotency_key=None):
        return {"entries": "bad"}

    monkeypatch.setattr(Client, "_request", invalid_manifest)
    with pytest.raises(InstantMLError, match="invalid artifact manifest"):
        im.Api(base_url="http://example.test")._manifest_entries("version-1")

    def valid_manifest(self, method, path, body=None, idempotency_key=None):
        return {"entries": [{"id": "entry-1"}, "skip-me"]}

    monkeypatch.setattr(Client, "_request", valid_manifest)
    assert im.Api(base_url="http://example.test")._manifest_entries("version-1") == [{"id": "entry-1"}]

    with pytest.raises(TypeError, match="output_path"):
        im.Api(base_url="http://example.test")._download_artifact_entry("entry-1", object())

    read_sizes = []

    class FakeResponse:
        def __init__(self, payload=b"payload"):
            self.payload = payload

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def read(self, size=-1):
            read_sizes.append(size)
            if size == -1:
                return self.payload
            if not self.payload:
                return b""
            chunk, self.payload = self.payload[:size], self.payload[size:]
            return chunk

    monkeypatch.setattr(urllib.request, "urlopen", lambda request, timeout: FakeResponse())
    target = tmp_path / "entry.bin"
    assert im.Api(base_url="http://example.test")._download_artifact_entry("entry-1", target) == str(target)
    assert target.read_bytes() == b"payload"
    assert read_sizes == [1024 * 1024, 1024 * 1024]

    def raise_http(request, timeout):
        raise urllib.error.HTTPError("http://example.test/download", 404, "missing", {}, BytesIO(b"missing"))

    monkeypatch.setattr(urllib.request, "urlopen", raise_http)
    with pytest.raises(InstantMLError, match="GET /api/artifact-entries/entry-1/download failed"):
        im.Api(base_url="http://example.test")._download_artifact_entry("entry-1", tmp_path / "missing.bin")

    def raise_url(request, timeout):
        raise urllib.error.URLError("offline")

    monkeypatch.setattr(urllib.request, "urlopen", raise_url)
    with pytest.raises(InstantMLError, match="offline"):
        im.Api(base_url="http://example.test")._download_artifact_entry("entry-1", tmp_path / "offline.bin")


def test_logged_artifact_download_rejects_symlink_escape(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    try:
        (root / "link").symlink_to(outside, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"symlinks unavailable: {exc}")

    class EscapeApi:
        def _manifest_entries(self, artifact_version_id):
            return [{"id": "entry-1", "path": "link/file.txt", "downloadable": True}]

        def _download_artifact_entry(self, entry_id, output_path):
            raise AssertionError("download should not happen")

    with pytest.raises(InstantMLError, match="escapes"):
        client_module.LoggedArtifact(EscapeApi(), {"id": "version-1"}).download(root)


def test_run_versioned_artifact_error_paths(monkeypatch, tmp_path):
    source_a = tmp_path / "a.bin"
    source_a.write_bytes(b"a")
    source_b = tmp_path / "b.bin"
    source_b.write_bytes(b"b")

    class BadSessionClient:
        base_url = "http://example.test"
        timeout = 7
        api_key = None
        offline_dir = None

        def _request(self, method, path, body, idempotency_key=None):
            return {"upload_session": "bad", "files": []}

    with pytest.raises(ValueError, match="uri"):
        Run(client=BadSessionClient(), run_id="run-1").log_artifact(im.VersionedArtifact("bad"), uri="demo://bad")
    with pytest.raises(TypeError, match="uri is required"):
        Run(client=BadSessionClient(), run_id="run-1").log_artifact("raw")
    with pytest.raises(ValueError, match="aliases and ttl_days"):
        Run(client=BadSessionClient(), run_id="run-1").log_artifact("raw", "demo://raw", aliases=["best"])
    with pytest.raises(InstantMLError, match="upload_mode"):
        Run(client=BadSessionClient(), run_id="run-1", upload_mode="spool").log_versioned_artifact(im.VersionedArtifact("spool"))
    with pytest.raises(TypeError, match="VersionedArtifact"):
        Run(client=BadSessionClient(), run_id="run-1").log_versioned_artifact("not-artifact")
    with pytest.raises(InstantMLError, match="invalid artifact upload session"):
        Run(client=BadSessionClient(), run_id="run-1").log_versioned_artifact(im.VersionedArtifact("bad-session").add_file(source_a))

    class UnknownEntryClient(BadSessionClient):
        def _request(self, method, path, body, idempotency_key=None):
            if path.endswith("/artifact-uploads"):
                return {
                    "upload_session": {"id": "session-1"},
                    "files": [
                        "not-a-dict",
                        {"entry_id": "entry-1", "path": "missing.bin", "upload_kind": "inline", "parts": []},
                    ],
                }
            return {"artifact_version": {"id": "version-1"}}

    artifact = im.VersionedArtifact("unknown").add_file(source_a, name="a.bin").add_file(source_b, name="b.bin")
    with pytest.raises(InstantMLError, match="unknown artifact upload entry"):
        Run(client=UnknownEntryClient(), run_id="run-1").log_versioned_artifact(artifact, aliases=["extra"])

    class BadCompleteClient(BadSessionClient):
        def _request(self, method, path, body, idempotency_key=None):
            if path.endswith("/artifact-uploads"):
                return {
                    "upload_session": {"id": "session-1"},
                    "files": [{"entry_id": "entry-1", "path": "a.bin", "upload_kind": "inline", "parts": []}],
                }
            return {"artifact_version": "bad"}

    with pytest.raises(InstantMLError, match="invalid artifact version"):
        Run(client=BadCompleteClient(), run_id="run-1").log_versioned_artifact(im.VersionedArtifact("bad-complete").add_file(source_a, name="a.bin"))

    monkeypatch.setattr(client_module, "_put_presigned_url", lambda url, payload, timeout: "etag-1")

    class BadRenewClient(BadSessionClient):
        def _request(self, method, path, body, idempotency_key=None):
            if path.endswith("/artifact-uploads"):
                return {
                    "upload_session": {"id": "session-1"},
                    "files": [
                        {
                            "entry_id": "entry-1",
                            "path": "a.bin",
                            "upload_kind": "multipart",
                            "part_size_bytes": 1,
                            "part_count": 2,
                            "parts": [{"part_number": 1, "url": "https://upload.test/part-1"}],
                        }
                    ],
                }
            if path.endswith("/renew"):
                return {"parts": "bad"}
            raise AssertionError(path)

    with pytest.raises(InstantMLError, match="invalid renewed"):
        Run(client=BadRenewClient(), run_id="run-1").log_versioned_artifact(im.VersionedArtifact("bad-renew").add_file(source_a, name="a.bin"))


def test_use_artifact_returns_existing_handle_when_server_omits_version():
    class FakeClient:
        base_url = "http://example.test"
        timeout = 10
        api_key = None
        offline_dir = None

        def _request(self, method, path, body, idempotency_key=None):
            assert path == "/api/runs/run-1/artifact-inputs"
            return {"edge": {"id": "edge-1"}}

    artifact = client_module.LoggedArtifact(im.Api(base_url="http://example.test"), {"id": "version-1"})
    assert Run(client=FakeClient(), run_id="run-1").use_artifact(artifact) is artifact


def test_checkpoint_policy_matches_positive_integer_intervals():
    policy = im.CheckpointPolicy(every_steps=3)

    assert [step for step in range(8) if policy.should_save(step)] == [3, 6]
    assert policy.should_save(6.0) is True
    assert policy.should_save(4.5) is False
    assert policy.should_save(None) is False
    assert im.CheckpointPolicy(every_steps=3, include_step_zero=True).should_save(0) is True
    with pytest.raises(TypeError, match="every_steps"):
        im.CheckpointPolicy(every_steps=3.0)
    with pytest.raises(ValueError, match="positive"):
        im.CheckpointPolicy(every_steps=0)


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
    run = im.Run(client=FakeClient(), run_id="run-1")
    table = run.log_table_object("eval/samples", ["prompt", "score"], [["a", 0.9]], step=2)
    histogram = run.log_objects({"eval/scores": im.Histogram([0, 1, 2], [4, 8])}, step=2)[0]
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
    run = im.Run(client=FailingClient(), run_id="run-1", upload_mode="spool", spool_dir=str(tmp_path / "spool"))
    table = run.log_objects({"eval/samples": im.Table(["prompt"], [{"prompt": "a"}])}, step=1)[0]
    assert table["id"] == "spooled"
    run.flush()
    event = _spool_events(tmp_path / "spool" / "run-1")[0]
    assert event["requests"][0]["path"] == "/api/runs/run-1/objects"
    assert event["requests"][0]["body"]["kind"] == "table"
    with pytest.raises(InstantMLError, match="rich media"):
        run.log_audio("audio/sample", str(source), step=1)
    with pytest.raises(ValueError, match="row length"):
        im.Run(client=FailingClient(), run_id="run-1").log_table_object("bad", ["a"], [[1, 2]])
    with pytest.raises(ValueError, match="nonnegative"):
        im.Run(client=FailingClient(), run_id="run-1").log_objects({"bad": im.Histogram([0, 1], [-1])}, step=1)


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
    run = im.Run(client=FakeClient(), run_id="run-1")
    run.log_histogram("model/weights", im.Histogram([0, 1], [3], metadata={"layer": 1}), step=1)
    run.log_image("images/frame", str(image), step=1)
    run.log_video_object("videos/rollout", str(video), step=1)
    assert [call[2]["kind"] for call in calls if call[1].endswith("/objects")] == ["histogram", "image", "video"]

    with pytest.raises(TypeError, match="objects"):
        run.log_objects(["bad"], step=1)
    with pytest.raises(TypeError, match="object key"):
        run.log_objects({1: im.Histogram([0, 1], [1])}, step=1)
    with pytest.raises(ValueError, match="object key"):
        run.log_objects({"": im.Histogram([0, 1], [1])}, step=1)
    with pytest.raises(ValueError, match="object key"):
        run.log_objects({"x" * 513: im.Histogram([0, 1], [1])}, step=1)
    with pytest.raises(TypeError, match="metadata"):
        run.log_objects({"x": im.Histogram([0, 1], [1])}, step=1, metadata=[])
    with pytest.raises(TypeError, match="JSON serializable"):
        run.log_objects({"x": im.Table(["a"], [{"a": object()}])}, step=1)
    with pytest.raises(ValueError, match="columns"):
        run.log_table_object("x", [], [])
    with pytest.raises(TypeError, match="table rows"):
        run.log_table_object("x", ["a"], "bad")
    with pytest.raises(TypeError, match="dictionaries"):
        run.log_table_object("x", ["a"], [object()])
    with pytest.raises(ValueError, match="not be empty"):
        run.log_objects({"x": im.Histogram([], [])}, step=1)
    with pytest.raises(ValueError, match="bins length"):
        run.log_objects({"x": im.Histogram([0, 1, 2, 3], [1, 2])}, step=1)
    with pytest.raises(TypeError, match="must be a list"):
        run.log_objects({"x": im.Histogram("bad", [1])}, step=1)
    with pytest.raises(TypeError, match="must contain numbers"):
        run.log_objects({"x": im.Histogram([0, "bad"], [1])}, step=1)
    with pytest.raises(ValueError, match="finite"):
        run.log_objects({"x": im.Histogram([0, float("inf")], [1])}, step=1)
    with pytest.raises(InstantMLError, match="does not exist"):
        run.log_image("images/missing", str(tmp_path / "missing.png"), step=1)
    with pytest.raises(TypeError, match="unsupported"):
        run._log_rich_object("x", object(), step=1, metadata=None)


def test_log_classification_eval_builds_binary_eval_object(monkeypatch):
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            return {"object": {"id": len(calls), **body}}

    run = im.Run(client=FakeClient(), run_id="run-1")
    result = run.log_classification_eval(
        "eval/classification",
        y_true=[0, 1, 1, 0],
        y_score=[0.1, 0.8, 0.7, 0.2],
        class_names=["negative", "positive"],
        positive_label="positive",
        split="validation",
        threshold=0.5,
        predictions=[{"id": "ex-1"}],
        metadata={"dataset": "holdout"},
        step=4,
    )

    assert result["kind"] == "classification_eval"
    assert calls[0][1] == "/api/runs/run-1/objects"
    payload = calls[0][2]
    assert payload["key"] == "eval/classification"
    assert payload["kind"] == "classification_eval"
    assert payload["step"] == 4
    assert payload["metadata"] == {"dataset": "holdout"}
    assert payload["summary"]["sample_count"] == 4
    assert payload["summary"]["accuracy"] == 1.0
    value = payload["value"]
    assert value["schema_version"] == 1
    assert value["task"] == "binary_classification"
    assert value["threshold_direction"] == "score_gte_threshold"
    assert value["class_names"] == ["negative", "positive"]
    assert value["confusion_matrix"] == [[2, 0], [0, 2]]
    assert value["per_class"][1]["precision"] == 1.0
    assert value["per_class"][1]["recall"] == 1.0
    assert value["predictions"][0] == {
        "id": "ex-1",
        "true_label": "negative",
        "predicted_label": "negative",
        "score": 0.1,
        "correct": True,
    }
    assert len(value["pr_curve"]) == 4
    assert len(value["roc_curve"]) == 4
    assert value["metadata"] == {"dataset": "holdout"}

    generic = run.log_objects({
        "eval/wrapper": im.ClassificationEval(
            y_true=["negative", "positive"],
            y_score=[0.4, 0.6],
            class_names=["negative", "positive"],
        )
    }, step=5)[0]
    assert generic["kind"] == "classification_eval"
    assert calls[1][2]["summary"]["accuracy"] == 1.0

    run.log_classification_eval(
        "eval/many-thresholds",
        y_true=[index % 2 for index in range(1000)],
        y_score=[index / 999 for index in range(1000)],
        class_names=["negative", "positive"],
    )
    many_thresholds_value = calls[2][2]["value"]
    assert len(many_thresholds_value["pr_curve"]) == 200
    assert len(many_thresholds_value["roc_curve"]) == 200
    assert many_thresholds_value["pr_curve"][0]["threshold"] > many_thresholds_value["pr_curve"][-1]["threshold"]


def test_log_classification_eval_accepts_tuple_inputs_and_explicit_predictions():
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            return {"object": {"id": len(calls), **body}}

    run = im.Run(client=FakeClient(), run_id="run-1")
    result = run.log_classification_eval(
        "eval/explicit",
        y_true=(0, 1),
        y_score=(0.7, 0.4),
        y_pred=(1, 0),
        class_names=("negative", "positive"),
    )

    assert result["kind"] == "classification_eval"
    value = calls[0][2]["value"]
    assert value["confusion_matrix"] == [[0, 1], [1, 0]]
    assert value["accuracy"] == 0.0


def test_log_classification_eval_validates_inputs(monkeypatch):
    class FailingClient:
        offline_dir = None

        def _request(self, method, path, body):
            raise AssertionError("network should not be used for invalid eval payloads")

    run = im.Run(client=FailingClient(), run_id="run-1")
    with pytest.raises(ValueError, match="at least one sample"):
        run.log_classification_eval("eval/bad", y_true=[], y_score=[])
    monkeypatch.setattr(serialization_module, "MAX_CLASSIFICATION_EVAL_SAMPLE_COUNT", 1)
    with pytest.raises(ValueError, match="at most 1 samples"):
        run.log_classification_eval("eval/bad", y_true=[0, 1], y_score=[0.1, 0.2])
    monkeypatch.setattr(serialization_module, "MAX_CLASSIFICATION_EVAL_SAMPLE_COUNT", 1_000_000)
    with pytest.raises(TypeError, match="must be a list"):
        run.log_classification_eval("eval/bad", y_true="bad", y_score=[0.1])
    with pytest.raises(ValueError, match="exactly two"):
        run.log_classification_eval("eval/bad", y_true=[0], y_score=[0.1], class_names=["negative"])
    with pytest.raises(ValueError, match="same length"):
        run.log_classification_eval("eval/bad", y_true=[0], y_score=[0.1, 0.2])
    with pytest.raises(ValueError, match="y_pred"):
        run.log_classification_eval("eval/bad", y_true=[0], y_score=[0.1], y_pred=[0, 1])
    with pytest.raises(ValueError, match="class_names"):
        run.log_classification_eval("eval/bad", y_true=[0], y_score=[0.1], class_names=["same", "same"])
    with pytest.raises(ValueError, match="128 bytes"):
        run.log_classification_eval(
            "eval/bad",
            y_true=[0],
            y_score=[0.1],
            class_names=["negative", "p" * 129],
        )
    with pytest.raises(ValueError, match="0..1"):
        run.log_classification_eval("eval/bad", y_true=[0], y_score=[1.2])
    with pytest.raises(TypeError, match="threshold"):
        run.log_classification_eval("eval/bad", y_true=[0], y_score=[0.2], threshold="high")
    with pytest.raises(ValueError, match="threshold"):
        run.log_classification_eval("eval/bad", y_true=[0], y_score=[0.2], threshold=1.5)
    with pytest.raises(TypeError, match="strings or class indices"):
        run.log_classification_eval("eval/bad", y_true=[True], y_score=[0.2])
    with pytest.raises(ValueError, match="class indices"):
        run.log_classification_eval("eval/bad", y_true=[2], y_score=[0.2])
    with pytest.raises(ValueError, match="class_names"):
        run.log_classification_eval("eval/bad", y_true=["missing"], y_score=[0.2])
    with pytest.raises(TypeError, match="strings or class indices"):
        run.log_classification_eval("eval/bad", y_true=[object()], y_score=[0.2])
    with pytest.raises(TypeError, match="predictions"):
        serialization_module._normalize_eval_predictions(
            {"id": "ex-1"},
            ["negative"],
            ["negative"],
            [0.2],
            ["negative", "positive"],
        )
    with pytest.raises(ValueError, match="at most 100"):
        run.log_classification_eval(
            "eval/bad",
            y_true=[0],
            y_score=[0.2],
            predictions=[{"id": f"ex-{index}"} for index in range(101)],
        )
    with pytest.raises(TypeError, match="correct"):
        run.log_classification_eval(
            "eval/bad",
            y_true=[0],
            y_score=[0.2],
            predictions=[{"id": "ex-1", "correct": "yes"}],
        )
    with pytest.raises(TypeError, match="prediction rows"):
        run.log_classification_eval(
            "eval/bad",
            y_true=[0],
            y_score=[0.2],
            predictions=[object()],
        )


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

    events = _spool_events(tmp_path / "run_1")
    assert len(events) == 7
    first_event = events[0]
    assert first_event["version"] == 1
    assert first_event["event_id"]
    assert first_event["sequence"] == 1
    assert first_event["data"] == {"metrics": {"reward": 1.5}}
    assert first_event["requests"][0]["path"] == "/runs/run/1/metrics"
    assert first_event["requests"][0]["body"]["timestamp"]
    # The active segment is finalized on finish(); no dotfile temp remains.
    assert not list((tmp_path / "run_1").glob(".*.tmp"))


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


def test_trace_context_manager_batches_nested_events_with_previews():
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body, idempotency_key=None):
            calls.append((method, path, body, idempotency_key))
            return {"inserted": len(body["events"]), "trace_ids": [body["events"][0]["trace_id"]]}

    run = Run(client=FakeClient(), run_id="run-1")
    with run.trace(
        "rollout",
        kind="rollout",
        step=7,
        attributes={"env": "cartpole"},
        capture="preview",
        inputs={"seed": 13},
    ) as trace:
        with trace.span("policy.generate", kind="model", inputs={"obs": [1, 2]}, capture="preview") as span:
            span.log_metric({"gen_ai.usage.input_tokens": 3})
            span.set_output({"action": 0})

    assert len(calls) == 1
    method, path, body, idempotency_key = calls[0]
    assert method == "POST"
    assert path == "/api/runs/run-1/traces/events"
    assert idempotency_key.startswith("instantml-trace-run-1-")
    events = body["events"]
    assert [event["event_kind"] for event in events] == ["started", "started", "updated", "finished", "finished"]
    root_start, child_start, child_update, child_finish, root_finish = events
    assert "parent_span_id" not in root_start
    assert child_start["parent_span_id"] == root_start["span_id"]
    assert child_start["trace_id"] == root_start["trace_id"]
    assert child_update["metrics"]["gen_ai.usage.input_tokens"] == 3
    assert child_update["input_preview"] == child_start["input_preview"]
    assert child_finish["input_preview"] == child_start["input_preview"]
    assert child_finish["output_preview"]
    assert root_finish["status"] == "ok"
    assert root_start["content_policy"] == "preview"


def test_trace_op_batches_preview_metadata_and_redacts_secrets():
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body, idempotency_key=None):
            calls.append((method, path, body, idempotency_key))
            return {"inserted": len(body["events"]), "trace_ids": [body["events"][0]["trace_id"]]}

    run = Run(client=FakeClient(), run_id="run-1")

    @run.trace_op(
        kind="reward",
        step=12,
        rank=2,
        thread_id="eval-thread",
        rollout_id="episode-12",
        attributes={"phase": "eval", "api_key": "instantml_SECRETKEY"},
        metrics={"gen_ai.usage.input_tokens": 7, "score": 0.25},
        links=[{"label": "docs", "authorization": "Bearer abcdefghijklmnop"}],
        capture="preview",
    )
    def score_rollout(prompt, answer, *, api_key="sk-abcdefghijklmnopqrstuvwxyz"):
        """Demo reward function."""
        return {"reward": 1.0, "token": "instantml_OUTPUTSECRET"}

    assert score_rollout.__name__ == "score_rollout"
    assert score_rollout.__doc__ == "Demo reward function."
    assert score_rollout("hello", "ok", api_key="sk-abcdefghijklmnopqrstuvwxyz") == {"reward": 1.0, "token": "instantml_OUTPUTSECRET"}

    run.flush()

    assert len(calls) == 1
    method, path, body, idempotency_key = calls[0]
    assert method == "POST"
    assert path == "/api/runs/run-1/traces/events"
    assert idempotency_key.startswith("instantml-trace-run-1-")
    start, finish = body["events"]
    assert [event["event_kind"] for event in body["events"]] == ["started", "finished"]
    assert start["name"].endswith("score_rollout")
    assert start["kind"] == "reward"
    assert start["step"] == 12.0
    assert start["rank"] == 2
    assert start["thread_id"] == "eval-thread"
    assert start["rollout_id"] == "episode-12"
    assert start["attributes"]["phase"] == "eval"
    assert start["attributes"]["api_key"] == "[REDACTED]"
    assert start["metrics"]["gen_ai.usage.input_tokens"] == 7
    assert start["links"][0]["authorization"] == "[REDACTED]"
    assert "hello" in start["input_preview"]
    assert "sk-abcdefghijklmnopqrstuvwxyz" not in start["input_preview"]
    assert "[REDACTED]" in start["input_preview"]
    assert finish["status"] == "ok"
    assert finish["input_preview"] == start["input_preview"]
    assert "instantml_OUTPUTSECRET" not in finish["output_preview"]
    assert "[REDACTED]" in finish["output_preview"]


def test_trace_op_capture_off_exception_privacy_and_context_cleanup():
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body, idempotency_key=None):
            calls.append((method, path, body, idempotency_key))
            return {"inserted": len(body["events"]), "trace_ids": [body["events"][0]["trace_id"]]}

    run = Run(client=FakeClient(), run_id="run-1")

    @run.trace_op(kind="reward")
    def fail_reward():
        raise ValueError("password=super-secret")

    with pytest.raises(ValueError, match="super-secret"):
        fail_reward()

    with run.trace("after-error", kind="rollout"):
        pass

    run.flush()
    events = [event for call in calls for event in call[2]["events"]]
    failed_start, failed_exception, next_start, next_finish = events
    assert [event["event_kind"] for event in events] == ["started", "exception", "started", "finished"]
    assert failed_exception["span_id"] == failed_start["span_id"]
    assert failed_exception["status"] == "error"
    assert failed_exception["error_type"] == "ValueError"
    assert failed_exception["error_preview"] == ""
    assert failed_exception["redaction_state"] == "not_captured"
    assert "parent_span_id" not in next_start
    assert next_start["trace_id"] != failed_start["trace_id"]
    assert next_finish["status"] == "ok"


def test_trace_op_nests_only_same_run_context_and_rejects_wrong_run_carrier():
    calls_a = []
    calls_b = []

    class FakeClientA:
        offline_dir = None

        def _request(self, method, path, body, idempotency_key=None):
            calls_a.append((method, path, body, idempotency_key))
            return {"inserted": len(body["events"]), "trace_ids": [body["events"][0]["trace_id"]]}

    class FakeClientB:
        offline_dir = None

        def _request(self, method, path, body, idempotency_key=None):
            calls_b.append((method, path, body, idempotency_key))
            return {"inserted": len(body["events"]), "trace_ids": [body["events"][0]["trace_id"]]}

    run_a = Run(client=FakeClientA(), run_id="run-a")
    run_b = Run(client=FakeClientB(), run_id="run-b")

    @run_a.trace_op(kind="tool")
    def same_run_tool():
        return "same"

    @run_b.trace_op(kind="tool")
    def other_run_tool():
        return "other"

    with run_a.trace("root", kind="rollout") as trace:
        assert same_run_tool() == "same"
        assert other_run_tool() == "other"
        with pytest.raises(ValueError, match="run_id"):
            with run_b.attach_trace_context(trace.context()):
                pass

    run_b.flush()

    events_a = calls_a[0][2]["events"]
    root_start, child_start, child_finish, root_finish = events_a
    assert child_start["trace_id"] == root_start["trace_id"]
    assert child_start["parent_span_id"] == root_start["span_id"]
    assert child_finish["status"] == "ok"
    assert root_finish["status"] == "ok"

    events_b = calls_b[0][2]["events"]
    other_start, other_finish = events_b
    assert other_start["trace_id"] != root_start["trace_id"]
    assert "parent_span_id" not in other_start
    assert other_finish["status"] == "ok"


def test_trace_op_async_function_traces_awaited_result_and_exception():
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body, idempotency_key=None):
            calls.append((method, path, body, idempotency_key))
            return {"inserted": len(body["events"]), "trace_ids": [body["events"][0]["trace_id"]]}

    run = Run(client=FakeClient(), run_id="run-1")

    @run.trace_op(kind="model", capture="preview")
    async def infer(prompt):
        await asyncio.sleep(0)
        return {"answer": prompt.upper()}

    @run.trace_op(kind="model", capture="preview")
    async def fail_infer():
        await asyncio.sleep(0)
        raise RuntimeError("Authorization: Bearer abcdefghijklmnop")

    async def scenario():
        assert await infer("ok") == {"answer": "OK"}
        with pytest.raises(RuntimeError, match="Bearer"):
            await fail_infer()

    asyncio.run(scenario())
    run.flush()

    events = [event for call in calls for event in call[2]["events"]]
    assert [event["event_kind"] for event in events] == ["started", "finished", "started", "exception"]
    assert "OK" in events[1]["output_preview"]
    assert events[3]["error_type"] == "RuntimeError"
    assert "Bearer abcdefghijklmnop" not in events[3]["error_preview"]
    assert "[REDACTED]" in events[3]["error_preview"]


def test_trace_op_generator_and_async_generator_finish_on_iteration():
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body, idempotency_key=None):
            calls.append((method, path, body, idempotency_key))
            return {"inserted": len(body["events"]), "trace_ids": [body["events"][0]["trace_id"]]}

    run = Run(client=FakeClient(), run_id="run-1")

    @run.trace_op(kind="dataset", capture="preview")
    def stream_rows(limit):
        for index in range(limit):
            yield {"row": index}

    @run.trace_op(kind="dataset", capture="preview")
    def broken_rows():
        yield {"row": 1}
        raise RuntimeError("password=leaked")

    assert tracing_module.inspect.isgeneratorfunction(stream_rows)
    assert list(stream_rows(2)) == [{"row": 0}, {"row": 1}]
    with pytest.raises(RuntimeError, match="leaked"):
        list(broken_rows())

    @run.trace_op(kind="dataset", capture="preview")
    async def async_rows(limit):
        for index in range(limit):
            await asyncio.sleep(0)
            yield {"row": index}

    @run.trace_op(kind="dataset", capture="preview")
    async def broken_async_rows():
        yield {"row": 1}
        raise RuntimeError("token=async-secret")

    async def collect_async():
        assert tracing_module.inspect.isasyncgenfunction(async_rows)
        collected = []
        async for row in async_rows(2):
            collected.append(row)
        assert collected == [{"row": 0}, {"row": 1}]
        with pytest.raises(RuntimeError, match="async-secret"):
            async for _row in broken_async_rows():
                pass

    asyncio.run(collect_async())

    events = [event for call in calls for event in call[2]["events"]]
    assert [event["event_kind"] for event in events] == [
        "started",
        "finished",
        "started",
        "exception",
        "started",
        "finished",
        "started",
        "exception",
    ]
    assert events[1]["status"] == "ok"
    assert events[3]["error_type"] == "RuntimeError"
    assert "password=leaked" not in events[3]["error_preview"]
    assert events[5]["status"] == "ok"
    assert "async-secret" not in events[7]["error_preview"]
    assert "[REDACTED]" in events[7]["error_preview"]


def test_trace_op_rejects_static_span_id_and_explicit_trace_id_stays_root():
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body, idempotency_key=None):
            calls.append((method, path, body, idempotency_key))
            return {"inserted": len(body["events"]), "trace_ids": [body["events"][0]["trace_id"]]}

    run = Run(client=FakeClient(), run_id="run-1")
    with pytest.raises(TypeError, match="span_id"):
        run.trace_op(span_id="1111111111111111")  # type: ignore[call-arg]

    explicit_trace_id = "1" * 32

    @run.trace_op(kind="tool", trace_id=explicit_trace_id)
    def explicit_trace():
        return "ok"

    with run.trace("root", kind="rollout"):
        assert explicit_trace() == "ok"

    events = calls[0][2]["events"]
    explicit_start = next(event for event in events if event["name"].endswith("explicit_trace") and event["event_kind"] == "started")
    assert explicit_start["trace_id"] == explicit_trace_id
    assert "parent_span_id" not in explicit_start


def test_trace_async_mode_queues_one_idempotent_batch(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    class FailingClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body, idempotency_key=None):
            raise AssertionError("trace batch should enqueue instead of using network")

    run = Run(client=FailingClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    with run.trace("rollout", kind="rollout"):
        pass

    status = run.upload_status()
    assert status["pending"] == 1
    queue_path = tmp_path / "run-1" / "queue.sqlite3"
    row = sqlite3.connect(queue_path).execute("select path, body_json, idempotency_key from events").fetchone()
    assert row[0] == "/api/runs/run-1/traces/events"
    assert row[2].startswith("instantml-trace-run-1-")
    assert len(json.loads(row[1])["events"]) == 2
    assert run._async_buffer is not None
    assert run._async_buffer.stop(timeout=1.0)
    if run._async_queue is not None:
        run._async_queue.close()
    run._finished = True
    client_module._unregister_active_run(run)


def test_trace_op_delivery_modes_preserve_trace_batch_idempotency(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    class AsyncClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body, idempotency_key=None):
            raise AssertionError("trace_op batch should enqueue instead of using network")

    async_run = Run(client=AsyncClient(), run_id="run-async", upload_mode="async", queue_dir=str(tmp_path / "async"))

    @async_run.trace_op(kind="reward")
    def async_reward(value):
        return value

    assert async_reward(1) == 1
    assert async_reward(2) == 2
    async_run.flush()
    queue_path = tmp_path / "async" / "run-async" / "queue.sqlite3"
    rows = sqlite3.connect(queue_path).execute("select path, body_json, idempotency_key from events order by rowid").fetchall()
    assert [row[0] for row in rows] == ["/api/runs/run-async/traces/events", "/api/runs/run-async/traces/events"]
    assert all(row[2].startswith("instantml-trace-run-async-") for row in rows)
    assert [len(json.loads(row[1])["events"]) for row in rows] == [2, 2]
    assert async_run._async_buffer is not None
    assert async_run._async_buffer.stop(timeout=1.0)
    if async_run._async_queue is not None:
        async_run._async_queue.close()
    async_run._finished = True
    client_module._unregister_active_run(async_run)

    class SpoolClient:
        offline_dir = None

        def _request(self, method, path, body, idempotency_key=None):
            raise AssertionError("process spool should write trace_op batch to disk")

    spool_run = Run(client=SpoolClient(), run_id="run-spool", upload_mode="spool", spool_dir=str(tmp_path / "spool"))

    @spool_run.trace_op(kind="reward")
    def spool_reward():
        return 1

    spool_reward()
    spool_run.flush()
    spool_event = _spool_events(tmp_path / "spool" / "run-spool")[0]
    spool_request = spool_event["requests"][0]
    assert spool_request["path"] == "/api/runs/run-spool/traces/events"
    assert spool_request["idempotency_key"].startswith("instantml-trace-run-spool-")
    assert len(spool_request["body"]["events"]) == 2
    spool_run._finished = True
    client_module._unregister_active_run(spool_run)

    class OfflineClient:
        offline_dir = str(tmp_path / "offline")

        def _request(self, method, path, body, idempotency_key=None):
            raise InstantMLError("offline")

    offline_run = Run(client=OfflineClient(), run_id="run-offline")

    @offline_run.trace_op(kind="reward")
    def offline_reward():
        return 1

    offline_reward()
    offline_run.flush()
    spooled = json.loads((tmp_path / "offline" / "run-offline.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert spooled["path"] == "/api/runs/run-offline/traces/events"
    assert spooled["idempotency_key"].startswith("instantml-trace-run-offline-")

    replay_calls = []

    class ReplayClient:
        offline_dir = str(tmp_path / "offline")

        def _request(self, method, path, body, idempotency_key=None):
            replay_calls.append((method, path, body, idempotency_key))
            return {}

    replay = Run(client=ReplayClient(), run_id="run-offline")
    assert replay.replay_offline() == 1
    assert replay_calls[0][1] == "/api/runs/run-offline/traces/events"
    assert replay_calls[0][3] == spooled["idempotency_key"]


def test_trace_payload_validation_and_redaction_edges(monkeypatch):
    with pytest.raises(TypeError, match="name"):
        trace_payload.normalize_name(13)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="non-empty"):
        trace_payload.normalize_name("  ")
    with pytest.raises(ValueError, match="512 bytes"):
        trace_payload.normalize_name("x" * 513)

    assert trace_payload.normalize_optional_label("", "thread_id") is None
    with pytest.raises(TypeError, match="thread_id"):
        trace_payload.normalize_optional_label(7, "thread_id")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="512 bytes"):
        trace_payload.normalize_optional_label("x" * 513, "thread_id")

    with pytest.raises(TypeError, match="rank"):
        trace_payload.normalize_rank(True)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="nonnegative"):
        trace_payload.normalize_rank(-1)
    with pytest.raises(TypeError, match="duration_ms"):
        trace_payload.normalize_duration_ms("slow")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="finite"):
        trace_payload.normalize_duration_ms(float("inf"))

    with pytest.raises(TypeError, match="attributes"):
        trace_payload.json_object([], "attributes", 100)  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="links"):
        trace_payload.json_object_or_array("bad", "links", 100)
    with pytest.raises(ValueError, match="finite"):
        trace_payload.json_object({"metric": float("nan")}, "attributes", 100)
    with pytest.raises(TypeError, match="JSON serializable"):
        trace_payload.json_object({"bad": object()}, "attributes", 100)
    with pytest.raises(ValueError, match="serialized bytes"):
        trace_payload.json_object({"large": "x" * 101}, "attributes", 100)

    monkeypatch.setattr(trace_payload, "redact_json_value", lambda value, key=None: [])
    with pytest.raises(TypeError, match="attributes"):
        trace_payload.json_object({"ok": 1}, "attributes", 100)
    monkeypatch.setattr(trace_payload, "redact_json_value", lambda value, key=None: "bad")
    with pytest.raises(TypeError, match="links"):
        trace_payload.json_object_or_array({"ok": 1}, "links", 100)


def test_trace_payload_preview_and_identifier_edges():
    class ExplodingString:
        def __str__(self):
            raise RuntimeError("boom")

        def __repr__(self):
            return "ExplodingString(value=instantml_SECRET123)"

    class Unrepresentable:
        def __str__(self):
            raise RuntimeError("boom")

        def __repr__(self):
            raise RuntimeError("also boom")

    text, truncated = trace_payload.preview_payload(ExplodingString(), "preview", "inputs")
    assert text == "ExplodingString(value=[REDACTED])"
    assert truncated is False
    text, truncated = trace_payload.preview_payload(Unrepresentable(), "preview", "inputs")
    assert text == "<unrepresentable>"
    assert truncated is False
    assert trace_payload.preview_payload(float("nan"), "preview", "inputs") == ('"nan"', False)
    assert trace_payload.json_object({"items": {3, 1, 2}}, "attributes", 100) == {"items": [1, 2, 3]}
    assert trace_payload.redact_json_value([["password", "hunter2-super-secret"], ["safe", "value"]]) == [
        ["password", "[REDACTED]"],
        ["safe", "value"],
    ]

    with pytest.raises(TypeError, match="trace_id"):
        trace_payload.normalize_trace_id(123)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="32 hex"):
        trace_payload.normalize_trace_id("not-hex")
    with pytest.raises(ValueError, match="all zeros"):
        trace_payload.normalize_trace_id("0" * 32)
    with pytest.raises(TypeError, match="kind"):
        trace_payload.normalize_kind(None)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="kind"):
        trace_payload.normalize_kind("unknown")

    clipped, was_truncated = trace_payload._truncate_utf8("é" * 3000, trace_payload.MAX_TRACE_PREVIEW_BYTES + 1)
    assert was_truncated is True
    assert clipped
    assert len(clipped.encode("utf-8")) <= trace_payload.MAX_TRACE_PREVIEW_BYTES + 1
    assert trace_payload._truncate_utf8("é", 1) == ("", True)
    with pytest.raises(TypeError, match="JSON serializable"):
        trace_payload._ensure_serialized_size({"bad": object()}, "attributes", 100)


def test_trace_context_attach_detach_start_span_and_wrap_inherit_parent():
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body, idempotency_key=None):
            calls.append((method, path, body, idempotency_key))
            return {"inserted": len(body["events"]), "trace_ids": [body["events"][0]["trace_id"]]}

    run = Run(client=FakeClient(), run_id="run-1")
    with pytest.raises(TypeError, match="dictionary"):
        run.attach_trace_context("bad")  # type: ignore[arg-type]

    with run.trace("root", kind="rollout", thread_id="thread-a", rank=3) as trace:
        assert trace.start() is trace
        carrier = trace.context()
        attached = run.attach_trace_context(carrier)
        assert attached.__enter__() is attached
        attached.__exit__(None, None, None)
        attached.detach()
        with run.attach_trace_context(carrier):
            manual = run.start_span("worker.manual", kind="custom")
            assert manual.parent_span_id == trace.span_id
            assert manual.thread_id == "thread-a"
            assert manual.rank == 3
            assert manual._duration_ms() is not None
            manual.finish(output={"ok": True})
        direct = trace.start_span("trace.start-span", kind="custom")
        assert direct.parent_span_id == trace.span_id
        direct.finish()
        wrapped = trace.wrap(lambda: run.start_span("worker.wrapped", kind="custom"))

    wrapped_span = wrapped()
    assert wrapped_span.parent_span_id == carrier["span_id"]
    wrapped_span.finish()
    run.flush()

    events = [event for call in calls for event in call[2]["events"]]
    assert any(event["name"] == "worker.manual" and event.get("parent_span_id") == carrier["span_id"] for event in events)
    assert any(event["name"] == "worker.wrapped" and event.get("parent_span_id") == carrier["span_id"] for event in events)


def test_trace_wrap_and_span_updates_are_thread_safe():
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body, idempotency_key=None):
            calls.append((method, path, body, idempotency_key))
            return {"inserted": len(body["events"]), "trace_ids": [body["events"][0]["trace_id"]]}

    run = Run(client=FakeClient(), run_id="run-1")
    with run.trace("root", kind="rollout") as trace:
        def work(index):
            span = run.start_span(f"worker.{index}", kind="custom")
            parent = span.parent_span_id
            span.finish()
            return parent

        wrapped = trace.wrap(work)
        with ThreadPoolExecutor(max_workers=4) as pool:
            parents = list(pool.map(wrapped, range(8)))
        assert parents == [trace.span_id] * 8

        update_span = trace.start_span("shared-updates", kind="custom")

        def update(index):
            update_span.log_metric(f"metric.{index}", index)
            update_span.add_attributes({f"attr.{index}": index})

        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(update, range(40)))
        update_span.finish()

    run.flush()
    events = [event for call in calls for event in call[2]["events"]]
    update_sequences = [
        event["sequence"]
        for event in events
        if event["span_id"] == update_span.span_id
    ]
    assert len(update_sequences) == len(set(update_sequences))
    assert update_sequences == sorted(update_sequences)


def test_trace_span_error_interrupt_double_finish_and_invalid_sync_payload():
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body, idempotency_key=None):
            calls.append((method, path, body, idempotency_key))
            return {"inserted": len(body["events"]), "trace_ids": [body["events"][0]["trace_id"]]}

    run = Run(client=FakeClient(), run_id="run-1")
    with pytest.raises(RuntimeError, match="rollout failed"):
        with run.trace("failing-rollout", kind="rollout", capture="preview"):
            raise RuntimeError("rollout failed")

    span = run.trace("manual-finish", kind="rollout")
    span.finish(status="interrupted", output={"partial": True})
    span.finish(status="ok")
    assert span._duration_ms() is not None
    manual_events = [event for call in calls for event in call[2]["events"] if event["name"] == "manual-finish"]
    assert [event["event_kind"] for event in manual_events] == ["started", "interrupted"]

    with pytest.raises(TypeError, match="JSON serializable"):
        run.trace("bad-attributes", kind="rollout", attributes={"bad": object()})
    with pytest.raises(ValueError, match="step"):
        run.trace("bad-step", kind="rollout", step=float("nan")).start()
    with pytest.raises(ValueError, match="status"):
        run.trace("bad-finish-status", kind="rollout").finish(status="unknown")
    pending = run.trace("pending-duration", kind="rollout")
    assert pending._duration_ms() is None
    pending.start()
    pending.add_attributes({"phase": "eval"})
    with pytest.raises(TypeError, match="JSON serializable"):
        pending.add_attributes({"bad": object()})
    with pytest.raises(ValueError, match="finite"):
        pending.log_metric({"bad": float("nan")})
    pending.finish()

    run.flush()
    events = [event for call in calls for event in call[2]["events"]]
    failing_exception = next(event for event in events if event["name"] == "failing-rollout" and event["event_kind"] == "exception")
    assert failing_exception["error_type"] == "RuntimeError"
    manual_events = [event for event in events if event["name"] == "manual-finish"]
    assert [event["event_kind"] for event in manual_events] == ["started", "interrupted"]


def test_trace_async_invalid_start_finish_and_update_payloads_warn(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    class FailingClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body, idempotency_key=None):
            raise AssertionError("trace batch should enqueue instead of using network")

    run = Run(client=FailingClient(), run_id="run-async", upload_mode="async", queue_dir=str(tmp_path))
    with pytest.warns(RuntimeWarning, match="trace span dropped an invalid payload"):
        run.trace("bad-start", kind="rollout", step=float("nan")).start()

    span = run.trace("bad-updates", kind="rollout")
    span.start()
    run._last_async_warning_at = 0
    with pytest.warns(RuntimeWarning, match="trace span dropped an invalid payload"):
        span.add_attributes({"bad": object()})
    run._last_async_warning_at = 0
    with pytest.warns(RuntimeWarning, match="trace span dropped an invalid payload"):
        span.log_metric({"bad": float("nan")})
    run._last_async_warning_at = 0
    with pytest.warns(RuntimeWarning, match="trace span dropped an invalid payload"):
        span.finish(status="unknown")

    status = run.upload_status()
    assert status["dropped"] == 4
    assert status["pending"] == 1
    assert run._async_buffer is not None
    assert run._async_buffer.stop(timeout=1.0)
    if run._async_queue is not None:
        run._async_queue.close()
    run._finished = True
    client_module._unregister_active_run(run)


def test_trace_op_decorator_fallbacks_and_helper_edges(monkeypatch):
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body, idempotency_key=None):
            calls.append((method, path, body, idempotency_key))
            return {"inserted": len(body["events"]), "trace_ids": [body["events"][0]["trace_id"]]}

    run = Run(client=FakeClient(), run_id="run-1")
    with pytest.raises(TypeError, match="callable"):
        run.trace_op()(object())  # type: ignore[arg-type]

    original_signature = tracing_module.inspect.signature

    def flaky_signature(fn):
        if getattr(fn, "__name__", "") == "signature_fallback":
            raise ValueError("no signature")
        return original_signature(fn)

    monkeypatch.setattr(tracing_module.inspect, "signature", flaky_signature)

    @run.trace_op(kind="tool", capture="preview")
    def signature_fallback(*args, **kwargs):
        return {"args": args, "kwargs": kwargs}

    assert signature_fallback(1, token="instantml_SECRET123")["args"] == (1,)

    @run.trace_op(kind="tool", capture="preview")
    def one_arg(value):
        return value

    with pytest.raises(TypeError):
        one_arg(1, 2)

    assert tracing_module._redaction_state("off", True, False) == "not_captured"
    assert tracing_module._redaction_state("preview", True, True) == "truncated"
    assert tracing_module._redaction_state("preview", False, False) == "redacted"
    assert tracing_module._error_preview(None, "preview") == (None, "", False)
    assert tracing_module._error_preview("instantml_SECRET123", "preview") == ("Error", "[REDACTED]", False)

    run.flush()
    events = [event for call in calls for event in call[2]["events"]]
    fallback_start = next(event for event in events if event["name"].endswith("signature_fallback") and event["event_kind"] == "started")
    assert '"args":[1]' in fallback_start["input_preview"]
    assert "instantml_SECRET123" not in fallback_start["input_preview"]
    one_arg_start = next(event for event in events if event["name"].endswith("one_arg") and event["event_kind"] == "started")
    assert '"args":[1,2]' in one_arg_start["input_preview"]
    one_arg_exception = next(event for event in events if event["name"].endswith("one_arg") and event["event_kind"] == "exception")
    assert one_arg_exception["error_type"] == "TypeError"


def test_trace_batch_flushes_before_and_after_size_thresholds(monkeypatch):
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body, idempotency_key=None):
            calls.append((method, path, body, idempotency_key))
            return {"inserted": len(body["events"]), "trace_ids": [body["events"][0]["trace_id"]]}

    run = Run(client=FakeClient(), run_id="run-1")
    monkeypatch.setattr(client_module, "MAX_TRACE_EVENTS_PER_BATCH", 2)
    run._record_trace_event({"trace_id": "1" * 32, "span_id": "1" * 16, "event_id": "a"})
    run._record_trace_event({"trace_id": "1" * 32, "span_id": "2" * 16, "event_id": "b"})
    assert [len(call[2]["events"]) for call in calls] == [2]

    calls.clear()
    monkeypatch.setattr(client_module, "MAX_TRACE_EVENTS_PER_BATCH", trace_payload.MAX_TRACE_EVENTS_PER_BATCH)
    first = {"trace_id": "2" * 32, "span_id": "3" * 16, "event_id": "c", "payload": "x" * 20}
    first_bytes = client_module._estimated_json_bytes(first) + client_module._TRACE_EVENT_SIZE_OVERHEAD_BYTES
    monkeypatch.setattr(client_module, "_TRACE_BATCH_MAX_BYTES", first_bytes + 1)
    run._record_trace_event(first)
    run._record_trace_event({"trace_id": "2" * 32, "span_id": "4" * 16, "event_id": "d", "payload": "y" * 20})
    run.flush()
    assert [len(call[2]["events"]) for call in calls] == [1, 1]

    calls.clear()
    monkeypatch.setattr(client_module, "MAX_TRACE_EVENTS_PER_BATCH", 2)
    monkeypatch.setattr(client_module, "_TRACE_BATCH_MAX_BYTES", 512 * 1024)
    run._submit_trace_batch([
        {"trace_id": "3" * 32, "span_id": f"{index + 1:016x}", "event_id": str(index)}
        for index in range(5)
    ])
    assert [len(call[2]["events"]) for call in calls] == [2, 2, 1]


def test_trace_record_event_hot_path_does_not_json_serialize(monkeypatch):
    class FallbackSized:
        def __str__(self):
            return "fallback"

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body, idempotency_key=None):
            raise AssertionError("trace event should not flush")

    run = Run(client=FakeClient(), run_id="run-1")
    assert client_module._estimated_json_bytes(FallbackSized()) == len(json.dumps("fallback").encode("utf-8"))
    assert client_module._estimated_json_bytes([1, 2]) >= len(json.dumps([1, 2], separators=(",", ":")).encode("utf-8"))
    escaped_text = "\"\\\n\u00e9\U0001f642"
    assert client_module._estimated_json_bytes(escaped_text) >= len(json.dumps(escaped_text).encode("utf-8"))
    minimal_event = {
        "trace_id": "3" * 32,
        "span_id": "5" * 16,
        "event_id": "hot-path",
        "sequence": 1,
        "event_kind": "started",
        "name": "reward.score",
        "kind": "reward",
        "status": "running",
        "started_at": "2026-07-03T12:00:00Z",
        "attributes": {},
        "metrics": {},
        "links": [],
        "content_policy": "off",
        "redaction_state": "not_captured",
        "truncated": False,
    }
    actual_bytes = len(json.dumps(minimal_event, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    estimated_bytes = client_module._estimated_json_bytes(minimal_event) + client_module._TRACE_EVENT_SIZE_OVERHEAD_BYTES
    assert estimated_bytes <= actual_bytes + 128

    def fail_json_dump(*args, **kwargs):
        raise AssertionError("trace event size should be estimated without json.dumps")

    monkeypatch.setattr(client_module.json, "dumps", fail_json_dump)
    run._record_trace_event(minimal_event)

    assert len(run._trace_events) == 1


def test_trace_async_invalid_payload_warns_and_counts_drop(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    class FailingClient:
        base_url = "http://example.test"
        timeout = 1.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body, idempotency_key=None):
            raise AssertionError("trace batch should enqueue instead of using network")

    run = Run(client=FailingClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    with pytest.warns(RuntimeWarning, match="trace span dropped an invalid payload"):
        with run.trace("rollout", kind="rollout", metrics={"bad": float("nan")}):
            pass

    status = run.upload_status()
    assert status["dropped"] == 1
    assert status["pending"] == 1
    assert run._async_buffer is not None
    assert run._async_buffer.stop(timeout=1.0)
    if run._async_queue is not None:
        run._async_queue.close()
    run._finished = True
    client_module._unregister_active_run(run)


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


def test_finish_drain_seconds_defaults_when_env_unset_or_blank(monkeypatch):
    monkeypatch.delenv("INSTANTML_FINISH_DRAIN_SECONDS", raising=False)
    assert _finish_drain_seconds(10.0) == 10.0
    monkeypatch.setenv("INSTANTML_FINISH_DRAIN_SECONDS", "   ")
    assert _finish_drain_seconds(10.0) == 10.0


def test_finish_drain_seconds_parses_env_override(monkeypatch):
    monkeypatch.setenv("INSTANTML_FINISH_DRAIN_SECONDS", "2.5")
    assert _finish_drain_seconds(10.0) == 2.5
    monkeypatch.setenv("INSTANTML_FINISH_DRAIN_SECONDS", "-3")
    assert _finish_drain_seconds(10.0) == 0.0


def test_finish_drain_seconds_warns_and_keeps_default_on_invalid_env(monkeypatch):
    monkeypatch.setenv("INSTANTML_FINISH_DRAIN_SECONDS", "fast")
    with pytest.warns(RuntimeWarning, match="invalid INSTANTML_FINISH_DRAIN_SECONDS"):
        assert _finish_drain_seconds(10.0) == 10.0


def test_async_finish_uses_env_drain_budget_when_no_explicit_timeout(monkeypatch, tmp_path):
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)
    monkeypatch.setenv("INSTANTML_FINISH_DRAIN_SECONDS", "0.125")

    class FakeClient:
        base_url = "http://example.test"
        timeout = 10.0
        offline_dir = None

        def _resolve_api_key(self):
            return None

        def _request(self, method, path, body):
            return {}

    run = Run(client=FakeClient(), run_id="run-1", upload_mode="async", queue_dir=str(tmp_path))
    waits = []
    monkeypatch.setattr(run, "_submit", lambda *args, **kwargs: None)
    monkeypatch.setattr(run, "_force_async_buffer_flush", lambda timeout=None: True)
    monkeypatch.setattr(run, "wait_for_processing", lambda timeout=None: waits.append(timeout) or True)

    run.finish()

    assert waits == [0.125]


def test_async_finish_timeout_warning_reports_queued_rows_and_recovery_command(monkeypatch, tmp_path):
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
    queue.enqueue("POST", "/runs/run-1/metrics", {"metrics": {"reward": 1.0}, "step": 1}, idempotency_key="event-1")
    queue.enqueue("POST", "/runs/run-1/metrics", {"metrics": {"reward": 2.0}, "step": 2}, idempotency_key="event-2")
    monkeypatch.setattr(run, "_submit", lambda *args, **kwargs: None)
    monkeypatch.setattr(run, "_force_async_buffer_flush", lambda timeout=None: True)
    monkeypatch.setattr(run, "wait_for_processing", lambda timeout=None: False)

    with pytest.warns(RuntimeWarning, match="did not finish before the finish\\(\\) drain timeout") as captured:
        run.finish(timeout=0.01)

    messages = [str(warning.message) for warning in captured if "drain timeout" in str(warning.message)]
    assert len(messages) == 1
    assert "2 queued row(s)" in messages[0]
    assert f"instantml-uploader --queue-dir {tmp_path}" in messages[0]
    assert "INSTANTML_FINISH_DRAIN_SECONDS" in messages[0]


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
    # Different runs so the two events are not grouped into a batch; this keeps
    # per-event terminal/retry semantics under test.
    repository.enqueue("POST", "/runs/run-1/metrics", {"metrics": {"reward": 1.0}, "step": 1}, idempotency_key="event-1")
    repository.enqueue("POST", "/runs/run-2/metrics", {"metrics": {"loss": 2.0}, "step": 1}, idempotency_key="event-2")
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
    # Distinct runs keep each event on the per-event path so the retry-blocks-
    # later ordering guarantee is exercised without batching.
    for index in range(3):
        repository.enqueue(
            "POST",
            f"/runs/run-{index}/metrics",
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
    # Distinct runs keep both on the per-event path (one terminal-fails, the
    # next succeeds) so the directory drain's continue-after-failure path is
    # exercised without batch grouping.
    repository.enqueue("POST", "/runs/run-1/metrics", {"metrics": {"bad": 1}, "step": 1}, idempotency_key="event-1")
    repository.enqueue("POST", "/runs/run-2/metrics", {"metrics": {"ok": 2}, "step": 1}, idempotency_key="event-2")
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

    # The trailing repository.close() checkpoints the WAL, which stamps
    # _last_checkpoint_at via one extra time.time() read.
    assert loop_calls == {"parent": 3, "drain": 2, "health": 1, "status": 2, "time": 3}


def test_async_queue_http_helpers(monkeypatch):
    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return None

        def read(self):
            return b"ok"

    opened = []
    monkeypatch.setattr(http_pool, "urlopen", lambda request, timeout: opened.append((request, timeout)) or FakeResponse())
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
    monkeypatch.setattr(http_pool, "urlopen", lambda request, timeout: (_ for _ in ()).throw(error))
    result = async_queue._send_request("http://example.test", None, 1, "POST", "/x", {})
    assert result.retryable
    assert result.retry_after == 2
    assert result.message == "slow down"

    malformed = urllib.error.HTTPError("http://example.test", 400, "bad", {}, BytesIO(b"{"))
    assert async_queue._decode_http_error(malformed) == ("HTTP Error 400: bad", None)
    non_object = urllib.error.HTTPError("http://example.test", 400, "bad", {}, BytesIO(b"[]"))
    assert async_queue._decode_http_error(non_object) == ("HTTP Error 400: bad", None)

    monkeypatch.setattr(
        http_pool,
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
    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            return {}

    run = Run(client=FakeClient(), run_id=client_module._PENDING_RUN_ID, upload_mode="spool")
    with pytest.raises(InstantMLError, match="process spool directory is not ready"):
        run._require_spool_writer()


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
    run.flush()

    event = _spool_events(tmp_path / "run-1")[0]
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
    run.flush()

    event = _spool_events(tmp_path / "run-1")[0]
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
    run.flush()
    event = _spool_events(tmp_path / "run-1")[0]
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
    run.flush()

    assert artifact["id"] == "spooled"
    assert artifact["metadata"] == {"kind": "note"}
    assert upload["id"] == "spooled"
    assert upload["source_path"] == str(source.resolve())
    events = _spool_events(tmp_path / "spool" / "run-1")
    assert events[0]["data"]["artifacts"][0]["name"] == "notes.json"
    assert events[1]["data"]["upload_file"]["source_path"] == str(source.resolve())


def test_log_config_can_preserve_nested_values():
    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            return {}

    class FakeShadow:
        def __init__(self):
            self.config_updates = []

        def update_config(self, data):
            self.config_updates.append(data)

    shadow = FakeShadow()
    run = Run(client=FakeClient(), run_id="run-1", shadow=shadow)
    run.log_config({"optimizer": {"lr": 0.001}}, flatten=False)

    assert calls[0][2]["attributes"] == [{"path": "config/optimizer", "type": "config", "value": {"lr": 0.001}}]
    assert shadow.config_updates == [{"optimizer": {"lr": 0.001}}]


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
    online = im.init(project="offline", name="replay-me", base_url=api_server, source_tracking=False, upload_mode="sync")
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


def test_trace_offline_replay_preserves_idempotency_key(tmp_path):
    calls = []

    class FailingClient:
        offline_dir = str(tmp_path)

        def _request(self, method, path, body, idempotency_key=None):
            raise InstantMLError("offline")

    run = Run(client=FailingClient(), run_id="run-1")
    with run.trace("rollout", kind="rollout"):
        pass

    spooled = json.loads((tmp_path / "run-1.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert spooled["idempotency_key"].startswith("instantml-trace-run-1-")

    class ReplayClient:
        offline_dir = str(tmp_path)

        def _request(self, method, path, body, idempotency_key=None):
            calls.append((method, path, body, idempotency_key))
            return {}

    replay = Run(client=ReplayClient(), run_id="run-1")
    assert replay.replay_offline() == 1
    assert calls[0][1] == "/api/runs/run-1/traces/events"
    assert calls[0][3] == spooled["idempotency_key"]


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
    run.flush()
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
    assert not list((tmp_path / "run-1").glob("*.jsonl"))

    run.log_config({"optimizer": {"lr": 0.001}})
    run.flush()
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
    run.flush()
    event_id = _spool_events(tmp_path / "run-1")[0]["event_id"]

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
    run.flush()
    event = _spool_events(tmp_path / "run-1")[0]
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
    run.flush()
    event_id = _spool_events(tmp_path / "run-1")[0]["event_id"]

    assert uploader.drain_spool(str(tmp_path), client=IdempotentClient()) == 1
    assert calls[0][1] == "/api/runs/run-1/logs"
    assert calls[0][3] == event_id


def test_process_uploader_sends_trace_request_idempotency_key(tmp_path):
    calls = []

    class IdempotentClient:
        def _request(self, method, path, body, idempotency_key=None):
            calls.append((method, path, body, idempotency_key))
            return {}

    run = Run(client=IdempotentClient(), run_id="run-1", upload_mode="spool", spool_dir=str(tmp_path))
    with run.trace("rollout", kind="rollout"):
        pass
    run.flush()
    event = _spool_events(tmp_path / "run-1")[0]
    request_key = event["requests"][0]["idempotency_key"]

    assert uploader.drain_spool(str(tmp_path), client=IdempotentClient()) == 1
    assert calls[0][1] == "/api/runs/run-1/traces/events"
    assert calls[0][3] == request_key


def test_package_level_drain_spool_wrapper(tmp_path):
    assert im.drain_spool(str(tmp_path)) == 0


def test_process_spool_integration_drains_to_api_server(api_server, tmp_path):
    run = im.init(
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
    run.flush()

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
    run_a.flush()
    run_b.flush()

    assert uploader.drain_spool(str(tmp_path), client=SometimesFailingClient()) == 1
    # run-a fails on its first event; the whole segment (2 events) is preserved
    # as the not-yet-delivered remainder. run-b drained fully.
    assert len(_spool_events(tmp_path / "run-a")) == 2
    assert not _spool_events(tmp_path / "run-b")
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
    run.flush()
    assert uploader.drain_spool(str(tmp_path), client=FakeClient(), max_events=1) == 1
    # One event delivered; the segment is rewritten with the 1-event remainder.
    assert len(_spool_events(tmp_path / "run-1")) == 1

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
    assert metadata["_instantml"]["stop_signal_capable"] is True
    assert isinstance(metadata["_instantml"]["sdk_version"], str)
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

    monkeypatch.setattr(http_pool, "urlopen", fake_urlopen)

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

    child = im.Api(base_url="http://example.test").fork_run(
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

    api = im.Api(base_url="http://example.test")
    assert api.fork_run("source-run", step=120, tags=["retry"]) == {"id": "child-1"}
    assert api.fork_run("source-run", step=120, tags=["retry"]) == {"id": "child-2"}

    assert calls[0][3] == calls[1][3]
    assert calls[0][3].startswith("instantml-fork-")


def test_api_fork_run_validates_inputs_and_response(monkeypatch):
    with pytest.raises(TypeError, match="inherit_config"):
        im.Api(base_url="http://example.test").fork_run("source-run", inherit_config="yes")
    with pytest.raises(TypeError, match="tags"):
        im.Api(base_url="http://example.test").fork_run("source-run", tags="retry")
    with pytest.raises(ValueError, match="notes"):
        im.Api(base_url="http://example.test").fork_run("source-run", notes="")

    def invalid_response(self, method, path, body=None, idempotency_key=None):
        return {"run": "not-a-dict"}

    monkeypatch.setattr(Client, "_request", invalid_response)
    with pytest.raises(InstantMLError, match="invalid fork response"):
        im.Api(base_url="http://example.test").fork_run("source-run", name="child")


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

    run = im.attach_run(
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

    run = im.attach_run(
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

    monkeypatch.setattr(http_pool, "urlopen", fake_urlopen)
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

    monkeypatch.setattr(http_pool, "urlopen", fake_urlopen)
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

    monkeypatch.setattr(http_pool, "urlopen", lambda *args, **kwargs: FakeResponse())
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

    monkeypatch.setattr(http_pool, "urlopen", lambda *args, **kwargs: FakeResponse())
    with pytest.raises(InstantMLError, match="non-object"):
        Client()._request("GET", "/health")


def test_sdk_http_error_fallback_message(monkeypatch):
    def fail(*args, **kwargs):
        raise urllib.error.HTTPError("url", 500, "boom", {}, BytesIO(b"not-json"))

    monkeypatch.setattr(http_pool, "urlopen", fail)
    with pytest.raises(InstantMLError, match="HTTP Error 500"):
        Client()._request("GET", "/health")


def test_sdk_http_error_non_error_object_message(monkeypatch):
    def fail(*args, **kwargs):
        body = BytesIO(json.dumps({"message": "not the standard shape"}).encode("utf-8"))
        raise urllib.error.HTTPError("url", 500, "boom", {}, body)

    monkeypatch.setattr(http_pool, "urlopen", fail)
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
            "explicit_text": im.Text("kept"),
            "table": im.Table.from_data([{"epoch": 1, "score": 0.9}]),
            "hist": im.Histogram.from_values([0.0, 1.0, 2.0], bins=2),
            "file": im.File(str(sample), artifact_type="checkpoint", metadata={"phase": "train"}),
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

    run.log({"tables": [im.Table(["a"], [[1]]), im.Table(["a"], [[2]])], "files": [im.File(str(first)), im.File(str(second))]})

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
    run.log_objects({"frame": im.Table.from_dataframe(FakeDataFrame())}, step=1)
    run.log_objects({"image": im.Image.from_data([[[255, 0, 0]]])}, step=1)
    run.log_objects({"scaled_image": im.Image.from_data([[[0.5, 0.0, 0.0]]])}, step=1)

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
        run.log_objects({"audio": im.Audio.from_data([0.0, 0.1])}, step=1)

    def fail_video_imports(name, *args, **kwargs):
        if name.startswith("imageio") or name.startswith("moviepy"):
            raise ImportError("no video dependency")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fail_video_imports)
    with pytest.raises(InstantMLError, match="moviepy or imageio"):
        run.log_objects({"video": im.Video.from_data([[[[0, 0, 0]]]])}, step=1)


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
    run.log({"loss": 1.0, "note": "ok", "table": im.Table(["a"], [[1]]), "weights": im.File(str(source))})
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

    monkeypatch.setattr(client_module, "_sample_system_metrics", lambda state: {"system/cpu_percent": 1.0})
    run = Run(client=FakeClient(), run_id="run-1")
    run.start_system_metrics(interval=0.01)
    with pytest.raises(InstantMLError, match="already running"):
        run.start_system_metrics(interval=0.01)
    time.sleep(0.03)
    run.finish()
    assert any(call[2]["metrics"] == {"system/cpu_percent": 1.0} for call in calls)
    with pytest.raises(ValueError, match="positive"):
        Run(client=FakeClient(), run_id="run-2").start_system_metrics(interval=0)


def test_system_metrics_env_opt_out_and_interval_override(monkeypatch):
    events = []

    def fake_request(self, method, path, body=None, idempotency_key=None):
        return {"run": {"id": "run-env"}}

    monkeypatch.setattr(Client, "_request", fake_request)
    monkeypatch.setattr(Run, "start_system_metrics", lambda self, interval=15.0: events.append(("system", interval)))

    # Opt out: the automatic sampler must not start regardless of the kwarg, so
    # an operator can silence it fleet-wide without touching training code.
    monkeypatch.setenv("INSTANTML_DISABLE_SYSTEM_METRICS", "1")
    im.attach_run("run-env", api_key="key", base_url="http://example.test",
                  system_metrics=True, system_metrics_interval=3.0, upload_mode="sync")
    assert events == []

    # Interval override via env wins over the kwarg.
    monkeypatch.delenv("INSTANTML_DISABLE_SYSTEM_METRICS", raising=False)
    monkeypatch.setenv("INSTANTML_SYSTEM_METRICS_INTERVAL_SECONDS", "2.0")
    im.attach_run("run-env", api_key="key", base_url="http://example.test",
                  system_metrics=True, system_metrics_interval=3.0, upload_mode="sync")
    assert events == [("system", 2.0)]


def test_resolve_system_metrics_env(monkeypatch):
    monkeypatch.delenv("INSTANTML_DISABLE_SYSTEM_METRICS", raising=False)
    monkeypatch.delenv("INSTANTML_SYSTEM_METRICS_INTERVAL_SECONDS", raising=False)
    assert _resolve_system_metrics(True, 15.0) == (True, 15.0)
    monkeypatch.setenv("INSTANTML_DISABLE_SYSTEM_METRICS", "yes")
    assert _resolve_system_metrics(True, 15.0) == (False, 15.0)
    monkeypatch.delenv("INSTANTML_DISABLE_SYSTEM_METRICS", raising=False)
    monkeypatch.setenv("INSTANTML_SYSTEM_METRICS_INTERVAL_SECONDS", "0.5")
    assert _resolve_system_metrics(True, 15.0) == (True, 0.5)
    monkeypatch.setenv("INSTANTML_SYSTEM_METRICS_INTERVAL_SECONDS", "-3")
    with pytest.warns(RuntimeWarning, match="INSTANTML_SYSTEM_METRICS_INTERVAL_SECONDS"):
        assert _resolve_system_metrics(True, 15.0) == (True, 15.0)
    # Non-numeric value (ValueError branch) is also ignored, not fatal.
    monkeypatch.setenv("INSTANTML_SYSTEM_METRICS_INTERVAL_SECONDS", "not-a-number")
    with pytest.warns(RuntimeWarning, match="INSTANTML_SYSTEM_METRICS_INTERVAL_SECONDS"):
        assert _resolve_system_metrics(True, 15.0) == (True, 15.0)


def test_collect_system_metrics_stdlib_fallback(monkeypatch):
    fallback = _collect_system_metrics_fallback()
    assert "system/cpu_count" in fallback  # os.cpu_count() is near-universal
    assert all(isinstance(value, float) for value in fallback.values())
    assert all(key.startswith("system/") for key in fallback)

    # When psutil is unavailable, _collect_system_metrics rides the fallback and
    # never emits the psutil-only system/cpu_percent key — telemetry still
    # appears with zero hard dependencies.
    monkeypatch.setattr(client_module, "_load_psutil", lambda: None)
    metrics = _collect_system_metrics()
    assert "system/cpu_percent" not in metrics
    assert "system/cpu_count" in metrics
    assert all(isinstance(value, float) for value in metrics.values())


def test_system_metrics_sampler_crash_is_contained(monkeypatch, recwarn):
    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            return {}

    def boom(state):
        raise RuntimeError("collector exploded")

    monkeypatch.setattr(client_module, "_sample_system_metrics", boom)
    run = Run(client=FakeClient(), run_id="crash")
    run.start_system_metrics(interval=0.01)
    sampler = run._system_sampler
    time.sleep(0.1)
    # The loop caught the exception, warned, and exited; the daemon thread is no
    # longer running, so a faulty collector never wedges the training run.
    assert sampler is not None and not sampler._thread.is_alive()
    run.finish()
    assert any("stopped after error" in str(w.message) for w in recwarn.list)


def test_system_metrics_fallback_defensive_branches(monkeypatch):
    import builtins

    real_import = builtins.__import__

    def no_resource(name, *args, **kwargs):
        if name == "resource":
            raise ImportError("no resource on this platform")
        return real_import(name, *args, **kwargs)

    def boom(*args, **kwargs):
        raise OSError("denied")

    # Simulate a platform without `resource` (e.g. Windows) plus a denied load
    # average and an unknown CPU count: the fallback degrades to {} and never
    # raises. Driven entirely by monkeypatches so this zero-dependency, OS-
    # independent core test never imports `resource` itself.
    monkeypatch.setattr(builtins, "__import__", no_resource)
    monkeypatch.setattr(client_module.os, "getloadavg", boom, raising=False)
    monkeypatch.setattr(client_module.os, "cpu_count", lambda: None)
    assert _collect_system_metrics_fallback() == {}


def test_load_psutil_handles_present_and_absent(monkeypatch):
    import builtins

    real_import = builtins.__import__
    sentinel = object()

    def import_present(name, *args, **kwargs):
        if name == "psutil":
            return sentinel
        return real_import(name, *args, **kwargs)

    def import_absent(name, *args, **kwargs):
        if name == "psutil":
            raise ImportError("no psutil installed")
        return real_import(name, *args, **kwargs)

    # Cover both branches without requiring the optional `instantml[system]`
    # extra (psutil) to actually be installed in the test environment.
    monkeypatch.setattr(builtins, "__import__", import_present)
    assert _load_psutil() is sentinel
    monkeypatch.setattr(builtins, "__import__", import_absent)
    assert _load_psutil() is None


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
    callback = im.TransformersCallback(project="hf-demo")
    callback.on_log(SimpleNamespace(project="ignored"), SimpleNamespace(global_step=9), object(), logs={"loss": 1.0, "epoch": "1"})
    assert fake_run.logged == [({"loss": 1.0}, 9)]

    logger = im.LightningLogger(project="lightning-demo", run=fake_run)
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
        im.Table(dataframe=object(), data=[])
    assert im.Table(columns=("a",), rows=({"a": 1},)).rows == [{"a": 1}]
    assert im.Table.from_data([{"auto": 1}]).columns == ["auto"]
    with pytest.raises(TypeError, match="bin count"):
        im.Histogram.from_values([1], bins=True)
    with pytest.raises(ValueError, match="positive"):
        im.Histogram.from_values([1], bins=0)
    with pytest.raises(ValueError, match="at least two"):
        im.Histogram.from_values([1], bins=[0])
    assert im.Histogram.from_values([1, 1], bins=1).counts == [2.0]
    assert sum(im.Histogram.from_values([1, 1], bins=2).counts) == 2.0
    assert im.Histogram.from_values([0, 2], bins=[0, 1, 2]).counts == [1.0, 1.0]
    assert im.Histogram.from_values([-1, 0, 3], bins=[0, 1, 2]).counts == [1.0, 0.0]

    with pytest.raises(ValueError, match="either path or data"):
        im.Image("x.png", data=object())
    with pytest.raises(ValueError, match="either path or data"):
        im.Audio("x.wav", data=object())
    with pytest.raises(ValueError, match="either path or data"):
        im.Video("x.mp4", data=object())
    assert im.Image(object()).path is None
    assert im.Audio(object()).path is None
    assert im.Video(object()).path is None


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
        _classify_log_payload({"items": [im.File("a"), im.Table(["a"], [[1]])]})
    with pytest.raises(TypeError, match="metrics"):
        run.log_metrics([], step=1)
    with pytest.raises(TypeError, match="finite numbers"):
        run.log_metrics({"bad": object()}, step=1)
    with pytest.raises(TypeError, match="text values"):
        run.log_text([])
    with pytest.raises(TypeError, match="text value"):
        run.log_text({"bad": object()})
    with pytest.raises(ValueError, match="must not be empty"):
        im.Histogram.from_values([])
    with pytest.raises(InstantMLError, match="upload source"):
        Run(client=FakeClient(), run_id="run-2").upload_file(str(tmp_path / "missing.txt"))


def test_scalar_like_values_are_coerced_for_logs():
    class ItemScalar:
        def item(self):
            return 1.25

    class ZeroDimTensor:
        def detach(self):
            return self

        def cpu(self):
            return self

        def numpy(self):
            return ItemScalar()

    class MultiValueTensor:
        def item(self):
            raise ValueError("only one element tensors can be converted to Python scalars")

    class BoolScalar:
        def item(self):
            return True

    calls = []

    class FakeClient:
        offline_dir = None

        def _request(self, method, path, body):
            calls.append((method, path, body))
            return {}

    run = Run(client=FakeClient(), run_id="run-1")
    run.log_metrics({"numpy_like": ItemScalar(), "torch_like": ZeroDimTensor()}, step=1)
    assert calls[0] == (
        "POST",
        "/runs/run-1/metrics",
        {
            "metrics": {"numpy_like": 1.25, "torch_like": 1.25},
            "step": 1,
            "timestamp": None,
            "preview": False,
            "preview_completion": 0.0,
        },
    )

    metrics, text, objects, files = _classify_log_payload({"loss": ZeroDimTensor(), "note": "ok"})
    assert metrics == {"loss": 1.25}
    assert text == {"note": "ok"}
    assert objects == {}
    assert files == {}

    with pytest.raises(TypeError, match="finite numbers"):
        run.log_metrics({"bad": MultiValueTensor()}, step=2)
    with pytest.raises(TypeError, match="finite numbers"):
        run.log_metrics({"bad": True}, step=2)
    with pytest.raises(TypeError, match="finite numbers"):
        run.log_metrics({"bad": BoolScalar()}, step=2)


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

    audio_path = run._materialize_media_source(im.Audio.from_data([0.1], sample_rate=8000))
    video_path = run._materialize_media_source(im.Video.from_data([[[[0, 0, 0]]]], fps=12, format="mov"))

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
    # psutil missing now degrades to the stdlib fallback, not an empty dict, so
    # telemetry still appears without the optional `instantml[system]` extra.
    no_psutil_metrics = _collect_system_metrics()
    assert "system/cpu_percent" not in no_psutil_metrics
    assert "system/cpu_count" in no_psutil_metrics

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
    monkeypatch.setattr(client_module, "_sample_system_metrics", lambda state: (_ for _ in ()).throw(RuntimeError("boom")))
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
    logger = im.LightningLogger(project="lazy")
    logger.log_image("images", ["image"], step=1, caption="x")
    logger.log_audio("audios", ["audio"], step=2)
    logger.log_video("videos", ["video"], step=3)
    logger.finalize()
    assert logger.version == "lazy-run"
    assert [entry[1] for entry in fake_run.logged] == [1, 2, 3]
    assert fake_run.finished == ["finished"]


def test_polished_framework_adapters_rank_zero_and_keras(monkeypatch, tmp_path):
    class FakeRun:
        run_id = "adapter-run"

        def __init__(self):
            self.logged = []
            self.artifacts = []
            self.finished = []

        def log(self, metrics, step=None):
            self.logged.append((metrics, step))

        def log_artifact(self, name, path, artifact_type="file", step=None, metadata=None):
            self.artifacts.append((name, path, artifact_type, step, metadata))

        def finish(self, status="finished"):
            self.finished.append(status)

    fake_run = FakeRun()
    monkeypatch.setattr(client_module, "init", lambda **kwargs: fake_run)

    callback = im.InstantMLCallback(project="hf-demo")
    callback.on_log(
        SimpleNamespace(project="ignored"),
        SimpleNamespace(global_step=1, is_world_process_zero=False),
        object(),
        logs={"loss": 1.0},
    )
    assert fake_run.logged == []

    output_dir = tmp_path / "checkpoint"
    output_dir.mkdir()
    callback.on_log(
        SimpleNamespace(project="ignored", output_dir=str(output_dir)),
        SimpleNamespace(global_step=2, is_world_process_zero=True),
        object(),
        logs={"loss": 0.5, "epoch": "2"},
    )
    callback.on_save(
        SimpleNamespace(output_dir=str(output_dir)),
        SimpleNamespace(global_step=2, is_world_process_zero=True),
        object(),
    )
    assert fake_run.logged == [({"loss": 0.5}, 2)]
    assert fake_run.artifacts == [("checkpoint", str(output_dir), "checkpoint", 2, None)]

    keras_callback = im.InstantMLKerasCallback(run=fake_run, log_batch=True)
    keras_callback.on_epoch_end(3, {"val_loss": 0.2, "ignored": object()})
    keras_callback.on_train_batch_end(4, {"loss": 0.1})
    keras_callback.on_train_end()
    assert fake_run.logged[-2:] == [({"val_loss": 0.2}, 3), ({"batch/loss": 0.1}, 4)]
    assert fake_run.finished == ["finished"]


def test_framework_adapter_rank_zero_edge_paths(monkeypatch, tmp_path):
    class FakeRun:
        run_id = "adapter-run"

        def __init__(self):
            self.logged = []
            self.configs = []
            self.artifacts = []
            self.finished = []

        def log(self, metrics, step=None):
            self.logged.append((metrics, step))

        def log_config(self, params):
            self.configs.append(params)

        def log_artifact(self, name, path, artifact_type="file", step=None, metadata=None):
            self.artifacts.append((name, path, artifact_type, step, metadata))

        def finish(self, status="finished"):
            self.finished.append(status)

    fake_run = FakeRun()
    init_calls = []

    def fake_init(**kwargs):
        init_calls.append(kwargs)
        return fake_run

    monkeypatch.setattr(client_module, "init", fake_init)

    assert client_module._rank_zero(state=SimpleNamespace(is_global_zero=True)) is True
    assert client_module._rank_zero(state=SimpleNamespace(is_global_zero=False)) is False
    monkeypatch.setenv("LOCAL_RANK", "0")
    assert client_module._rank_zero() is True
    monkeypatch.setenv("RANK", "1")
    assert client_module._rank_zero() is False
    monkeypatch.delenv("RANK", raising=False)
    monkeypatch.delenv("LOCAL_RANK", raising=False)

    callback = im.InstantMLCallback(project="hf-demo")
    callback.setup(SimpleNamespace(project="ignored"), SimpleNamespace(is_global_zero=False))
    assert callback.run is None
    callback.on_save(SimpleNamespace(output_dir=str(tmp_path)), SimpleNamespace(is_global_zero=True), object())
    assert fake_run.artifacts == []

    empty_callback = im.InstantMLCallback()
    monkeypatch.setattr(empty_callback, "setup", lambda *args, **kwargs: None)
    empty_callback.on_log(SimpleNamespace(project="ignored"), SimpleNamespace(is_global_zero=True), object(), logs={"loss": 1.0})
    assert empty_callback.run is None

    logger = im.InstantMLLogger(project="lightning-demo", run=fake_run)
    monkeypatch.setenv("RANK", "1")
    assert logger.version == "rank-nonzero"
    logger.log_metrics({"loss": 1.0}, step=1)
    logger.log_hyperparams({"lr": 0.1})
    logger.log_image("image", ["frame"], step=1)
    logger.log_audio("audio", ["clip"], step=1)
    logger.log_video("video", ["movie"], step=1)
    assert fake_run.logged == []
    assert fake_run.configs == []
    monkeypatch.delenv("RANK", raising=False)

    lazy_keras = im.InstantMLKerasCallback(project="keras-demo")
    lazy_keras.on_train_begin()
    lazy_keras.on_train_batch_end(1, {"loss": 0.5})
    assert init_calls == [{"project": "keras-demo"}]
    assert fake_run.logged == []


def test_framework_adapters_subclass_installed_framework_bases(monkeypatch):
    class TrainerCallback:
        pass

    class LightningBase:
        pass

    class KerasBase:
        pass

    transformers_module = ModuleType("transformers")
    transformers_module.TrainerCallback = TrainerCallback
    lightning_logger_module = ModuleType("lightning.pytorch.loggers.logger")
    lightning_logger_module.Logger = LightningBase
    keras_callbacks_module = ModuleType("keras.callbacks")
    keras_callbacks_module.Callback = KerasBase

    monkeypatch.setitem(sys.modules, "transformers", transformers_module)
    monkeypatch.setitem(sys.modules, "lightning", ModuleType("lightning"))
    monkeypatch.setitem(sys.modules, "lightning.pytorch", ModuleType("lightning.pytorch"))
    monkeypatch.setitem(sys.modules, "lightning.pytorch.loggers", ModuleType("lightning.pytorch.loggers"))
    monkeypatch.setitem(sys.modules, "lightning.pytorch.loggers.logger", lightning_logger_module)
    monkeypatch.setitem(sys.modules, "keras", ModuleType("keras"))
    monkeypatch.setitem(sys.modules, "keras.callbacks", keras_callbacks_module)

    assert isinstance(im.InstantMLCallback(), TrainerCallback)
    assert isinstance(im.InstantMLLogger(project="demo", run=object()), LightningBase)
    assert isinstance(im.InstantMLKerasCallback(run=object()), KerasBase)


def test_framework_adapter_lazy_helper_edge_paths(monkeypatch):
    missing_attr_module = ModuleType("framework_missing_attr")
    monkeypatch.setitem(sys.modules, "framework_missing_attr", missing_attr_module)
    assert client_module._optional_framework_base("framework_missing_attr", "callbacks.Callback") is None

    class ChildCallback(im.InstantMLCallback):
        pass

    class ChildLogger(im.InstantMLLogger):
        pass

    class ChildKeras(im.InstantMLKerasCallback):
        pass

    assert type(ChildCallback()) is ChildCallback
    assert type(ChildLogger(run=object())) is ChildLogger
    assert type(ChildKeras(run=object())) is ChildKeras

    class MetaA(type):
        pass

    class MetaB(type):
        pass

    class ConflictingBase(metaclass=MetaA):
        pass

    class ConflictingAdapter(metaclass=MetaB):
        pass

    assert type(client_module._framework_adapter_new(ConflictingAdapter, ConflictingBase, "Broken")) is ConflictingAdapter


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
        im.init(project="test")


def test_top_level_init_defaults_to_async_upload_mode(monkeypatch, tmp_path):
    def fake_request(self, method, path, body=None):
        return {"run": {"id": "run-top-default-async"}}

    monkeypatch.setenv("INSTANTML_API_KEY", "env-key")
    monkeypatch.setattr(Client, "_request", fake_request)
    monkeypatch.setattr(Run, "_start_async_uploader", lambda self: None)

    run = im.init(project="test", base_url="http://example.test", queue_dir=str(tmp_path / "async"))

    assert run.wait_for_init(timeout=2.0) == "run-top-default-async"
    assert run.upload_mode == "async"
    assert (tmp_path / "async" / "run-top-default-async" / "queue.sqlite3").exists()


def test_init_succeeds_with_explicit_api_key(monkeypatch):
    calls = []

    def fake_request(self, method, path, body=None):
        calls.append((method, path))
        return {"run": {"id": "run-1"}}

    monkeypatch.setattr(Client, "_request", fake_request)
    run = im.init(project="test", api_key="my-key", base_url="http://example.test", upload_mode="sync")
    assert run.run_id == "run-1"


def test_init_succeeds_with_env_var(monkeypatch):
    calls = []

    def fake_request(self, method, path, body=None):
        calls.append((method, path))
        return {"run": {"id": "run-2"}}

    monkeypatch.setenv("INSTANTML_API_KEY", "env-key")
    monkeypatch.setattr(Client, "_request", fake_request)
    run = im.init(project="test", base_url="http://example.test", upload_mode="sync")
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
    run = im.init(project="test", base_url="http://example.test", upload_mode="sync")
    assert run.run_id == "run-3"
