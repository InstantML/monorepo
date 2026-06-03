from __future__ import annotations

import sys
from types import SimpleNamespace

import pytest

import instantml.wandb_mirror as wandb


@pytest.fixture(autouse=True)
def _reset_wandb_mirror(monkeypatch):
    monkeypatch.setattr(wandb, "_real_wandb", None)
    monkeypatch.setattr(wandb, "_warned", set())
    monkeypatch.setattr(wandb, "run", None)
    wandb.config.attach(None, None)
    sys.modules.pop("wandb", None)


class FakeWandbRun:
    def __init__(self):
        self.logged = []
        self.finished = []
        self.artifacts = []
        self.watched = []

    def log(self, data, step=None, **kwargs):
        self.logged.append((data, step, kwargs))
        return "wandb-log"

    def finish(self, exit_code=None, **kwargs):
        self.finished.append((exit_code, kwargs))
        return "wandb-finish"

    def log_artifact(self, *args, **kwargs):
        self.artifacts.append((args, kwargs))
        return "wandb-artifact"

    def watch(self, *args, **kwargs):
        self.watched.append((args, kwargs))
        return "wandb-watch"


class FakeInstantRun:
    def __init__(self):
        self.logged = []
        self.finished = []
        self.configs = []

    def log(self, data, step=None):
        self.logged.append((data, step))

    def finish(self, status="finished"):
        self.finished.append(status)

    def log_config(self, data):
        self.configs.append(data)


class FailingInstantRun(FakeInstantRun):
    def __init__(self, fail_log=False, fail_finish=False, fail_config=False):
        super().__init__()
        self.fail_log = fail_log
        self.fail_finish = fail_finish
        self.fail_config = fail_config

    def log(self, data, step=None):
        if self.fail_log:
            raise RuntimeError("log failed")
        super().log(data, step=step)

    def finish(self, status="finished"):
        if self.fail_finish:
            raise RuntimeError("finish failed")
        super().finish(status=status)

    def log_config(self, data):
        if self.fail_config:
            raise RuntimeError("config failed")
        super().log_config(data)


def _install_fake_wandb(monkeypatch, fake_wandb):
    monkeypatch.setitem(sys.modules, "wandb", fake_wandb)


def test_wandb_mirror_keeps_wandb_primary_and_mirrors_scalars(monkeypatch):
    fake_wandb_run = FakeWandbRun()
    fake_instant_run = FakeInstantRun()
    wandb_init_calls = []
    instant_init_calls = []

    fake_wandb = SimpleNamespace(
        config={},
        init=lambda **kwargs: (wandb_init_calls.append(kwargs) or fake_wandb_run),
        define_metric=lambda *args, **kwargs: ("metric", args, kwargs),
    )
    _install_fake_wandb(monkeypatch, fake_wandb)

    def fake_instantml_init(**kwargs):
        instant_init_calls.append(kwargs)
        return fake_instant_run

    monkeypatch.setattr(wandb, "instantml_init", fake_instantml_init)

    wrapped = wandb.init(
        project="train",
        entity="team",
        name="run-a",
        config={"lr": 0.1},
        tags=["pilot"],
        notes="hello",
        id="wb-1",
        instantml_project="mirrored-train",
        instantml_api_key="instantml_test",
    )

    assert wrapped is wandb.run
    assert wandb_init_calls[0]["project"] == "train"
    assert wandb_init_calls[0]["entity"] == "team"
    assert instant_init_calls[0]["project"] == "mirrored-train"
    assert instant_init_calls[0]["api_key"] == "instantml_test"
    assert instant_init_calls[0]["metadata"]["wandb_shadow"] == {
        "project": "train",
        "entity": "team",
        "id": "wb-1",
        "group": None,
        "job_type": None,
    }

    assert (
        wandb.log({"loss": 1.0, "epoch": 2, "text": "ignored", "flag": True}, step=3)
        == "wandb-log"
    )
    assert fake_wandb_run.logged == [
        ({"loss": 1.0, "epoch": 2, "text": "ignored", "flag": True}, 3, {})
    ]
    assert fake_instant_run.logged == [({"loss": 1.0, "epoch": 2}, 3)]

    wandb.config.update({"epochs": 10})
    assert fake_wandb.config == {"epochs": 10}
    assert fake_instant_run.configs == [{"epochs": 10}]

    assert wrapped.watch("model") == "wandb-watch"
    assert fake_wandb_run.watched == [(("model",), {})]

    assert wandb.finish(exit_code=1) == "wandb-finish"
    assert fake_wandb_run.finished == [(1, {})]
    assert fake_instant_run.finished == ["failed"]
    assert wandb.run is None


def test_wandb_mirror_instantml_init_failure_does_not_break_wandb(monkeypatch):
    fake_wandb_run = FakeWandbRun()
    fake_wandb = SimpleNamespace(config={}, init=lambda **kwargs: fake_wandb_run)
    _install_fake_wandb(monkeypatch, fake_wandb)

    def fail_instantml_init(**kwargs):
        raise RuntimeError("no InstantML credentials")

    monkeypatch.setattr(wandb, "instantml_init", fail_instantml_init)

    with pytest.warns(RuntimeWarning, match="mirror disabled"):
        wrapped = wandb.init(project="train")

    wrapped.log({"loss": 0.5}, step=1)
    assert fake_wandb_run.logged == [({"loss": 0.5}, 1, {})]
    assert wrapped.finish() == "wandb-finish"


