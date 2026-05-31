from __future__ import annotations

import json
import sys
import types
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from instantml import importers
from instantml.client import InstantMLError


def test_redact_value_scrubs_secret_keys_and_signed_urls():
    redacted = importers.redact_value(
        {
            "api_key": "wandb-secret",
            "nested": {
                "max_tokens": 128,
                "tokenizer": "bpe",
                "hf_token": "hf-secret",
                "notes": "bearer abcdefghijklmnopqrstuvwxyz",
                "artifact": "https://example.com/model.pt?X-Amz-Signature=supersecret&X-Amz-Credential=AKIASECRET&X-Goog-Signature=googsecret&sig=azsecret",
            },
        }
    )

    assert redacted["api_key"] == "[REDACTED]"
    assert redacted["nested"]["max_tokens"] == 128
    assert redacted["nested"]["tokenizer"] == "bpe"
    assert redacted["nested"]["hf_token"] == "[REDACTED]"
    assert redacted["nested"]["notes"] == "[REDACTED]"
    assert redacted["nested"]["artifact"] == "https://example.com/model.pt?X-Amz-Signature=[REDACTED]&X-Amz-Credential=[REDACTED]&X-Goog-Signature=[REDACTED]&sig=[REDACTED]"


def test_chunks_from_transformed_json_expands_wandb_history_and_artifacts():
    chunks = importers.chunks_from_transformed_json(
        {
            "project": "source-project",
            "runs": [
                {
                    "id": "run-1",
                    "name": "candidate",
                    "state": "finished",
                    "config": {"token": "please-do-not-send"},
                    "tags": ["baseline"],
                    "history": [
                        {"_step": 0, "_timestamp": 1778716800, "loss": 1.0, "ignored": "text"},
                        {"_step": 1, "_timestamp": 1778716801, "loss": 0.5},
                    ],
                    "artifacts": [{"name": "model.pt", "uri": "wandb://run-1/model.pt"}],
                }
            ],
        },
        source_type="wandb",
        target_project="target-project",
    )

    assert len(chunks) == 1
    chunk = chunks[0]
    assert chunk["schema_version"] == 2
    assert chunk["source_project"] == "source-project"
    assert chunk["target_project"] == "target-project"
    assert chunk["runs"][0]["source_run_id"] == "run-1"
    assert chunk["runs"][0]["config"]["token"] == "[REDACTED]"
    assert [point["key"] for point in chunk["metric_points"]] == ["loss", "loss"]
    assert chunk["artifact_refs"][0]["source_run_id"] == "run-1"
    assert chunk["final"] is True
    assert len(chunk["content_hash"]) == 64


def test_upload_chunks_creates_job_sets_server_hash_and_commits(monkeypatch):
    calls: list[tuple[str, str, dict | None]] = []

    class FakeClient:
        def __init__(self, *, base_url, timeout, api_key):
            self.base_url = base_url
            self.timeout = timeout
            self.api_key = api_key

        def _request(self, method, path, body=None, idempotency_key=None):
            calls.append((method, path, body))
            if path == "/api/imports/jobs":
                return {"job": {"id": 42, "status": "created"}}
            if path.endswith("/commit"):
                return {"job": {"id": 42, "status": "committed"}}
            return {"job": {"id": 42, "status": "uploading"}, "chunk": body}

    monkeypatch.setattr(importers, "Client", FakeClient)

    result = importers.upload_chunks(
        source_type="wandb",
        source_project="entity/project",
        target_project="target-project",
        chunks=[
            importers.canonical_chunk(
                source_type="wandb",
                source_project="entity/project",
                target_project="target-project",
                job_id=0,
                chunk_id="chunk-0",
                sequence=0,
                runs=[{"source_run_id": "run-1", "name": "candidate"}],
                metric_points=[],
            )
        ],
        base_url="http://example.test",
        api_key="instantml_test",
    )

    assert result["job"]["status"] == "committed"
    assert calls[0] == (
        "POST",
        "/api/imports/jobs",
        {
            "schema_version": 2,
            "source_type": "wandb",
            "source_project": "entity/project",
            "target_project": "target-project",
        },
    )
    assert calls[1][0] == "POST"
    assert calls[1][1] == "/api/imports/jobs/42/chunks"
    assert calls[1][2]["job_id"] == 42
    assert calls[1][2]["final"] is True
    assert calls[1][2]["content_hash"] == ""
    assert calls[2] == ("POST", "/api/imports/jobs/42/commit", None)


