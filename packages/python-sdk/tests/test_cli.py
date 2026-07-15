"""Tests for instantml.cli — device-code login, credential resolution, and helpers."""

from __future__ import annotations

import json
import os
import stat
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, call, patch

import pytest

import instantml.cli as cli_module
from instantml.cli import (
    _ApiError,
    _parse_toml_simple,
    _post,
    cmd_login,
    cmd_logout,
    cmd_whoami,
    delete_credentials,
    load_credentials,
    resolve_api_key_from_credentials,
    write_credentials,
)
from instantml.client import Client, InstantMLError, _check_credentials_or_raise


# ---------------------------------------------------------------------------
# TOML parser
# ---------------------------------------------------------------------------


def test_parse_toml_simple_handles_quoted_strings():
    text = """
# comment
api_key = "instantml_XXXX"
api_host = 'https://app.example.com'
org_id = "abc-123"
user_email = "alice@example.com"
"""
    result = _parse_toml_simple(text)
    assert result["api_key"] == "instantml_XXXX"
    assert result["api_host"] == "https://app.example.com"
    assert result["org_id"] == "abc-123"
    assert result["user_email"] == "alice@example.com"


def test_parse_toml_simple_handles_unquoted_values():
    text = "api_key = secret\norg_id = 42\n"
    result = _parse_toml_simple(text)
    assert result["api_key"] == "secret"
    assert result["org_id"] == "42"


def test_parse_toml_simple_ignores_comments_and_blank_lines():
    text = "\n# This is a comment\n\napi_key = \"mykey\"\n"
    result = _parse_toml_simple(text)
    assert list(result.keys()) == ["api_key"]


def test_parse_toml_simple_returns_empty_for_empty_input():
    assert _parse_toml_simple("") == {}


def test_parse_toml_simple_handles_equals_in_value():
    text = 'api_key = "instantml_abc=def"\n'
    result = _parse_toml_simple(text)
    assert result["api_key"] == "instantml_abc=def"


# ---------------------------------------------------------------------------
# load_credentials / write_credentials / delete_credentials
# ---------------------------------------------------------------------------


def test_load_credentials_returns_empty_dict_when_no_file(tmp_path, monkeypatch):
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", tmp_path / "credentials")
    result = load_credentials()
    assert result == {}


def test_write_and_load_credentials_roundtrip(tmp_path, monkeypatch):
    cred_path = tmp_path / "credentials"
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", cred_path)

    write_credentials(
        api_key="instantml_SECRET",
        api_host="https://app.instantml.ai",
        org_id="org-uuid",
        user_email="alice@example.com",
    )

    assert cred_path.exists()
    creds = load_credentials()
    assert creds["api_key"] == "instantml_SECRET"
    assert creds["api_host"] == "https://app.instantml.ai"
    assert creds["org_id"] == "org-uuid"
    assert creds["user_email"] == "alice@example.com"


def test_write_credentials_sets_mode_0600(tmp_path, monkeypatch):
    cred_path = tmp_path / "credentials"
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", cred_path)
    write_credentials("key", "host", "org", "user@example.com")
    mode = stat.S_IMODE(cred_path.stat().st_mode)
    assert mode == 0o600, f"expected 0600, got {oct(mode)}"


def test_delete_credentials_removes_file(tmp_path, monkeypatch):
    cred_path = tmp_path / "credentials"
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", cred_path)
    write_credentials("key", "host", "org", "user@example.com")
    assert delete_credentials() is True
    assert not cred_path.exists()


def test_delete_credentials_returns_false_when_no_file(tmp_path, monkeypatch):
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", tmp_path / "credentials")
    assert delete_credentials() is False


def test_resolve_api_key_from_credentials(tmp_path, monkeypatch):
    cred_path = tmp_path / "credentials"
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", cred_path)
    monkeypatch.chdir(tmp_path)
    assert resolve_api_key_from_credentials() is None
    write_credentials("instantml_MY_KEY", "host", "org", "user@example.com")
    assert resolve_api_key_from_credentials() == "instantml_MY_KEY"