def test_wandb_mirror_skips_instantml_mirror_for_extra_log_kwargs(monkeypatch):
    fake_wandb_run = FakeWandbRun()
    fake_instant_run = FakeInstantRun()
    fake_wandb = SimpleNamespace(config={}, init=lambda **kwargs: fake_wandb_run)
    _install_fake_wandb(monkeypatch, fake_wandb)
    monkeypatch.setattr(wandb, "instantml_init", lambda **kwargs: fake_instant_run)

    wandb.init(project="train")
    with pytest.warns(RuntimeWarning, match="extra kwargs"):
        wandb.log({"loss": 0.5}, step=1, commit=False)

    assert fake_wandb_run.logged == [({"loss": 0.5}, 1, {"commit": False})]
    assert fake_instant_run.logged == []


def test_wandb_mirror_real_wandb_failure_still_raises(monkeypatch):
    def fail_wandb_init(**kwargs):
        raise RuntimeError("wandb login failed")

    fake_wandb = SimpleNamespace(config={}, init=fail_wandb_init)
    _install_fake_wandb(monkeypatch, fake_wandb)
    monkeypatch.setattr(wandb, "instantml_init", lambda **kwargs: FakeInstantRun())

    with pytest.raises(RuntimeError, match="wandb login failed"):
        wandb.init(project="train")


def test_wandb_mirror_unknown_attributes_delegate_to_real_wandb(monkeypatch):
    fake_wandb = SimpleNamespace(config={}, Artifact=lambda name: ("artifact", name))
    _install_fake_wandb(monkeypatch, fake_wandb)

    assert wandb.Artifact("model") == ("artifact", "model")


def test_wandb_mirror_config_proxy_mapping_behaviour(monkeypatch):
    class ConfigDict(dict):
        def custom(self):
            return "custom"

    fake_instant_run = FakeInstantRun()
    backing_config = ConfigDict()
    proxy = wandb.ConfigProxy(backing_config, fake_instant_run)

    assert len(proxy) == 0
    assert list(proxy) == []

    proxy["lr"] = 0.01
    assert backing_config["lr"] == 0.01
    assert proxy["lr"] == 0.01
    assert fake_instant_run.configs == [{"lr": 0.01}]
    assert len(proxy) == 1
    assert list(proxy) == ["lr"]

    assert proxy.custom() == "custom"


def test_wandb_mirror_config_proxy_unattached_errors():
    proxy = wandb.ConfigProxy()

    with pytest.raises(RuntimeError, match="before wandb.init"):
        proxy["lr"] = 0.01

    with pytest.raises(AttributeError, match="missing"):
        proxy.missing


def test_wandb_mirror_config_update_failures_warn_once(monkeypatch):
    fake_wandb_run = FakeWandbRun()
    fake_instant_run = FailingInstantRun(fail_config=True)
    fake_wandb = SimpleNamespace(config={}, init=lambda **kwargs: fake_wandb_run)
    _install_fake_wandb(monkeypatch, fake_wandb)
    monkeypatch.setattr(wandb, "instantml_init", lambda **kwargs: fake_instant_run)

    wandb.init(project="train")

    with pytest.warns(RuntimeWarning, match="config mirror failed") as captured:
        wandb.config.update({"epochs": 10})
        wandb.config.update({"batch_size": 32})

    assert len(captured) == 1


def test_wandb_mirror_non_mapping_config_warns_once():
    class BadConfig:
        def __iter__(self):
            raise RuntimeError("not iterable")

    with pytest.warns(RuntimeWarning, match="non-mapping W&B config") as captured:
        assert wandb._safe_config(BadConfig()) is None
        assert wandb._safe_config(BadConfig()) is None

    assert len(captured) == 1
    assert wandb._safe_config(None) is None


def test_wandb_mirror_context_manager_finishes_failed_run(monkeypatch):
    fake_wandb_run = FakeWandbRun()
    fake_instant_run = FakeInstantRun()
    fake_wandb = SimpleNamespace(config={}, init=lambda **kwargs: fake_wandb_run)
    _install_fake_wandb(monkeypatch, fake_wandb)
    monkeypatch.setattr(wandb, "instantml_init", lambda **kwargs: fake_instant_run)

    with pytest.raises(ValueError, match="boom"):
        with wandb.init(project="train") as wrapped:
            assert wrapped is wandb.run
            raise ValueError("boom")

    assert fake_wandb_run.finished == [(1, {})]
    assert fake_instant_run.finished == ["failed"]
    assert wandb.run is None