def test_upload_chunks_can_leave_job_uncommitted(monkeypatch):
    calls: list[tuple[str, str, dict | None]] = []

    class FakeClient:
        def __init__(self, *, base_url, timeout, api_key):
            del base_url, timeout, api_key

        def _request(self, method, path, body=None, idempotency_key=None):
            del idempotency_key
            calls.append((method, path, body))
            if path == "/api/imports/jobs":
                return {"job": {"id": 42, "status": "created"}}
            return {"job": {"id": 42, "status": "uploading"}, "chunk": body}

    monkeypatch.setattr(importers, "Client", FakeClient)

    result = importers.upload_chunks(
        source_type="tensorboard",
        source_project="runs/tb",
        target_project="target",
        chunks=[
            importers.canonical_chunk(
                source_type="tensorboard",
                source_project="runs/tb",
                target_project="target",
                job_id=0,
                chunk_id="chunk-0",
                sequence=0,
                runs=[],
                metric_points=[],
            )
        ],
        commit=False,
        api_key="instantml_test",
    )

    assert result["job"]["status"] == "uploading"
    assert [call[1] for call in calls] == ["/api/imports/jobs", "/api/imports/jobs/42/chunks"]


def test_upload_chunks_streams_multiple_chunks_and_marks_only_last_final(monkeypatch):
    calls: list[tuple[str, str, dict | None]] = []

    class FakeClient:
        def __init__(self, *, base_url, timeout, api_key):
            del base_url, timeout, api_key

        def _request(self, method, path, body=None, idempotency_key=None):
            del idempotency_key
            calls.append((method, path, body))
            if path == "/api/imports/jobs":
                return {"job": {"id": 44, "status": "created"}}
            if path.endswith("/commit"):
                return {"job": {"id": 44, "status": "committed"}}
            return {"job": {"id": 44, "status": "uploading"}, "chunk": body}

    monkeypatch.setattr(importers, "Client", FakeClient)

    result = importers.upload_chunks(
        source_type="wandb",
        source_project="source",
        target_project="target",
        chunks=(
            {"schema_version": 2, "chunk_id": f"chunk-{index}", "final": False}
            for index in range(2)
        ),
        api_key="instantml_test",
    )

    assert result["job"]["status"] == "committed"
    assert calls[1][2]["final"] is False
    assert calls[2][2]["final"] is True


def test_upload_chunks_accepts_empty_dry_run(monkeypatch):
    calls: list[tuple[str, str, dict | None]] = []

    class FakeClient:
        def __init__(self, *, base_url, timeout, api_key):
            del base_url, timeout, api_key

        def _request(self, method, path, body=None, idempotency_key=None):
            del idempotency_key
            calls.append((method, path, body))
            return {"job": {"id": 43, "status": "created"}}

    monkeypatch.setattr(importers, "Client", FakeClient)

    result = importers.upload_chunks(
        source_type="wandb",
        source_project="source",
        target_project="target",
        chunks=[],
        commit=False,
        api_key="instantml_test",
    )

    assert result == {"job": {"id": 43, "status": "created"}}
    assert calls[0] == (
        "POST",
        "/api/imports/jobs",
        {
            "schema_version": 2,
            "source_type": "wandb",
            "source_project": "source",
            "target_project": "target",
        },
    )
    assert calls[1][0] == "POST"
    assert calls[1][1] == "/api/imports/jobs/43/chunks"
    assert calls[1][2]["final"] is True
    assert calls[1][2]["runs"] == []
    assert calls[1][2]["metric_points"] == []


def test_chunks_from_transformed_json_records_invalid_runs_key_value_metrics_and_splits():
    chunks = importers.chunks_from_transformed_json(
        {
            "project": "source-project",
            "runs": [
                "not-a-run",
                {
                    "run_id": "run-2",
                    "metrics": [
                        "not-a-point",
                        {"key": "loss", "value": "bad", "step": "bad-step"},
                        {"_step": "not-finite", "acc": 0.9, "nan": float("nan"), "_runtime": 1.2},
                    ],
                },
            ],
        },
        source_type="neptune",
        target_project="target",
        chunk_metric_limit=2,
    )

    assert len(chunks) == 1
    assert chunks[0]["warnings"] == [
        {"code": "invalid_run", "message": "Skipped non-object run at index 0"},
        {"code": "invalid_metric_value", "message": "Skipped non-numeric metric at run run-2, row 1"},
    ]
    assert chunks[0]["metric_points"] == [
        {"source_run_id": "run-2", "key": "acc", "step": 2.0, "value": 0.9, "timestamp": None},
    ]
    assert chunks[0]["final"] is True