def test_local_init_writes_config_and_project_credentials(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", tmp_path / "global" / "credentials")

    cli_module.cmd_local(
        [
            "init",
            "--root",
            str(tmp_path),
            "--api-host",
            "http://127.0.0.1:8123",
            "--web-host",
            "http://127.0.0.1:3001",
        ]
    )

    config = cli_module.local_config_path(tmp_path)
    creds = cli_module.local_credentials_path(tmp_path)
    assert config.exists()
    assert creds.exists()
    assert cli_module._parse_toml_simple(config.read_text(encoding="utf-8")) == {
        "api_host": "http://127.0.0.1:8123",
        "web_host": "http://127.0.0.1:3001",
        "compose_file": "docker-compose.yml",
        "service": "instantml",
    }
    assert cli_module.load_local_credentials(tmp_path)["api_key"] == "local"
    assert stat.S_IMODE(creds.stat().st_mode) == 0o600
    assert "instantml local up" in capsys.readouterr().out


def test_local_init_rejects_non_loopback_api_host(tmp_path, capsys):
    with pytest.raises(SystemExit):
        cli_module.cmd_local(
            ["init", "--root", str(tmp_path), "--api-host", "http://0.0.0.0:8000"]
        )
    # No local credentials should have been written for a non-loopback host.
    assert not cli_module.local_credentials_path(tmp_path).exists()
    assert "loopback" in capsys.readouterr().err


def test_local_init_allows_non_loopback_host_without_credentials(tmp_path, capsys):
    cli_module.cmd_local(
        [
            "init",
            "--root",
            str(tmp_path),
            "--api-host",
            "http://0.0.0.0:8000",
            "--no-credentials",
        ]
    )
    assert cli_module.local_config_path(tmp_path).exists()
    assert not cli_module.local_credentials_path(tmp_path).exists()


def test_local_credentials_take_precedence_over_global_login(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    global_path = tmp_path / "global-credentials"
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", global_path)
    write_credentials("hosted-key", "https://api.instantml.ai", "org", "user@example.com")
    cli_module.write_local_credentials(api_host="http://127.0.0.1:8000", root=tmp_path)

    assert cli_module.load_effective_credentials()["api_key"] == "local"
    assert cli_module.resolve_api_key_from_credentials() == "local"
    assert cli_module.resolve_api_host_from_credentials() == "http://127.0.0.1:8000"


def test_local_credentials_suppress_auth_only_for_loopback(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("INSTANTML_API_KEY", raising=False)
    monkeypatch.delenv("INSTANTML_API_BASE_URL", raising=False)
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", tmp_path / "global" / "credentials")
    cli_module.write_local_credentials(api_host="http://127.0.0.1:8000", root=tmp_path)

    assert Client(base_url="http://127.0.0.1:8000", api_key=None)._resolve_api_key() is None
    _check_credentials_or_raise(None, "http://127.0.0.1:8000")
    with pytest.raises(InstantMLError, match="InstantML credentials"):
        Client(base_url="https://api.instantml.ai", api_key=None)._resolve_api_key()
    with pytest.raises(InstantMLError, match="InstantML credentials"):
        _check_credentials_or_raise(None, "https://api.instantml.ai")
    with pytest.raises(InstantMLError, match="InstantML credentials"):
        _check_credentials_or_raise("local", "https://api.instantml.ai")
    monkeypatch.setenv("INSTANTML_API_KEY", "local")
    with pytest.raises(InstantMLError, match="InstantML credentials"):
        Client(base_url="https://api.instantml.ai", api_key=None)._resolve_api_key()
    with pytest.raises(InstantMLError, match="InstantML credentials"):
        _check_credentials_or_raise(None, "https://api.instantml.ai")


def test_default_base_url_uses_project_local_credentials(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("INSTANTML_API_BASE_URL", raising=False)
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", tmp_path / "global" / "credentials")
    cli_module.write_local_credentials(api_host="http://127.0.0.1:8123", root=tmp_path)

    assert Client(api_key=None).base_url == "http://127.0.0.1:8123"


def test_run_compose_uses_configured_compose_file(tmp_path, monkeypatch):
    captured = {}
    compose_file = tmp_path / "compose.dev.yml"
    compose_file.write_text("services: {}\n", encoding="utf-8")

    monkeypatch.setattr(cli_module, "_compose_command", lambda: ["docker", "compose"])

    def fake_run(command, cwd=None):
        captured["command"] = command
        captured["cwd"] = cwd
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(cli_module.subprocess, "run", fake_run)

    rc = cli_module._run_compose(tmp_path, {"compose_file": "compose.dev.yml"}, ["up", "-d", "instantml"])

    assert rc == 0
    assert captured == {
        "command": ["docker", "compose", "-f", str(compose_file), "up", "-d", "instantml"],
        "cwd": tmp_path,
    }


def test_compose_command_falls_back_to_legacy_binary(monkeypatch):
    calls = []

    def fake_succeeds(command):
        calls.append(command)
        return command == ["docker-compose", "version"]

    monkeypatch.setattr(cli_module, "_command_succeeds", fake_succeeds)

    assert cli_module._compose_command() == ["docker-compose"]
    assert calls == [["docker", "compose", "version"], ["docker-compose", "version"]]


def test_cmd_import_transformed_json_dispatch(monkeypatch):
    from instantml import importers

    captured = {}
    printed = []

    def fake_import_transformed_json(**kwargs):
        captured.update(kwargs)
        return {"job": {"id": 7, "status": "dry_run_ready"}}

    monkeypatch.setattr(importers, "import_transformed_json", fake_import_transformed_json)
    monkeypatch.setattr(cli_module, "_print_import_result", lambda result: printed.append(result))

    cli_module.cmd_import(
        [
            "neptune",
            "--project",
            "target-project",
            "--input",
            "neptune.json",
            "--source-project",
            "workspace/project",
            "--api-host",
            "http://api.example",
            "--dry-run",
        ]
    )

    assert captured == {
        "source_type": "neptune",
        "input_path": "neptune.json",
        "target_project": "target-project",
        "source_project": "workspace/project",
        "base_url": "http://api.example",
        "dry_run": True,
    }
    assert printed == [{"job": {"id": 7, "status": "dry_run_ready"}}]


def test_cmd_import_neptune_exporter_dispatch(monkeypatch, tmp_path):
    from instantml import importers

    data_dir = tmp_path / "data"
    files_dir = tmp_path / "files"
    data_dir.mkdir()
    files_dir.mkdir()
    captured = {}

    monkeypatch.setattr(importers, "chunks_from_neptune_exporter", lambda *args, **kwargs: [{"chunk_id": "chunk-0", "final": True}])

    def fake_upload_chunks(**kwargs):
        captured.update(kwargs)
        return {"job": {"id": 10, "status": "dry_run_ready"}}

    monkeypatch.setattr(importers, "upload_chunks", fake_upload_chunks)
    monkeypatch.setattr(cli_module, "_print_import_result", lambda result: None)

    cli_module.cmd_import(
        [
            "neptune",
            "--project",
            "target",
            "--input",
            str(data_dir),
            "--source-project",
            "workspace/source",
            "--files-path",
            str(files_dir),
            "--api-host",
            "http://api.example",
            "--dry-run",
        ]
    )

    assert captured == {
        "source_type": "neptune",
        "source_project": "workspace/source",
        "target_project": "target",
        "chunks": [{"chunk_id": "chunk-0", "final": True}],
        "base_url": "http://api.example",
        "commit": False,
    }


def test_cmd_import_wandb_direct_export_dispatch(monkeypatch):
    from instantml import importers

    calls = []
    monkeypatch.setattr(importers, "chunks_from_wandb_project", lambda *args, **kwargs: [{"chunk_id": "chunk-0", **kwargs}])

    def fake_upload_chunks(**kwargs):
        calls.append(kwargs)
        return {"job": {"id": 8, "status": "committed"}}

    monkeypatch.setattr(importers, "upload_chunks", fake_upload_chunks)
    monkeypatch.setattr(cli_module, "_print_import_result", lambda result: None)

    cli_module.cmd_import(
        [
            "wandb",
            "--project",
            "target",
            "--entity",
            "team",
            "--source-project",
            "source",
            "--limit",
            "5",
            "--api-host",
            "http://api.example",
        ]
    )

    assert calls == [
        {
                "source_type": "wandb",
                "source_project": "team/source",
                "target_project": "target",
                "chunks": [{"chunk_id": "chunk-0", "target_project": "target", "limit": 5}],
                "base_url": "http://api.example",
                "commit": True,
            }
    ]


def test_cmd_sync_tensorboard_dispatch(monkeypatch):
    from instantml import importers

    captured = {}
    monkeypatch.setattr(importers, "tensorboard_logdir_payload", lambda logdir, run_name=None: {"project": "tb", "runs": [{"id": run_name}]})
    monkeypatch.setattr(importers, "chunks_from_transformed_json", lambda payload, **kwargs: [{"chunk_id": "chunk-0"}])

    def fake_upload_chunks(**kwargs):
        captured.update(kwargs)
        return {"job": {"id": 9, "status": "dry_run_ready"}}

    monkeypatch.setattr(importers, "upload_chunks", fake_upload_chunks)
    monkeypatch.setattr(cli_module, "_print_import_result", lambda result: None)

    cli_module.cmd_sync(
        [
            "tensorboard",
            "runs/tb",
            "--project",
            "target",
            "--run-name",
            "trial-1",
            "--api-host",
            "http://api.example",
            "--dry-run",
        ]
    )

    assert captured == {
        "source_type": "tensorboard",
        "source_project": "runs/tb",
        "target_project": "target",
        "chunks": [{"chunk_id": "chunk-0"}],
        "base_url": "http://api.example",
        "commit": False,
    }


def test_cmd_sync_tensorboard_existing_run_dispatch(monkeypatch):
    from instantml import importers

    requests = []
    monkeypatch.setattr(
        importers,
        "tensorboard_logdir_payload",
        lambda logdir, run_name=None: {
            "project": "tb",
            "runs": [{"metrics": [{"key": "loss", "step": 2.0, "value": 0.5, "timestamp": "2026-05-30T00:00:00Z"}]}],
        },
    )

    class FakeClient:
        def __init__(self, *, base_url):
            self.base_url = base_url

        def _request(self, method, path, body=None, idempotency_key=None):
            requests.append((self.base_url, method, path, body, idempotency_key))
            return {"ok": True}

    monkeypatch.setattr("instantml.client.Client", FakeClient)
    monkeypatch.setattr(cli_module, "_print_import_result", lambda result: requests.append(("printed", result)))

    cli_module.cmd_sync(
        [
            "tensorboard",
            "runs/tb",
            "--project",
            "target",
            "--run-id",
            "run-existing",
            "--api-host",
            "http://api.example",
            "--watch",
            "--max-sync-passes",
            "1",
        ]
    )

    assert requests[0] == (
        "http://api.example",
        "POST",
        "/runs/run-existing/metrics",
        {
            "metrics": {"loss": 0.5},
            "step": 2.0,
            "timestamp": "2026-05-30T00:00:00Z",
            "preview": False,
            "preview_completion": 0.0,
        },
        None,
    )
    assert requests[1] == ("printed", {"job": {"id": "run-existing", "status": "synced"}, "summary": {"runs": 1, "metrics": 1, "artifacts": 0}})


def test_cmd_sync_tensorboard_existing_run_dry_run_does_not_write(monkeypatch):
    from instantml import importers

    requests = []
    monkeypatch.setattr(
        importers,
        "tensorboard_logdir_payload",
        lambda logdir, run_name=None: {
            "project": "tb",
            "runs": [{"metrics": [{"key": "loss", "step": 2.0, "value": 0.5, "timestamp": 1778716800.0}]}],
        },
    )

    class FakeClient:
        def __init__(self, *, base_url):
            raise AssertionError("dry-run must not create a client")

    monkeypatch.setattr("instantml.client.Client", FakeClient)
    monkeypatch.setattr(cli_module, "_print_import_result", lambda result: requests.append(("printed", result)))

    cli_module.cmd_sync(
        [
            "tensorboard",
            "runs/tb",
            "--project",
            "target",
            "--run-id",
            "run-existing",
            "--dry-run",
        ]
    )

    assert requests == [
        (
            "printed",
            {"job": {"id": "run-existing", "status": "dry_run_ready"}, "summary": {"runs": 1, "metrics": 1, "artifacts": 0}},
        )
    ]


def test_cmd_sync_tensorboard_rejects_run_id_for_multi_run_logdir(monkeypatch, capsys):
    from instantml import importers

    monkeypatch.setattr(
        importers,
        "tensorboard_logdir_payload",
        lambda logdir, run_name=None: {
            "project": "tb",
            "runs": [
                {"id": "a", "metrics": [{"key": "loss", "step": 1.0, "value": 0.5}]},
                {"id": "b", "metrics": [{"key": "loss", "step": 1.0, "value": 0.4}]},
            ],
        },
    )

    with pytest.raises(SystemExit):
        cli_module.cmd_sync(["tensorboard", "runs/tb", "--project", "target", "--run-id", "run-existing"])

    assert "requires a single TensorBoard run" in capsys.readouterr().err


def test_tensorboard_metric_batches_normalize_timestamps():
    batches = cli_module._tensorboard_metric_batches(
        [
            {"key": "loss", "step": 1.0, "value": 0.5, "timestamp": 1778716800.0},
            {"key": "acc", "step": 1.0, "value": 0.9, "timestamp": 1778716800.0},
            {"key": "lr", "step": 2.0, "value": 0.01, "timestamp": None},
        ]
    )

    assert batches == [
        {
            "step": 1.0,
            "timestamp": "2026-05-14T00:00:00Z",
            "metrics": {"loss": 0.5, "acc": 0.9},
        },
        {"step": 2.0, "timestamp": None, "metrics": {"lr": 0.01}},
    ]


def test_cmd_sync_tensorboard_watch_filters_duplicate_events(monkeypatch):
    from instantml import importers

    uploads = []
    printed = []
    monkeypatch.setattr(
        importers,
        "tensorboard_logdir_payload",
        lambda logdir, run_name=None: {
            "project": "tb",
            "runs": [{"metrics": [{"key": "loss", "step": 1.0, "value": 0.25, "timestamp": "2026-05-30T00:00:00Z"}]}],
        },
    )
    monkeypatch.setattr(importers, "chunks_from_transformed_json", lambda payload, **kwargs: [{"chunk_id": "chunk-0", "metrics": payload["runs"][0]["metrics"]}])

    def fake_upload_chunks(**kwargs):
        uploads.append(kwargs)
        return {"job": {"id": 11, "status": "committed"}, "summary": {"runs": 1, "metrics": 1, "artifacts": 0}}

    monkeypatch.setattr(importers, "upload_chunks", fake_upload_chunks)
    monkeypatch.setattr(cli_module, "_print_import_result", lambda result: printed.append(result))

    cli_module.cmd_sync(
        [
            "tensorboard",
            "runs/tb",
            "--project",
            "target",
            "--watch",
            "--watch-interval",
            "0.1",
            "--max-sync-passes",
            "2",
        ]
    )

    assert len(uploads) == 1
    assert uploads[0]["chunks"][0]["metrics"] == [{"key": "loss", "step": 1.0, "value": 0.25, "timestamp": "2026-05-30T00:00:00Z"}]
    assert printed[-1] == {"job": {"id": "runs/tb", "status": "synced"}, "summary": {"runs": 1, "metrics": 0, "artifacts": 0}}


def test_cmd_sync_tensorboard_watch_filters_each_run_independently(monkeypatch):
    from instantml import importers

    uploads = []
    monkeypatch.setattr(
        importers,
        "tensorboard_logdir_payload",
        lambda logdir, run_name=None: {
            "project": "tb",
            "runs": [
                {"id": "a", "metrics": [{"key": "loss", "step": 1.0, "value": 0.25, "timestamp": "2026-05-30T00:00:00Z"}]},
                {"id": "b", "metrics": [{"key": "loss", "step": 1.0, "value": 0.25, "timestamp": "2026-05-30T00:00:00Z"}]},
            ],
        },
    )
    monkeypatch.setattr(importers, "chunks_from_transformed_json", lambda payload, **kwargs: [{"chunk_id": "chunk-0", "runs": payload["runs"]}])

    def fake_upload_chunks(**kwargs):
        uploads.append(kwargs)
        return {"job": {"id": 11, "status": "committed"}, "summary": {"runs": 2, "metrics": 2, "artifacts": 0}}

    monkeypatch.setattr(importers, "upload_chunks", fake_upload_chunks)
    monkeypatch.setattr(cli_module, "_print_import_result", lambda result: None)

    cli_module.cmd_sync(["tensorboard", "runs/tb", "--project", "target", "--watch", "--max-sync-passes", "2"])

    assert len(uploads) == 1
    assert [len(run["metrics"]) for run in uploads[0]["chunks"][0]["runs"]] == [1, 1]


def test_cmd_sync_tensorboard_watch_handles_keyboard_interrupt(monkeypatch, capsys):
    from instantml import importers

    monkeypatch.setattr(
        importers,
        "tensorboard_logdir_payload",
        lambda logdir, run_name=None: {"project": "tb", "runs": [{"metrics": []}]},
    )
    monkeypatch.setattr(importers, "chunks_from_transformed_json", lambda payload, **kwargs: [{"chunk_id": "chunk-0"}])
    monkeypatch.setattr(
        importers,
        "upload_chunks",
        lambda **kwargs: {"job": {"id": 12, "status": "committed"}, "summary": {"runs": 1, "metrics": 0, "artifacts": 0}},
    )
    monkeypatch.setattr(cli_module.time, "sleep", lambda seconds: (_ for _ in ()).throw(KeyboardInterrupt()))

    cli_module.cmd_sync(["tensorboard", "runs/tb", "--project", "target", "--watch"])

    assert "TensorBoard watch stopped." in capsys.readouterr().out


def test_cmd_import_reports_missing_required_source_arguments(capsys):
    with pytest.raises(SystemExit) as wandb_exc:
        cli_module.cmd_import(["wandb", "--project", "target"])
    assert wandb_exc.value.code == 1
    assert "W&B direct import requires" in capsys.readouterr().err

    with pytest.raises(SystemExit) as neptune_exc:
        cli_module.cmd_import(["neptune", "--project", "target"])
    assert neptune_exc.value.code == 1
    assert "requires --input" in capsys.readouterr().err


def test_cmd_import_reports_importer_errors(monkeypatch, capsys):
    from instantml import importers

    def fail_import(**kwargs):
        raise RuntimeError("source export failed")

    monkeypatch.setattr(importers, "import_transformed_json", fail_import)

    with pytest.raises(SystemExit) as exc_info:
        cli_module.cmd_import(["mlflow", "--project", "target", "--input", "payload.json"])

    assert exc_info.value.code == 1
    assert "source export failed" in capsys.readouterr().err


def test_cmd_sync_reports_importer_errors(monkeypatch, capsys):
    from instantml import importers

    monkeypatch.setattr(importers, "tensorboard_logdir_payload", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("bad logdir")))

    with pytest.raises(SystemExit) as exc_info:
        cli_module.cmd_sync(["tensorboard", "runs/tb", "--project", "target"])

    assert exc_info.value.code == 1
    assert "bad logdir" in capsys.readouterr().err


def test_print_import_result_formats_committed_summary(capsys):
    cli_module._print_import_result(
        {"job": {"id": 12, "status": "committed", "summary": {"runs": 2, "metrics": 10, "artifacts": 1}}}
    )

    output = capsys.readouterr().out
    assert "Import job complete." in output
    assert "job_id: 12" in output
    assert "metrics: 10" in output


def test_main_dispatches_import_and_sync(monkeypatch):
    calls = []
    monkeypatch.setattr(cli_module, "cmd_import", lambda rest: calls.append(("import", rest)))
    monkeypatch.setattr(cli_module, "cmd_sync", lambda rest: calls.append(("sync", rest)))

    cli_module.main(["import", "wandb"])
    cli_module.main(["sync", "tensorboard"])

    assert calls == [("import", ["wandb"]), ("sync", ["tensorboard"])]


# ---------------------------------------------------------------------------
# Credential resolution order in Client._resolve_api_key
# ---------------------------------------------------------------------------


def test_resolve_api_key_kwarg_wins_over_everything(tmp_path, monkeypatch):
    cred_path = tmp_path / "credentials"
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", cred_path)
    monkeypatch.chdir(tmp_path)
    write_credentials("from_file", "host", "org", "user@example.com")
    monkeypatch.setenv("INSTANTML_API_KEY", "from_env")

    client = Client(api_key="from_kwarg")
    assert client._resolve_api_key() == "from_kwarg"


def test_resolve_api_key_env_wins_over_file(tmp_path, monkeypatch):
    cred_path = tmp_path / "credentials"
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", cred_path)
    monkeypatch.chdir(tmp_path)
    write_credentials("from_file", "host", "org", "user@example.com")
    monkeypatch.setenv("INSTANTML_API_KEY", "from_env")

    client = Client(api_key=None)
    assert client._resolve_api_key() == "from_env"


def test_resolve_api_key_file_used_when_no_kwarg_or_env(tmp_path, monkeypatch):
    cred_path = tmp_path / "credentials"
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", cred_path)
    monkeypatch.chdir(tmp_path)
    write_credentials("from_file", "host", "org", "user@example.com")
    monkeypatch.delenv("INSTANTML_API_KEY", raising=False)

    client = Client(api_key=None)
    assert client._resolve_api_key() == "from_file"


def test_resolve_api_key_returns_none_when_nothing_set(tmp_path, monkeypatch):
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", tmp_path / "credentials")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("INSTANTML_API_KEY", raising=False)

    client = Client(api_key=None)
    assert client._resolve_api_key() is None


# ---------------------------------------------------------------------------
# logout command
# ---------------------------------------------------------------------------


def test_cmd_logout_removes_credentials(tmp_path, monkeypatch, capsys):
    cred_path = tmp_path / "credentials"
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", cred_path)
    write_credentials("key", "host", "org", "user@example.com")
    cmd_logout()
    assert not cred_path.exists()
    captured = capsys.readouterr()
    assert "removed" in captured.out.lower() or str(cred_path) in captured.out


def test_cmd_logout_prints_message_when_no_file(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", tmp_path / "credentials")
    cmd_logout()
    captured = capsys.readouterr()
    assert "no credentials" in captured.out.lower()


# ---------------------------------------------------------------------------
# whoami command
# ---------------------------------------------------------------------------


def test_cmd_whoami_prints_credentials(tmp_path, monkeypatch, capsys):
    cred_path = tmp_path / "credentials"
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", cred_path)
    write_credentials("instantml_SECRET", "https://app.instantml.ai", "org-123", "alice@example.com")
    cmd_whoami()
    captured = capsys.readouterr()
    assert "org-123" in captured.out
    assert "alice@example.com" in captured.out
    # Key should be truncated, not shown in full.
    assert "instantml_SECRET" not in captured.out
    assert "instantml_" in captured.out  # prefix shown


def test_cmd_whoami_exits_when_not_logged_in(tmp_path, monkeypatch):
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", tmp_path / "credentials")
    with pytest.raises(SystemExit) as exc_info:
        cmd_whoami()
    assert exc_info.value.code == 1


# ---------------------------------------------------------------------------
# login command — mocked HTTP flow
# ---------------------------------------------------------------------------


def _make_start_response(user_code: str = "ABCD-EFGH") -> dict[str, Any]:
    return {
        "device_code": "test_device_code_opaque",
        "user_code": user_code,
        "verification_uri": "http://localhost:3000/auth/device",
        "verification_uri_complete": f"http://localhost:3000/auth/device?code={user_code}",
        "expires_in": 900,
        "interval": 1,
    }


def _make_pending_response() -> dict[str, Any]:
    return {"status": "pending"}


def _make_authorized_response() -> dict[str, Any]:
    return {
        "status": "authorized",
        "api_key": {
            "plaintext": "instantml_MYAPIKEY",
            "prefix": "instantml_MYAP",
            "id": "00000000-0000-0000-0000-000000000001",
        },
        "org": {"id": "00000000-0000-0000-0000-000000000002", "name": "Test Org", "slug": "test-org"},
        "user": {"primary_email": "alice@example.com", "display_name": "Alice"},
    }


def test_cmd_login_success_flow(tmp_path, monkeypatch):
    """Happy path: start -> pending -> authorized -> writes credentials."""
    cred_path = tmp_path / "credentials"
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", cred_path)
    monkeypatch.setattr(cli_module, "_POLL_TIMEOUT_SECS", 30)

    call_count = [0]

    def fake_post(host: str, path: str, body: dict, timeout: float = 10.0) -> dict:
        call_count[0] += 1
        if path == "/api/auth/device-code/start":
            return _make_start_response()
        if path == "/api/auth/device-code/poll":
            if call_count[0] <= 2:
                return _make_pending_response()
            return _make_authorized_response()
        raise AssertionError(f"Unexpected path: {path}")

    monkeypatch.setattr(cli_module, "_post", fake_post)
    monkeypatch.setattr(cli_module, "time", SimpleNamespace(
        sleep=lambda _: None,
        monotonic=lambda: 0.0,
    ))

    # Suppress webbrowser.open.
    import webbrowser
    monkeypatch.setattr(webbrowser, "open", lambda url: None)

    cmd_login(api_host="http://localhost:8001")

    creds = load_credentials()
    assert creds["api_key"] == "instantml_MYAPIKEY"
    assert creds["org_id"] == "00000000-0000-0000-0000-000000000002"
    assert creds["user_email"] == "alice@example.com"
    assert creds["api_host"] == "http://localhost:8001"


def test_cmd_login_expired_exits_with_error(tmp_path, monkeypatch):
    """If the device code expires before confirmation, exit with code 1."""
    cred_path = tmp_path / "credentials"
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", cred_path)
    monkeypatch.setattr(cli_module, "_POLL_TIMEOUT_SECS", 5)

    # Monotonic time that immediately exceeds the deadline.
    times = iter([0.0, 1000.0])

    def fake_post(host, path, body, timeout=10.0):
        if path == "/api/auth/device-code/start":
            return _make_start_response()
        return {"status": "expired"}

    monkeypatch.setattr(cli_module, "_post", fake_post)
    monkeypatch.setattr(cli_module, "time", SimpleNamespace(
        sleep=lambda _: None,
        monotonic=lambda: next(times),
    ))
    import webbrowser
    monkeypatch.setattr(webbrowser, "open", lambda url: None)

    with pytest.raises(SystemExit) as exc_info:
        cmd_login(api_host="http://localhost:8001")
    assert exc_info.value.code == 1
    assert not cred_path.exists()


def test_cmd_login_denied_exits_with_error(tmp_path, monkeypatch):
    """If the device code is denied, exit with code 1."""
    cred_path = tmp_path / "credentials"
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", cred_path)
    monkeypatch.setattr(cli_module, "_POLL_TIMEOUT_SECS", 30)

    call_count = [0]

    def fake_post(host, path, body, timeout=10.0):
        if path == "/api/auth/device-code/start":
            return _make_start_response()
        return {"status": "denied"}

    monkeypatch.setattr(cli_module, "_post", fake_post)
    monkeypatch.setattr(cli_module, "time", SimpleNamespace(
        sleep=lambda _: None,
        monotonic=lambda: 0.0,
    ))
    import webbrowser
    monkeypatch.setattr(webbrowser, "open", lambda url: None)

    with pytest.raises(SystemExit) as exc_info:
        cmd_login(api_host="http://localhost:8001")
    assert exc_info.value.code == 1


def test_cmd_login_slow_down_increases_interval(tmp_path, monkeypatch):
    """slow_down response causes the interval to grow."""
    cred_path = tmp_path / "credentials"
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", cred_path)
    monkeypatch.setattr(cli_module, "_POLL_TIMEOUT_SECS", 30)

    intervals_seen = []
    poll_count = [0]

    original_sleep = time.sleep

    def fake_sleep(secs):
        intervals_seen.append(secs)

    def fake_post(host, path, body, timeout=10.0):
        if path == "/api/auth/device-code/start":
            return {"device_code": "dc", "user_code": "ABCD-EFGH",
                    "verification_uri": "http://localhost:3000/auth/device",
                    "verification_uri_complete": "http://localhost:3000/auth/device?code=ABCD-EFGH",
                    "expires_in": 900, "interval": 1}
        poll_count[0] += 1
        if poll_count[0] == 1:
            raise _ApiError(429, "slow_down", "polling too fast")
        return _make_authorized_response()

    monkeypatch.setattr(cli_module, "_post", fake_post)
    monkeypatch.setattr(cli_module, "time", SimpleNamespace(
        sleep=fake_sleep,
        monotonic=lambda: 0.0,
    ))
    import webbrowser
    monkeypatch.setattr(webbrowser, "open", lambda url: None)

    cmd_login(api_host="http://localhost:8001")
    # After slow_down, interval should have grown.
    assert len(intervals_seen) >= 2
    assert intervals_seen[-1] > intervals_seen[0]


def test_cmd_login_start_failure_exits_with_error(tmp_path, monkeypatch):
    """Network failure on /start prints error and exits with code 1."""
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", tmp_path / "credentials")

    def fake_post(host, path, body, timeout=10.0):
        raise _ApiError(0, "network_error", "connection refused")

    monkeypatch.setattr(cli_module, "_post", fake_post)

    with pytest.raises(SystemExit) as exc_info:
        cmd_login(api_host="http://localhost:8001")
    assert exc_info.value.code == 1


def test_cmd_login_keyboard_interrupt_exits_cleanly(tmp_path, monkeypatch):
    """Ctrl+C during polling exits with code 1 and does not write credentials."""
    cred_path = tmp_path / "credentials"
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", cred_path)
    monkeypatch.setattr(cli_module, "_POLL_TIMEOUT_SECS", 30)

    def fake_post(host, path, body, timeout=10.0):
        if path == "/api/auth/device-code/start":
            return _make_start_response()
        raise KeyboardInterrupt

    monkeypatch.setattr(cli_module, "_post", fake_post)
    monkeypatch.setattr(cli_module, "time", SimpleNamespace(
        sleep=lambda _: None,
        monotonic=lambda: 0.0,
    ))
    import webbrowser
    monkeypatch.setattr(webbrowser, "open", lambda url: None)

    with pytest.raises(SystemExit) as exc_info:
        cmd_login(api_host="http://localhost:8001")
    assert exc_info.value.code == 1
    assert not cred_path.exists()


# ---------------------------------------------------------------------------
# main() entrypoint dispatch
# ---------------------------------------------------------------------------


def test_main_login_dispatches_to_cmd_login(monkeypatch):
    called = []

    def fake_login(api_host=cli_module._DEFAULT_API_HOST):
        called.append(("login", api_host))

    monkeypatch.setattr(cli_module, "cmd_login", fake_login)
    cli_module.main(["login"])
    assert called == [("login", cli_module._DEFAULT_API_HOST)]


def test_main_login_accepts_api_host_flag(monkeypatch):
    called = []

    def fake_login(api_host=cli_module._DEFAULT_API_HOST):
        called.append(api_host)

    monkeypatch.setattr(cli_module, "cmd_login", fake_login)
    cli_module.main(["login", "--api-host", "https://app.example.com"])
    assert called == ["https://app.example.com"]


def test_main_logout_dispatches_to_cmd_logout(monkeypatch):
    called = []
    monkeypatch.setattr(cli_module, "cmd_logout", lambda: called.append("logout"))
    cli_module.main(["logout"])
    assert called == ["logout"]


def test_main_whoami_dispatches_to_cmd_whoami(monkeypatch):
    called = []
    monkeypatch.setattr(cli_module, "cmd_whoami", lambda: called.append("whoami"))
    cli_module.main(["whoami"])
    assert called == ["whoami"]


def test_main_unknown_subcommand_exits_with_error():
    with pytest.raises(SystemExit) as exc_info:
        cli_module.main(["unknown-subcommand"])
    assert exc_info.value.code == 1


def test_main_help_prints_usage(capsys):
    cli_module.main(["--help"])
    captured = capsys.readouterr()
    assert "login" in captured.out
    assert "logout" in captured.out
    assert "whoami" in captured.out


def test_main_no_args_prints_help(capsys):
    cli_module.main([])
    captured = capsys.readouterr()
    assert "login" in captured.out


def test_sdk_version_returns_unknown_when_metadata_is_unavailable():
    with patch("importlib.metadata.version", side_effect=RuntimeError("missing metadata")):
        assert cli_module._sdk_version() == "unknown"


# ---------------------------------------------------------------------------
# credentials_path
# ---------------------------------------------------------------------------


def test_credentials_path_returns_path():
    """credentials_path() should return a Path object (line 29)."""
    from instantml.cli import credentials_path
    result = credentials_path()
    assert hasattr(result, "exists")  # it's a Path


# ---------------------------------------------------------------------------
# load_credentials — exception fallback (lines 43-44)
# ---------------------------------------------------------------------------


def test_load_credentials_returns_empty_on_corrupt_file(tmp_path, monkeypatch):
    """When the credentials file cannot be parsed, return {} (lines 43-44)."""
    cred_path = tmp_path / "credentials"
    cred_path.write_text("\x00\x01\x02 not valid toml\x00", encoding="latin-1")
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", cred_path)
    # Simulate a read error by monkeypatching _parse_toml_simple to raise.
    monkeypatch.setattr(cli_module, "_parse_toml_simple", lambda _: (_ for _ in ()).throw(ValueError("bad")))
    result = load_credentials()
    assert result == {}


# ---------------------------------------------------------------------------
# _parse_toml_simple — line without "=" (line 97)
# ---------------------------------------------------------------------------


def test_parse_toml_simple_skips_lines_without_equals():
    """Lines without '=' are skipped (line 97)."""
    text = "not_a_key_value_line\napi_key = \"mykey\"\n"
    result = _parse_toml_simple(text)
    assert result == {"api_key": "mykey"}


# ---------------------------------------------------------------------------
# _post — direct tests to cover lines 116-137
# ---------------------------------------------------------------------------


def test_post_success(monkeypatch):
    """_post returns parsed JSON on a 200 response (lines 116-125)."""
    import io
    from unittest.mock import MagicMock

    fake_resp = MagicMock()
    fake_resp.read.return_value = json.dumps({"ok": True}).encode("utf-8")
    fake_resp.__enter__ = lambda s: s
    fake_resp.__exit__ = MagicMock(return_value=False)

    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=10: fake_resp)
    result = _post("http://localhost:8001", "/api/test", {"x": 1})
    assert result == {"ok": True}


def test_post_http_error_with_json_body(monkeypatch):
    """HTTPError with a JSON body raises _ApiError with parsed fields (lines 126-135)."""
    import io
    import urllib.error

    err_body = json.dumps({"code": "not_found", "error": "Not found"}).encode("utf-8")
    http_error = urllib.error.HTTPError(
        url="http://localhost/test",
        code=404,
        msg="Not Found",
        hdrs=None,  # type: ignore[arg-type]
        fp=io.BytesIO(err_body),
    )

    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=10: (_ for _ in ()).throw(http_error))
    with pytest.raises(_ApiError) as exc_info:
        _post("http://localhost:8001", "/api/test", {})
    assert exc_info.value.status == 404
    assert exc_info.value.code == "not_found"
    assert exc_info.value.message == "Not found"


def test_post_http_error_with_non_json_body(monkeypatch):
    """HTTPError with non-JSON body falls back to str(exc) (lines 132-134)."""
    import io
    import urllib.error

    http_error = urllib.error.HTTPError(
        url="http://localhost/test",
        code=500,
        msg="Internal Server Error",
        hdrs=None,  # type: ignore[arg-type]
        fp=io.BytesIO(b"<html>error</html>"),
    )

    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=10: (_ for _ in ()).throw(http_error))
    with pytest.raises(_ApiError) as exc_info:
        _post("http://localhost:8001", "/api/test", {})
    assert exc_info.value.status == 500
    assert exc_info.value.code == ""


def test_post_url_error_raises_api_error(monkeypatch):
    """URLError (network failure) raises _ApiError with status 0 (lines 136-137)."""
    import urllib.error

    url_error = urllib.error.URLError("connection refused")
    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=10: (_ for _ in ()).throw(url_error))
    with pytest.raises(_ApiError) as exc_info:
        _post("http://localhost:8001", "/api/test", {})
    assert exc_info.value.status == 0
    assert exc_info.value.code == "network_error"