def test_wandb_mirror_skips_empty_and_disabled_mirror(monkeypatch):
    fake_wandb_run = FakeWandbRun()
    fake_wandb = SimpleNamespace(config={}, init=lambda **kwargs: fake_wandb_run)
    _install_fake_wandb(monkeypatch, fake_wandb)

    def unexpected_instantml_init(**kwargs):
        raise AssertionError("InstantML should be disabled")

    monkeypatch.setattr(wandb, "instantml_init", unexpected_instantml_init)

    wrapped = wandb.init(project="train", instantml_disabled=True)
    assert wrapped._instantml_run is None
    assert wandb.log({"text": "ignored", "flag": True}, step=1) == "wandb-log"
    assert fake_wandb_run.logged == [({"text": "ignored", "flag": True}, 1, {})]


def test_wandb_mirror_skips_non_scalar_payloads_when_mirror_active(monkeypatch):
    fake_wandb_run = FakeWandbRun()
    fake_instant_run = FakeInstantRun()
    fake_wandb = SimpleNamespace(config={}, init=lambda **kwargs: fake_wandb_run)
    _install_fake_wandb(monkeypatch, fake_wandb)
    monkeypatch.setattr(wandb, "instantml_init", lambda **kwargs: fake_instant_run)

    wandb.init(project="train")
    payload = {"text": "ignored", "flag": True, "nan": float("nan")}
    assert wandb.log(payload, step=1) == "wandb-log"

    assert fake_wandb_run.logged == [(payload, 1, {})]
    assert fake_instant_run.logged == []


def test_wandb_mirror_warns_when_log_or_finish_mirror_fails(monkeypatch):
    fake_wandb_run = FakeWandbRun()
    fake_instant_run = FailingInstantRun(fail_log=True, fail_finish=True)
    fake_wandb = SimpleNamespace(config={}, init=lambda **kwargs: fake_wandb_run)
    _install_fake_wandb(monkeypatch, fake_wandb)
    monkeypatch.setattr(wandb, "instantml_init", lambda **kwargs: fake_instant_run)

    wrapped = wandb.init(project="train")

    with pytest.warns(RuntimeWarning, match="metric mirror failed") as log_warnings:
        wandb.log({"loss": 0.5}, step=1)
        wandb.log({"loss": 0.4}, step=2)

    assert len(log_warnings) == 1
    assert fake_wandb_run.logged == [({"loss": 0.5}, 1, {}), ({"loss": 0.4}, 2, {})]

    with pytest.warns(RuntimeWarning, match="finish mirror failed") as finish_warnings:
        assert wrapped.finish() == "wandb-finish"
        assert wrapped.finish() == "wandb-finish"

    assert len(finish_warnings) == 1


def test_wandb_mirror_log_artifact_warns_but_preserves_wandb_result(monkeypatch):
    fake_wandb_run = FakeWandbRun()
    fake_wandb = SimpleNamespace(config={}, init=lambda **kwargs: fake_wandb_run)
    _install_fake_wandb(monkeypatch, fake_wandb)
    monkeypatch.setattr(wandb, "instantml_init", lambda **kwargs: FakeInstantRun())

    wrapped = wandb.init(project="train")
    with pytest.warns(RuntimeWarning, match="does not mirror W&B artifacts yet") as captured:
        assert wrapped.log_artifact("artifact", aliases=["latest"]) == "wandb-artifact"
        assert wrapped.log_artifact("artifact", aliases=["latest"]) == "wandb-artifact"

    assert len(captured) == 1
    assert fake_wandb_run.artifacts == [
        (("artifact",), {"aliases": ["latest"]}),
        (("artifact",), {"aliases": ["latest"]}),
    ]


def test_wandb_mirror_module_helpers_without_active_run_delegate(monkeypatch):
    calls = []
    fake_wandb = SimpleNamespace(
        config={},
        log=lambda *args, **kwargs: calls.append(("log", args, kwargs)) or "log-result",
        finish=lambda *args, **kwargs: calls.append(("finish", args, kwargs)) or "finish-result",
        define_metric=lambda *args, **kwargs: calls.append(("metric", args, kwargs)) or "metric-result",
        watch=lambda *args, **kwargs: calls.append(("watch", args, kwargs)) or "watch-result",
    )
    _install_fake_wandb(monkeypatch, fake_wandb)

    assert wandb.log({"loss": 0.1}, step=1) == "log-result"
    assert wandb.finish(exit_code=0) == "finish-result"
    assert wandb.define_metric("loss", step_metric="step") == "metric-result"
    assert wandb.watch("model", log="all") == "watch-result"
    assert calls == [
        ("log", ({"loss": 0.1},), {"step": 1}),
        ("finish", (), {"exit_code": 0}),
        ("metric", ("loss",), {"step_metric": "step"}),
        ("watch", ("model",), {"log": "all"}),
    ]


def test_wandb_mirror_module_watch_uses_active_wandb_run(monkeypatch):
    fake_wandb_run = FakeWandbRun()
    fake_wandb = SimpleNamespace(config={}, init=lambda **kwargs: fake_wandb_run)
    _install_fake_wandb(monkeypatch, fake_wandb)
    monkeypatch.setattr(wandb, "instantml_init", lambda **kwargs: FakeInstantRun())

    wandb.init(project="train")
    assert wandb.watch("model", log_freq=10) == "wandb-watch"
    assert fake_wandb_run.watched == [(("model",), {"log_freq": 10})]