def test_chunks_from_transformed_json_splits_key_value_metric_rows():
    chunks = importers.chunks_from_transformed_json(
        {"project": "source", "runs": [{"id": "run-1", "metrics": [{"key": "a", "value": 1.0}, {"key": "b", "value": 2.0}]}]},
        source_type="neptune",
        target_project="target",
        chunk_metric_limit=2,
    )

    assert len(chunks) == 2
    assert [point["key"] for point in chunks[0]["metric_points"]] == ["a", "b"]
    assert chunks[1]["final"] is True


def test_chunks_from_transformed_json_splits_wandb_history_rows():
    chunks = importers.chunks_from_transformed_json(
        {"project": "source", "runs": [{"id": "run-1", "history": [{"loss": 1.0}, {"loss": 0.5}]}]},
        source_type="wandb",
        target_project="target",
        chunk_metric_limit=1,
    )

    assert [chunk["sequence"] for chunk in chunks] == [0, 1, 2]
    assert chunks[0]["metric_points"][0]["value"] == 1.0
    assert chunks[1]["metric_points"][0]["value"] == 0.5
    assert chunks[2]["final"] is True


def test_import_transformed_json_uploads_loaded_payload(tmp_path, monkeypatch):
    payload_path = tmp_path / "wandb.json"
    payload_path.write_text(
        json.dumps({"project": "source", "runs": [{"id": "run-1", "history": [{"loss": 1.0}]}]}),
        encoding="utf-8",
    )
    captured = {}

    def fake_upload_chunks(**kwargs):
        captured.update(kwargs)
        return {"job": {"status": "dry_run_ready"}}

    monkeypatch.setattr(importers, "upload_chunks", fake_upload_chunks)

    result = importers.import_transformed_json(
        source_type="wandb",
        input_path=payload_path,
        target_project="target",
        api_key="instantml_test",
        dry_run=True,
    )

    assert result["job"]["status"] == "dry_run_ready"
    assert captured["source_type"] == "wandb"
    assert captured["source_project"] == "source"
    assert captured["target_project"] == "target"
    assert captured["commit"] is False
    assert captured["chunks"][0]["runs"][0]["source_run_id"] == "run-1"


def test_load_json_payload_requires_object(tmp_path):
    payload_path = tmp_path / "bad.json"
    payload_path.write_text("[]", encoding="utf-8")

    with pytest.raises(Exception, match="object payload"):
        importers.load_json_payload(payload_path)


def test_export_wandb_project_reads_runs_and_artifact_refs(monkeypatch):
    class FakeFile:
        def __init__(self, name):
            self.name = name

    class FakeRun:
        id = "wb-run"
        name = "candidate"
        state = "finished"
        config = {"lr": 0.1}
        tags = ["baseline"]
        path = ["entity", "project", "wb-run"]
        summary = {"best": 0.9}

        def scan_history(self):
            return [{"_step": 0, "loss": 1.0}]

        def files(self):
            return [FakeFile("model.pt"), FakeFile(None)]

    class FakeApi:
        def runs(self, path):
            assert path == "entity/project"
            return [FakeRun(), FakeRun()]

    monkeypatch.setitem(sys.modules, "wandb", SimpleNamespace(Api=lambda: FakeApi()))

    payload = importers.export_wandb_project("entity", "project", limit=1)

    assert payload == {
        "project": "project",
        "runs": [
            {
                "id": "wb-run",
                "name": "candidate",
                "state": "finished",
                "config": {"lr": 0.1},
                "tags": ["baseline"],
                "metadata": {"entity": "entity", "project": "project", "path": ["entity", "project", "wb-run"]},
                "summary": {"best": 0.9},
                "history": [{"_step": 0, "loss": 1.0}],
                "artifacts": [{"name": "model.pt", "uri": "wandb://wb-run/model.pt", "type": "file"}],
            }
        ],
    }


