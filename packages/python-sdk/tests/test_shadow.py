"""Tests for the shadow-wandb dual-logging shim.

The real `wandb` package is not a runtime dep of this SDK, so these tests
install a fake `wandb` module into ``sys.modules`` to capture the calls the
shim would make in production.
"""

from __future__ import annotations

import sys
import threading
import warnings
from typing import Any
from unittest.mock import MagicMock

import pytest

from instantml import shadow
from instantml.shadow import ShadowWandb, build_shadow


class _FakeWandbConfig:
    def __init__(self) -> None:
        self.updates: list[tuple[dict[str, Any], dict[str, Any]]] = []

    def update(self, data: dict[str, Any], **kwargs: Any) -> None:
        self.updates.append((dict(data), kwargs))


class _FakeWandbRun:
    def __init__(self) -> None:
        self.logs: list[tuple[dict[str, Any], dict[str, Any]]] = []
        self.finish_calls: list[dict[str, Any]] = []
        self.artifacts: list[Any] = []
        self.config = _FakeWandbConfig()

    def log(self, data: dict[str, Any], **kwargs: Any) -> None:
        self.logs.append((dict(data), kwargs))

    def finish(self, **kwargs: Any) -> None:
        self.finish_calls.append(kwargs)

    def log_artifact(self, artifact: Any) -> None:
        self.artifacts.append(artifact)


class _FakeArtifact:
    def __init__(self, name: str, type: str) -> None:
        self.name = name
        self.type = type
        self.files: list[str] = []

    def add_file(self, path: str) -> None:
        self.files.append(path)


def _install_fake_wandb(monkeypatch: pytest.MonkeyPatch, fake_run: _FakeWandbRun, init_started: threading.Event | None = None, fail_init: bool = False) -> MagicMock:
    fake_wandb = MagicMock()
    fake_wandb.Artifact = _FakeArtifact

    def _init(**kwargs: Any) -> _FakeWandbRun:
        if init_started is not None:
            init_started.set()
        if fail_init:
            raise RuntimeError("boom")
        fake_run.init_kwargs = kwargs
        return fake_run

    fake_wandb.init = _init
    monkeypatch.setitem(sys.modules, "wandb", fake_wandb)
    return fake_wandb


def test_build_shadow_returns_none_when_disabled() -> None:
    assert build_shadow(False, project="p", name=None, config=None, tags=None, notes=None) is None
    assert build_shadow(None, project="p", name=None, config=None, tags=None, notes=None) is None
    assert build_shadow(0, project="p", name=None, config=None, tags=None, notes=None) is None