# ---------------------------------------------------------------------------
# cmd_login — missing device_code / user_code (line 173)
# ---------------------------------------------------------------------------


def test_cmd_login_missing_device_code_exits(tmp_path, monkeypatch):
    """Server response without device_code/user_code causes exit (line 173)."""
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", tmp_path / "credentials")

    def fake_post(host, path, body, timeout=10.0):
        if path == "/api/auth/device-code/start":
            return {"verification_uri": "http://localhost/auth", "expires_in": 900, "interval": 1}
        raise AssertionError("should not poll")

    monkeypatch.setattr(cli_module, "_post", fake_post)

    with pytest.raises(SystemExit) as exc_info:
        cmd_login(api_host="http://localhost:8001")
    assert exc_info.value.code == 1


# ---------------------------------------------------------------------------
# cmd_login — browser open failure (lines 189-190)
# ---------------------------------------------------------------------------


def test_cmd_login_browser_open_failure_continues(tmp_path, monkeypatch):
    """If webbrowser.open raises, print fallback message and continue (lines 189-190)."""
    cred_path = tmp_path / "credentials"
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", cred_path)
    monkeypatch.setattr(cli_module, "_POLL_TIMEOUT_SECS", 30)

    call_count = [0]

    def fake_post(host, path, body, timeout=10.0):
        call_count[0] += 1
        if path == "/api/auth/device-code/start":
            return _make_start_response()
        return _make_authorized_response()

    monkeypatch.setattr(cli_module, "_post", fake_post)
    monkeypatch.setattr(cli_module, "time", SimpleNamespace(
        sleep=lambda _: None,
        monotonic=lambda: 0.0,
    ))

    import webbrowser
    monkeypatch.setattr(webbrowser, "open", lambda url: (_ for _ in ()).throw(OSError("no browser")))

    # Should succeed despite browser open failure.
    cmd_login(api_host="http://localhost:8001")
    assert cred_path.exists()