def test_chunks_from_wandb_project_streams_unique_sequences(monkeypatch):
    class FakeRun:
        def __init__(self, run_id, history):
            self.id = run_id
            self.name = run_id
            self.state = "finished"
            self.config = {}
            self.tags = []
            self.path = ["entity", "project", run_id]
            self._history = history

        def scan_history(self):
            return iter(self._history)

        def files(self):
            return []

    class FakeApi:
        def runs(self, path):
            assert path == "entity/project"
            return [
                FakeRun("run-1", [{"_step": 0, "loss": 1.0}, {"_step": 1, "loss": 0.5}]),
                FakeRun("run-2", [{"_step": 0, "loss": 0.25}]),
            ]

    monkeypatch.setitem(sys.modules, "wandb", SimpleNamespace(Api=lambda: FakeApi()))

    chunks = list(
        importers.chunks_from_wandb_project(
            "entity",
            "project",
            target_project="target",
            chunk_metric_limit=1,
        )
    )

    assert [chunk["sequence"] for chunk in chunks] == [0, 1, 2]
    assert [chunk["chunk_id"] for chunk in chunks] == ["chunk-0", "chunk-1", "chunk-2"]
    assert chunks[0]["runs"][0]["source_run_id"] == "run-1"
    assert chunks[1]["runs"] == []
    assert chunks[2]["runs"][0]["source_run_id"] == "run-2"


def test_chunks_from_wandb_project_handles_limit_and_pending_final(monkeypatch):
    class FakeRun:
        id = "run-final"
        name = "run-final"
        state = "finished"
        config = {}
        tags = []
        path = ["entity", "project", "run-final"]

        def scan_history(self):
            return iter(["bad-row", {"_step": 2, "loss": 0.5}])

        def files(self):
            return []

    class FakeApi:
        def runs(self, path):
            assert path == "entity/project"
            return [FakeRun()]

    monkeypatch.setitem(sys.modules, "wandb", SimpleNamespace(Api=lambda: FakeApi()))

    assert list(importers.chunks_from_wandb_project("entity", "project", target_project="target", limit=0)) == []
    chunks = list(
        importers.chunks_from_wandb_project(
            "entity",
            "project",
            target_project="target",
            chunk_metric_limit=10,
        )
    )

    assert len(chunks) == 1
    assert chunks[0]["sequence"] == 0
    assert chunks[0]["metric_points"] == [
        {"source_run_id": "run-final", "key": "loss", "step": 2.0, "value": 0.5, "timestamp": None}
    ]


def test_chunks_from_wandb_project_requires_optional_dependency(monkeypatch):
    real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__

    def missing_wandb(name, *args, **kwargs):
        if name == "wandb":
            raise ImportError("no wandb")
        return real_import(name, *args, **kwargs)

    monkeypatch.delitem(sys.modules, "wandb", raising=False)
    monkeypatch.setattr("builtins.__import__", missing_wandb)

    with pytest.raises(InstantMLError, match="W&B import"):
        list(importers.chunks_from_wandb_project("entity", "project", target_project="target"))


def test_export_wandb_project_requires_optional_dependency(monkeypatch):
    real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__

    def missing_wandb(name, *args, **kwargs):
        if name == "wandb":
            raise ImportError("no wandb")
        return real_import(name, *args, **kwargs)

    monkeypatch.delitem(sys.modules, "wandb", raising=False)
    monkeypatch.setattr("builtins.__import__", missing_wandb)

    with pytest.raises(InstantMLError, match="W&B import"):
        importers.export_wandb_project("entity", "project")