def test_shadow_init_true_mirrors_args_to_wandb_init(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_run = _FakeWandbRun()
    _install_fake_wandb(monkeypatch, fake_run)
    shim = build_shadow(True, project="myproj", name="myrun", config={"lr": 0.1}, tags=["smoke"], notes="hello")
    assert shim is not None
    assert shim.wait_for_init(timeout=2.0)
    assert fake_run.init_kwargs == {
        "project": "myproj",
        "name": "myrun",
        "config": {"lr": 0.1},
        "tags": ["smoke"],
        "notes": "hello",
    }


def test_shadow_init_dict_overrides_project_and_entity(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_run = _FakeWandbRun()
    _install_fake_wandb(monkeypatch, fake_run)
    shim = build_shadow(
        {"project": "wb-proj", "entity": "jays-team"},
        project="instantml-proj",
        name=None,
        config=None,
        tags=None,
        notes=None,
    )
    assert shim is not None
    assert shim.wait_for_init(timeout=2.0)
    assert fake_run.init_kwargs["project"] == "wb-proj"
    assert fake_run.init_kwargs["entity"] == "jays-team"


def test_shadow_init_attaches_to_existing_wandb_run() -> None:
    existing = _FakeWandbRun()
    shim = ShadowWandb(
        project="p", name=None, config=None, tags=None, notes=None, existing_run=existing
    )
    assert shim.wait_for_init(timeout=1.0)
    shim.log({"loss": 0.5}, step=1)
    assert existing.logs == [({"loss": 0.5}, {"step": 1})]


def test_build_shadow_with_object_treats_it_as_existing_run() -> None:
    existing = _FakeWandbRun()
    shim = build_shadow(existing, project="p", name=None, config=None, tags=None, notes=None)
    assert shim is not None
    assert shim.wait_for_init(timeout=1.0)
    shim.log({"loss": 0.5}, step=1)
    assert existing.logs == [({"loss": 0.5}, {"step": 1})]


def test_shadow_log_fans_metrics_with_step_coerced_to_int(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_run = _FakeWandbRun()
    _install_fake_wandb(monkeypatch, fake_run)
    shim = build_shadow(True, project="p", name=None, config=None, tags=None, notes=None)
    assert shim is not None
    shim.wait_for_init(timeout=2.0)
    shim.log({"loss": 0.2}, step=5.0)
    shim.log({"acc": 0.9}, step=5.5)
    shim.log({"only_data": 1.0})
    assert fake_run.logs[0] == ({"loss": 0.2}, {"step": 5})
    assert fake_run.logs[1] == ({"acc": 0.9}, {"step": 5.5})
    assert fake_run.logs[2] == ({"only_data": 1.0}, {})


def test_shadow_queues_log_calls_until_wandb_init_resolves(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_run = _FakeWandbRun()
    init_gate = threading.Event()
    init_release = threading.Event()
    fake_wandb = MagicMock()
    fake_wandb.Artifact = _FakeArtifact

    def _init(**kwargs: Any) -> _FakeWandbRun:
        init_gate.set()
        assert init_release.wait(timeout=2.0)
        return fake_run

    fake_wandb.init = _init
    monkeypatch.setitem(sys.modules, "wandb", fake_wandb)

    shim = build_shadow(True, project="p", name=None, config=None, tags=None, notes=None)
    assert shim is not None
    assert init_gate.wait(timeout=2.0)
    shim.log({"a": 1.0}, step=1)
    shim.log({"b": 2.0}, step=2)
    assert fake_run.logs == []
    init_release.set()
    assert shim.wait_for_init(timeout=2.0)
    for _ in range(50):
        if len(fake_run.logs) >= 2:
            break
        threading.Event().wait(0.01)
    assert fake_run.logs == [({"a": 1.0}, {"step": 1}), ({"b": 2.0}, {"step": 2})]


def test_shadow_drops_and_warns_when_init_queue_is_full(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_run = _FakeWandbRun()
    init_gate = threading.Event()
    init_release = threading.Event()
    fake_wandb = MagicMock()
    fake_wandb.Artifact = _FakeArtifact

    def _init(**kwargs: Any) -> _FakeWandbRun:
        init_gate.set()
        assert init_release.wait(timeout=2.0)
        return fake_run

    fake_wandb.init = _init
    monkeypatch.setitem(sys.modules, "wandb", fake_wandb)
    monkeypatch.setattr(shadow, "MAX_SHADOW_QUEUE_EVENTS", 1)

    shim = build_shadow(True, project="p", name=None, config=None, tags=None, notes=None)
    assert shim is not None
    assert init_gate.wait(timeout=2.0)
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        shim.log({"first": 1.0}, step=1)
        shim.log({"second": 2.0}, step=2)
        shim.log({"third": 3.0}, step=3)
    assert shim.dropped_events == 2
    assert sum("queue is full" in str(w.message) for w in captured) == 1
    init_release.set()
    assert shim.wait_for_init(timeout=2.0)
    for _ in range(50):
        if fake_run.logs:
            break
        threading.Event().wait(0.01)
    assert fake_run.logs == [({"first": 1.0}, {"step": 1})]


def test_shadow_warns_and_disables_when_wandb_not_installed(monkeypatch: pytest.MonkeyPatch) -> None:
    real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__

    def _missing(name: str, *args: Any, **kwargs: Any) -> Any:
        if name == "wandb":
            raise ImportError("no wandb in test env")
        return real_import(name, *args, **kwargs)

    monkeypatch.delitem(sys.modules, "wandb", raising=False)
    monkeypatch.setattr("builtins.__import__", _missing)
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        shim = build_shadow(True, project="p", name=None, config=None, tags=None, notes=None)
        assert shim is not None
        assert shim.wait_for_init(timeout=2.0)
        shim.log({"loss": 1.0}, step=1)
    assert shim.disabled
    assert any("wandb" in str(w.message) for w in captured)


def test_shadow_warns_and_disables_when_wandb_init_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_run = _FakeWandbRun()
    _install_fake_wandb(monkeypatch, fake_run, fail_init=True)
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        shim = build_shadow(True, project="p", name=None, config=None, tags=None, notes=None)
        assert shim is not None
        assert shim.wait_for_init(timeout=2.0)
    assert shim.disabled
    assert any("wandb.init" in str(w.message) for w in captured)


def test_shadow_finish_translates_status_to_exit_code(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_run = _FakeWandbRun()
    _install_fake_wandb(monkeypatch, fake_run)
    shim = build_shadow(True, project="p", name=None, config=None, tags=None, notes=None)
    assert shim is not None
    shim.wait_for_init(timeout=2.0)
    shim.finish(status="finished")
    shim.finish(status="failed")
    assert fake_run.finish_calls == [{"exit_code": 0}, {"exit_code": 1}]


def test_shadow_update_config_calls_run_config_update(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_run = _FakeWandbRun()
    _install_fake_wandb(monkeypatch, fake_run)
    shim = build_shadow(True, project="p", name=None, config=None, tags=None, notes=None)
    assert shim is not None
    shim.wait_for_init(timeout=2.0)
    shim.update_config({"lr": 0.01})
    assert fake_run.config.updates == [({"lr": 0.01}, {"allow_val_change": True})]


def test_shadow_log_artifact_file_wraps_in_wandb_artifact(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    fake_run = _FakeWandbRun()
    _install_fake_wandb(monkeypatch, fake_run)
    ckpt = tmp_path / "model.pt"
    ckpt.write_bytes(b"x")
    shim = build_shadow(True, project="p", name=None, config=None, tags=None, notes=None)
    assert shim is not None
    shim.wait_for_init(timeout=2.0)
    shim.log_artifact_file(str(ckpt), name="model-v1", artifact_type="checkpoint")
    assert len(fake_run.artifacts) == 1
    artifact = fake_run.artifacts[0]
    assert artifact.name == "model-v1"
    assert artifact.type == "checkpoint"
    assert artifact.files == [str(ckpt)]


def test_shadow_log_artifact_file_noop_when_disabled() -> None:
    existing = _FakeWandbRun()
    shim = ShadowWandb(
        project="p", name=None, config=None, tags=None, notes=None, existing_run=existing
    )
    shim._disabled = True
    shim.log_artifact_file("/nonexistent", name="x")
    assert existing.artifacts == []


def test_shadow_log_artifact_file_disables_when_wandb_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delitem(sys.modules, "wandb", raising=False)
    existing = _FakeWandbRun()
    shim = ShadowWandb(project="p", name=None, config=None, tags=None, notes=None, existing_run=existing)

    real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__

    def missing_wandb(name: str, *args: Any, **kwargs: Any) -> Any:
        if name == "wandb":
            raise ImportError("no wandb")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", missing_wandb)
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        shim.log_artifact_file("/tmp/model.pt", name="model")

    assert shim.disabled is True
    assert existing.artifacts == []
    assert any("artifact logging disabled" in str(w.message) for w in captured)


def test_shadow_log_artifact_file_swallows_wandb_failures(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    fake_run = _FakeWandbRun()
    fake_wandb = MagicMock()

    class _BrokenArtifact:
        def __init__(self, **kwargs: Any) -> None:
            raise RuntimeError("artifact broken")

    fake_wandb.Artifact = _BrokenArtifact

    def _init(**kwargs: Any) -> _FakeWandbRun:
        return fake_run

    fake_wandb.init = _init
    monkeypatch.setitem(sys.modules, "wandb", fake_wandb)
    shim = build_shadow(True, project="p", name=None, config=None, tags=None, notes=None)
    assert shim is not None
    shim.wait_for_init(timeout=2.0)
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        shim.log_artifact_file("/tmp/anything", name="x")
    assert any("Artifact" in str(w.message) for w in captured)
    assert fake_run.artifacts == []


def test_run_log_metrics_fans_out_to_shadow() -> None:
    from instantml.client import Client, Run

    existing = _FakeWandbRun()
    shim = ShadowWandb(project="p", name=None, config=None, tags=None, notes=None, existing_run=existing)
    calls: list[tuple[str, str, dict[str, Any]]] = []

    class _FakeClient(Client):
        def _request(self, method: str, path: str, body: Any = None, idempotency_key: Any = None) -> dict[str, Any]:
            calls.append((method, path, body))
            return {"artifact": {"id": "art-1", **(body or {})}}

    run = Run(client=_FakeClient(), run_id="run-1", shadow=shim)
    run.log_metrics({"loss": 0.5, "acc": 0.9}, step=3)
    assert existing.logs[0] == ({"loss": 0.5, "acc": 0.9}, {"step": 3})


def test_run_log_artifact_fans_out_local_file_to_shadow(tmp_path) -> None:
    from instantml.client import Client, Run

    ckpt = tmp_path / "model.pt"
    ckpt.write_bytes(b"x")
    existing = _FakeWandbRun()
    shim = ShadowWandb(project="p", name=None, config=None, tags=None, notes=None, existing_run=existing)

    class _FakeClient(Client):
        def _request(self, method: str, path: str, body: Any = None, idempotency_key: Any = None) -> dict[str, Any]:
            return {"artifact": {"id": "art-1", **(body or {})}}

    # Stub wandb.Artifact since log_artifact_file imports it directly.
    import sys
    fake_wandb = MagicMock()
    fake_wandb.Artifact = _FakeArtifact
    sys.modules["wandb"] = fake_wandb
    try:
        run = Run(client=_FakeClient(), run_id="run-1", shadow=shim)
        run.log_artifact(name="model-v1", uri=str(ckpt), artifact_type="checkpoint")
        assert len(existing.artifacts) == 1
        assert existing.artifacts[0].name == "model-v1"
        assert existing.artifacts[0].files == [str(ckpt)]
    finally:
        sys.modules.pop("wandb", None)


def test_run_log_artifact_skips_shadow_for_non_local_uri() -> None:
    from instantml.client import Client, Run

    existing = _FakeWandbRun()
    shim = ShadowWandb(project="p", name=None, config=None, tags=None, notes=None, existing_run=existing)

    class _FakeClient(Client):
        def _request(self, method: str, path: str, body: Any = None, idempotency_key: Any = None) -> dict[str, Any]:
            return {"artifact": {"id": "art-1", **(body or {})}}

    run = Run(client=_FakeClient(), run_id="run-1", shadow=shim)
    run.log_artifact(name="remote", uri="s3://bucket/key.tar")
    assert existing.artifacts == []


def test_run_finish_fans_out_to_shadow() -> None:
    from instantml.client import Client, Run

    existing = _FakeWandbRun()
    shim = ShadowWandb(project="p", name=None, config=None, tags=None, notes=None, existing_run=existing)

    class _FakeClient(Client):
        def _request(self, method: str, path: str, body: Any = None, idempotency_key: Any = None) -> dict[str, Any]:
            return {"run": {"id": "run-1", "status": body.get("status", "finished")}}

    run = Run(client=_FakeClient(), run_id="run-1", shadow=shim)
    run.finish(status="finished")
    assert existing.finish_calls == [{"exit_code": 0}]


def test_shadow_finish_warns_when_init_does_not_complete(monkeypatch: pytest.MonkeyPatch) -> None:
    existing = _FakeWandbRun()
    shim = ShadowWandb(project="p", name=None, config=None, tags=None, notes=None, existing_run=existing)
    monkeypatch.setenv("INSTANTML_SHADOW_WANDB_FINISH_TIMEOUT", "0")
    shim._init_done.clear()

    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        shim.finish("failed")

    assert any("finish skipped" in str(w.message) for w in captured)
    assert existing.finish_calls == []


def test_is_local_file_uri_helpers(tmp_path) -> None:
    from instantml.client import _is_local_file_uri, _strip_file_uri

    f = tmp_path / "a.bin"
    f.write_bytes(b"x")
    assert _is_local_file_uri(str(f)) is True
    assert _is_local_file_uri(f"file://{f}") is True
    assert _is_local_file_uri("s3://bucket/key") is False
    assert _is_local_file_uri("/nonexistent/path/that/does/not/exist.bin") is False
    assert _is_local_file_uri(123) is False  # type: ignore[arg-type]
    assert _strip_file_uri(f"file://{f}") == str(f)
    assert _strip_file_uri(str(f)) == str(f)


def test_shadow_log_swallows_wandb_run_log_exceptions(monkeypatch: pytest.MonkeyPatch) -> None:
    class _BoomRun(_FakeWandbRun):
        def log(self, data: dict[str, Any], **kwargs: Any) -> None:
            raise RuntimeError("network down")

    fake_run = _BoomRun()
    _install_fake_wandb(monkeypatch, fake_run)
    shim = build_shadow(True, project="p", name=None, config=None, tags=None, notes=None)
    assert shim is not None
    shim.wait_for_init(timeout=2.0)
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        shim.log({"loss": 1.0}, step=1)
    assert any("shadow_wandb log failed" in str(w.message) for w in captured)