# ---------------------------------------------------------------------------
# cmd_login — non-slow_down poll error warning (lines 213-214)
# ---------------------------------------------------------------------------


def test_cmd_login_poll_error_non_slow_down_retries(tmp_path, monkeypatch, capsys):
    """Non-slow_down _ApiError during polling prints warning and retries (lines 213-214)."""
    cred_path = tmp_path / "credentials"
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", cred_path)
    monkeypatch.setattr(cli_module, "_POLL_TIMEOUT_SECS", 30)

    poll_count = [0]

    def fake_post(host, path, body, timeout=10.0):
        if path == "/api/auth/device-code/start":
            return _make_start_response()
        poll_count[0] += 1
        if poll_count[0] == 1:
            raise _ApiError(503, "server_error", "service unavailable")
        return _make_authorized_response()

    monkeypatch.setattr(cli_module, "_post", fake_post)
    monkeypatch.setattr(cli_module, "time", SimpleNamespace(
        sleep=lambda _: None,
        monotonic=lambda: 0.0,
    ))
    import webbrowser
    monkeypatch.setattr(webbrowser, "open", lambda url: None)

    cmd_login(api_host="http://localhost:8001")
    captured = capsys.readouterr()
    assert "warning" in captured.out.lower() or "poll error" in captured.out.lower()
    assert cred_path.exists()