def test_neptune_exporter_payload_reads_parquet_and_file_refs(tmp_path):
    pyarrow = pytest.importorskip("pyarrow")
    import pyarrow.parquet as pq

    data_dir = tmp_path / "data" / "workspace-project-abcd"
    files_dir = tmp_path / "files" / "workspace-project-abcd"
    data_dir.mkdir(parents=True)
    files_dir.mkdir(parents=True)
    (files_dir / "model.pt").write_text("weights", encoding="utf-8")
    rows = [
        {
            "project_id": "workspace/project",
            "run_id": "RUN-1",
            "attribute_path": "sys/name",
            "attribute_type": "string",
            "step": None,
            "timestamp": None,
            "int_value": None,
            "float_value": None,
            "string_value": "Experiment A",
            "bool_value": None,
            "datetime_value": None,
            "string_set_value": None,
            "file_value": None,
        },
        {
            "project_id": "workspace/project",
            "run_id": "RUN-1",
            "attribute_path": "sys/tags",
            "attribute_type": "string_set",
            "step": None,
            "timestamp": None,
            "int_value": None,
            "float_value": None,
            "string_value": None,
            "bool_value": None,
            "datetime_value": None,
            "string_set_value": ["production", "baseline"],
            "file_value": None,
        },
        {
            "project_id": "workspace/project",
            "run_id": "RUN-1",
            "attribute_path": "config/lr",
            "attribute_type": "float",
            "step": None,
            "timestamp": None,
            "int_value": None,
            "float_value": 0.1,
            "string_value": None,
            "bool_value": None,
            "datetime_value": None,
            "string_set_value": None,
            "file_value": None,
        },
        {
            "project_id": "workspace/project",
            "run_id": "RUN-1",
            "attribute_path": "config/enabled",
            "attribute_type": "bool",
            "step": None,
            "timestamp": None,
            "int_value": None,
            "float_value": None,
            "string_value": None,
            "bool_value": True,
            "datetime_value": None,
            "string_set_value": None,
            "file_value": None,
        },
        {
            "project_id": "workspace/project",
            "run_id": "RUN-1",
            "attribute_path": "sys/state",
            "attribute_type": "string",
            "step": None,
            "timestamp": None,
            "int_value": None,
            "float_value": None,
            "string_value": "FAILED",
            "bool_value": None,
            "datetime_value": None,
            "string_set_value": None,
            "file_value": None,
        },
        {
            "project_id": "workspace/project",
            "run_id": "RUN-1",
            "attribute_path": "sys/owner",
            "attribute_type": "string",
            "step": None,
            "timestamp": None,
            "int_value": None,
            "float_value": None,
            "string_value": "alice",
            "bool_value": None,
            "datetime_value": None,
            "string_set_value": None,
            "file_value": None,
        },
        {
            "project_id": "workspace/project",
            "run_id": "RUN-1",
            "attribute_path": "config/epochs",
            "attribute_type": "int",
            "step": None,
            "timestamp": None,
            "int_value": 3,
            "float_value": None,
            "string_value": None,
            "bool_value": None,
            "datetime_value": None,
            "string_set_value": None,
            "file_value": None,
        },
        {
            "project_id": "workspace/project",
            "run_id": "RUN-1",
            "attribute_path": "config/started",
            "attribute_type": "datetime",
            "step": None,
            "timestamp": None,
            "int_value": None,
            "float_value": None,
            "string_value": None,
            "bool_value": None,
            "datetime_value": datetime(2026, 5, 30, tzinfo=timezone.utc),
            "string_set_value": None,
            "file_value": None,
        },
        {
            "project_id": "workspace/project",
            "run_id": "RUN-1",
            "attribute_path": "config/name",
            "attribute_type": "string",
            "step": None,
            "timestamp": None,
            "int_value": None,
            "float_value": None,
            "string_value": "candidate",
            "bool_value": None,
            "datetime_value": None,
            "string_set_value": None,
            "file_value": None,
        },
        {
            "project_id": "workspace/project",
            "run_id": "RUN-1",
            "attribute_path": "metrics/loss",
            "attribute_type": "float_series",
            "step": 1.0,
            "timestamp": datetime(2026, 5, 30, tzinfo=timezone.utc),
            "int_value": None,
            "float_value": 0.25,
            "string_value": None,
            "bool_value": None,
            "datetime_value": None,
            "string_set_value": None,
            "file_value": None,
        },
        {
            "project_id": "workspace/project",
            "run_id": "RUN-1",
            "attribute_path": "files/model",
            "attribute_type": "file",
            "step": None,
            "timestamp": None,
            "int_value": None,
            "float_value": None,
            "string_value": None,
            "bool_value": None,
            "datetime_value": None,
            "string_set_value": None,
            "file_value": {"path": "workspace-project-abcd/model.pt"},
        },
        {
            "project_id": "workspace/project",
            "run_id": "RUN-1",
            "attribute_path": "files/log",
            "attribute_type": "file_series",
            "step": 2.0,
            "timestamp": None,
            "int_value": None,
            "float_value": None,
            "string_value": None,
            "bool_value": None,
            "datetime_value": None,
            "string_set_value": None,
            "file_value": {"path": "workspace-project-abcd/log.txt"},
        },
        {
            "project_id": "workspace/project",
            "run_id": "RUN-1",
            "attribute_path": "files/bad",
            "attribute_type": "file",
            "step": None,
            "timestamp": None,
            "int_value": None,
            "float_value": None,
            "string_value": None,
            "bool_value": None,
            "datetime_value": None,
            "string_set_value": None,
            "file_value": {"path": "../secret.txt"},
        },
        {
            "project_id": "workspace/project",
            "run_id": "RUN-1",
            "attribute_path": "",
            "attribute_type": "",
            "step": None,
            "timestamp": None,
            "int_value": None,
            "float_value": None,
            "string_value": None,
            "bool_value": None,
            "datetime_value": None,
            "string_set_value": None,
            "file_value": None,
        },
    ]
    pq.write_table(pyarrow.Table.from_pylist(rows), data_dir / "RUN-1_part_0.parquet")

    payload = importers.neptune_exporter_payload(tmp_path / "data", files_path=tmp_path / "files")

    assert payload["project"] == "workspace/project"
    run = payload["runs"][0]
    assert run["name"] == "Experiment A"
    assert run["status"] == "failed"
    assert run["config"] == {
        "config/lr": 0.1,
        "config/enabled": True,
        "config/epochs": 3,
        "config/started": "2026-05-30T00:00:00+00:00",
        "config/name": "candidate",
    }
    assert run["metadata"]["neptune"]["sys/owner"] == "alice"
    assert "production" in run["tags"]
    assert run["metrics"] == [
        {
            "key": "metrics/loss",
            "step": 1.0,
            "value": 0.25,
            "timestamp": "2026-05-30T00:00:00+00:00",
        }
    ]
    assert run["artifacts"] == [
        {
            "name": "model.pt",
            "type": "file",
            "uri": (tmp_path / "files" / "workspace-project-abcd" / "model.pt").as_uri(),
            "metadata": {"neptune_attribute_path": "files/model"},
        },
        {
            "name": "log.txt",
            "type": "file",
            "uri": (tmp_path / "files" / "workspace-project-abcd" / "log.txt").as_uri(),
            "metadata": {"neptune_attribute_path": "files/log"},
            "step": 2.0,
        },
    ]

    chunks = list(importers.chunks_from_neptune_exporter(data_dir / "RUN-1_part_0.parquet", target_project="target"))
    assert chunks[0]["source_type"] == "neptune"
    metric_chunks = [chunk for chunk in chunks if chunk["metric_points"]]
    assert metric_chunks[0]["metric_points"][0]["key"] == "metrics/loss"
    assert chunks[0]["artifact_refs"][0]["uri"].startswith("neptune-export://")