# ---------------------------------------------------------------------------
# cmd_login — expired status via poll response (line 225)
# ---------------------------------------------------------------------------


def test_cmd_login_poll_returns_expired_status(tmp_path, monkeypatch):
    """Poll returning 'expired' status triggers _die (line 225)."""
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", tmp_path / "credentials")
    monkeypatch.setattr(cli_module, "_POLL_TIMEOUT_SECS", 30)

    def fake_post(host, path, body, timeout=10.0):
        if path == "/api/auth/device-code/start":
            return _make_start_response()
        return {"status": "expired"}

    monkeypatch.setattr(cli_module, "_post", fake_post)
    monkeypatch.setattr(cli_module, "time", SimpleNamespace(
        sleep=lambda _: None,
        monotonic=lambda: 0.0,  # always before deadline
    ))
    import webbrowser
    monkeypatch.setattr(webbrowser, "open", lambda url: None)

    with pytest.raises(SystemExit) as exc_info:
        cmd_login(api_host="http://localhost:8001")
    assert exc_info.value.code == 1


# ---------------------------------------------------------------------------
# _handle_authorized — missing plaintext (line 245)
# ---------------------------------------------------------------------------


def test_handle_authorized_missing_plaintext_exits(tmp_path, monkeypatch):
    """When authorized response has no plaintext, _die is called (line 245)."""
    from instantml.cli import _handle_authorized

    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", tmp_path / "credentials")

    poll = {
        "status": "authorized",
        "api_key": {"id": "abc"},  # no 'plaintext'
        "org": {"id": "org-1", "name": "Org"},
        "user": {"primary_email": "alice@example.com"},
    }
    with pytest.raises(SystemExit) as exc_info:
        _handle_authorized(poll, "http://localhost:8001")
    assert exc_info.value.code == 1