def test_neptune_exporter_payload_rejects_missing_unsafe_and_missing_pyarrow(monkeypatch, tmp_path):
    with pytest.raises(InstantMLError, match="does not exist"):
        importers.neptune_exporter_payload(tmp_path / "missing")

    symlink_root = tmp_path / "symlink-root"
    real_root = tmp_path / "real-root"
    real_root.mkdir()
    try:
        symlink_root.symlink_to(real_root)
    except (OSError, NotImplementedError):
        symlink_root = None
    if symlink_root is not None:
        with pytest.raises(InstantMLError, match="must not be a symlink"):
            importers.neptune_exporter_payload(symlink_root)

    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(InstantMLError, match="does not contain parquet"):
        importers.neptune_exporter_payload(empty)

    unsafe = tmp_path / "unsafe"
    unsafe.mkdir()
    target = tmp_path / "target.parquet"
    target.write_bytes(b"not parquet")
    symlink = unsafe / "link.parquet"
    try:
        symlink.symlink_to(target)
    except (OSError, NotImplementedError):
        symlink = None
    if symlink is not None:
        with pytest.raises(InstantMLError, match="Unsafe Neptune parquet"):
            importers.neptune_exporter_payload(unsafe)

    real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__

    def missing_pyarrow(name, *args, **kwargs):
        if name.startswith("pyarrow"):
            raise ImportError("no pyarrow")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", missing_pyarrow)
    pyarrow_missing = tmp_path / "pyarrow-missing"
    pyarrow_missing.mkdir()
    (pyarrow_missing / "part-0.parquet").write_bytes(b"not parquet")
    with pytest.raises(InstantMLError, match="pyarrow"):
        importers.neptune_exporter_payload(pyarrow_missing)


def test_chunks_from_neptune_exporter_rejects_missing_unsafe_and_missing_pyarrow(monkeypatch, tmp_path):
    with pytest.raises(InstantMLError, match="does not exist"):
        list(importers.chunks_from_neptune_exporter(tmp_path / "missing", target_project="target"))

    symlink_root = tmp_path / "symlink-root"
    real_root = tmp_path / "real-root"
    real_root.mkdir()
    try:
        symlink_root.symlink_to(real_root)
    except (OSError, NotImplementedError):
        symlink_root = None
    if symlink_root is not None:
        with pytest.raises(InstantMLError, match="must not be a symlink"):
            list(importers.chunks_from_neptune_exporter(symlink_root, target_project="target"))

    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(InstantMLError, match="does not contain parquet"):
        list(importers.chunks_from_neptune_exporter(empty, target_project="target"))

    unsafe = tmp_path / "unsafe"
    unsafe.mkdir()
    target = tmp_path / "target.parquet"
    target.write_bytes(b"not parquet")
    symlink = unsafe / "link.parquet"
    try:
        symlink.symlink_to(target)
    except (OSError, NotImplementedError):
        symlink = None
    if symlink is not None:
        with pytest.raises(InstantMLError, match="Unsafe Neptune parquet"):
            list(importers.chunks_from_neptune_exporter(unsafe, target_project="target"))

    real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__

    def missing_pyarrow(name, *args, **kwargs):
        if name.startswith("pyarrow"):
            raise ImportError("no pyarrow")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", missing_pyarrow)
    pyarrow_missing = tmp_path / "pyarrow-missing"
    pyarrow_missing.mkdir()
    (pyarrow_missing / "part-0.parquet").write_bytes(b"not parquet")
    with pytest.raises(InstantMLError, match="pyarrow"):
        list(importers.chunks_from_neptune_exporter(pyarrow_missing, target_project="target"))


def test_chunks_from_neptune_exporter_streams_metrics_and_skips_bad_values(tmp_path):
    pyarrow = pytest.importorskip("pyarrow")
    import pyarrow.parquet as pq

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    rows = [
        {
            "project_id": "workspace/project",
            "run_id": "RUN-1",
            "attribute_path": "sys/name",
            "attribute_type": "string",
            "step": None,
            "timestamp": None,
            "int_value": None,
            "float_value": None,
            "string_value": "Experiment A",
            "bool_value": None,
            "datetime_value": None,
            "string_set_value": None,
            "file_value": None,
        },
        {
            "project_id": "workspace/project",
            "run_id": "RUN-1",
            "attribute_path": "metrics/loss",
            "attribute_type": "float_series",
            "step": 1,
            "timestamp": datetime(2026, 5, 30, tzinfo=timezone.utc),
            "int_value": None,
            "float_value": 0.4,
            "string_value": None,
            "bool_value": None,
            "datetime_value": None,
            "string_set_value": None,
            "file_value": None,
        },
        {
            "project_id": "workspace/project",
            "run_id": "RUN-1",
            "attribute_path": "metrics/loss",
            "attribute_type": "float_series",
            "step": 2,
            "timestamp": datetime(2026, 5, 30, tzinfo=timezone.utc),
            "int_value": None,
            "float_value": 0.2,
            "string_value": None,
            "bool_value": None,
            "datetime_value": None,
            "string_set_value": None,
            "file_value": None,
        },
        {
            "project_id": "workspace/project",
            "run_id": "RUN-1",
            "attribute_path": "metrics/bad",
            "attribute_type": "float_series",
            "step": 3,
            "timestamp": None,
            "int_value": None,
            "float_value": float("nan"),
            "string_value": None,
            "bool_value": None,
            "datetime_value": None,
            "string_set_value": None,
            "file_value": None,
        },
    ]
    pq.write_table(pyarrow.Table.from_pylist(rows), data_dir / "RUN-1_part_0.parquet")

    chunks = list(importers.chunks_from_neptune_exporter(data_dir, target_project="target", chunk_metric_limit=1))

    assert [chunk["sequence"] for chunk in chunks] == [0, 1, 2, 3]
    assert chunks[0]["runs"][0]["name"] == "Experiment A"
    assert [chunk["metric_points"][0]["value"] for chunk in chunks[1:3]] == [0.4, 0.2]
    assert chunks[3]["final"] is True
    assert chunks[3]["metric_points"] == []


def test_neptune_helper_edge_cases(tmp_path):
    assert importers._neptune_file_path(SimpleNamespace(path="safe/model.pt")) == "safe/model.pt"
    assert importers._neptune_file_path({"path": ""}) is None
    assert importers._neptune_file_path(object()) is None
    assert importers._safe_file_uri(tmp_path / "files", "../outside.txt") == "neptune-export://../outside.txt"
    assert importers._iso_or_none(None) is None
    assert importers._iso_or_none("already-iso") == "already-iso"