# ---------------------------------------------------------------------------
# cmd_whoami — api_key not set (line 298)
# ---------------------------------------------------------------------------


def test_cmd_whoami_shows_not_set_when_no_api_key(tmp_path, monkeypatch, capsys):
    """When credentials have no api_key, prints '(not set)' (line 298)."""
    cred_path = tmp_path / "credentials"
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", cred_path)
    # Write a credentials file without api_key.
    cred_path.parent.mkdir(parents=True, exist_ok=True)
    cred_path.write_text('api_host = "http://localhost"\norg_id = "org-1"\nuser_email = "alice@example.com"\n')

    cmd_whoami()
    captured = capsys.readouterr()
    assert "(not set)" in captured.out


# ---------------------------------------------------------------------------
# main() with argv=None uses sys.argv (line 309)
# ---------------------------------------------------------------------------


def test_main_with_none_argv_reads_sys_argv(monkeypatch, capsys):
    """main(None) falls back to sys.argv[1:] (line 309)."""
    monkeypatch.setattr("sys.argv", ["instantml", "--help"])
    cli_module.main(None)
    captured = capsys.readouterr()
    assert "login" in captured.out


# ---------------------------------------------------------------------------
# main() login — unknown option (line 326)
# ---------------------------------------------------------------------------


def test_main_login_unknown_option_exits(monkeypatch):
    """Unknown flag in `login` subcommand calls _die (line 326)."""
    with pytest.raises(SystemExit) as exc_info:
        cli_module.main(["login", "--unknown-flag"])
    assert exc_info.value.code == 1