def test_wandb_artifact_refs_swallow_file_listing_errors():
    class BrokenRun:
        id = "broken"

        def files(self):
            raise RuntimeError("wandb api unavailable")

    assert importers._wandb_artifact_refs(BrokenRun()) == []


def test_tensorboard_logdir_payload_reads_scalar_events(monkeypatch, tmp_path):
    class FakeAccumulator:
        def __init__(self, path):
            self.path = path

        def Reload(self):
            self.reloaded = True

        def Tags(self):
            return {"scalars": ["train/loss"], "tensors": ["eval/acc"]}

        def Scalars(self, tag):
            assert tag == "train/loss"
            return [SimpleNamespace(step=1, value=0.25, wall_time=1778716800.0)]

        def Tensors(self, tag):
            assert tag == "eval/acc"
            return [
                SimpleNamespace(
                    step=2,
                    wall_time=1778716801.0,
                    tensor_proto=SimpleNamespace(float_val=[0.75]),
                )
            ]

    module = types.ModuleType("tensorboard.backend.event_processing.event_accumulator")
    module.EventAccumulator = FakeAccumulator
    monkeypatch.setitem(sys.modules, "tensorboard", types.ModuleType("tensorboard"))
    monkeypatch.setitem(sys.modules, "tensorboard.backend", types.ModuleType("tensorboard.backend"))
    monkeypatch.setitem(sys.modules, "tensorboard.backend.event_processing", types.ModuleType("tensorboard.backend.event_processing"))
    monkeypatch.setitem(sys.modules, "tensorboard.backend.event_processing.event_accumulator", module)

    logdir = tmp_path / "trial-1"
    logdir.mkdir()
    (logdir / "events.out.tfevents.test").write_text("", encoding="utf-8")
    payload = importers.tensorboard_logdir_payload(logdir, run_name="display-name")

    assert payload["project"] == "trial-1"
    assert payload["runs"][0]["name"] == "display-name"
    assert payload["runs"][0]["metrics"] == [
        {"key": "train/loss", "step": 1.0, "value": 0.25, "timestamp": 1778716800.0},
        {"key": "eval/acc", "step": 2.0, "value": 0.75, "timestamp": 1778716801.0},
    ]


def test_tensor_scalar_value_handles_content_and_empty_values():
    import struct

    assert importers._tensor_scalar_value(None) is None
    assert importers._tensor_scalar_value(SimpleNamespace(tensor_content=struct.pack("<f", 0.5), dtype=1)) == pytest.approx(0.5)
    assert importers._tensor_scalar_value(SimpleNamespace(tensor_content=struct.pack("<d", 0.25), dtype=2)) == pytest.approx(0.25)
    assert importers._tensor_scalar_value(SimpleNamespace(tensor_content=b"", dtype=1)) is None


def test_tensorboard_event_dirs_finds_nested_and_empty_logdirs(tmp_path):
    (tmp_path / "parent").mkdir()
    (tmp_path / "parent" / "events.out.tfevents.root").write_text("", encoding="utf-8")
    nested = tmp_path / "parent" / "child"
    nested.mkdir(parents=True)
    (nested / "events.out.tfevents.test").write_text("", encoding="utf-8")
    nested_only = tmp_path / "nested-only" / "child"
    nested_only.mkdir(parents=True)
    (nested_only / "events.out.tfevents.test").write_text("", encoding="utf-8")
    empty = tmp_path / "empty"
    empty.mkdir()

    assert importers._tensorboard_event_dirs(tmp_path / "parent") == [tmp_path / "parent", nested]
    assert importers._tensorboard_event_dirs(tmp_path / "nested-only") == [nested_only]
    assert importers._tensorboard_event_dirs(empty) == [empty]


def test_tensorboard_logdir_payload_requires_optional_dependency(monkeypatch):
    real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__

    def missing_tensorboard(name, *args, **kwargs):
        if name.startswith("tensorboard"):
            raise ImportError("no tensorboard")
        return real_import(name, *args, **kwargs)

    for name in list(sys.modules):
        if name.startswith("tensorboard"):
            monkeypatch.delitem(sys.modules, name, raising=False)
    monkeypatch.setattr("builtins.__import__", missing_tensorboard)

    with pytest.raises(InstantMLError, match="TensorBoard sync"):
        importers.tensorboard_logdir_payload("runs/tb")