# ---------------------------------------------------------------------------
# client.py — _resolve_api_key exception branch (lines 359-360)
# ---------------------------------------------------------------------------


def test_resolve_api_key_handles_import_error(monkeypatch, tmp_path):
    """If the cli import inside _resolve_api_key fails, fall through to None (lines 359-360)."""
    import sys
    import instantml.cli as real_cli
    from instantml.client import Client

    monkeypatch.delenv("INSTANTML_API_KEY", raising=False)

    # Temporarily break the cli module so the import inside _resolve_api_key raises.
    saved = sys.modules.get("instantml.cli")
    sys.modules["instantml.cli"] = None  # type: ignore[assignment]
    try:
        client = Client(api_key=None)
        result = client._resolve_api_key()
        assert result is None
    finally:
        if saved is not None:
            sys.modules["instantml.cli"] = saved
        else:
            del sys.modules["instantml.cli"]


# ---------------------------------------------------------------------------
# client.py — _check_credentials_or_raise (lines 1171-1188)
# ---------------------------------------------------------------------------


def test_check_credentials_or_raise_explicit_key(monkeypatch):
    """With an explicit api_key, function returns immediately (line 1171-1172)."""
    from instantml.client import _check_credentials_or_raise
    # Should not raise.
    _check_credentials_or_raise("instantml_MYKEY")


def test_check_credentials_or_raise_env_key(monkeypatch):
    """With INSTANTML_API_KEY env var set, function returns (lines 1173-1174)."""
    from instantml.client import _check_credentials_or_raise
    monkeypatch.setenv("INSTANTML_API_KEY", "instantml_ENVKEY")
    _check_credentials_or_raise(None)  # should not raise


def test_check_credentials_or_raise_file_key(tmp_path, monkeypatch):
    """With credentials file present, function returns (lines 1175-1178)."""
    from instantml.client import _check_credentials_or_raise
    cred_path = tmp_path / "credentials"
    monkeypatch.setattr(cli_module, "_CREDENTIALS_PATH", cred_path)
    monkeypatch.delenv("INSTANTML_API_KEY", raising=False)
    write_credentials("instantml_FILEKEY", "http://localhost", "org-1", "user@example.com")
    _check_credentials_or_raise(None)  # should not raise


# Obsolete tests removed: previously tested silent-return / warn paths of
# _check_credentials_or_raise. PR #39 changed the helper to unconditionally
# raise InstantMLError when no credentials resolve. New behavior is covered
# by test_check_credentials_* in test_client.py.
